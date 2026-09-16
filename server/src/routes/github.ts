import { Router, type Request, type Response } from 'express';
import jwt from 'jsonwebtoken';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { GitHubClient, repoWebUrl, toHttpError } from '../github/client.js';
import {
  authorizeUrl,
  clientForUser,
  exchangeCode,
  oauthCallbackUrl,
  oauthConfigured,
  publicConnection,
  randomState,
  requireClientForUser,
  revokeOAuthToken,
  saveConnection,
} from '../github/connection.js';
import { decryptSecret } from '../lib/crypto.js';
import { asyncHandler, HttpError, parseBody } from '../lib/http.js';
import { requireAuth, SESSION_COOKIE, setSessionCookie, signSession, withWorkspace } from '../middleware/auth.js';
import { GithubConnection, Member, User, Workspace, type ProjectDoc } from '../models/index.js';
import { loadProject, serializeProject } from './projects.js';

export const githubRouter = Router();
const OAUTH_COOKIE = 'gh_oauth';
const limiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });

const origin = (req: Request) => `${req.protocol}://${req.get('host')}`;
const safeNext = (n: unknown, fallback: string) => (typeof n === 'string' && n.startsWith('/') && !n.startsWith('//') ? n : fallback);

function sessionUserId(req: Request): string | null {
  const token = req.cookies?.[SESSION_COOKIE];
  if (!token) return null;
  try {
    return (jwt.verify(token, config.jwtSecret) as { sub: string }).sub;
  } catch {
    return null;
  }
}

githubRouter.get('/config', (_req, res) => {
  res.json({ oauthConfigured: oauthConfigured(), webUrl: config.github.webUrl, scopes: config.github.scopes.split(/[ ,]/) });
});

// ------------------------------------------------------------------ OAuth (browser redirects)
githubRouter.get('/oauth/start', limiter, (req, res) => {
  const mode = req.query.mode === 'connect' ? 'connect' : 'login';
  const fail = (msg: string) => res.redirect(`${mode === 'connect' ? '/settings?tab=github&' : '/login?'}githubError=${encodeURIComponent(msg)}`);
  if (!oauthConfigured()) return fail('GitHub OAuth is not configured on this server (GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET).');
  const uid = sessionUserId(req);
  if (mode === 'connect' && !uid) return res.redirect('/login?next=%2Fsettings%3Ftab%3Dgithub');
  const state = randomState();
  const redirectUri = oauthCallbackUrl(origin(req));
  const next = safeNext(req.query.next, mode === 'connect' ? '/settings?tab=github' : '/dashboard');
  const signed = jwt.sign({ state, mode, uid, next, redirectUri }, config.jwtSecret, { expiresIn: '10m' });
  res.cookie(OAUTH_COOKIE, signed, { httpOnly: true, sameSite: 'lax', secure: config.isProd, maxAge: 10 * 60 * 1000, path: '/api/github' });
  res.redirect(authorizeUrl(state, redirectUri));
});

githubRouter.get(
  '/oauth/callback',
  limiter,
  asyncHandler(async (req: Request, res: Response) => {
    let payload: { state: string; mode: 'login' | 'connect'; uid: string | null; next: string; redirectUri: string };
    try {
      payload = jwt.verify(req.cookies?.[OAUTH_COOKIE] || '', config.jwtSecret) as typeof payload;
    } catch {
      return res.redirect('/login?githubError=' + encodeURIComponent('GitHub sign-in expired, please try again.'));
    }
    res.clearCookie(OAUTH_COOKIE, { path: '/api/github' });
    const failTo = payload.mode === 'connect' ? '/settings?tab=github&' : '/login?';
    try {
      if (req.query.error) throw new HttpError(400, String(req.query.error_description || req.query.error));
      if (typeof req.query.state !== 'string' || req.query.state !== payload.state) throw new HttpError(400, 'GitHub sign-in state mismatch');
      if (typeof req.query.code !== 'string') throw new HttpError(400, 'Missing authorization code');
      const { token, scopes } = await exchangeCode(req.query.code, payload.redirectUri);

      let userId = payload.mode === 'connect' ? payload.uid : null;
      if (payload.mode === 'connect' && userId !== sessionUserId(req)) throw new HttpError(400, 'Session changed during GitHub sign-in');
      if (!userId) {
        const client = new GitHubClient(token);
        const gh = await client.getUser();
        const linked = await GithubConnection.findOne({ githubUserId: gh.id }).lean();
        if (linked) userId = String(linked.userId);
        else {
          // Only a *verified* primary email may be used to match an existing account.
          const verified = await client.getPrimaryEmail();
          const existing = verified ? await User.findOne({ email: verified.toLowerCase() }) : null;
          if (existing) userId = String(existing._id);
          else {
            const user = await User.create({
              name: gh.name || gh.login,
              email: (verified || `${gh.id}+${gh.login}@users.noreply.github.com`).toLowerCase(),
              authProvider: 'github',
            });
            const ws = await Workspace.create({ name: `${gh.name || gh.login}'s workspace`, ownerId: user._id, plan: 'free' });
            await Member.create({ workspaceId: ws._id, userId: user._id, role: 'owner' });
            userId = String(user._id);
            payload.next = '/projects/new';
          }
        }
      }
      const user = await User.findById(userId);
      if (!user) throw new HttpError(400, 'Account not found');
      await saveConnection(user._id, token, 'oauth', scopes);
      if (payload.mode === 'login') setSessionCookie(res, signSession(user));
      const sep = payload.next.includes('?') ? '&' : '?';
      res.redirect(`${payload.next}${sep}github=connected`);
    } catch (err) {
      res.redirect(`${failTo}githubError=${encodeURIComponent((err as Error).message)}`);
    }
  }),
);

