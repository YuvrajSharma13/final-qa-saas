import type { Types } from 'mongoose';
import { askJson, llmEnabled } from '../../ai/llm.js';
import { sha1 } from '../../lib/crypto.js';
import { VIEWPORTS } from '../../lib/plans.js';
import { sanitizeText, sanitizeValue } from '../../lib/sanitize.js';
import { Bug, SEVERITIES, type Severity } from '../../models/index.js';
import { describeStep } from '../steps.js';
import type { Finding, RunContext, Step } from '../types.js';

/**
 * Agent 5 — Bug Analyzer.
 * Input: raw failures from the Functional, API and Vision agents.
 * Output: consolidated, de-duplicated developer-facing bugs with severity and likely cause.
 */

export interface Cluster {
  key: string;
  findings: Finding[];
}

const VALIDATION_KINDS = new Set(['empty_body', 'missing_field', 'wrong_type', 'invalid_format', 'malformed_json', 'discovered_post']);

export function clusterKey(f: Finding): string {
  const imageSrc = (f.details?.imageSrc as string | undefined) || undefined;
  if (f.symptom === 'broken_image' && imageSrc) return `asset:${imageSrc}`;
  if (f.route && (f.source === 'api' || f.symptom === 'server_error')) return `route:${f.route}`;
  if (f.source === 'vision') return `visual:${f.page}:${f.symptom}:${f.element?.selector || f.details?.region || ''}`;
  if (f.symptom === 'page_error') {
    const first = String((f.details?.failures as { actual?: string }[] | undefined)?.find((x) => x)?.actual || f.actual).slice(0, 60);
    return `page-error:${f.page}:${first.replace(/[0-9a-f]{6,}/gi, '#')}`;
  }
  return `flow:${f.workflow}:${f.scenarioKind}:${f.symptom}`;
}

export function clusterFindings(findings: Finding[]): Cluster[] {
  const map = new Map<string, Finding[]>();
  for (const f of findings) {
    const k = clusterKey(f);
    map.set(k, [...(map.get(k) || []), f]);
  }
  return [...map.entries()].map(([key, fs]) => ({ key, findings: fs }));
}

const rank = (s: Severity) => SEVERITIES.indexOf(s);
const maxSeverity = (xs: Severity[]) => xs.reduce((a, b) => (rank(b) < rank(a) ? b : a), 'low' as Severity);
const uniq = <T,>(xs: (T | undefined | null)[]) => [...new Set(xs.filter((x): x is T => x !== undefined && x !== null && x !== ''))];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function pageName(path?: string) {
  const seg = (path || '/').split('/').filter(Boolean).pop() || 'home';
  return cap(seg.replace(/\.html?$/, '').replace(/[-_]/g, ' '));
}

function viewportList(fs: Finding[]) {
  const vps = uniq(fs.map((f) => f.viewport));
  return { names: vps, sizes: vps.map((v) => `${VIEWPORTS[v]?.width}×${VIEWPORTS[v]?.height}`) };
}

export interface BugDraft {
  title: string;
  description: string;
  category: 'functional' | 'api' | 'visual';
  severity: Severity;
  sources: string[];
  likelyCause: string;
  confidence: 'high' | 'medium' | 'low';
  expected: string;
  actual: string;
  reproSteps: string[];
  location: Record<string, unknown>;
}

