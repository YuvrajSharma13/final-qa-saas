import type { Browser } from 'playwright-core';
import type { Types } from 'mongoose';
import { config } from '../../config.js';
import { decryptSecret } from '../../lib/crypto.js';
import { Bug, RegressionTest, type BugDoc, type ProjectDoc } from '../../models/index.js';
import { instrumentedPage, launchBrowser } from '../browser.js';
import { saveTestCase } from '../evidence.js';
import { describeStep, executeSteps } from '../steps.js';
import type { Finding, Locator, RunContext, Step } from '../types.js';

/**
 * Agent 7 — Regression Test.
 * Input: confirmed bugs + their evidence. Output: a repeatable test (declarative steps executed by the
 * platform on every run, plus an exportable Playwright spec) and verification of previously-open bugs.
 */

type StoredFinding = Pick<Finding, 'source' | 'symptom' | 'page' | 'viewport' | 'element' | 'steps' | 'apiCheck' | 'details'>;

const PASSIVE = new Set(['expectNoServerErrors', 'expectNoPageErrors']);

export function buildRegressionSteps(bug: Pick<BugDoc, 'category' | 'location' | 'evidence'>): { steps: Step[]; manual: boolean } {
  const findings = (((bug.evidence || {}) as { findings?: StoredFinding[] }).findings || []) as StoredFinding[];
  const key = String(((bug.evidence || {}) as { clusterKey?: string }).clusterKey || '');
  const functional = findings.find((f) => f.source === 'functional' && f.steps?.length);
  const apis = findings.filter((f) => f.source === 'api' && f.apiCheck);
  const visual = findings.filter((f) => f.source === 'vision');
  const steps: Step[] = [];

  if (key.startsWith('asset:')) {
    const pages = [...new Set(findings.map((f) => f.page).filter(Boolean))] as string[];
    for (const p of pages) steps.push({ action: 'goto', path: p }, { action: 'expectImagesLoaded' });
    return { steps, manual: false };
  }
  if (functional) {
    steps.push(...functional.steps!);
    if (!steps.some((s) => PASSIVE.has(s.action))) steps.push({ action: 'expectNoServerErrors' }, { action: 'expectNoPageErrors' });
  }
  const seenApi = new Set<string>();
  for (const a of apis) {
    const k = `${a.apiCheck!.kind}:${a.apiCheck!.path}:${JSON.stringify(a.apiCheck!.step.body ?? a.apiCheck!.step.rawBody ?? '')}`;
    if (seenApi.has(k) || seenApi.size >= 5) continue;
    seenApi.add(k);
    steps.push(a.apiCheck!.step);
  }
  if (steps.length) return { steps, manual: false };

  if (visual.length) {
    const byViewport = new Map<string, StoredFinding>();
    for (const v of visual) if (v.viewport && !byViewport.has(v.viewport)) byViewport.set(v.viewport, v);
    let manual = false;
    for (const [vp, v] of byViewport) {
      const setup = ((v.details?.setup as Step[] | undefined) || []).filter((s) => s.action !== 'setViewport');
      steps.push({ action: 'setViewport', viewport: vp }, ...setup, { action: 'goto', path: v.page || '/' });
      if (['clipped_element', 'horizontal_overflow'].includes(String(v.symptom)) && v.element?.selector) {
        steps.push({ action: 'expectFullyVisible', target: { css: v.element.selector }, description: v.element.text ? `“${v.element.text}”` : v.element.selector });
      } else if (v.symptom === 'broken_image') {
        steps.push({ action: 'expectImagesLoaded' });
      } else {
        manual = true;
      }
    }
    return { steps, manual };
  }
  return { steps, manual: true };
}

// ------------------------------------------------------------------ Playwright export
const js = (v: unknown) => JSON.stringify(v);
const reLiteral = (s: string) => `/${s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}/i`;

function pwLocator(l: Locator): string {
  const nth = l.nth ? `.nth(${l.nth})` : '.first()';
  if (l.css) return `page.locator(${js(l.css)})${nth}`;
  if (l.role) return `page.getByRole(${js(l.role)}${l.name ? `, { name: ${reLiteral(l.name)} }` : ''})${nth}`;
  if (l.label) return `page.getByLabel(${reLiteral(l.label)})${nth}`;
  return `page.getByText(${reLiteral(l.text || '')})${nth}`;
}

