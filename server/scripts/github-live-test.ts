/**
 * LIVE end-to-end test against real GitHub (no stand-ins):
 *   token → repo/branch → QA run on QuickBite → AI fix → diff → your approval → ai-fix branch →
 *   lint/tests → commit → push → pull request.
 *
 * Prerequisites
 *   1. MongoDB running (MONGODB_URI, default mongodb://127.0.0.1:27017/ai_qa_saas_live)
 *   2. A throwaway GitHub repo that contains the QuickBite folder at its root, e.g.:
 *        cd quickbite && git init -b main && git add -A && git commit -m "QuickBite"
 *        git remote add origin https://github.com/<you>/quickbite-ai-qa-test.git && git push -u origin main
 *   3. A fine-grained token for that repo with Contents: read/write and Pull requests: read/write
 *
 * Run (from server/):
 *   GITHUB_TOKEN=github_pat_... GITHUB_TEST_REPO=<you>/quickbite-ai-qa-test npm run test:github-live
 *   add --yes to approve diffs without prompting.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const repoFull = process.env.GITHUB_TEST_REPO || '';
const autoYes = process.argv.includes('--yes');
if (!token || !/^[\w.-]+\/[\w.-]+$/.test(repoFull)) {
  console.error('Set GITHUB_TOKEN and GITHUB_TEST_REPO=owner/repo (see the header of this file).');
  process.exit(2);
}
const [owner, repo] = repoFull.split('/');
const QB_PORT = 4400 + Math.floor(Math.random() * 100);
const QB_URL = `http://127.0.0.1:${QB_PORT}/`;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiqa-live-'));

process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/ai_qa_saas_live';
process.env.ALLOW_PRIVATE_TARGETS = 'true';
process.env.STORAGE_DIR = path.join(tmp, 'storage');
process.env.AUTOFIX_WORK_DIR = path.join(tmp, 'work');
const GITHUB_TOKEN_VALUE = token;
delete process.env.GITHUB_TOKEN; // the platform must only use the token stored through its own API
delete process.env.GH_TOKEN;

const step = (m: string) => console.log(`\n\x1b[36m▶ ${m}\x1b[0m`);
const info = (m: string) => console.log(`  ${m}`);

const qb = spawn(process.execPath, ['server.js'], { cwd: path.resolve(here, '../../quickbite'), env: { ...process.env, PORT: String(QB_PORT), QUICKBITE_FIXED: '0' }, stdio: 'ignore' });
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGODB_URI);
const { createApp } = await import('../src/app.js');
const server = createApp().listen(0);
await new Promise((r) => server.once('listening', r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
let cookie = '';

async function call(method: string, p: string, body?: unknown) {
  const res = await fetch(base + p, { method, headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status}: ${json.error || JSON.stringify(json)}`);
  const sc = res.headers.getSetCookie().find((c) => c.startsWith('qa_session='));
  if (sc) cookie = sc.split(';')[0];
  return json;
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFix(id: string, statuses: string[]) {
  let seen = 0;
  for (;;) {
    const { fix } = await call('GET', `/api/autofixes/${id}`);
    for (const e of fix.events.slice(seen)) info(`[${e.step}] ${e.message}`);
    seen = fix.events.length;
    if (statuses.includes(fix.status)) return fix;
    if (['failed', 'canceled', 'rejected'].includes(fix.status)) throw new Error(`Fix ${fix.status}: ${fix.error}`);
    await sleep(1500);
  }
}

let exitCode = 0;
try {
  for (let i = 0; i < 40 && !(await fetch(`${QB_URL}__demo/mode`).then((r) => r.ok).catch(() => false)); i++) await sleep(250);

  step('Sign up and connect GitHub (token stored encrypted server-side)');
  await call('POST', '/api/auth/register', { name: 'Live Test', email: `live.${Date.now()}@example.com`, password: 'live-test-password' });
  await call('POST', '/api/billing/plan', { plan: 'pro' });
  const conn = await call('POST', '/api/github/token', { token: GITHUB_TOKEN_VALUE });
  info(`Connected as @${conn.connection.login}`);

  step(`Select repository ${repoFull} and branch`);
  const { repos } = await call('GET', `/api/github/repos?q=${encodeURIComponent(repo)}`);
  const r = repos.find((x: { fullName: string }) => x.fullName.toLowerCase() === repoFull.toLowerCase());
  if (!r) throw new Error(`${repoFull} is not visible to this token`);
  if (!r.canPush) throw new Error('The token has no push access to the repository');
  const { branches, defaultBranch } = await call('GET', `/api/github/repos/${owner}/${repo}/branches`);
  info(`Branches: ${branches.map((b: { name: string }) => b.name).join(', ')} (default ${defaultBranch})`);
  const baseBranch = process.env.GITHUB_TEST_BRANCH || defaultBranch;

  const { project } = await call('POST', '/api/projects', { name: 'QuickBite (live GitHub test)', appUrl: QB_URL, settings: { apiSpecUrl: '/openapi.json', viewports: ['desktop'] } });
  await call('PUT', `/api/github/projects/${project.id}/repository`, { owner, repo, baseBranch });

  step('Detect bugs (QA run: functional + API agents, code analysis on GitHub)');
  const { run } = await call('POST', `/api/projects/${project.id}/runs`, { agents: { vision: false } });
  let runData;
  for (;;) {
    runData = await call('GET', `/api/runs/${run.id}`);
    if (['completed', 'failed'].includes(runData.run.status)) break;
    await sleep(2000);
  }
  if (runData.run.status !== 'completed') throw new Error(`QA run failed: ${runData.run.error}`);
  for (const b of runData.bugs) info(`• [${b.severity}] ${b.title}`);
  const bug = runData.bugs.find((b: { title: string }) => /Login fails/.test(b.title)) || runData.bugs[0];

  step(`Generate a fix for: ${bug.title}`);
  let { fix } = await call('POST', '/api/autofixes', { bugId: bug._id });
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    fix = await waitFix(fix._id, ['awaiting_approval', 'pr_open']);
    if (fix.status === 'pr_open') break;
    const a = fix.attempts[fix.attempts.length - 1];
    console.log(`\n--- Attempt ${a.n} (${a.engine}) ---\n${a.explanation}\n\n${a.diff}`);
    const answer = autoYes ? 'y' : (await rl.question('Approve this exact diff and let the platform branch, validate, commit, push and open a PR? [y/N] ')).trim().toLowerCase();
    if (answer !== 'y') {
      await call('POST', `/api/autofixes/${fix._id}/reject`, { feedback: 'Rejected in live test' });
      throw new Error('Diff rejected — nothing was pushed');
    }
    await call('POST', `/api/autofixes/${fix._id}/approve`, { attempt: a.n, patchHash: a.patchHash, confirm: true });
  }
  rl.close();

  step('Pull request');
  const last = fix.attempts[fix.attempts.length - 1];
  info(`Branch: ${fix.branch} (commit ${fix.commitSha.slice(0, 10)})`);
  info(`Validation: ${last.validation?.summary}`);
  info(`PR: ${fix.pr.url}`);
  const refreshed = await call('POST', `/api/autofixes/${fix._id}/refresh`);
  info(`PR state: ${refreshed.fix.pr.state}, checks: ${refreshed.fix.pr.checks?.state}`);
  const dash = await call('GET', '/api/dashboard');
  info(`Dashboard: ${dash.github.counts.openPrs} open AI PR(s) for ${dash.github.repositories.map((x: { owner: string; repo: string; baseBranch: string }) => `${x.owner}/${x.repo}@${x.baseBranch}`).join(', ')}`);
  console.log('\n\x1b[32m✔ LIVE GITHUB FLOW PASSED\x1b[0m — review and close/merge the PR on GitHub.');
} catch (e) {
  console.error(`\n\x1b[31m✖ ${(e as Error).message}\x1b[0m`);
  exitCode = 1;
} finally {
  qb.kill();
  const { autofixIdle } = await import('../src/autofix/service.js');
  await autofixIdle();
  server.close();
  await mongoose.disconnect();
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(exitCode);
}
