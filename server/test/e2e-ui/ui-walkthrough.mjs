// Browser-level walkthrough of the SaaS UI (sign-up → project → AI QA run → bug detail → billing → rerun).
// Usage: BASE_URL=http://localhost:4000 SHOTS=/tmp/shots node test/e2e-ui/ui-walkthrough.mjs
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS || path.resolve('ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const executablePath = process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const browser = await chromium.launch({ executablePath });
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/Failed to load resource|fonts\.g/.test(m.text()) && errors.push(m.text()));
const shot = async (name, full = false) => page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: full });
const step = (m) => console.log(`• ${m}`);
const expectText = async (re, timeout = 10000) => page.getByText(re).first().waitFor({ timeout });

async function waitForRunDone(timeoutMs = 240000) {
  await page.getByRole('button', { name: /Rerun QA/ }).waitFor({ timeout: timeoutMs });
}

try {
  step('landing page');
  await page.goto(BASE + '/');
  await expectText(/automated testing team/i);
  await shot('01-landing', true);

  step('sign up');
  await page.getByRole('link', { name: 'Start free' }).click();
  await page.getByLabel('Your name').fill('Priya Developer');
  await page.getByLabel('Workspace name').fill('QuickBite Dev Team');
  await page.getByLabel('Email').fill(`priya.${Date.now()}@example.com`);
  await page.getByLabel('Password').fill('supersecret123');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('**/projects/new');

  step('create project from demo values and start AI QA');
  await page.getByRole('button', { name: 'Fill demo values' }).click();
  await shot('02-new-project', true);
  await page.getByRole('button', { name: 'Create & start AI QA' }).click();
  await page.waitForURL('**/runs/**');
  await expectText(/waiting for agents|Test Planner/i);
  await page.waitForTimeout(6000);
  await shot('03-run-live');

  step('wait for the run to finish');
  await waitForRunDone();
  await page.waitForTimeout(800);
  await shot('04-run-complete', true);

  step('inspect Vision agent output');
  await page.getByRole('button', { name: /Vision QA/ }).first().click();
  await expectText(/output \(structured\)/);
  await shot('05-vision-agent', false);

  step('screenshots tab + annotated modal');
  await page.getByRole('tab', { name: /Screenshots/ }).click();
  const card = page.locator('figure', { hasText: '/checkout · 375×812' }).first();
  await card.locator('button').first().click();
  await expectText(/Computer-vision findings/);
  await page.waitForTimeout(500);
  await shot('06-cv-annotated-modal');
  await page.keyboard.press('Escape');

  step('bugs list');
  await page.goto(BASE + '/bugs');
  await expectText(/Bug tracker/);
  await page.locator('tbody tr').first().waitFor();
  const bugCount = await page.locator('tbody tr').count();
  console.log(`  open bugs listed: ${bugCount}`);
  await shot('07-bugs', true);

  step('upgrade to Pro (test-mode billing)');
  await page.goto(BASE + '/billing');
  await page.getByRole('button', { name: 'Switch to Pro' }).click();
  await expectText(/Switched to Pro/);
  await shot('08-billing', true);

  step('rerun with repository analysis');
  await page.goto(BASE + '/projects');
  await page.getByRole('link', { name: /QuickBite/ }).first().click();
  await page.getByRole('button', { name: /Rerun AI QA/ }).click();
  await page.waitForURL('**/runs/**');
  await waitForRunDone();
  await page.getByRole('tab', { name: /^Bugs/ }).click();

  step('bug detail with root cause + regression test');
  await page.getByRole('link', { name: /UI clipped/ }).first().click();
  await expectText(/Suggested patch/);
  await shot('09-bug-detail-visual', true);
  await page.goto(BASE + '/bugs?status=open&severity=critical');
  await page.locator('tbody tr a').first().click();
  await expectText(/Regression test/);
  await shot('10-bug-detail-api', true);

  step('project overview + dashboard + settings');
  await page.goto(BASE + '/projects');
  await page.getByRole('link', { name: /QuickBite/ }).first().click();
  await expectText(/Run history/);
  await shot('11-project', true);
  await page.goto(BASE + '/dashboard');
  await expectText(/QA dashboard/);
  await page.waitForTimeout(500);
  await shot('12-dashboard', true);
  await page.goto(BASE + '/settings');
  await expectText(/GitHub & API configuration/);
  await shot('13-settings', true);

  step('mobile layout');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(BASE + '/dashboard');
  await expectText(/QA dashboard/);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`  mobile horizontal overflow: ${overflow}px`);
  await shot('14-dashboard-mobile', true);

  console.log(errors.length ? `Console errors:\n${errors.join('\n')}` : 'No console errors');
  console.log('UI WALKTHROUGH PASSED');
} catch (err) {
  await shot('zz-failure', true).catch(() => undefined);
  console.error('UI WALKTHROUGH FAILED:', err.message);
  console.error(errors.join('\n'));
  process.exitCode = 1;
} finally {
  await browser.close();
}