export function toPlaywright(title: string, steps: Step[], baseUrl: string): string {
  const needsPage = steps.some((s) => s.action !== 'request');
  const needsRequest = steps.some((s) => s.action === 'request');
  const body: string[] = [];
  if (needsPage) {
    body.push(
      'const serverErrors: string[] = [];',
      'const pageErrors: string[] = [];',
      "page.on('response', (r) => { if (r.status() >= 500) serverErrors.push(`${r.request().method()} ${r.url()} -> ${r.status()}`); });",
      "page.on('pageerror', (e) => pageErrors.push(e.message));",
    );
  }
  for (const s of steps) {
    body.push(`// ${describeStep(s)}`);
    switch (s.action) {
      case 'setViewport': {
        const sizes: Record<string, [number, number]> = { desktop: [1440, 900], tablet: [768, 1024], mobile: [375, 812] };
        const [w, h] = sizes[s.viewport] || sizes.desktop;
        body.push(`await page.setViewportSize({ width: ${w}, height: ${h} });`);
        break;
      }
      case 'goto':
        body.push(`await page.goto(new URL(${js(s.path)}, BASE_URL).toString());`);
        break;
      case 'click':
        body.push(`await ${pwLocator(s.target)}.click();`);
        break;
      case 'fill':
        body.push(`await ${pwLocator(s.target)}.fill(${s.secret ? "process.env.QA_TEST_PASSWORD ?? ''" : js(s.value)});`);
        break;
      case 'press':
        body.push(`await ${pwLocator(s.target)}.press(${js(s.key)});`);
        break;
      case 'wait':
        body.push(`await page.waitForTimeout(${s.ms});`);
        break;
      case 'expectVisible':
        body.push(`await expect(${pwLocator(s.target)}).toBeVisible();`);
        break;
      case 'expectAnyVisible':
        body.push(`await expect(${s.targets.map(pwLocator).reduce((a, b) => `${a}.or(${b})`)}.first()).toBeVisible({ timeout: ${s.timeoutMs ?? 4000} });`);
        break;
      case 'expectText':
        body.push(`await expect(page.locator('body')).toContainText(new RegExp(${js(s.pattern)}, ${js(s.flags ?? 'i')}), { timeout: ${s.timeoutMs ?? 5000} });`);
        break;
      case 'expectNoServerErrors':
        body.push('expect(serverErrors, "no 5xx responses").toEqual([]);');
        break;
      case 'expectNoPageErrors':
        body.push('expect(pageErrors, "no uncaught errors").toEqual([]);');
        break;
      case 'expectImagesLoaded':
        body.push(
          "await page.waitForLoadState('networkidle');",
          'const broken = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.src));',
          'expect(broken, "images that failed to load").toEqual([]);',
        );
        break;
      case 'expectCartMath':
        body.push(
          'const cart = await page.evaluate(() => {',
          "  const money = (t: string) => [...t.matchAll(/[$€£₹]\\s?(\\d+(?:[.,]\\d{1,2})?)/g)].map((m) => parseFloat(m[1].replace(',', '.')));",
          "  const rows = [...document.querySelectorAll('input[type=number]')].map((input) => {",
          "    const row = (input as HTMLInputElement).closest('tr, li, [class*=line], [class*=item]') as HTMLElement;",
          '    const values = money(row.innerText);',
          '    return { unit: values[0], qty: Number((input as HTMLInputElement).value) };',
          '  });',
          "  const totalEl = document.querySelector('[data-testid*=total i], [id*=total i], [class*=total i]') as HTMLElement;",
          '  const shown = money(totalEl.innerText).pop();',
          '  return { expected: Math.round(rows.reduce((s, r) => s + r.unit * r.qty, 0) * 100) / 100, shown };',
          '});',
          'expect(cart.shown).toBeCloseTo(cart.expected, 2);',
        );
        break;
      case 'expectFullyVisible':
        body.push(
          `const visible = await page.locator(${js(s.target.css)}).evaluate((el) => {`,
          '  const r = el.getBoundingClientRect();',
          '  let left = 0, right = window.innerWidth;',
          '  for (let p = el.parentElement; p; p = p.parentElement) {',
          "    if (['hidden', 'clip'].includes(getComputedStyle(p).overflowX)) { const pr = p.getBoundingClientRect(); left = Math.max(left, pr.left); right = Math.min(right, pr.right); }",
          '  }',
          '  return Math.max(0, Math.min(r.right, right) - Math.max(r.left, left)) / r.width;',
          '});',
          'expect(visible, "fraction of the element that is visible").toBeGreaterThan(0.98);',
        );
        break;
      case 'request': {
        const opts: string[] = [];
        if (s.body !== undefined) opts.push(`data: ${js(s.body)}`);
        if (s.rawBody !== undefined) opts.push(`data: ${js(s.rawBody)}, headers: { 'content-type': 'application/json' }`);
        body.push(
          `{`,
          `  const res = await request.fetch(new URL(${js(s.path)}, API_URL).toString(), { method: ${js(s.method)}${opts.length ? `, ${opts.join(', ')}` : ''} });`,
          s.allowAnyBelow500 ? '  expect(res.status()).toBeLessThan(500);' : `  expect(${js(s.expectStatus)}).toContain(res.status());`,
          `}`,
        );
        break;
      }
    }
  }
  const fixtures = [needsPage && 'page', needsRequest && 'request'].filter(Boolean).join(', ');
  return [
    "import { test, expect } from '@playwright/test';",
    '',
    `const BASE_URL = process.env.BASE_URL ?? ${js(baseUrl)};`,
    'const API_URL = process.env.API_URL ?? BASE_URL;',
    '',
    `// Generated by AI QA SaaS — regression test for: ${title.replace(/\n/g, ' ')}`,
    `test(${js(`regression: ${title}`)}, async ({ ${fixtures} }) => {`,
    ...body.map((l) => `  ${l}`),
    '});',
    '',
  ].join('\n');
}

