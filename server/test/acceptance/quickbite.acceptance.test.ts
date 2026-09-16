/**
 * Acceptance test — mirrors the spec's end-to-end demo (§17) and SaaS requirements (§19, §22):
 *
 *  Developer signs up → creates a QuickBite project → clicks "Start AI QA" →
 *  Test Planner finds login/menu/cart/checkout workflows → Functional agent finds the cart total bug →
 *  API agent finds invalid checkout data returning 500 → Vision agent finds the clipped checkout button
 *  on 375×812 → Bug Analyzer consolidates → Code agent points at files → Regression agent creates tests →
 *  run is stored → developer fixes the app and reruns → bugs are verified fixed → regression reopens bugs.
 *
 * Requires MongoDB (MONGODB_URI) and Chromium. QuickBite is started on a free port by the test.
 */
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const QUICKBITE_DIR = path.resolve(here, '../../../quickbite');
const QB_PORT = 4190 + Math.floor(Math.random() * 50);
const QB_URL = `http://127.0.0.1:${QB_PORT}/`;

process.env.NODE_ENV = 'test';
process.env.MONGODB_URI ??= 'mongodb://127.0.0.1:27017/ai_qa_saas_acceptance';
process.env.ALLOW_PRIVATE_TARGETS = 'true';
process.env.ALLOW_LOCAL_REPOS = 'true';
process.env.AI_DISABLED = '1';
process.env.RUN_RATE_LIMIT = '100';
process.env.INTERNAL_API_TOKEN = 'acceptance-internal-token';
process.env.STORAGE_DIR = path.resolve(here, '../../storage-test');

let qb: ChildProcess;
let base = '';
let server: import('node:http').Server;
let mongoose: typeof import('mongoose').default;

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

function client() {
  let token = '';
  const call = async (method: string, p: string, body?: unknown): Promise<{ status: number; json: Json }> => {
    const res = await fetch(`${base}/api${p}`, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json().catch(() => ({}))) as Json };
  };
  return {
    call,
    async signup(name: string) {
      const r = await call('POST', '/auth/register', { name, email: `${name.toLowerCase()}.${Date.now()}@example.com`, password: 'password-123' });
      assert.equal(r.status, 201, JSON.stringify(r.json));
      token = r.json.token;
      return r.json;
    },
    async waitForRun(runId: string, timeoutMs = 240_000) {
      const end = Date.now() + timeoutMs;
      while (Date.now() < end) {
        const r = await call('GET', `/runs/${runId}`);
        if (['completed', 'failed', 'canceled'].includes(r.json.run?.status)) return r.json;
        await new Promise((res) => setTimeout(res, 1500));
      }
      throw new Error('run timed out');
    },
  };
}

async function setQuickBiteFixed(fixed: boolean) {
  const r = await fetch(`${QB_URL}__demo/mode`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ fixed }) });
  assert.equal(r.status, 200);
}