// ------------------------------------------------------------------ authenticated API
const authed = Router();
authed.use(requireAuth, withWorkspace);
githubRouter.use(authed);

authed.get(
  '/status',
  asyncHandler(async (req, res) => {
    const c = await GithubConnection.findOne({ userId: req.user!.id }).lean();
    res.json({ oauthConfigured: oauthConfigured(), connection: c ? publicConnection(c) : { connected: false } });
  }),
);

authed.post(
  '/token',
  limiter,
  asyncHandler(async (req, res) => {
    const { token } = parseBody(z.object({ token: z.string().trim().min(20).max(300) }), req.body);
    const { connection } = await saveConnection(req.user!.id, token, 'token');
    res.status(201).json({ connection: publicConnection(connection.toObject()) });
  }),
);

authed.delete(
  '/connection',
  asyncHandler(async (req, res) => {
    const c = await GithubConnection.findOne({ userId: req.user!.id });
    if (c) {
      if (c.method === 'oauth') {
        try {
          await revokeOAuthToken(decryptSecret(c.tokenEnc));
        } catch {
          /* best effort */
        }
      }
      await c.deleteOne();
    }
    res.json({ ok: true });
  }),
);

authed.get(
  '/repos',
  limiter,
  asyncHandler(async (req, res) => {
    const { client } = await requireClientForUser(req.user!.id);
    const repos = await client.listRepos(String(req.query.q || '')).catch(toHttpError);
    res.json({
      repos: repos.map((r) => ({
        id: r.id,
        owner: r.owner.login,
        name: r.name,
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        description: r.description,
        pushedAt: r.pushed_at,
        url: r.html_url,
        canPush: Boolean(r.permissions?.push),
      })),
    });
  }),
);

const namePart = z.string().regex(/^[\w.-]{1,100}$/);

authed.get(
  '/repos/:owner/:repo/branches',
  limiter,
  asyncHandler(async (req, res) => {
    const owner = parseBody(namePart, req.params.owner);
    const repo = parseBody(namePart, req.params.repo);
    const { client } = await requireClientForUser(req.user!.id);
    const [meta, branches] = await Promise.all([client.getRepo(owner, repo), client.listBranches(owner, repo)]).catch(toHttpError);
    res.json({
      defaultBranch: meta.default_branch,
      canPush: Boolean(meta.permissions?.push),
      branches: branches.map((b) => ({ name: b.name, sha: b.commit.sha, protected: b.protected, isDefault: b.name === meta.default_branch })),
    });
  }),
);

authed.put(
  '/projects/:id/repository',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    const body = parseBody(z.object({ owner: namePart, repo: namePart, baseBranch: z.string().trim().min(1).max(250) }), req.body);
    const { client } = await requireClientForUser(req.user!.id);
    const meta = await client.getRepo(body.owner, body.repo).catch(toHttpError);
    await client.getBranch(body.owner, body.repo, body.baseBranch).catch(toHttpError);
    project.repoUrl = repoWebUrl(meta.owner.login, meta.name);
    project.set('settings.github', {
      owner: meta.owner.login,
      repo: meta.name,
      baseBranch: body.baseBranch,
      defaultBranch: meta.default_branch,
      private: meta.private,
      connectedBy: req.user!.id,
      linkedAt: new Date(),
    });
    await project.save();
    res.json({ project: serializeProject(project.toObject() as ProjectDoc), canPush: Boolean(meta.permissions?.push) });
  }),
);

authed.delete(
  '/projects/:id/repository',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    project.set('settings.github', { owner: '', repo: '', baseBranch: '', defaultBranch: '' });
    if (/github/.test(project.repoUrl)) project.repoUrl = '';
    await project.save();
    res.json({ project: serializeProject(project.toObject() as ProjectDoc) });
  }),
);

authed.get(
  '/projects/:id/repository',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id);
    const gh = project.settings?.github;
    if (!gh?.owner) return res.json({ linked: false });
    const c = await clientForUser(req.user!.id);
    let live: Record<string, unknown> | null = null;
    if (c) {
      try {
        const [meta, branch] = await Promise.all([c.client.getRepo(gh.owner, gh.repo!), c.client.getBranch(gh.owner, gh.repo!, gh.baseBranch!)]);
        live = { defaultBranch: meta.default_branch, canPush: Boolean(meta.permissions?.push), headSha: branch.commit.sha, protected: branch.protected };
      } catch (e) {
        live = { error: (e as Error).message };
      }
    }
    res.json({ linked: true, owner: gh.owner, repo: gh.repo, baseBranch: gh.baseBranch, defaultBranch: gh.defaultBranch, private: gh.private, url: repoWebUrl(gh.owner, gh.repo!), live });
  }),
);
