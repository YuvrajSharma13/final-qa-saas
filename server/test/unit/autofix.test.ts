/**
 * Auto-fix engine unit tests: patch safety rules, exact-diff guarantees, branch guard, validation judging,
 * and the AI engine loop (the Anthropic Messages endpoint is served locally so the prompt/feedback cycle can be
 * asserted without a real model).
 */
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const pexec = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const QUICKBITE_DIR = path.resolve(here, '../../../quickbite');

// Local Messages API endpoint for the model
const prompts: string[] = [];
const replies: string[] = [];
const modelServer = http.createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const body = JSON.parse(Buffer.concat(chunks).toString());
  const content = body.messages[0].content;
  prompts.push(Array.isArray(content) ? content.map((c: { text?: string }) => c.text || '').join('') : content);
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: body.model,
      content: [{ type: 'text', text: replies.shift() || '{}' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
});
await new Promise<void>((r) => modelServer.listen(0, '127.0.0.1', r));
process.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${(modelServer.address() as AddressInfo).port}`;
process.env.ANTHROPIC_API_KEY = 'test-key';
delete process.env.AI_DISABLED;

const { applyEdits, diffAndRevert, applyApprovedDiff, PatchError, safeRepoPath, sha256 } = await import('../../src/autofix/patch.js');
const { assertSafePushBranch, branchNameFor, cleanEnv, git } = await import('../../src/autofix/git.js');
const { judge, countFailures } = await import('../../src/autofix/validation.js');
const { generateFix, jsonTemplateToObject } = await import('../../src/autofix/generator.js');

let repo = '';
before(async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiqa-unit-'));
  repo = path.join(tmp, 'repo');
  await fs.cp(QUICKBITE_DIR, repo, { recursive: true, filter: (s) => !/node_modules/.test(s) });
  await git(['init', '-q', '-b', 'main'], { cwd: repo });
  await git(['add', '-A'], { cwd: repo });
  await git(['commit', '-q', '-m', 'init'], { cwd: repo });
});
after(async () => {
  modelServer.close();
  await fs.rm(path.dirname(repo), { recursive: true, force: true });
});

const loginBug = {
  title: 'Login fails with HTTP 500 for invalid credentials',
  category: 'functional',
  description: '',
  expected: 'A clear error message is shown',
  actual: 'POST /api/login → 500',
  reproSteps: ['Open /login'],
  location: { routes: ['POST /api/login'], pages: ['/login'], scenarioKinds: ['auth_invalid_login'] },
  rootCause: { likelyCause: 'missing null check' },
  evidence: {},
} as never;

describe('patch safety', () => {
  test('edits must target existing, allowed files and match exactly once', async () => {
    await assert.rejects(applyEdits(repo, [{ path: '../etc/passwd', find: 'x', replace: 'y' }]), PatchError);
    await assert.rejects(applyEdits(repo, [{ path: '.github/workflows/ci.yml', find: 'x', replace: 'y' }]), /not allowed/);
    await assert.rejects(applyEdits(repo, [{ path: 'package-lock.json', find: 'x', replace: 'y' }]), /not allowed/);
    await assert.rejects(applyEdits(repo, [{ path: 'src/new-file.js', find: 'x', replace: 'y' }]), /only edits existing files/);
    await assert.rejects(applyEdits(repo, [{ path: 'src/routes/orders.js', find: 'router', replace: 'r' }]), /ambiguous/);
    await assert.rejects(applyEdits(repo, [{ path: 'src/routes/orders.js', find: 'does-not-exist', replace: 'r' }]), /not found/);
    assert.throws(() => safeRepoPath(repo, '/abs/path'), PatchError);
    const status = (await git(['status', '--porcelain'], { cwd: repo })).stdout;
    assert.equal(status, '', 'failed edits leave the tree untouched');
  });

  test('diff is exact, the tree is restored, and only the approved diff can be applied', async () => {
    const touched = await applyEdits(repo, [{ path: 'public/js/cart.js', find: '  return cart.reduce((sum, line) => sum + line.price, 0);', replace: '  return cart.reduce((sum, line) => sum + line.price * line.quantity, 0);' }]);
    const d = await diffAndRevert(repo, touched);
    assert.match(d.diff, /^-  return cart\.reduce\(\(sum, line\) => sum \+ line\.price, 0\);$/m);
    assert.equal(d.files[0].additions, 1);
    assert.equal((await git(['status', '--porcelain'], { cwd: repo })).stdout, '');
    await assert.rejects(applyApprovedDiff(repo, d.diff, 'f'.repeat(64), ['public/js/cart.js']), /hash mismatch/);
    await assert.rejects(applyApprovedDiff(repo, d.diff, d.patchHash, ['public/js/other.js']), /differ from the approved files/);
    await git(['checkout', '--', '.'], { cwd: repo });
    const files = await applyApprovedDiff(repo, d.diff, d.patchHash, ['public/js/cart.js']);
    assert.deepEqual(files, ['public/js/cart.js']);
    assert.equal(sha256((await git(['diff', '--unified=3'], { cwd: repo })).stdout), d.patchHash);
    await git(['checkout', '--', '.'], { cwd: repo });
  });
});

describe('git & branch guards', () => {
  test('never pushes outside ai-fix/*', () => {
    assert.throws(() => assertSafePushBranch('main', 'main', 'main'), /only ai-fix/);
    assert.throws(() => assertSafePushBranch('master', 'develop', 'master'), /only ai-fix/);
    assert.throws(() => assertSafePushBranch('ai-fix/main', 'main', 'main'), /protected/);
    assert.throws(() => assertSafePushBranch('ai-fix/../main', 'main', 'main'), /Invalid/);
    assert.doesNotThrow(() => assertSafePushBranch('ai-fix/cart-total-abc123', 'main', 'main'));
    assert.match(branchNameFor('Cart total is incorrect after changing item quantity!', '66e9f0c1d2a3b4c5d6e7f809'), /^ai-fix\/cart-total-is-incorrect-after-changing-e7f809$/);
  });

  test('child processes never see platform secrets', () => {
    process.env.JWT_SECRET = 'jwt-secret-value';
    process.env.GITHUB_TOKEN = 'ghp_ambienttoken';
    const env = cleanEnv({ CI: 'true' });
    for (const k of ['JWT_SECRET', 'GITHUB_TOKEN', 'ANTHROPIC_API_KEY', 'MONGODB_URI', 'APP_ENCRYPTION_KEY']) assert.equal(env[k], undefined, k);
    assert.equal(env.CI, 'true');
  });
});

describe('validation verdicts', () => {
  const report = (checks: object[]) => ({ phase: 'patched' as const, checks: checks as never, passed: false, summary: '', startedAt: new Date(), durationMs: 0 });
  test('regressions fail; pre-existing failures that do not grow are tolerated', () => {
    const baseline = report([
      { name: 'Lint', kind: 'lint', status: 'passed' },
      { name: 'Tests', kind: 'test', status: 'failed', failures: 2 },
      { name: 'Build', kind: 'build', status: 'failed' },
    ]);
    assert.deepEqual(judge(baseline, report([{ name: 'Lint', kind: 'lint', status: 'passed' }, { name: 'Tests', kind: 'test', status: 'failed', failures: 1 }, { name: 'Build', kind: 'build', status: 'failed' }])).ok, true);
    assert.deepEqual(judge(baseline, report([{ name: 'Lint', kind: 'lint', status: 'failed' }])).problems, ['Lint']);
    assert.match(judge(baseline, report([{ name: 'Tests', kind: 'test', status: 'failed', failures: 3 }])).problems[0], /2 → 3/);
    assert.equal(judge(null, report([{ name: 'Syntax: a.js', kind: 'syntax', status: 'failed' }])).ok, false);
  });
  test('failure counters for common runners', () => {
    assert.equal(countFailures('# tests 4\n# pass 3\n# fail 1\n'), 1);
    assert.equal(countFailures('Tests:       2 failed, 10 passed, 12 total'), 2);
    assert.equal(countFailures('  3 passing\n  1 failing'), 1);
    assert.equal(countFailures('==== 4 failed, 20 passed in 1.2s ===='), 4);
    assert.equal(countFailures('all good'), null);
  });
});

describe('fix generation', () => {
  test('rule engine converts string-built JSON into an object literal', () => {
    assert.equal(
      jsonTemplateToObject('  return JSON.parse(`{"greeting":"Thanks ${order.customer.name}!","total":${order.total}}`);'),
      '  return { greeting: `Thanks ${order.customer.name}!`, total: order.total };',
    );
  });

  test('AI engine: unusable patch is retried with the error, validation feedback reaches the model', async () => {
    prompts.length = 0;
    replies.push(
      JSON.stringify({ explanation: 'bad', edits: [{ path: 'src/routes/auth.js', find: 'this text is not in the file', replace: 'x' }] }),
      '```json\n' +
        JSON.stringify({
          explanation: 'Guard the user lookup and return 401 for unknown accounts.',
          edits: [{ path: 'src/routes/auth.js', find: '  if (user.password !== password) {\n    return res.status(401)', replace: '  if (!user || user.password !== password) {\n    return res.status(401)' }],
        }) +
        '\n```',
    );
    const logs: string[] = [];
    const p = await generateFix({ root: repo, bug: loginBug, attempt: 2, previous: [{ n: 1, explanation: 'first try', diff: '--- a', feedback: 'Validation failed: Lint (lint) exit 1 — copy guideline QB-12' }], log: (m) => logs.push(m) });
    assert.equal(p.engine, 'llm');
    assert.deepEqual(p.files.map((f) => f.path), ['src/routes/auth.js']);
    assert.match(p.diff, /^\+  if \(!user \|\| user\.password !== password\) \{$/m);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /copy guideline QB-12/, 'validation errors are sent back to the model');
    assert.match(prompts[0], /<file path="src\/routes\/auth\.js">/, 'relevant source files are provided');
    assert.match(prompts[1], /could not be applied: Edit target not found/);
    assert.ok(logs.some((l) => /AI patch rejected/.test(l)));
    assert.equal((await git(['status', '--porcelain'], { cwd: repo })).stdout, '', 'generation never leaves changes behind');
  });

  test('falls back to the rule engine when the model gives nothing usable', async () => {
    replies.push('not json', '{"edits": []}');
    const p = await generateFix({ root: repo, bug: loginBug, attempt: 1, previous: [], log: () => undefined });
    assert.equal(p.engine, 'rules');
    assert.ok(p.files.some((f) => f.path === 'src/routes/auth.js'));
    void pexec;
  });
});
