/**
 * GitHub auto-fix acceptance test:
 *   GitHub login (OAuth) → select repository → select branch → QA run detects a bug → fix generated →
 *   exact diff shown → approval → ai-fix branch → patch applied → tests/lint → validation failure fed back →
 *   second attempt approved → commit → push → pull request → PR status on the dashboard → merge detected.
 *
 * The product code runs unmodified; GITHUB_WEB_URL / GITHUB_API_URL point at a local GitHub-compatible test
 * server (real git smart-HTTP over real bare repositories). For a run against github.com use
 * `npm run test:github-live` (see README).
 */
import assert from 'node:assert/strict';
import { execFile, spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { GitHubTestServer } from '../support/github-test-server.js';

const pexec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const QUICKBITE_DIR = path.resolve(here, '../../../quickbite');
const QB_PORT = 4300 + Math.floor(Math.random() * 50);
const QB_URL = `http://127.0.0.1:${QB_PORT}/`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiqa-gh-'));

const gh = await new GitHubTestServer().start(path.join(tmp, 'remotes'));
const dev = gh.addUser('priya-dev', 'Priya Developer');

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = process.env.MONGODB_URI_GITHUB_TEST || 'mongodb://127.0.0.1:27017/ai_qa_saas_github_acceptance';
process.env.ALLOW_PRIVATE_TARGETS = 'true';
process.env.AI_DISABLED = '1';
process.env.RUN_RATE_LIMIT = '100';
process.env.STORAGE_DIR = path.join(tmp, 'storage');
process.env.GITHUB_WEB_URL = gh.url;
process.env.GITHUB_API_URL = `${gh.url}/api/v3`;
process.env.GITHUB_CLIENT_ID = gh.clientId;
process.env.GITHUB_CLIENT_SECRET = gh.clientSecret;
process.env.AUTOFIX_WORK_DIR = path.join(tmp, 'work');
process.env.APP_URL = 'http://localhost:5173';

let qb: ChildProcess;
let base = '';
let server: import('node:http').Server;
let mongoose: typeof import('mongoose').default;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
let cookie = '';

async function call(method: string, p: string, body?: unknown): Promise<{ status: number; json: Json; headers: Headers }> {
  const res = await fetch(`${base}${p}`, {
    method,
    redirect: 'manual',
    headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json().catch(() => ({}))) as Json, headers: res.headers };
}

async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, what: string, timeoutMs = 240_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const fixStatus = (id: string, statuses: string[]) =>
  waitFor(async () => {
    const r = await call('GET', `/api/autofixes/${id}`);
    if (['failed', 'canceled'].includes(r.json.fix.status) && !statuses.includes(r.json.fix.status)) {
      throw new Error(`Fix ${r.json.fix.status}: ${r.json.fix.error}\n${r.json.fix.events.map((e: Json) => `${e.step}: ${e.message}`).join('\n')}`);
    }
    return statuses.includes(r.json.fix.status) ? r.json.fix : null;
  }, `fix status ${statuses.join('/')}`);

before(async () => {
  await gh.createRepo('acme', 'quickbite', QUICKBITE_DIR, 'main');
  qb = spawn(process.execPath, ['server.js'], { cwd: QUICKBITE_DIR, env: { ...process.env, PORT: String(QB_PORT), QUICKBITE_FIXED: '0' }, stdio: 'ignore' });
  await waitFor(() => fetch(`${QB_URL}__demo/mode`).then((r) => r.ok).catch(() => false), 'QuickBite', 20_000);
  mongoose = (await import('mongoose')).default;
  await mongoose.connect(process.env.MONGODB_URI!);
  await mongoose.connection.db!.dropDatabase();
  const { createApp } = await import('../../src/app.js');
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch(() => undefined)));
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  qb?.kill();
  const { autofixIdle } = await import('../../src/autofix/service.js');
  const { queueIdle } = await import('../../src/qa/queue.js');
  await Promise.all([autofixIdle(), queueIdle()]);
  server?.close();
  await gh.stop();
  await mongoose?.disconnect();
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('GitHub → AI fix → validation → PR', () => {
  let projectId = '';
  let bugId = '';
  let fixId = '';

  test('1. Login with GitHub (OAuth web flow) creates an account and stores the token encrypted', async () => {
    const start = await call('GET', '/api/github/oauth/start?mode=login');
    assert.equal(start.status, 302);
    const authorize = new URL(start.headers.get('location')!);
    assert.equal(authorize.origin, gh.url);
    assert.equal(authorize.searchParams.get('client_id'), gh.clientId);
    assert.match(authorize.searchParams.get('scope')!, /repo/);
    const oauthCookie = start.headers.get('set-cookie')!.split(';')[0];

    // GitHub redirects back with a code
    const ghRes = await fetch(authorize, { redirect: 'manual' });
    const callback = new URL(ghRes.headers.get('location')!);
    assert.equal(callback.pathname, '/api/github/oauth/callback');

    // State mismatch is rejected
    cookie = oauthCookie;
    const bad = await call('GET', `/api/github/oauth/callback?code=x&state=wrong`);
    assert.equal(bad.status, 302);
    assert.match(bad.headers.get('location')!, /githubError=/);

    // Replay with a fresh flow
    const start2 = await call('GET', '/api/github/oauth/start?mode=login');
    cookie = start2.headers.get('set-cookie')!.split(';')[0];
    const ghRes2 = await fetch(new URL(start2.headers.get('location')!), { redirect: 'manual' });
    const cb = new URL(ghRes2.headers.get('location')!);
    const done = await call('GET', `${cb.pathname}${cb.search}`);
    assert.equal(done.status, 302);
    assert.match(done.headers.get('location')!, /^\/projects\/new\?github=connected/);
    const session = done.headers.getSetCookie().find((c) => c.startsWith('qa_session='));
    assert.ok(session, 'SaaS session issued');
    cookie = session!.split(';')[0];

    const me = await call('GET', '/api/auth/me');
    assert.equal(me.json.user.email, dev.email);
    const status = await call('GET', '/api/github/status');
    assert.equal(status.json.connection.connected, true);
    assert.equal(status.json.connection.login, 'priya-dev');
    assert.ok(!JSON.stringify(status.json).includes(dev.token), 'token never returned to the browser');
    const stored = await mongoose.connection.db!.collection('githubConnections').findOne({});
    assert.ok(stored && !JSON.stringify(stored).includes(dev.token), 'token is encrypted at rest');
  });

  test('2. Select repository and branch, link to a project', async () => {
    const up = await call('POST', '/api/billing/plan', { plan: 'pro' });
    assert.equal(up.status, 200);
    const repos = await call('GET', '/api/github/repos');
    assert.equal(repos.status, 200);
    const repo = repos.json.repos.find((r: Json) => r.fullName === 'acme/quickbite');
    assert.ok(repo?.canPush);
    const branches = await call('GET', '/api/github/repos/acme/quickbite/branches');
    assert.deepEqual(branches.json.branches.map((b: Json) => b.name), ['main']);
    assert.equal(branches.json.defaultBranch, 'main');

    const p = await call('POST', '/api/projects', { name: 'QuickBite', appUrl: QB_URL, settings: { apiSpecUrl: '/openapi.json', viewports: ['desktop'] } });
    assert.equal(p.status, 201, JSON.stringify(p.json));
    projectId = p.json.project.id;
    const link = await call('PUT', `/api/github/projects/${projectId}/repository`, { owner: 'acme', repo: 'quickbite', baseBranch: 'main' });
    assert.equal(link.status, 200, JSON.stringify(link.json));
    assert.deepEqual(
      { owner: link.json.project.settings.github.owner, repo: link.json.project.settings.github.repo, base: link.json.project.settings.github.baseBranch },
      { owner: 'acme', repo: 'quickbite', base: 'main' },
    );
    const info = await call('GET', `/api/github/projects/${projectId}/repository`);
    assert.equal(info.json.live.canPush, true);
    assert.equal(info.json.live.protected, true);
  });

  test('3. QA run detects bugs and Code Analysis reads the linked GitHub branch', async () => {
    const start = await call('POST', `/api/projects/${projectId}/runs`, { agents: { vision: false } });
    assert.equal(start.status, 202, JSON.stringify(start.json));
    const run = await waitFor(async () => {
      const r = await call('GET', `/api/runs/${start.json.run.id}`);
      return ['completed', 'failed'].includes(r.json.run.status) ? r.json : null;
    }, 'QA run');
    assert.equal(run.run.status, 'completed', run.run.error);
    const code = run.agentRuns.find((a: Json) => a.agentType === 'code_analysis');
    assert.equal(code.status, 'completed', JSON.stringify(code));
    assert.equal(code.output.repository, 'github:acme/quickbite@main');
    const login = run.bugs.find((b: Json) => /Login fails/.test(b.title));
    assert.ok(login, run.bugs.map((b: Json) => b.title).join('\n'));
    assert.ok(login.rootCause.fileReferences.some((f: Json) => f.path === 'src/routes/auth.js'));
    bugId = login._id;
  });

  test('4. AI fix is generated and the exact diff is shown before anything is applied', async () => {
    const noRepoBug = await call('POST', '/api/autofixes', { bugId: '000000000000000000000000' });
    assert.equal(noRepoBug.status, 404);
    const r = await call('POST', '/api/autofixes', { bugId });
    assert.equal(r.status, 202, JSON.stringify(r.json));
    fixId = r.json.fix._id;
    const dup = await call('POST', '/api/autofixes', { bugId });
    assert.equal(dup.status, 409, 'one active fix per bug');

    const fix = await fixStatus(fixId, ['awaiting_approval']);
    const a1 = fix.attempts[0];
    assert.equal(a1.n, 1);
    assert.equal(a1.engine, 'rules');
    assert.deepEqual(a1.files.map((f: Json) => f.path).sort(), ['public/js/login.js', 'src/routes/auth.js']);
    assert.match(a1.diff, /^diff --git a\/public\/js\/login\.js/m);
    assert.match(a1.diff, /^\+\s+if \(!user\) return res\.status\(401\)/m);
    assert.equal(a1.patchHash.length, 64);
    const auth = a1.files.find((f: Json) => f.path === 'src/routes/auth.js');
    assert.ok(auth.before.includes('if (user.password !== password)') && auth.after.includes('if (!user) return res.status(401)'));

    // Nothing has been pushed yet
    assert.deepEqual((await gh.branches('acme', 'quickbite')).map((b) => b.name), ['main']);
  });

  test('5. Approval requires the exact reviewed diff and explicit confirmation', async () => {
    const fix = (await call('GET', `/api/autofixes/${fixId}`)).json.fix;
    const a1 = fix.attempts[0];
    assert.equal((await call('POST', `/api/autofixes/${fixId}/approve`, { attempt: 1, patchHash: a1.patchHash })).status, 400, 'confirm flag required');
    assert.equal((await call('POST', `/api/autofixes/${fixId}/approve`, { attempt: 1, patchHash: 'a'.repeat(64), confirm: true })).status, 409, 'stale diff rejected');
    const ok = await call('POST', `/api/autofixes/${fixId}/approve`, { attempt: 1, patchHash: a1.patchHash, confirm: true });
    assert.equal(ok.status, 200, JSON.stringify(ok.json));
  });

  test('6. Validation fails (lint) → error is fed back → a new attempt awaits approval; nothing pushed', async () => {
    const fix = await fixStatus(fixId, ['awaiting_approval']);
    assert.equal(fix.attempts.length, 2, JSON.stringify(fix.events.slice(-8)));
    const a1 = fix.attempts[0];
    assert.equal(a1.status, 'validation_failed');
    const lint = a1.validation.checks.find((c: Json) => c.kind === 'lint');
    assert.equal(lint.status, 'failed');
    assert.match(lint.output, /copy guideline QB-12/);
    const tests = a1.validation.checks.find((c: Json) => c.kind === 'test');
    assert.equal(tests.status, 'passed', 'the login test passes with the fix');
    assert.match(a1.feedback, /Validation failed/);
    assert.equal(fix.baseline.checks.find((c: Json) => c.kind === 'test').failures, 1, 'baseline had 1 failing test');

    const a2 = fix.attempts[1];
    assert.equal(a2.status, 'proposed');
    assert.deepEqual(a2.files.map((f: Json) => f.path), ['src/routes/auth.js'], 'narrowed to the root cause');
    assert.deepEqual((await gh.branches('acme', 'quickbite')).map((b) => b.name), ['main'], 'still nothing pushed');
    assert.equal((await call('POST', `/api/autofixes/${fixId}/approve`, { attempt: 1, patchHash: a1.patchHash, confirm: true })).status, 409, 'old attempt cannot be approved');
  });

  test('7. Second attempt approved → validated → committed → pushed to ai-fix branch → PR created', async () => {
    const before = (await gh.branches('acme', 'quickbite')).find((b) => b.name === 'main')!.sha;
    const fix0 = (await call('GET', `/api/autofixes/${fixId}`)).json.fix;
    const a2 = fix0.attempts[1];
    const ok = await call('POST', `/api/autofixes/${fixId}/approve`, { attempt: 2, patchHash: a2.patchHash, confirm: true });
    assert.equal(ok.status, 200);
    const fix = await fixStatus(fixId, ['pr_open']);

    const v = fix.attempts[1].validation;
    assert.equal(v.verdict.ok, true);
    assert.deepEqual(
      v.checks.filter((c: Json) => c.kind !== 'syntax').map((c: Json) => [c.kind, c.status]),
      [
        ['install', 'skipped'],
        ['lint', 'passed'],
        ['test', 'passed'],
      ],
    );

    // Branch & commit on the remote
    const branches = await gh.branches('acme', 'quickbite');
    const main = branches.find((b) => b.name === 'main')!;
    assert.equal(main.sha, before, 'main/master is never pushed to');
    assert.match(fix.branch, /^ai-fix\/login-fails-with-http-500/);
    const aiBranch = branches.find((b) => b.name === fix.branch)!;
    assert.equal(aiBranch.sha, fix.commitSha);
    const changed = (await gh.git('acme', 'quickbite', ['diff', '--name-only', `main..${fix.branch}`])).trim();
    assert.equal(changed, 'src/routes/auth.js', 'only the approved file is committed');
    const remoteDiff = await gh.git('acme', 'quickbite', ['diff', '--no-color', '--unified=3', `main..${fix.branch}`]);
    assert.equal(remoteDiff, a2.diff, 'pushed change is byte-for-byte the approved diff');
    const author = (await gh.git('acme', 'quickbite', ['log', '-1', '--format=%an <%ae>|%s', fix.branch])).trim();
    const [who, subject] = author.split('|');
    assert.equal(who, `Priya Developer <${dev.id}+priya-dev@users.noreply.github.com>`, 'commit authored by the approving developer');
    assert.match(subject, /^fix: Login fails with HTTP 500/);
    assert.ok(gh.requests.filter((r) => r.path.includes('.git/')).every((r) => r.auth.toLowerCase() === 'basic'), 'git traffic authenticated with the user token');

    // Pull request
    assert.equal(fix.pr.number, 1);
    const pr = gh.pulls[0];
    assert.equal(pr.base, 'main');
    assert.equal(pr.head, fix.branch);
    assert.match(pr.body, /Validation/);
    assert.match(pr.body, /Tests \(test\).*passed/);
    assert.deepEqual(pr.labels, ['ai-fix', 'bug']);

    // Bug history and notifications
    const bug = (await call('GET', `/api/bugs/${bugId}`)).json.bug;
    assert.equal(bug.rootCause.autofix.prNumber, 1);
    assert.ok(bug.history.some((h: Json) => /PR #1 opened/.test(h.message)));
    const notes = await call('GET', '/api/notifications');
    assert.ok(notes.json.notifications.some((n: Json) => n.type === 'autofix_pr'));

    // No token in anything the browser can read
    const raw = JSON.stringify((await call('GET', `/api/autofixes/${fixId}`)).json);
    assert.ok(!raw.includes(dev.token));
    // Work directory cleaned up
    assert.equal(await fs.stat(path.join(tmp, 'work', fixId)).then(() => true).catch(() => false), false);
  });

  test('8. Dashboard shows repo/branch/PR status and picks up the merge', async () => {
    const dash = await call('GET', '/api/dashboard');
    assert.equal(dash.json.github.connection.login, 'priya-dev');
    assert.deepEqual(dash.json.github.repositories.map((r: Json) => `${r.owner}/${r.repo}@${r.baseBranch}`), ['acme/quickbite@main']);
    assert.equal(dash.json.github.counts.openPrs, 1);
    assert.equal(dash.json.github.fixes[0].pr.number, 1);

    await gh.merge(1);
    const refreshed = await call('POST', `/api/autofixes/${fixId}/refresh`);
    assert.equal(refreshed.json.fix.status, 'merged');
    assert.equal(refreshed.json.fix.pr.checks.state, 'success');
    const list = await call('GET', `/api/autofixes?projectId=${projectId}`);
    assert.equal(list.json.fixes[0].status, 'merged');
  });

  test('9. Guard rails: reject flow pushes nothing; disconnecting GitHub blocks new fixes', async () => {
    // A second bug: reject its fix without pushing
    const bugs = await call('GET', `/api/projects/${projectId}/bugs?status=open`);
    const cart = bugs.json.bugs.find((b: Json) => /Cart total/.test(b.title));
    const r = await call('POST', '/api/autofixes', { bugId: cart._id });
    assert.equal(r.status, 202);
    const fix = await fixStatus(r.json.fix._id, ['awaiting_approval']);
    assert.match(fix.attempts[0].diff, /\+.*line\.price \* line\.quantity/);
    const rej = await call('POST', `/api/autofixes/${fix._id}/reject`, { feedback: 'Prefer a helper function' });
    assert.equal(rej.json.fix.status, 'rejected');
    assert.equal((await gh.branches('acme', 'quickbite')).filter((b) => b.name.includes('cart')).length, 0);

    const disc = await call('DELETE', '/api/github/connection');
    assert.equal(disc.status, 200);
    const again = await call('POST', '/api/autofixes', { bugId: cart._id });
    assert.equal(again.status, 409);
    assert.match(again.json.error, /Connect your GitHub account/);
  });
});