before(async () => {
  qb = spawn(process.execPath, ['server.js'], { cwd: QUICKBITE_DIR, env: { ...process.env, PORT: String(QB_PORT), QUICKBITE_FIXED: '0' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    const ok = await fetch(`${QB_URL}__demo/mode`).then((r) => r.ok).catch(() => false);
    if (ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
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
  server?.close();
  const { queueIdle } = await import('../../src/qa/queue.js');
  await queueIdle();
  await mongoose?.disconnect();
});

describe('AI QA SaaS — QuickBite end-to-end demo', () => {
  const dev = client();
  let projectId = '';
  let firstRun: Json;

  test('developer signs up and gets a Free workspace', async () => {
    const reg = await dev.signup('Dev');
    assert.ok(reg.user.id);
    const me = await dev.call('GET', '/auth/me');
    assert.equal(me.json.workspaces[0].plan, 'free');
    assert.equal(me.json.workspaces[0].role, 'owner');
  });

  test('Free plan limits: repository analysis & tablet are gated, one project only', async () => {
    const tablet = await dev.call('POST', '/projects', { name: 'X', appUrl: QB_URL, settings: { viewports: ['tablet'] } });
    assert.equal(tablet.status, 402);
    const up = await dev.call('POST', '/billing/plan', { plan: 'pro' });
    assert.equal(up.status, 200, JSON.stringify(up.json));
    assert.match(up.json.message, /test mode/);
  });

  test('creates a QuickBite project; secrets are write-only', async () => {
    const r = await dev.call('POST', '/projects', {
      name: 'QuickBite',
      appUrl: QB_URL,
      repoUrl: QUICKBITE_DIR,
      settings: { apiSpecUrl: '/openapi.json', viewports: ['desktop', 'tablet', 'mobile'], githubToken: 'ghp_supersecrettoken1234567890abcd', testUsername: 'demo@quickbite.test', testPassword: 'quickbite123' },
    });
    assert.equal(r.status, 201, JSON.stringify(r.json));
    projectId = r.json.project.id;
    const raw = JSON.stringify(r.json);
    assert.ok(!raw.includes('ghp_supersecret'), 'GitHub token must never be returned');
    assert.ok(!raw.includes('quickbite123'), 'test password must never be returned');
    assert.equal(r.json.project.settings.hasGithubToken, true);
    assert.equal(r.json.project.settings.hasTestPassword, true);
  });

  test('Start AI QA → the 7 agents run and find the intentional bugs', async () => {
    const start = await dev.call('POST', `/projects/${projectId}/runs`, {});
    assert.equal(start.status, 202, JSON.stringify(start.json));
    const dup = await dev.call('POST', `/projects/${projectId}/runs`, {});
    assert.equal(dup.status, 409, 'only one active run per project');
    firstRun = await dev.waitForRun(start.json.run.id);
    assert.equal(firstRun.run.status, 'completed', firstRun.run.error);

    // Multi-agent: every agent has its own record with structured output.
    const agents = Object.fromEntries(firstRun.agentRuns.map((a: Json) => [a.agentType, a]));
    for (const t of ['test_planner', 'functional_qa', 'api_qa', 'vision_qa', 'bug_analyzer', 'code_analysis', 'regression_test']) {
      assert.equal(agents[t]?.status, 'completed', `${t} should complete (${agents[t]?.status} ${agents[t]?.error || ''})`);
      assert.ok(agents[t].output && Object.keys(agents[t].output).length, `${t} has structured output`);
    }

    // Test Planner identifies login, menu, cart and checkout workflows.
    for (const w of ['Login', 'Menu', 'Cart', 'Checkout']) assert.ok(agents.test_planner.output.workflows.includes(w), `planner found ${w}`);
    assert.equal(firstRun.run.plan.spec.loaded, true);

    const titles = firstRun.bugs.map((b: Json) => b.title).join('\n');
    const find = (re: RegExp) => firstRun.bugs.find((b: Json) => re.test(b.title));

    // Functional agent: cart total incorrect after quantity change.
    const cart = find(/Cart total is incorrect/);
    assert.ok(cart, `cart bug missing:\n${titles}`);
    assert.equal(cart.category, 'functional');
    assert.ok(agents.functional_qa.output.results.some((r: Json) => r.status === 'failed' && /quantity/i.test(r.test)));

    // API agent: invalid checkout data → unexpected 500.
    const api = find(/POST \/api\/orders returns 500/);
    assert.ok(api, `checkout API bug missing:\n${titles}`);
    assert.equal(api.category, 'api');
    assert.equal(api.severity, 'critical');

    // Vision agent: checkout button clipped at 375×812 (computer vision, pixel-confirmed).
    const visual = find(/Checkout UI clipped on .*mobile/);
    assert.ok(visual, `visual bug missing:\n${titles}`);
    assert.equal(visual.category, 'visual');
    const mobileShot = firstRun.screenshots.find((s: Json) => s.pagePath === '/checkout' && s.viewport.name === 'mobile');
    assert.ok(mobileShot.annotatedRef, 'annotated evidence image stored');
    const ann = mobileShot.annotations.find((a: Json) => a.type === 'clipped_element');
    assert.equal(ann.confidence, 'high', 'pixel-edge analysis confirms the clipping');
    assert.ok(agents.vision_qa.output.results.some((r: Json) => r.viewport === '375x812' && r.type === 'clipped_element'));
    const desktopShot = firstRun.screenshots.find((s: Json) => s.pagePath === '/checkout' && s.viewport.name === 'desktop');
    assert.equal(desktopShot.annotations.length, 0, 'checkout renders correctly on desktop');

    // Other intentional defects.
    assert.ok(find(/Login fails with HTTP 500/), 'login bug');
    assert.ok(find(/Broken image on \/menu/), 'broken image bug');
    assert.ok(find(/Order confirmation fails/), 'confirmation edge-case bug');

    // Bug Analyzer consolidates many raw failures into a handful of developer-facing bugs.
    const cons = agents.bug_analyzer.output.consolidation;
    assert.ok(cons.rawFailures > cons.bugs, `consolidated ${cons.rawFailures} failures into ${cons.bugs} bugs`);
    assert.equal(firstRun.bugs.length, 6);

    // Code agent points at the likely files.
    const expectRef = (bug: Json, file: string) =>
      assert.ok(bug.rootCause.fileReferences.some((f: Json) => f.path === file), `${bug.title} → ${file}; got ${bug.rootCause.fileReferences.map((f: Json) => f.path)}`);
    expectRef(cart, 'public/js/cart.js');
    expectRef(api, 'src/routes/orders.js');
    expectRef(visual, 'public/css/styles.css');
    assert.match(visual.rootCause.likelyCause, /min-width: 420px/);
    assert.match(cart.rootCause.likelyCause, /quantity/);

    // Regression agent: one reproducing test per bug.
    assert.equal(firstRun.regressionTests.length, 6);
    assert.ok(firstRun.regressionTests.every((t: Json) => t.status === 'failing'), 'generated tests reproduce the bugs');

    // Dashboard stores the run with severity, category and evidence.
    const s = firstRun.run.summary;
    assert.ok(s.testsExecuted >= 40 && s.failed > 0 && s.passed > 0);
    assert.deepEqual(s.issues, { functional: 3, api: 1, visual: 2 });
    const dash = await dev.call('GET', '/dashboard');
    assert.equal(dash.json.metrics.openBugs, 6);
    assert.equal(dash.json.metrics.severity.critical, 1);
    assert.equal(dash.json.lastRun._id, firstRun.run._id);
  });

  test('bug detail exposes evidence, likely cause, patch and a Playwright regression spec', async () => {
    const visual = firstRun.bugs.find((b: Json) => /clipped/.test(b.title));
    const d = await dev.call('GET', `/bugs/${visual._id}`);
    assert.equal(d.status, 200);
    assert.ok(d.json.screenshots.length >= 1);
    assert.match(d.json.bug.rootCause.suggestedPatch, /-.*min-width: 420px[\s\S]*\+.*width: 100%/);
    assert.match(d.json.regressionTests[0].code, /@playwright\/test/);
    assert.ok(d.json.bug.evidence.agentOutputs.some((o: Json) => o.agent === 'vision_qa' && o.viewport === '375x812'));
    const img = await fetch(`${base}/api/screenshots/${d.json.screenshots[0]._id}/image?variant=annotated`);
    assert.equal(img.status, 401, 'screenshots require authentication');
  });

  test('stored secrets never leak into runs, plans or logs', async () => {
    const raw = JSON.stringify(firstRun);
    assert.ok(!raw.includes('quickbite123'), 'test password not in run payload');
    assert.ok(!raw.includes('ghp_supersecret'), 'token not in run payload');
  });

  test('developer triages a bug (status + severity history)', async () => {
    const broken = firstRun.bugs.find((b: Json) => /Broken image/.test(b.title));
    const r = await dev.call('PATCH', `/bugs/${broken._id}`, { severity: 'medium', note: 'Customers notice this' });
    assert.equal(r.status, 200);
    assert.equal(r.json.bug.severity, 'medium');
  });

  test('developer fixes QuickBite and reruns → regression tests verify every fix', async () => {
    await setQuickBiteFixed(true);
    const start = await dev.call('POST', `/projects/${projectId}/runs`, { trigger: 'rerun' });
    const run = await dev.waitForRun(start.json.run.id);
    assert.equal(run.run.status, 'completed');
    assert.equal(run.run.summary.fixedBugs, 6);
    assert.equal(run.run.summary.failed, 0);
    assert.equal(run.run.summary.qaScore, 100);
    const bugs = await dev.call('GET', `/projects/${projectId}/bugs`);
    assert.ok(bugs.json.bugs.every((b: Json) => b.status === 'fixed'));
    const tests = await dev.call('GET', `/projects/${projectId}/regression-tests`);
    assert.ok(tests.json.regressionTests.every((t: Json) => t.status === 'passing'));
    const dash = await dev.call('GET', '/dashboard');
    assert.equal(dash.json.metrics.openBugs, 0);
    assert.equal(dash.json.trend.direction, 'improving');
  });

  test('a regression reopens the bug instead of duplicating it', async () => {
    await setQuickBiteFixed(false);
    const start = await dev.call('POST', `/projects/${projectId}/runs`, { trigger: 'rerun', agents: { vision: false, api: false } });
    const run = await dev.waitForRun(start.json.run.id);
    assert.equal(run.run.status, 'completed');
    assert.ok(run.run.summary.reopenedBugs >= 3, `reopened ${run.run.summary.reopenedBugs}`);
    assert.equal(run.run.summary.newBugs, 0, 'no duplicates');
    const cart = run.bugs.find((b: Json) => /Cart total/.test(b.title));
    assert.equal(cart.runRelation, 'reopened');
    const all = await dev.call('GET', `/projects/${projectId}/bugs`);
    assert.equal(all.json.bugs.length, 6, 'still six distinct bugs');
    const notes = await dev.call('GET', '/notifications');
    assert.ok(notes.json.notifications.some((n: Json) => n.type === 'critical_bugs'), 'critical-bug notification sent');
    assert.ok(notes.json.notifications.some((n: Json) => n.type === 'bugs_fixed'));
  });
});

describe('SaaS isolation & security', () => {
  test('another tenant cannot read or modify the first tenant’s data', async () => {
    const owner = client();
    await owner.signup('Owner');
    const p = await owner.call('POST', '/projects', { name: 'Private', appUrl: QB_URL });
    assert.equal(p.status, 201);
    const intruder = client();
    await intruder.signup('Intruder');
    const id = p.json.project.id;
    assert.equal((await intruder.call('GET', `/projects/${id}`)).status, 404);
    assert.equal((await intruder.call('POST', `/projects/${id}/runs`, {})).status, 404);
    assert.equal((await intruder.call('PATCH', `/projects/${id}`, { name: 'pwned' })).status, 404);
    const list = await intruder.call('GET', '/projects');
    assert.equal(list.json.projects.length, 0);
    const bugs = await intruder.call('GET', '/bugs');
    assert.equal(bugs.json.bugs.length, 0);
  });

  test('Free plan allows exactly one project and rejects unauthenticated access', async () => {
    const u = client();
    await u.signup('Solo');
    assert.equal((await u.call('POST', '/projects', { name: 'A', appUrl: QB_URL })).status, 201);
    const second = await u.call('POST', '/projects', { name: 'B', appUrl: QB_URL });
    assert.equal(second.status, 402);
    const anon = await fetch(`${base}/api/projects`);
    assert.equal(anon.status, 401);
  });

  test('input validation and internal endpoints', async () => {
    const u = client();
    await u.signup('Val');
    assert.equal((await u.call('POST', '/projects', { name: 'Bad', appUrl: 'ftp://example.com' })).status, 400);
    assert.equal((await u.call('POST', '/projects', { name: 'Bad', appUrl: 'http://u:p@example.com' })).status, 400);
    assert.equal((await u.call('POST', '/projects', { name: 'Bad', appUrl: QB_URL, repoUrl: 'https://gitlab.com/x/y' })).status, 400);
    const noToken = await fetch(`${base}/api/agents/queue`, { headers: { authorization: 'Bearer x' } });
    assert.equal(noToken.status, 401, 'internal orchestration endpoints require the server-side token');
    const withToken = await fetch(`${base}/api/agents/queue`, { headers: { 'x-internal-token': process.env.INTERNAL_API_TOKEN! } });
    assert.equal(withToken.status, 200);
    const wrongLogin = await u.call('POST', '/auth/login', { email: 'nobody@example.com', password: 'x' });
    assert.equal(wrongLogin.status, 401);
  });
});
