/**
 * TEST-ONLY local GitHub-compatible server (GitHub Enterprise-style URLs).
 *
 * The product talks to it exactly as it talks to github.com — the only difference is GITHUB_WEB_URL /
 * GITHUB_API_URL. It serves:
 *   • real git smart-HTTP (git http-backend) with token auth, backed by real bare repositories
 *   • the subset of the REST v3 API the product uses (/api/v3/...), answered from those repositories
 *   • the OAuth web flow (/login/oauth/authorize, /login/oauth/access_token)
 * This lets CI exercise clone → branch → commit → push → pull request without github.com credentials.
 */
import { execFile, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export interface TestUser {
  id: number;
  login: string;
  name: string;
  email: string;
  token: string;
}

interface Pull {
  number: number;
  owner: string;
  repo: string;
  title: string;
  body: string;
  head: string;
  base: string;
  state: 'open' | 'closed';
  merged: boolean;
  labels: string[];
  created_by: string;
}

export class GitHubTestServer {
  server!: http.Server;
  url = '';
  root = '';
  users: TestUser[] = [];
  pulls: Pull[] = [];
  oauthCodes = new Map<string, string>();
  requests: { method: string; path: string; auth: string }[] = [];
  clientId = 'test-client-id';
  clientSecret = 'test-client-secret';
  private gitExecPath = '';

  async start(root: string) {
    this.root = root;
    await fs.mkdir(root, { recursive: true });
    this.gitExecPath = (await pexec('git', ['--exec-path'])).stdout.trim();
    this.server = http.createServer((req, res) => this.handle(req, res).catch((e) => this.send(res, 500, { message: String(e) })));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  stop() {
    return new Promise((r) => this.server.close(r));
  }

  addUser(login: string, name: string) {
    const u = { id: 1000 + this.users.length, login, name, email: `${login}@example.com`, token: `ghp_${crypto.randomBytes(18).toString('hex')}` };
    this.users.push(u);
    return u;
  }

  /** Creates a bare repository whose default branch contains `sourceDir`. */
  async createRepo(owner: string, repo: string, sourceDir: string, defaultBranch = 'main') {
    const bare = path.join(this.root, owner, `${repo}.git`);
    await fs.mkdir(path.dirname(bare), { recursive: true });
    await pexec('git', ['init', '-q', '--bare', '-b', defaultBranch, bare]);
    const work = path.join(this.root, '_seed', `${owner}-${repo}`);
    await fs.cp(sourceDir, work, { recursive: true, filter: (src) => !/node_modules|\.git$|storage/.test(src) });
    const g = (...args: string[]) => pexec('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: work, env: { ...process.env, GIT_AUTHOR_NAME: 'Seed', GIT_AUTHOR_EMAIL: 'seed@example.com', GIT_COMMITTER_NAME: 'Seed', GIT_COMMITTER_EMAIL: 'seed@example.com' } });
    await g('init', '-q', '-b', defaultBranch);
    await g('add', '-A');
    await g('commit', '-q', '-m', 'Initial import');
    await g('push', '-q', bare, `${defaultBranch}:${defaultBranch}`);
    await pexec('git', ['config', 'http.receivepack', 'true'], { cwd: bare });
    return bare;
  }

  bare(owner: string, repo: string) {
    return path.join(this.root, owner, `${repo}.git`);
  }

  async git(owner: string, repo: string, args: string[]) {
    return (await pexec('git', args, { cwd: this.bare(owner, repo), maxBuffer: 20_000_000 })).stdout;
  }

  async branches(owner: string, repo: string) {
    const out = await this.git(owner, repo, ['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads']);
    return out
      .split('\n')
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split(' ');
        return { name, sha };
      });
  }

  /** Simulates pressing "Merge" (fast-forward) on a pull request. */
  async merge(number: number) {
    const pr = this.pulls.find((p) => p.number === number)!;
    const head = (await this.branches(pr.owner, pr.repo)).find((b) => b.name === pr.head)!;
    await this.git(pr.owner, pr.repo, ['update-ref', `refs/heads/${pr.base}`, head.sha]);
    pr.state = 'closed';
    pr.merged = true;
  }

  private userFor(req: http.IncomingMessage): TestUser | undefined {
    const h = req.headers.authorization || '';
    if (h.startsWith('Bearer ')) return this.users.find((u) => u.token === h.slice(7));
    if (h.toLowerCase().startsWith('basic ')) {
      const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
      return this.users.find((u) => u.token === pass);
    }
    return undefined;
  }

  private send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(typeof body === 'string' ? body : JSON.stringify(body));
  }

  private async body(req: http.IncomingMessage) {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    return Buffer.concat(chunks);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const u = new URL(req.url!, this.url);
    this.requests.push({ method: req.method!, path: u.pathname, auth: req.headers.authorization ? req.headers.authorization.split(' ')[0] : '' });

    // ---------------- OAuth web flow
    if (u.pathname === '/login/oauth/authorize') {
      const code = crypto.randomBytes(8).toString('hex');
      this.oauthCodes.set(code, this.users[0].token);
      const back = new URL(u.searchParams.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', u.searchParams.get('state')!);
      res.writeHead(302, { location: back.toString() });
      return res.end();
    }
    if (u.pathname === '/login/oauth/access_token' && req.method === 'POST') {
      const b = JSON.parse((await this.body(req)).toString() || '{}');
      const token = this.oauthCodes.get(b.code);
      if (b.client_id !== this.clientId || b.client_secret !== this.clientSecret || !token) return this.send(res, 200, { error: 'bad_verification_code' });
      this.oauthCodes.delete(b.code);
      return this.send(res, 200, { access_token: token, token_type: 'bearer', scope: 'repo,read:user,user:email' });
    }

    // ---------------- git smart HTTP
    const gitMatch = u.pathname.match(/^\/([\w.-]+)\/([\w.-]+\.git)(\/.*)$/);
    if (gitMatch) {
      const user = this.userFor(req);
      if (!user) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="GitHub"' });
        return res.end('Authentication required');
      }
      return this.gitBackend(req, res, `/${gitMatch[1]}/${gitMatch[2]}${gitMatch[3]}`, u.search.slice(1), user.login);
    }

    // ---------------- REST API
    if (!u.pathname.startsWith('/api/v3/')) return this.send(res, 404, { message: 'Not Found' });
    const user = this.userFor(req);
    if (!user) return this.send(res, 401, { message: 'Bad credentials' });
    const p = u.pathname.slice('/api/v3'.length);
    const scopes = { 'x-oauth-scopes': 'repo, read:user, user:email' };
    let m: RegExpMatchArray | null;

    if (p === '/user') return this.send(res, 200, { id: user.id, login: user.login, name: user.name, email: null, avatar_url: '', html_url: `${this.url}/${user.login}` }, scopes);
    if (p === '/user/emails') return this.send(res, 200, [{ email: user.email, primary: true, verified: true }]);
    if (p === '/user/repos') {
      const owners = await fs.readdir(this.root);
      const repos = [];
      for (const o of owners.filter((x) => !x.startsWith('_'))) for (const r of await fs.readdir(path.join(this.root, o))) repos.push(await this.repoJson(o, r.replace(/\.git$/, '')));
      return this.send(res, 200, repos);
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)$/))) {
      if (!(await exists(this.bare(m[1], m[2])))) return this.send(res, 404, { message: 'Not Found' });
      return this.send(res, 200, await this.repoJson(m[1], m[2]));
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/branches$/))) {
      return this.send(res, 200, (await this.branches(m[1], m[2])).map((b) => ({ name: b.name, commit: { sha: b.sha }, protected: b.name === 'main' })));
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/branches\/(.+)$/))) {
      const b = (await this.branches(m[1], m[2])).find((x) => x.name === decodeURIComponent(m![3]));
      return b ? this.send(res, 200, { name: b.name, commit: { sha: b.sha }, protected: b.name === 'main' }) : this.send(res, 404, { message: 'Branch not found' });
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/git\/trees\/(.+)$/))) {
      const out = await this.git(m[1], m[2], ['ls-tree', '-r', '-l', decodeURIComponent(m[3])]);
      const tree = out
        .split('\n')
        .filter(Boolean)
        .map((l) => {
          const [meta, file] = l.split('\t');
          const parts = meta.split(/\s+/);
          return { path: file, type: parts[1], size: Number(parts[3]) || 0 };
        });
      return this.send(res, 200, { tree, truncated: false });
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/contents\/(.+)$/))) {
      const ref = u.searchParams.get('ref') || 'HEAD';
      const file = m[3].split('/').map(decodeURIComponent).join('/');
      try {
        const content = await this.git(m[1], m[2], ['show', `${ref}:${file}`]);
        res.writeHead(200, { 'content-type': 'application/vnd.github.raw+json' });
        return res.end(content);
      } catch {
        return this.send(res, 404, { message: 'Not Found' });
      }
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/pulls$/))) {
      const [owner, repo] = [m[1], m[2]];
      if (req.method === 'POST') {
        const b = JSON.parse((await this.body(req)).toString());
        const branches = await this.branches(owner, repo);
        if (!branches.some((x) => x.name === b.head)) return this.send(res, 422, { message: 'Validation Failed', errors: [{ message: `head ${b.head} does not exist` }] });
        if (!branches.some((x) => x.name === b.base)) return this.send(res, 422, { message: 'Validation Failed', errors: [{ message: 'base does not exist' }] });
        if (this.pulls.some((x) => x.owner === owner && x.repo === repo && x.head === b.head && x.state === 'open')) {
          return this.send(res, 422, { message: 'Validation Failed', errors: [{ message: `A pull request already exists for ${owner}:${b.head}.` }] });
        }
        const pr: Pull = { number: this.pulls.length + 1, owner, repo, title: b.title, body: b.body, head: b.head, base: b.base, state: 'open', merged: false, labels: [], created_by: user.login };
        this.pulls.push(pr);
        return this.send(res, 201, await this.pullJson(pr));
      }
      const head = u.searchParams.get('head')?.split(':')[1];
      const list = this.pulls.filter((x) => x.owner === owner && x.repo === repo && (!head || x.head === head) && (u.searchParams.get('state') !== 'open' || x.state === 'open'));
      return this.send(res, 200, await Promise.all(list.map((x) => this.pullJson(x))));
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/pulls\/(\d+)$/))) {
      const pr = this.pulls.find((x) => x.owner === m![1] && x.repo === m![2] && x.number === Number(m![3]));
      return pr ? this.send(res, 200, await this.pullJson(pr)) : this.send(res, 404, { message: 'Not Found' });
    }
    if ((m = p.match(/^\/repos\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)\/labels$/))) {
      const pr = this.pulls.find((x) => x.number === Number(m![3]));
      const b = JSON.parse((await this.body(req)).toString());
      pr?.labels.push(...b.labels);
      return this.send(res, 200, (pr?.labels || []).map((name) => ({ name })));
    }
    if ((m = p.match(/^\/repos\/[\w.-]+\/[\w.-]+\/commits\/\w+\/check-runs$/))) {
      return this.send(res, 200, { total_count: 1, check_runs: [{ name: 'ci / test', status: 'completed', conclusion: 'success', html_url: `${this.url}/checks/1` }] });
    }
    if ((m = p.match(/^\/repos\/[\w.-]+\/[\w.-]+\/commits\/\w+\/status$/))) return this.send(res, 200, { state: 'success', total_count: 0 });
    return this.send(res, 404, { message: `Not Found: ${p}` });
  }

  private async repoJson(owner: string, repo: string) {
    const head = (await this.git(owner, repo, ['symbolic-ref', '--short', 'HEAD'])).trim();
    return {
      id: owner.length * 1000 + repo.length,
      name: repo,
      full_name: `${owner}/${repo}`,
      private: true,
      archived: false,
      default_branch: head,
      html_url: `${this.url}/${owner}/${repo}`,
      description: 'Test repository',
      updated_at: new Date().toISOString(),
      pushed_at: new Date().toISOString(),
      owner: { login: owner },
      permissions: { admin: true, push: true, pull: true },
    };
  }

  private async pullJson(pr: Pull) {
    const head = (await this.branches(pr.owner, pr.repo)).find((b) => b.name === pr.head);
    return {
      number: pr.number,
      html_url: `${this.url}/${pr.owner}/${pr.repo}/pull/${pr.number}`,
      state: pr.state,
      merged: pr.merged,
      merged_at: pr.merged ? new Date().toISOString() : null,
      draft: false,
      mergeable: true,
      title: pr.title,
      body: pr.body,
      head: { ref: pr.head, sha: head?.sha || '' },
      base: { ref: pr.base },
      updated_at: new Date().toISOString(),
    };
  }

  private gitBackend(req: http.IncomingMessage, res: http.ServerResponse, pathInfo: string, query: string, user: string) {
    return new Promise<void>((resolve) => {
      const child = spawn(path.join(this.gitExecPath, 'git-http-backend'), [], {
        env: {
          PATH: process.env.PATH,
          GIT_PROJECT_ROOT: this.root,
          GIT_HTTP_EXPORT_ALL: '1',
          PATH_INFO: pathInfo,
          QUERY_STRING: query,
          REQUEST_METHOD: req.method,
          CONTENT_TYPE: req.headers['content-type'] || '',
          HTTP_CONTENT_ENCODING: String(req.headers['content-encoding'] || ''),
          GIT_PROTOCOL: String(req.headers['git-protocol'] || ''),
          REMOTE_USER: user,
          REMOTE_ADDR: '127.0.0.1',
        },
      });
      req.pipe(child.stdin);
      let buf = Buffer.alloc(0);
      let headersSent = false;
      child.stdout.on('data', (chunk: Buffer) => {
        if (headersSent) return void res.write(chunk);
        buf = Buffer.concat([buf, chunk]);
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.subarray(0, idx).toString();
        let status = 200;
        const headers: Record<string, string> = {};
        for (const line of head.split('\r\n')) {
          const [k, ...v] = line.split(':');
          if (k.toLowerCase() === 'status') status = parseInt(v.join(':'), 10);
          else headers[k] = v.join(':').trim();
        }
        res.writeHead(status, headers);
        headersSent = true;
        res.write(buf.subarray(idx + 4));
      });
      child.stderr.on('data', () => undefined);
      child.on('close', () => {
        if (!headersSent) res.writeHead(500);
        res.end();
        resolve();
      });
    });
  }
}

async function exists(p: string) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}
