import type { Browser } from 'playwright-core';
import { VIEWPORTS } from '../../lib/plans.js';
import type { Severity } from '../../models/index.js';
import { instrumentedPage } from '../browser.js';
import { saveScreenshot, saveTestCase } from '../evidence.js';
import { describeStep, executeSteps } from '../steps.js';
import type { Finding, RunContext, Scenario, StepFailure, Symptom, TestPlan } from '../types.js';

/**
 * Agent 2 — Functional QA.
 * Input: functional scenarios from the plan. Output: pass/fail per workflow + evidence.
 */

const SYMPTOM_PRIORITY: Symptom[] = ['server_error', 'calculation_mismatch', 'text_missing', 'missing_feedback', 'page_error', 'broken_image', 'unexpected_status', 'element_missing', 'not_fully_visible', 'step_error'];

export function primaryFailure(failures: StepFailure[]): StepFailure {
  return [...failures].sort((a, b) => SYMPTOM_PRIORITY.indexOf(a.symptom) - SYMPTOM_PRIORITY.indexOf(b.symptom))[0];
}

export function functionalSeverity(s: Pick<Scenario, 'kind' | 'workflow'>, symptom: Symptom): Severity {
  const money = /checkout|cart|order|payment/i.test(s.workflow) || s.kind.startsWith('checkout') || s.kind === 'cart_quantity';
  if (symptom === 'broken_image') return 'low';
  if (symptom === 'calculation_mismatch') return 'high';
  if (symptom === 'server_error') return money || s.kind.startsWith('auth') ? 'high' : 'medium';
  if (symptom === 'text_missing' || symptom === 'missing_feedback') return money ? 'high' : 'medium';
  if (symptom === 'page_error') return 'medium';
  return 'low';
}

export async function runFunctionalAgent(ctx: RunContext, browser: Browser, plan: TestPlan) {
  const findings: Finding[] = [];
  const results: Record<string, unknown>[] = [];
  let passed = 0;
  let failed = 0;
  let errored = 0;
  const vp = VIEWPORTS.desktop;
  for (const scenario of plan.scenarios) {
    if (ctx.isCanceled()) break;
    const ip = await instrumentedPage(browser, ctx.appUrl, 'desktop');
    try {
      const r = await executeSteps(ip, scenario.steps, { baseUrl: ctx.appUrl, secrets: { testPassword: ctx.credentials?.password ?? '' } });
      const onlyStepErrors = r.failures.length > 0 && r.failures.every((f) => f.symptom === 'step_error');
      const status = r.passed ? 'passed' : onlyStepErrors ? 'error' : 'failed';
      let screenshotId: string | undefined;
      if (r.screenshot) {
        const shot = await saveScreenshot(ctx, r.screenshot, {
          kind: 'failure',
          agentType: 'functional_qa',
          viewport: { name: vp.name, width: vp.width, height: vp.height },
          url: ip.page.url(),
          pagePath: safePath(ip.page.url()),
        });
        screenshotId = String(shot._id);
      }
      const primary = r.failures.length ? primaryFailure(r.failures) : null;
      const serverFailure = r.failures.find((f) => f.symptom === 'server_error');
      const testCaseId = await saveTestCase(ctx, {
        agentType: 'functional_qa',
        category: 'functional',
        kind: scenario.kind,
        name: scenario.name,
        target: scenario.page,
        expected: scenario.expected,
        actual: r.passed ? 'As expected' : r.failures.map((f) => f.actual).join(' · '),
        status,
        durationMs: r.durationMs,
        evidence: {
          screenshotIds: screenshotId ? [screenshotId] : [],
          steps: scenario.steps.map(describeStep),
          failures: r.failures.map((f) => ({ step: f.stepIndex + 1, description: describeStep(f.step), expected: f.expected, actual: f.actual, symptom: f.symptom, data: f.data })),
          network: r.network.filter((n) => ['xhr', 'fetch', 'document'].includes(n.resourceType) || n.status >= 400).slice(-25),
          console: r.console.slice(-10),
          pageErrors: r.pageErrors.slice(-10),
        },
      });
      if (status === 'passed') passed++;
      else if (status === 'failed') failed++;
      else errored++;
      results.push({
        test: scenario.name,
        workflow: scenario.workflow,
        status,
        expected: primary?.expected ?? scenario.expected,
        actual: primary?.actual ?? 'as expected',
        evidence: screenshotId ? `screenshot:${screenshotId}` : 'log',
      });
      ctx.log('functional_qa', `${status === 'passed' ? '✓' : status === 'failed' ? '✗' : '!'} ${scenario.name}${primary ? ` — ${primary.actual}` : ''}`, status === 'passed' ? 'info' : 'warn');

      if (status === 'failed' && primary) {
        const serverData = serverFailure?.data as { route?: string; status?: number; entries?: unknown[] } | undefined;
        const imgData = r.failures.find((f) => f.symptom === 'broken_image')?.data as { src?: string; status?: number } | undefined;
        findings.push({
          source: 'functional',
          testCaseId: String(testCaseId),
          title: scenario.name,
          symptom: serverFailure ? 'server_error' : primary.symptom,
          page: scenario.page,
          workflow: scenario.workflow,
          scenarioKind: scenario.kind,
          route: serverData?.route,
          status: serverData?.status,
          expected: primary.expected,
          actual: r.failures.map((f) => f.actual).join(' · '),
          severityHint: functionalSeverity(scenario, serverFailure ? 'server_error' : primary.symptom),
          confidence: 'high',
          screenshotIds: screenshotId ? [screenshotId] : [],
          network: r.network.filter((n) => n.status >= 400).slice(0, 10),
          console: [...r.pageErrors.map((t) => ({ type: 'pageerror', text: t })), ...r.console.filter((c) => c.type === 'error')].slice(0, 10),
          steps: scenario.steps,
          details: {
            symptoms: [...new Set(r.failures.map((f) => f.symptom))],
            failures: r.failures.map((f) => ({ symptom: f.symptom, expected: f.expected, actual: f.actual, data: f.data })),
            imageSrc: imgData?.src,
            imageStatus: imgData?.status,
          },
        });
      }
    } finally {
      await ip.close();
    }
  }
  return {
    findings,
    stats: { executed: passed + failed + errored, passed, failed, errored },
    output: { summary: { executed: passed + failed + errored, passed, failed, inconclusive: errored }, results },
  };
}

function safePath(url: string) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}