export function describeCluster(c: Cluster): BugDraft {
  const fs = c.findings;
  const sources = uniq(fs.map((f) => f.source));
  const severity = maxSeverity(fs.map((f) => f.severityHint));
  const functional = fs.find((f) => f.source === 'functional');
  const apiFs = fs.filter((f) => f.source === 'api');
  const vision = fs.filter((f) => f.source === 'vision');
  const lead = [...fs].sort((a, b) => rank(a.severityHint) - rank(b.severityHint))[0];
  const route = fs.find((f) => f.route)?.route;
  const serverStatus = fs.find((f) => f.symptom === 'server_error' && f.status)?.status || fs.find((f) => (f.status || 0) >= 500)?.status;
  const vp = viewportList(fs);
  const responseText = fs.flatMap((f) => f.network.map((n) => n.responseSnippet || '')).find((t) => /Error|Cannot|undefined|Unexpected/i.test(t)) || '';
  const decode = (s: string) => s.replace(/&#39;|&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const errorHint = decode(responseText).match(/(TypeError|SyntaxError|ReferenceError|RangeError)[^<]{0,120}/)?.[0];

  let title = lead.title;
  let likelyCause = 'Unclear — see evidence.';
  let category: BugDraft['category'] = functional ? 'functional' : apiFs.length ? 'api' : 'visual';

  if (c.key.startsWith('route:')) {
    const status = serverStatus || apiFs[0]?.status;
    const validationKinds = apiFs.filter((f) => VALIDATION_KINDS.has(String(f.details?.kind)));
    const acceptsInvalid = validationKinds.some((f) => f.symptom === 'unexpected_status' && (f.status || 0) < 300);
    const crashesOnInvalid = validationKinds.some((f) => f.symptom === 'server_error');
    if (functional?.scenarioKind === 'auth_invalid_login' || apiFs.some((f) => f.details?.kind === 'invalid_credentials')) {
      const noFeedback = functional && (functional.details?.symptoms as string[] | undefined)?.includes('missing_feedback');
      title = `Login fails with HTTP ${status} for invalid credentials${noFeedback ? ' and shows no error message' : ''}`;
      likelyCause = `The login handler (${route}) throws for unknown accounts — the user lookup result is used without a null check${errorHint ? ` (${errorHint.trim()})` : ''}.${noFeedback ? ' The login form also does not handle non-JSON error responses, so the user sees nothing.' : ''}`;
    } else if (functional?.scenarioKind === 'checkout_special_chars') {
      title = `Order confirmation fails (HTTP ${status} on ${route}) when the customer name contains quotes or apostrophes`;
      likelyCause = `Server-side response building breaks on special characters in user input (string-built JSON/HTML or missing escaping) in ${route}${errorHint ? ` — ${errorHint.trim()}` : ''}.`;
    } else if (functional) {
      title = `${functional.workflow}: ${functional.title} — ${route} returns HTTP ${status}`;
      likelyCause = `Unhandled server error in ${route} during the ${(functional.workflow || "").toLowerCase()} workflow${errorHint ? ` (${errorHint.trim()})` : ''}.`;
    } else if (crashesOnInvalid) {
      title = `${route} returns ${status} for invalid input instead of a 4xx validation error${acceptsInvalid ? ' (and accepts some invalid data)' : ''}`;
      likelyCause = `The ${route} handler uses the request payload without validating it, so malformed input throws an unhandled exception${errorHint ? ` (${errorHint.trim()})` : ''}${acceptsInvalid ? '; invalid formats (e.g. email) are also accepted' : ''}. Add schema validation that returns 400 with field errors.`;
      category = 'api';
    } else if (acceptsInvalid) {
      title = `${route} accepts invalid data (HTTP ${apiFs[0].status} instead of 4xx)`;
      likelyCause = `No input validation on ${route}: ${validationKinds.map((f) => f.title).join('; ')}.`;
      category = 'api';
    } else if (apiFs.some((f) => f.symptom === 'server_error')) {
      title = `${route} responds with HTTP ${status}`;
      likelyCause = `Unhandled exception in ${route}${errorHint ? ` (${errorHint.trim()})` : ''}.`;
      category = 'api';
    } else if (apiFs.some((f) => f.symptom === 'schema_mismatch')) {
      title = `${route} response does not match the documented contract`;
      likelyCause = apiFs.map((f) => f.actual).join('; ');
      category = 'api';
    } else {
      title = `${route}: ${apiFs[0]?.title || lead.title} — got ${apiFs[0]?.actual.split(' — ')[0]}`;
      likelyCause = `Endpoint behaviour differs from the API contract: ${apiFs.map((f) => `${f.expected} vs ${f.actual.split(' — ')[0]}`).join('; ')}.`;
      category = 'api';
    }
  } else if (c.key.startsWith('asset:')) {
    const src = c.key.slice(6);
    const status = fs.map((f) => f.details?.imageStatus as number | undefined).find(Boolean);
    const pages = uniq(fs.map((f) => f.page));
    title = `Broken image on ${pages.join(', ')}: ${src}${status ? ` returns HTTP ${status}` : ''}`;
    likelyCause = `The image URL ${src} ${status ? `returns HTTP ${status}` : 'cannot be loaded'} — the asset path referenced by the page data/template is stale or the file is missing.`;
    category = vision.length ? 'visual' : 'functional';
  } else if (c.key.startsWith('visual:')) {
    category = 'visual';
    const v = vision[0];
    const page = pageName(v.page);
    const where = `${vp.names.join(' & ')} (${vp.sizes.join(', ')})`;
    const el = v.element;
    const label = el?.text ? `“${el.text.slice(0, 40)}”` : el?.selector || 'element';
    switch (v.symptom) {
      case 'clipped_element': {
        const tag = String(v.details?.tag || el?.selector?.match(/^(\w+)/)?.[1] || 'element');
        title = `${page} UI clipped on ${where}: ${label} ${/button|btn/i.test(`${tag} ${el?.selector}`) ? 'button' : 'element'} is cut off`;
        likelyCause = cap(String(v.details?.likelyCause || 'Fixed-width element inside an overflow:hidden container'));
        const okOn = (v.details?.fullyVisibleOn as string[] | undefined) || [];
        if (okOn.length) likelyCause += `. Renders fully on ${okOn.join(', ')}, so the layout is not responsive.`;
        break;
      }
      case 'horizontal_overflow':
        title = `Horizontal scrolling on ${v.page} at ${where}`;
        likelyCause = `${el?.selector || 'An element'} is wider than the viewport${el?.styles?.width ? ` (width: ${el.styles.width}${el.styles.minWidth && el.styles.minWidth !== '0px' ? `, min-width: ${el.styles.minWidth}` : ''})` : ''}.`;
        break;
      case 'overlapping_elements':
        title = `Overlapping controls on ${v.page} at ${where}: ${label}`;
        likelyCause = 'Absolute positioning or negative margins cause controls to overlap at this width.';
        break;
      case 'reference_mismatch':
        title = `${v.page} no longer matches its visual reference at ${where}`;
        likelyCause = `Layout or styling changed since the reference was approved (${v.details?.diffRatio ? `${(Number(v.details.diffRatio) * 100).toFixed(1)}% pixels differ` : 'pixels differ'}).`;
        break;
      default:
        title = `${page}: ${v.title} (${where})`;
        likelyCause = 'Reported by the vision model — review the annotated screenshot.';
    }
  } else if (c.key.startsWith('page-error:')) {
    title = `JavaScript error on ${functional?.page}: ${String(functional?.actual).slice(0, 80)}`;
    likelyCause = 'Uncaught exception in client-side code.';
  } else if (functional) {
    const data = (functional.details?.failures as { symptom: string; data?: Record<string, number | string[]> }[] | undefined)?.find((x) => x.symptom === functional.symptom)?.data;
    switch (functional.symptom) {
      case 'calculation_mismatch':
        title = /cart/i.test(functional.workflow || '') ? 'Cart total is incorrect after changing item quantity' : `${functional.workflow}: calculated amount is incorrect`;
        if (data && typeof data.total === 'number' && Math.abs(Number(data.total) - Number(data.sumUnits)) < 0.011) {
          likelyCause = 'The total is computed by summing unit prices — the quantity is not multiplied in (a reduce() over price instead of price × quantity).';
        } else if (Array.isArray(data?.lineProblems) && data.lineProblems.length) {
          likelyCause = 'Line subtotal calculation does not use unit price × quantity.';
        } else {
          likelyCause = 'The total is not recalculated after the quantity changes (stale state).';
        }
        break;
      case 'missing_feedback':
        title = `${functional.workflow}: no feedback shown — ${functional.title.toLowerCase()}`;
        likelyCause = 'The UI does not render the error/success state for this action.';
        break;
      case 'text_missing':
        title = `${functional.workflow}: ${functional.title} — expected content never appears`;
        likelyCause = 'The workflow completes without showing the expected state; check the client-side handler and the API response.';
        break;
      default:
        title = `${functional.workflow}: ${functional.title}`;
        likelyCause = functional.actual;
    }
  }

  const stepsFinding = functional || apiFs[0] || vision[0];
  let reproSteps: string[] = [];
  if (stepsFinding?.steps?.length) reproSteps = stepsFinding.steps.filter((s) => !s.action.startsWith('expectNo')).map(describeStep);
  else if (vision.length) {
    const v = vision[0];
    const setup = (v.details?.setup as Step[] | undefined) || [];
    reproSteps = [
      describeStep({ action: 'setViewport', viewport: v.viewport || 'mobile' }),
      ...setup.map(describeStep),
      describeStep({ action: 'goto', path: v.page || '/' }),
      `Look at the ${String(v.details?.region || 'highlighted')} region: ${v.actual}`,
    ];
  }

  const confidence = sources.length > 1 || fs.some((f) => f.confidence === 'high') ? 'high' : fs.some((f) => f.confidence === 'medium') ? 'medium' : 'low';
  return {
    title: sanitizeText(title, 200),
    description: `${fs.length} failing check(s) from ${sources.map((s) => `${s} agent`).join(', ')} were consolidated into this bug.`,
    category,
    severity,
    sources,
    likelyCause: sanitizeText(likelyCause, 600),
    confidence,
    expected: lead.expected,
    actual: lead.actual,
    reproSteps,
    location: {
      pages: uniq(fs.map((f) => f.page)),
      routes: uniq(fs.map((f) => f.route)),
      viewports: vp.names,
      selectors: uniq(fs.map((f) => f.element?.selector)),
      classes: uniq(fs.flatMap((f) => f.element?.classes || [])),
      workflow: functional?.workflow,
      imageSrc: c.key.startsWith('asset:') ? c.key.slice(6) : undefined,
      texts: uniq(fs.map((f) => f.element?.text)),
      styles: vision.find((v) => v.element?.styles)?.element?.styles,
      clipper: vision.find((v) => v.details?.clipper)?.details?.clipper,
      scenarioKinds: uniq(fs.map((f) => f.scenarioKind)),
      apiKinds: uniq(apiFs.map((f) => String(f.details?.kind))),
      responseSnippets: uniq(fs.flatMap((f) => f.network.map((n) => n.responseSnippet))).slice(0, 3),
    },
  };
}

function agentOutputs(fs: Finding[]) {
  return fs.slice(0, 12).map((f) => {
    if (f.source === 'functional') return { agent: 'functional_qa', test: f.title, status: 'failed', expected: f.expected, actual: f.actual, evidence: f.screenshotIds[0] ? `screenshot:${f.screenshotIds[0]}` : 'log' };
    if (f.source === 'api') return { agent: 'api_qa', endpoint: f.route, check: f.details?.kind, status: 'failed', expected: f.expected, actual: f.actual };
    const vp = VIEWPORTS[f.viewport || 'desktop'];
    return { agent: 'vision_qa', viewport: `${vp.width}x${vp.height}`, issue: f.actual, severity: f.severityHint, region: f.details?.region, confidence: f.confidence };
  });
}

const CATEGORY_AGENT: Record<string, 'functional' | 'api' | 'vision'> = { functional: 'functional', api: 'api', visual: 'vision' };

export async function runBugAnalyzer(ctx: RunContext, findings: Finding[], agentsRan: Record<'functional' | 'api' | 'vision', boolean>) {
  const clusters = clusterFindings(findings);
  const now = new Date();
  const touched: Types.ObjectId[] = [];
  const created: Types.ObjectId[] = [];
  const reopened: Types.ObjectId[] = [];
  const outputs: Record<string, unknown>[] = [];
  let llmBudget = llmEnabled() ? 5 : 0;

  for (const c of clusters) {
    const d = describeCluster(c);
    const fingerprint = sha1(`${ctx.projectId}:${c.key}`);
    const evidence = sanitizeValue({
      screenshotIds: uniq(c.findings.flatMap((f) => f.screenshotIds)),
      testCaseIds: uniq(c.findings.map((f) => f.testCaseId)),
      network: c.findings.flatMap((f) => f.network).filter((n) => n.status >= 400 || n.status === 0).slice(0, 8),
      console: c.findings.flatMap((f) => f.console).slice(0, 8),
      agentOutputs: agentOutputs(c.findings),
      findings: c.findings.map((f) => ({ source: f.source, symptom: f.symptom, title: f.title, page: f.page, route: f.route, viewport: f.viewport, severity: f.severityHint, confidence: f.confidence, expected: f.expected, actual: f.actual, element: f.element, details: f.details, apiCheck: f.apiCheck, steps: f.steps })),
      clusterKey: c.key,
    });
    const analyzerOutput = { title: d.title, category: d.category, severity: d.severity, likelyCause: d.likelyCause, evidence: evidence.screenshotIds.map((id: string) => `screenshot_${id}`) };

    let bug = await Bug.findOne({ projectId: ctx.projectId, fingerprint });
    let state: 'new' | 'reopened' | 'recurring' | 'ignored' = 'new';
    if (bug) {
      const userSetSeverity = bug.history.some((h) => h.event === 'severity' && h.userId);
      if (bug.status === 'fixed') {
        state = 'reopened';
        bug.status = 'open';
        bug.history.push({ at: now, event: 'reopened', message: 'Regression: the issue reappeared after being marked fixed', runId: ctx.runId });
        reopened.push(bug._id);
      } else {
        state = bug.status === 'ignored' ? 'ignored' : 'recurring';
        bug.history.push({ at: now, event: 'seen', message: `Seen again (${c.findings.length} failing check(s))`, runId: ctx.runId });
      }
      if (bug.history.length > 60) bug.history.splice(0, bug.history.length - 60);
      bug.set({
        title: d.title,
        description: d.description,
        category: d.category,
        severity: userSetSeverity ? bug.severity : d.severity,
        sources: d.sources,
        location: d.location,
        evidence,
        expected: d.expected,
        actual: d.actual,
        reproSteps: d.reproSteps,
        lastSeenRunId: ctx.runId,
        occurrences: (bug.occurrences || 1) + 1,
        rootCause: { ...(bug.rootCause as object), analyzer: { likelyCause: d.likelyCause, confidence: d.confidence }, likelyCause: (bug.rootCause as { likelyCause?: string })?.likelyCause || d.likelyCause },
      });
    } else {
      bug = new Bug({
        projectId: ctx.projectId,
        workspaceId: ctx.workspaceId,
        runId: ctx.runId,
        lastSeenRunId: ctx.runId,
        fingerprint,
        title: d.title,
        description: d.description,
        category: d.category,
        severity: d.severity,
        status: 'open',
        sources: d.sources,
        location: d.location,
        evidence,
        expected: d.expected,
        actual: d.actual,
        reproSteps: d.reproSteps,
        rootCause: { likelyCause: d.likelyCause, confidence: d.confidence, analyzer: { likelyCause: d.likelyCause, confidence: d.confidence } },
        history: [{ at: now, event: 'detected', message: `Detected by ${d.sources.join(' + ')} agent(s)`, runId: ctx.runId }],
      });
      created.push(bug._id);
      if (llmBudget-- > 0) {
        ctx.aiCalls++;
        const better = await askJson<{ title?: string; summary?: string }>({
          system: 'You write concise, developer-facing bug reports.',
          prompt: `Rewrite this bug for a developer. Keep technical details (routes, selectors, status codes).\nTitle: ${d.title}\nLikely cause: ${d.likelyCause}\nExpected: ${d.expected}\nActual: ${d.actual}\nReturn {"title": "<= 110 chars", "summary": "2 sentences"}`,
          maxTokens: 300,
        });
        if (better?.title) bug.title = sanitizeText(better.title, 200);
        if (better?.summary) bug.description = `${sanitizeText(better.summary, 600)} ${d.description}`;
      }
    }
    await bug.save();
    touched.push(bug._id);
    outputs.push({ ...analyzerOutput, id: bug._id, title: bug.title, status: state, sources: d.sources, rawFailures: c.findings.length });
    ctx.log('bug_analyzer', `${state === 'new' ? 'New' : cap(state)} ${d.severity} ${d.category} bug: ${bug.title} (${c.findings.length} failure(s) → 1 bug)`);
  }

  // Open bugs that were checkable in this run but did not reproduce → candidates for regression verification.
  const notReproduced = await Bug.find({ projectId: ctx.projectId, status: 'open', _id: { $nin: touched } });
  const candidates = notReproduced.filter((b) => (b.sources || []).some((s) => agentsRan[s as 'functional' | 'api' | 'vision']) || agentsRan[CATEGORY_AGENT[b.category]]);
  for (const b of candidates) ctx.log('bug_analyzer', `Not reproduced this run: ${b.title} — handing to Regression Test agent for verification`);

  return {
    bugIds: touched,
    created,
    reopened,
    notReproduced: candidates.map((b) => b._id),
    output: {
      consolidation: { rawFailures: findings.length, bugs: clusters.length, new: created.length, reopened: reopened.length, notReproduced: candidates.length },
      bugs: outputs,
    },
  };
}