// ------------------------------------------------------------------ persistence + execution
export async function generateRegressionForBug(bug: BugDoc) {
  const { steps, manual } = buildRegressionSteps(bug);
  const { Project } = await import('../../models/index.js');
  const project = await Project.findById(bug.projectId).lean();
  const name = `Regression: ${bug.title}`.slice(0, 180);
  const rc = (bug.rootCause || {}) as { suggestedFix?: string };
  const doc = {
    bugId: bug._id,
    projectId: bug.projectId,
    name,
    steps,
    expected: manual ? `${bug.expected || 'Issue no longer present'} (manual verification needed for part of this check)` : bug.expected || 'Issue no longer reproduces',
    code: toPlaywright(bug.title, steps, project?.appUrl || 'http://localhost:3000'),
    suggestedFix: rc.suggestedFix,
  };
  const existing = await RegressionTest.findOne({ bugId: bug._id });
  if (existing) {
    existing.set(doc);
    await existing.save();
    return existing;
  }
  return RegressionTest.create({ ...doc, status: 'pending' });
}

type RegressionDoc = Awaited<ReturnType<typeof generateRegressionForBug>>;

export async function executeRegressionTest(test: RegressionDoc, project: Pick<ProjectDoc, 'appUrl' | 'settings'>, browser: Browser | null, runId?: Types.ObjectId) {
  const steps = (test.steps || []) as Step[];
  if (!steps.length) return { status: 'pending' as const, detail: 'No automated steps' };
  const needsBrowser = steps.some((s) => s.action !== 'request');
  let own: Browser | null = null;
  let ip = null;
  try {
    if (needsBrowser) {
      if (!browser) own = await launchBrowser();
      ip = await instrumentedPage((browser || own)!, project.appUrl, 'desktop');
    }
    const r = await executeSteps(ip, steps, {
      baseUrl: project.appUrl,
      apiBaseUrl: project.settings?.apiBaseUrl || project.appUrl,
      secrets: { testPassword: project.settings?.testPasswordEnc ? decryptSecret(project.settings.testPasswordEnc) : '' },
    });
    const onlyErrors = r.failures.length > 0 && r.failures.every((f) => f.symptom === 'step_error');
    const status = r.passed ? 'passing' : onlyErrors ? 'error' : 'failing';
    const detail = r.passed ? `All ${steps.length} steps passed` : r.failures.map((f) => `Step ${f.stepIndex + 1}: ${f.actual}`).join(' · ').slice(0, 500);
    test.status = status;
    test.lastRunAt = new Date();
    if (runId) test.lastRunId = runId;
    test.lastResult = { status, durationMs: r.durationMs, failures: r.failures.map((f) => ({ step: f.stepIndex + 1, description: describeStep(f.step), expected: f.expected, actual: f.actual })) };
    test.results.push({ at: new Date(), runId, status, detail });
    if (test.results.length > 30) test.results.splice(0, test.results.length - 30);
    await test.save();
    return { status, detail, durationMs: r.durationMs };
  } finally {
    await ip?.close();
    await own?.close();
  }
}

