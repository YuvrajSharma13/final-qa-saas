import crypto from 'node:crypto';
import type { Types } from 'mongoose';
import { config } from '../config.js';
import { decryptSecret, encryptSecret } from '../lib/crypto.js';
import { HttpError } from '../lib/http.js';
import { GithubConnection, type ProjectDoc } from '../models/index.js';
import { GitHubClient, type GhUser } from './client.js';

export const oauthConfigured = () => Boolean(config.github.clientId && config.github.clientSecret);

export function publicConnection(c: { login: string; name?: string | null; email?: string | null; avatarUrl?: string | null; method: string; scopes?: string[]; createdAt?: Date; lastUsedAt?: Date | null; lastError?: string | null; githubUserId: number }) {
  return {
    connected: true,
    login: c.login,
    name: c.name,
    email: c.email,
    avatarUrl: c.avatarUrl,
    method: c.method,
    scopes: c.scopes,
    githubUserId: c.githubUserId,
    connectedAt: c.createdAt,
    lastUsedAt: c.lastUsedAt,
    lastError: c.lastError,
  };
}

/** Validates a token against GitHub and stores it (encrypted) for the user. */
export async function saveConnection(userId: Types.ObjectId, token: string, method: 'oauth' | 'token', knownScopes?: string[]) {
  const client = new GitHubClient(token);
  let gh: GhUser;
  try {
    gh = await client.getUser();
  } catch (e) {
    throw new HttpError(400, `GitHub token check failed: ${(e as Error).message}`);
  }
  const email = gh.email || (await client.getPrimaryEmail());
  const other = await GithubConnection.findOne({ githubUserId: gh.id, userId: { $ne: userId } }).lean();
  if (other) throw new HttpError(409, `GitHub account @${gh.login} is already linked to another user`);
  const doc = {
    userId,
    githubUserId: gh.id,
    login: gh.login,
    name: gh.name,
    email,
    avatarUrl: gh.avatar_url,
    method,
    scopes: knownScopes?.length ? knownScopes : client.scopes,
    tokenEnc: encryptSecret(token),
    lastUsedAt: new Date(),
    lastError: '',
  };
  const existing = await GithubConnection.findOne({ userId });
  if (existing) {
    existing.set(doc);
    await existing.save();
    return { connection: existing, gh };
  }
  return { connection: await GithubConnection.create(doc), gh };
}

export async function clientForUser(userId: Types.ObjectId | string | undefined | null) {
  if (!userId) return null;
  const c = await GithubConnection.findOne({ userId });
  if (!c) return null;
  let token: string;
  try {
    token = decryptSecret(c.tokenEnc);
  } catch {
    return null;
  }
  c.lastUsedAt = new Date();
  await c.save().catch(() => undefined);
  return { client: new GitHubClient(token), token, connection: c };
}

export async function requireClientForUser(userId: Types.ObjectId) {
  const c = await clientForUser(userId);
  if (!c) throw new HttpError(409, 'Connect your GitHub account first (Settings → GitHub).');
  return c;
}

/**
 * Token used for a project's repository: the requesting user's GitHub connection, then the user who linked the
 * repository, then the project-level token (legacy "GitHub token" setting).
 */
export async function tokenForProject(project: Pick<ProjectDoc, 'settings'>, preferUserId?: Types.ObjectId | null): Promise<{ token: string; source: string; userId?: Types.ObjectId } | null> {
  for (const uid of [preferUserId, project.settings?.github?.connectedBy]) {
    const c = await clientForUser(uid);
    if (c) return { token: c.token, source: `github:${c.connection.login}`, userId: c.connection.userId };
  }
  if (project.settings?.githubTokenEnc) {
    try {
      return { token: decryptSecret(project.settings.githubTokenEnc), source: 'project-token' };
    } catch {
      return null;
    }
  }
  return null;
}

export async function markConnectionError(userId: Types.ObjectId | undefined, message: string) {
  if (userId) await GithubConnection.updateOne({ userId }, { lastError: message.slice(0, 300) });
}

// ------------------------------------------------------------------ OAuth web flow
export function oauthCallbackUrl(requestOrigin: string) {
  return config.github.callbackUrl || `${requestOrigin}/api/github/oauth/callback`;
}

export function authorizeUrl(state: string, redirectUri: string) {
  const u = new URL(`${config.github.webUrl}/login/oauth/authorize`);
  u.searchParams.set('client_id', config.github.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', config.github.scopes);
  u.searchParams.set('state', state);
  u.searchParams.set('allow_signup', 'true');
  return u.toString();
}

export async function exchangeCode(code: string, redirectUri: string): Promise<{ token: string; scopes: string[] }> {
  const res = await fetch(`${config.github.webUrl}/login/oauth/access_token`, {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'ai-qa-saas' },
    body: JSON.stringify({ client_id: config.github.clientId, client_secret: config.github.clientSecret, code, redirect_uri: redirectUri }),
    signal: AbortSignal.timeout(15000),
  });
  const data = (await res.json().catch(() => ({}))) as { access_token?: string; scope?: string; error?: string; error_description?: string };
  if (!res.ok || !data.access_token) throw new HttpError(400, `GitHub sign-in failed: ${data.error_description || data.error || res.status}`);
  return { token: data.access_token, scopes: (data.scope || '').split(/[ ,]/).filter(Boolean) };
}

/** Best-effort revocation of an OAuth grant when the user disconnects. */
export async function revokeOAuthToken(token: string) {
  if (!oauthConfigured()) return;
  const basic = Buffer.from(`${config.github.clientId}:${config.github.clientSecret}`).toString('base64');
  await fetch(`${config.github.apiUrl}/applications/${config.github.clientId}/grant`, {
    method: 'DELETE',
    headers: { Authorization: `Basic ${basic}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'User-Agent': 'ai-qa-saas' },
    body: JSON.stringify({ access_token: token }),
    signal: AbortSignal.timeout(10000),
  }).catch(() => undefined);
}

export const randomState = () => crypto.randomBytes(24).toString('base64url');
