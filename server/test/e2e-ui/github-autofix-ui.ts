/**
 * Browser walkthrough of the GitHub auto-fix UI:
 *   Continue with GitHub → project → link repo/branch → QA run → bug → Generate AI fix → review diff →
 *   approve → validation failure + new attempt → approve → PR open → dashboard GitHub panel.
 * Uses the local GitHub-compatible test server (see test/support/github-test-server.ts).
 *   npx tsx test/e2e-ui/github-autofix-ui.ts   (needs MongoDB, Chromium and a built web app)
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { GitHubTestServer } from '../support/github-test-server.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = process.env.SHOTS || path.resolve('ui-shots');
await fs.mkdir(SHOTS, { recursive: true });
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'aiqa-ghui-'));
const gh = await new GitHubTestServer().start(path.join(tmp, 'remotes'));
gh.addUser('priya-dev', 'Priya Developer');
await gh.createRepo('acme', 'quickbite', path.resolve(here, '../../../quickbite'));
const QB_PORT = 4500 + Math.floor(Math.random() * 50);

Object.assign(process.env, {
  MONGODB_URI: 'mongodb://127.0.0.1:27017/ai_qa_saas_github_ui',
  ALLOW_PRIVATE_TARGETS: 'true',
  AI_DISABLED: '1',
  STORAGE_DIR: path.join(tmp, 'storage'),
  GITHUB_WEB_URL: gh.url,
  GITHUB_API_URL: `${gh.url}/api/v3`,
  GITHUB_CLIENT_ID: gh.clientId,
  GITHUB_CLIENT_SECRET: gh.clientSecret,
  AUTOFIX_WORK_DIR: path.join(tmp, 'work'),
  NODE_ENV: 'test',
});
const qb = spawn(process.execPath, ['server.js'], { cwd: path.resolve(here, '../../../quickbite'), env: { ...process.env, PORT: String(QB_PORT) }, stdio: 'ignore' });
const mongoose = (await import('mongoose')).default;
await mongoose.connect(process.env.MONGODB_URI!);
await mongoose.connection.db!.dropDatabase();
const { createApp } = await import('../../src/app.js');
const server = createApp().listen(0, '127.0.0.1');
await new Promise((r) => server.once('listening', r));
const BASE = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const executablePath = process.env.CHROMIUM_PATH || (await fs.access('/opt/pw-browsers/chromium').then(() => '/opt/pw-browsers/chromium').catch(() => undefined));
const browser = await chromium.launch({ executablePath });
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
const shot = (name: string, fullPage = false) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage });
const step = (m: string) => console.log(`• ${m}`);
let exit = 0;
try {
  step('Continue with GitHub');
  await page.goto(`${BASE}/login`);
  await page.getByRole('link', { name: 'Continue with GitHub' }).click();
  await page.waitForURL('**/projects/new?github=connected');

  step('Create project and upgrade (test-mode billing)');
  await page.getByLabel('Project name').fill('QuickBite');
  await page.getByLabel('Application URL').fill(`http://127.0.0.1:${QB_PORT}/`);
  await page.getByLabel('OpenAPI / Swagger spec URL').fill('/openapi.json');
  await page.getByRole('button', { name: 'Create project', exact: true }).click();
  await page.waitForURL(/\/projects\/[a-f0-9]{24}$/);
  const projectUrl = page.url();
  await page.goto(`${BASE}/billing`);
  await page.getByRole('button', { name: 'Switch to Pro' }).click();
  await page.getByText(/Switched to Pro/).waitFor();

  step('Settings → GitHub: select repository and branch');
  await page.goto(`${BASE}/settings?tab=github`);
  await page.getByText('@priya-dev').waitFor();
  await page.getByLabel('Repository', { exact: true }).selectOption('acme/quickbite');
  await page.getByLabel('Base branch').locator('option[value="main"]').waitFor({ state: 'attached' });
  await page.getByLabel('Base branch').selectOption('main');
  await page.getByRole('button', { name: 'Link repository' }).click();
  await page.getByText('Linked acme/quickbite @ main').waitFor();
  await shot('gh-01-settings', true);

  step('Run QA (functional + API) and open the login bug');
  await page.goto(`${projectUrl}/run`);
  await page.getByText('Vision QA', { exact: true }).click();
  await page.getByRole('button', { name: 'Start AI QA' }).click();
  await page.getByRole('button', { name: /Rerun QA/ }).waitFor({ timeout: 240_000 });
  await page.getByRole('tab', { name: /^Bugs/ }).click();
  await page.getByRole('link', { name: /Login fails/ }).first().click();
  await page.getByText('AI auto-fix').first().waitFor();
  await shot('gh-02-bug-autofix-card');

  step('Generate AI fix and review the diff');
  await page.getByRole('button', { name: 'Generate AI fix' }).click();
  await page.waitForURL('**/fixes/**');
  await page.getByText('Your approval is required').waitFor({ timeout: 120_000 });
  await page.getByText('Before', { exact: true }).first().waitFor();
  await shot('gh-03-diff-review', true);
  const approve = page.getByRole('button', { name: /Approve · branch/ });
  if (!(await approve.isDisabled())) throw new Error('Approve must be disabled until the reviewer confirms');
  await page.getByLabel(/I reviewed this exact diff/).check();
  await approve.click();

  step('Validation fails → attempt 2 awaits approval');
  await page.getByRole('tab', { name: 'Attempt 2' }).waitFor({ timeout: 240_000 });
  await page.getByText('Your approval is required').waitFor();
  await shot('gh-04-attempt2', true);
  await page.getByRole('tab', { name: 'Attempt 1' }).click();
  await page.getByText('validation failed').first().waitFor();
  await page.getByRole('button', { name: /Lint \(lint\)/ }).first().click();
  await page.getByText(/copy guideline QB-12/).first().waitFor();
  await shot('gh-05-attempt1-validation', true);
  await page.getByRole('tab', { name: 'Attempt 2' }).click();
  await page.getByLabel(/I reviewed this exact diff/).check();
  await page.getByRole('button', { name: /Approve · branch/ }).click();

  step('PR opened');
  await page.getByRole('link', { name: 'Open on GitHub' }).waitFor({ timeout: 240_000 });
  await shot('gh-06-pr-open', true);

  step('Dashboard GitHub panel');
  await page.goto(`${BASE}/dashboard`);
  await page.getByText('GitHub & AI fixes').waitFor();
  await page.getByText(/#1 open/).first().waitFor();
  await shot('gh-07-dashboard', true);

  step('AI fixes list');
  await page.goto(`${BASE}/fixes`);
  await page.getByText('PR open').first().waitFor();
  await shot('gh-08-fixes');

  if (errors.length) throw new Error(`Console errors:\n${errors.join('\n')}`);
  console.log('GITHUB AUTOFIX UI WALKTHROUGH PASSED');
} catch (e) {
  exit = 1;
  console.error('FAILED:', (e as Error).message);
  await shot('gh-zz-failure', true).catch(() => undefined);
} finally {
  await browser.close();
  qb.kill();
  const { autofixIdle } = await import('../../src/autofix/service.js');
  await autofixIdle();
  server.close();
  await gh.stop();
  await mongoose.disconnect();
  await fs.rm(tmp, { recursive: true, force: true });
  process.exit(exit);
}
