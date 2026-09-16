import type { Severity } from '../../models/index.js';
import { saveTestCase } from '../evidence.js';
import { describeStep, executeSteps } from '../steps.js';
import type { ApiCheck, Finding, RunContext, StepFailure, TestPlan } from '../types.js';

/**
 * Agent 3 — API QA.
 * Input: API checks (spec + discovered endpoints). Output: API failures + request/response evidence.
 */

const CRITICAL_ROUTE = /order|checkout|payment|pay\b|cart|billing|invoice/i;
const VALIDATION_KINDS = new Set(['empty_body', 'missing_field', 'wrong_type', 'invalid_format', 'malformed_json', 'invalid_credentials', 'discovered_post']);

export function apiSeverity(check: ApiCheck, f: StepFailure): Severity {
  if (f.symptom === 'server_error') {
    if (CRITICAL_ROUTE.test(check.route) && check.method !== 'GET') return 'critical';
    return 'high';
  }
  if (f.symptom === 'unexpected_status') {
    if (check.kind === 'contract') return 'high';
    if (VALIDATION_KINDS.has(check.kind)) return 'medium';
    return 'low';
  }
  if (f.symptom === 'schema_mismatch') return 'medium';
  return 'low';
}

export async function runApiAgent(ctx: RunContext, plan: TestPlan) {
  const findings: Finding[] = [];
  const results: Record<string, unknown>[] = [];
  let passed = 0;
  let failed = 0;
  const baseUrl = ctx.apiBaseUrl || ctx.appUrl;
  for (const check of plan.apiChecks) {
    if (ctx.isCanceled()) break;
    const r = await executeSteps(null, [check.step], { baseUrl, apiBaseUrl: baseUrl });
    const call = r.api?.[0];
    const failure = r.failures[0];
    const status = r.passed ? 'passed' : failure?.symptom === 'step_error' ? 'error' : 'failed';
    const testCaseId = await saveTestCase(ctx, {
      agentType: 'api_qa',
      category: 'api',
      kind: check.kind,
      name: check.name,
      target: check.route,
      expected: check.expected,
      actual: failure ? failure.actual : `HTTP ${call?.status} in ${call?.ms} ms`,
      status,
      durationMs: r.durationMs,
      evidence: {
        request: { method: check.step.method, path: check.step.path, body: check.step.body ?? check.step.rawBody ?? null },
        response: call ? { status: call.status, ms: call.ms, body: call.bodySnippet } : null,
        steps: [describeStep(check.step)],
      },
    });
    if (status === 'passed') passed++;
    else failed++;
    results.push({ endpoint: check.route, check: check.kind, status, expected: check.expected, actual: failure?.actual ?? `HTTP ${call?.status}` });
    ctx.log('api_qa', `${status === 'passed' ? '✓' : '✗'} ${check.name}${failure ? ` — ${failure.actual.slice(0, 90)}` : ''}`, status === 'passed' ? 'info' : 'warn');
    if (status === 'failed' && failure) {
      findings.push({
        source: 'api',
        testCaseId: String(testCaseId),
        title: check.name,
        symptom: failure.symptom,
        route: check.route,
        status: call?.status,
        expected: failure.expected,
        actual: failure.actual,
        severityHint: apiSeverity(check, failure),
        confidence: 'high',
        screenshotIds: [],
        network: call
          ? [{ method: check.step.method, url: check.step.path, path: check.step.path, status: call.status, resourceType: 'fetch', durationMs: call.ms, requestBody: check.step.body ?? check.step.rawBody, responseSnippet: call.bodySnippet }]
          : [],
        console: [],
        steps: [check.step],
        apiCheck: check,
        details: { kind: check.kind },
      });
    }
  }
  return {
    findings,
    stats: { executed: passed + failed, passed, failed },
    output: { summary: { executed: passed + failed, passed, failed, baseUrl }, results },
  };
}
