import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { sanitizeText } from '../lib/sanitize.js';

/** Thin, typed wrapper around the GitHub REST API (v3). Tokens stay server-side. */
export class GitHubError extends Error {
  constructor(public status: number, message: string, public documentation?: string) {
    super(message);
  }
}

export interface GhUser {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatar_url: string;
  html_url: string;
}
export interface GhRepo {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  html_url: string;
  description: string | null;
  updated_at: string;
  pushed_at: string;
  archived: boolean;
  owner: { login: string };
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}
export interface GhBranch {
  name: string;
  commit: { sha: string };
  protected: boolean;
}
export interface GhPull {
  number: number;
  html_url: string;
  state: 'open' | 'closed';
  merged: boolean;
  merged_at: string | null;
  draft: boolean;
  mergeable: boolean | null;
  mergeable_state?: string;
  title: string;
  head: { ref: string; sha: string };
  base: { ref: string };
  updated_at: string;
}

export class GitHubClient {
  constructor(private token: string, private apiUrl = config.github.apiUrl) {}

  scopes: string[] = [];

  async request<T>(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}): Promise<T> {
    const res = await fetch(`${this.apiUrl}${path}`, {
      method,
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'ai-qa-saas',
        Authorization: `Bearer ${this.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...extraHeaders,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(20000),
    }).catch((err: Error) => {
      throw new GitHubError(502, `GitHub is unreachable: ${err.message}`);
    });
    const scopeHeader = res.headers.get('x-oauth-scopes');
    if (scopeHeader !== null) this.scopes = scopeHeader.split(',').map((s) => s.trim()).filter(Boolean);
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    let data: unknown = text;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      /* non-JSON (e.g. raw file content) */
    }
    if (!res.ok) {
      const d = (data || {}) as { message?: string; documentation_url?: string; errors?: { message?: string; code?: string }[] };
      const detail = d.errors?.map((e) => e.message || e.code).filter(Boolean).join('; ');
      const remaining = res.headers.get('x-ratelimit-remaining');
      let msg = d.message || `GitHub API error ${res.status}`;
      if (res.status === 401) msg = 'GitHub rejected the token (expired or revoked). Reconnect GitHub.';
      else if (res.status === 403 && remaining === '0') msg = 'GitHub API rate limit exceeded. Try again later.';
      throw new GitHubError(res.status, sanitizeText(detail ? `${msg}: ${detail}` : msg, 400), d.documentation_url);
    }
    return data as T;
  }

  getUser() {
    return this.request<GhUser>('GET', '/user');
  }

  async getPrimaryEmail(): Promise<string | null> {
    try {
      const emails = await this.request<{ email: string; primary: boolean; verified: boolean }[]>('GET', '/user/emails');
      return emails.find((e) => e.primary && e.verified)?.email || null;
    } catch {
      return null;
    }
  }

  async listRepos(query = '', limit = 100): Promise<GhRepo[]> {
    const out: GhRepo[] = [];
    for (let page = 1; page <= 5 && out.length < 500; page++) {
      const batch = await this.request<GhRepo[]>('GET', `/user/repos?per_page=100&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    const q = query.trim().toLowerCase();
    return out.filter((r) => !r.archived && (!q || r.full_name.toLowerCase().includes(q))).slice(0, limit);
  }

  getRepo(owner: string, repo: string) {
    return this.request<GhRepo>('GET', `/repos/${enc(owner)}/${enc(repo)}`);
  }

  async listBranches(owner: string, repo: string): Promise<GhBranch[]> {
    const out: GhBranch[] = [];
    for (let page = 1; page <= 5; page++) {
      const batch = await this.request<GhBranch[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/branches?per_page=100&page=${page}`);
      out.push(...batch);
      if (batch.length < 100) break;
    }
    return out;
  }

  getBranch(owner: string, repo: string, branch: string) {
    return this.request<GhBranch>('GET', `/repos/${enc(owner)}/${enc(repo)}/branches/${encodeURIComponent(branch)}`);
  }

  async branchExists(owner: string, repo: string, branch: string) {
    try {
      await this.getBranch(owner, repo, branch);
      return true;
    } catch (e) {
      if (e instanceof GitHubError && e.status === 404) return false;
      throw e;
    }
  }

  getTree(owner: string, repo: string, ref: string) {
    return this.request<{ tree: { path: string; type: string; size?: number }[]; truncated: boolean }>('GET', `/repos/${enc(owner)}/${enc(repo)}/git/trees/${encodeURIComponent(ref)}?recursive=1`);
  }

  getFileRaw(owner: string, repo: string, path: string, ref: string) {
    return this.request<string>('GET', `/repos/${enc(owner)}/${enc(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`, undefined, {
      Accept: 'application/vnd.github.raw+json',
    });
  }

  createPull(owner: string, repo: string, input: { title: string; head: string; base: string; body: string; draft?: boolean; maintainer_can_modify?: boolean }) {
    return this.request<GhPull>('POST', `/repos/${enc(owner)}/${enc(repo)}/pulls`, input);
  }

  getPull(owner: string, repo: string, number: number) {
    return this.request<GhPull>('GET', `/repos/${enc(owner)}/${enc(repo)}/pulls/${number}`);
  }

  async findOpenPull(owner: string, repo: string, head: string) {
    const list = await this.request<GhPull[]>('GET', `/repos/${enc(owner)}/${enc(repo)}/pulls?state=open&head=${encodeURIComponent(`${owner}:${head}`)}`);
    return list[0] || null;
  }

  async addLabels(owner: string, repo: string, number: number, labels: string[]) {
    return this.request('POST', `/repos/${enc(owner)}/${enc(repo)}/issues/${number}/labels`, { labels });
  }

  async checksSummary(owner: string, repo: string, sha: string) {
    const [runs, status] = await Promise.all([
      this.request<{ total_count: number; check_runs: { name: string; status: string; conclusion: string | null; html_url: string }[] }>(
        'GET',
        `/repos/${enc(owner)}/${enc(repo)}/commits/${sha}/check-runs?per_page=50`,
      ).catch(() => ({ total_count: 0, check_runs: [] })),
      this.request<{ state: string; total_count: number }>('GET', `/repos/${enc(owner)}/${enc(repo)}/commits/${sha}/status`).catch(() => ({ state: 'unknown', total_count: 0 })),
    ]);
    const runsList = runs.check_runs || [];
    const failed = runsList.filter((r) => r.conclusion && !['success', 'neutral', 'skipped'].includes(r.conclusion)).length;
    const pending = runsList.filter((r) => r.status !== 'completed').length;
    const passed = runsList.filter((r) => r.conclusion === 'success').length;
    let state = 'none';
    if (runsList.length || status.total_count) {
      state = failed || status.state === 'failure' || status.state === 'error' ? 'failure' : pending || status.state === 'pending' ? 'pending' : 'success';
    }
    return {
      state,
      total: runsList.length + status.total_count,
      passed,
      failed,
      pending,
      runs: runsList.slice(0, 20).map((r) => ({ name: r.name, status: r.status, conclusion: r.conclusion, url: r.html_url })),
    };
  }
}

const enc = (s: string) => encodeURIComponent(s);

export function repoGitUrl(owner: string, repo: string) {
  return `${config.github.webUrl}/${owner}/${repo}.git`;
}

export function repoWebUrl(owner: string, repo: string) {
  return `${config.github.webUrl}/${owner}/${repo}`;
}

export function toHttpError(err: unknown): never {
  if (err instanceof GitHubError) {
    const status = err.status === 401 ? 401 : err.status === 404 ? 404 : err.status === 422 ? 422 : err.status >= 500 ? 502 : 400;
    throw new HttpError(status === 401 ? 409 : status, err.message);
  }
  throw err;
}

export function parseGithubRepoUrl(url: string): { owner: string; repo: string } | null {
  const web = config.github.webUrl;
  if (url.startsWith(`${web}/`)) {
    const [owner, repo] = url.slice(web.length + 1).replace(/\.git$|\/$/g, '').split('/');
    if (owner && repo && /^[\w.-]+$/.test(owner) && /^[\w.-]+$/.test(repo)) return { owner, repo };
  }
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}