export async function runRegressionAgent(
  ctx: RunContext,
  browser: Browser,
  project: Pick<ProjectDoc, 'appUrl' | 'settings'>,
  input: { bugIds: Types.ObjectId[]; notReproduced: Types.ObjectId[] },
) {
  const verified: Record<string, unknown>[] = [];
  const generated: Record<string, unknown>[] = [];
  const fixedBugIds: Types.ObjectId[] = [];
  let passed = 0;
  let failed = 0;

  const record = async (name: string, bugTitle: string, res: { status: string; detail: string; durationMs?: number }, expectFailing: boolean) => {
    const ok = expectFailing ? true : res.status === 'passing';
    await saveTestCase(ctx, {
      agentType: 'regression_test',
      category: 'regression',
      kind: expectFailing ? 'reproduction' : 'verification',
      name: `${expectFailing ? 'Reproduce' : 'Verify fix'}: ${bugTitle}`.slice(0, 200),
      target: name,
      expected: expectFailing ? 'Generated test reproduces the bug (fails before the fix)' : 'Regression test passes',
      actual: `${res.status}: ${res.detail}`,
      status: res.status === 'error' ? 'error' : expectFailing ? 'passed' : res.status === 'passing' ? 'passed' : 'failed',
      durationMs: res.durationMs,
    });
    if (ok) passed++;
    else failed++;
  };

  // 1) Verify previously-open bugs that were not reproduced by the testing agents.
  for (const id of input.notReproduced) {
    if (ctx.isCanceled()) break;
    const bug = await Bug.findById(id);
    if (!bug || bug.status !== 'open') continue;
    let test = await RegressionTest.findOne({ bugId: bug._id });
    if (!test) test = await generateRegressionForBug(bug as unknown as BugDoc);
    const res = await executeRegressionTest(test, project, browser, ctx.runId);
    await record(test.name || '', bug.title, res, false);
    if (res.status === 'passing') {
      bug.status = 'fixed';
      bug.history.push({ at: new Date(), event: 'fixed', message: `Verified fixed: regression test passed (${res.detail})`, runId: ctx.runId });
      await bug.save();
      fixedBugIds.push(bug._id);
      ctx.log('regression_test', `✓ Fixed: ${bug.title} — regression test now passes`);
    } else {
      bug.history.push({ at: new Date(), event: 'seen', message: `Regression test still ${res.status}: ${res.detail}`, runId: ctx.runId });
      await bug.save();
      ctx.log('regression_test', `✗ Still failing: ${bug.title} — ${res.detail.slice(0, 100)}`, 'warn');
    }
    verified.push({ bugId: bug._id, bug: bug.title, test: test.name, status: res.status, bugStatus: bug.status });
  }

  // 2) Generate (or refresh) a regression test for every bug found in this run and confirm it reproduces.
  for (const id of input.bugIds) {
    if (ctx.isCanceled()) break;
    const bug = await Bug.findById(id);
    if (!bug || bug.status !== 'open') continue;
    const test = await generateRegressionForBug(bug as unknown as BugDoc);
    const res = await executeRegressionTest(test, project, browser, ctx.runId);
    await record(test.name || '', bug.title, res, true);
    generated.push({ bugId: bug._id, bug: bug.title, test: test.name, steps: test.steps.length, status: res.status, reproduces: res.status === 'failing' });
    ctx.log('regression_test', `${res.status === 'failing' ? 'Reproduced' : res.status === 'passing' ? 'Could not reproduce' : 'Generated'}: ${test.name?.slice(0, 90)} (${test.steps.length} steps)`, res.status === 'passing' ? 'warn' : 'info');
  }
  return {
    fixedBugIds,
    stats: { executed: passed + failed, passed, failed },
    output: { generated, verified, exportFormat: '@playwright/test', note: config.isProd ? undefined : 'Regression specs can be exported from the bug page and run with `npx playwright test`.' },
  };
}
