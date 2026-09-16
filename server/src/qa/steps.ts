import { request as pwRequest, type APIRequestContext, type Page } from 'playwright-core';
import { VIEWPORTS } from '../lib/plans.js';
import { sanitizeText, sanitizeValue } from '../lib/sanitize.js';
import { absoluteUrl, routeOf, settle, type Instrumented } from './browser.js';
import { BROKEN_IMAGES, CART_MATH, ELEMENT_VISIBILITY, runInPage } from './pageScripts.js';
import type { Locator, NetworkEntry, Step, StepFailure } from './types.js';

export interface ExecOptions {
  baseUrl: string;
  apiBaseUrl?: string;
  stopOnFailure?: boolean;
  /** Values for {{secret:name}} placeholders (decrypted server-side, never persisted in steps). */
  secrets?: Record<string, string>;
}

export interface ExecResult {
  passed: boolean;
  failures: StepFailure[];
  stepsRun: number;
  durationMs: number;
  network: NetworkEntry[];
  console: { type: string; text: string }[];
  pageErrors: string[];
  screenshot?: Buffer;
  api?: { status: number; ms: number; bodySnippet: string; route: string }[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function resolveLocator(page: Page, l: Locator) {
  let loc;
  if (l.css) loc = page.locator(l.css);
  else if (l.role) loc = page.getByRole(l.role, l.name ? { name: new RegExp(escapeRe(l.name), 'i') } : {});
  else if (l.label) loc = page.getByLabel(new RegExp(escapeRe(l.label), 'i'));
  else if (l.text) loc = page.getByText(new RegExp(escapeRe(l.text), 'i'));
  else throw new Error('Empty locator');
  return loc.nth(l.nth ?? 0);
}

export function describeLocator(l: Locator): string {
  if (l.role) return `${l.role} "${l.name ?? ''}"`;
  if (l.label) return `field labelled "${l.label}"`;
  if (l.text) return `text "${l.text}"`;
  return `\`${l.css}\``;
}

export function describeStep(s: Step): string {
  switch (s.action) {
    case 'setViewport': {
      const v = VIEWPORTS[s.viewport];
      return `Use the ${s.viewport} viewport (${v?.width}×${v?.height})`;
    }
    case 'goto': return `Open ${s.path}`;
    case 'click': return `Click ${s.description || describeLocator(s.target)}`;
    case 'fill': return `Type ${s.secret ? '"••••••"' : JSON.stringify(s.value)} into ${describeLocator(s.target)}`;
    case 'press': return `Press ${s.key} in ${describeLocator(s.target)}`;
    case 'wait': return `Wait ${s.ms} ms`;
    case 'expectVisible': return `Expect ${describeLocator(s.target)} to be visible`;
    case 'expectAnyVisible': return `Expect ${s.description || 'feedback'} to be visible`;
    case 'expectText': return `Expect ${s.description || `text /${s.pattern}/`} to appear`;
    case 'expectNoServerErrors': return 'Expect no HTTP 5xx responses';
    case 'expectNoPageErrors': return 'Expect no uncaught JavaScript errors';
    case 'expectImagesLoaded': return 'Expect every image to load';
    case 'expectCartMath': return 'Expect line subtotals and the total to equal unit price × quantity';
    case 'expectFullyVisible': return `Expect ${s.description || describeLocator(s.target)} to be fully visible (not clipped)`;
    case 'request': return `${s.method} ${s.path}${s.body !== undefined || s.rawBody ? ` with ${s.rawBody ? 'raw body' : 'JSON body'}` : ''} → expect ${s.allowAnyBelow500 ? 'non-5xx' : s.expectStatus.join('/')}`;
  }
}

async function waitForPredicate(fn: () => Promise<boolean>, timeoutMs: number) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn().catch(() => false)) return true;
    await new Promise((r) => setTimeout(r, 150));
  }
  return fn().catch(() => false);
}

const IGNORABLE_CONSOLE = /Failed to load resource|favicon|net::ERR_ABORTED|Download the React DevTools/i;

/**
 * Executes declarative steps. Browser steps need `ip`; request steps use Playwright's APIRequestContext.
 */
export async function executeSteps(ip: Instrumented | null, steps: Step[], opts: ExecOptions): Promise<ExecResult> {
  const t0 = Date.now();
  const failures: StepFailure[] = [];
  const mark = ip?.mark() ?? { network: 0, console: 0, pageErrors: 0 };
  let api: APIRequestContext | null = null;
  const apiResults: NonNullable<ExecResult['api']> = [];
  let stepsRun = 0;
  const page = ip?.page;
  const needPage = () => {
    if (!page) throw new Error('This step needs a browser page');
    return page;
  };
  const fail = (i: number, step: Step, f: Omit<StepFailure, 'stepIndex' | 'step'>) => failures.push({ stepIndex: i, step, ...f });

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i];
    if (opts.stopOnFailure !== false && failures.length && !step.action.startsWith('expectNo')) continue;
    stepsRun++;
    try {
      switch (step.action) {
        case 'setViewport': {
          const vp = VIEWPORTS[step.viewport] || VIEWPORTS.desktop;
          await needPage().setViewportSize({ width: vp.width, height: vp.height });
          break;
        }
        case 'goto': {
          const res = await needPage().goto(absoluteUrl(opts.baseUrl, step.path), { waitUntil: 'load' });
          await settle(needPage());
          if (res && res.status() >= 400) {
            fail(i, step, {
              expected: `${step.path} loads successfully`,
              actual: `Document request returned HTTP ${res.status()}`,
              symptom: res.status() >= 500 ? 'server_error' : 'unexpected_status',
              data: { status: res.status(), route: routeOf('GET', step.path) },
            });
          }
          break;
        }
        case 'click':
          await resolveLocator(needPage(), step.target).click({ timeout: 6000 });
          await settle(needPage(), 3000);
          break;
        case 'fill':
          await resolveLocator(needPage(), step.target).fill(
            step.value.replace(/\{\{secret:(\w+)\}\}/g, (_, name) => opts.secrets?.[name] ?? ''),
            { timeout: 6000 },
          );
          break;
        case 'press':
          await resolveLocator(needPage(), step.target).press(step.key, { timeout: 6000 });
          await settle(needPage(), 2000);
          break;
        case 'wait':
          await new Promise((r) => setTimeout(r, Math.min(step.ms, 10000)));
          break;
        case 'expectVisible': {
          const ok = await resolveLocator(needPage(), step.target)
            .waitFor({ state: 'visible', timeout: step.timeoutMs ?? 5000 })
            .then(() => true)
            .catch(() => false);
          if (!ok) fail(i, step, { expected: `${describeLocator(step.target)} is visible`, actual: 'Element was not visible', symptom: 'element_missing' });
          break;
        }
        case 'expectAnyVisible': {
          const p = needPage();
          const ok = await waitForPredicate(async () => {
            for (const t of step.targets) if (await resolveLocator(p, t).isVisible()) return true;
            return false;
          }, step.timeoutMs ?? 4000);
          if (!ok) {
            fail(i, step, {
              expected: `${step.description || 'User-facing feedback'} is shown`,
              actual: `No visible ${step.description || 'feedback'} after ${(step.timeoutMs ?? 4000) / 1000}s`,
              symptom: 'missing_feedback',
            });
          }
          break;
        }
        case 'expectText': {
          const re = new RegExp(step.pattern, step.flags ?? 'i');
          const p = needPage();
          const ok = await waitForPredicate(async () => re.test(await p.evaluate('document.body.innerText')), step.timeoutMs ?? 5000);
          if (!ok) {
            const bodyText = String(await p.evaluate('document.body.innerText').catch(() => '')).replace(/\s+/g, ' ').slice(0, 240);
            fail(i, step, {
              expected: step.description || `Page shows text matching /${step.pattern}/`,
              actual: `Not found. Page text: "${sanitizeText(bodyText, 240)}"`,
              symptom: 'text_missing',
            });
          }
          break;
        }
        case 'expectNoServerErrors': {
          const bad = (ip?.network.slice(mark.network) || []).filter((n) => n.status >= 500);
          if (bad.length) {
            fail(i, step, {
              expected: 'No HTTP 5xx responses',
              actual: bad.map((b) => `${b.method} ${b.path} → ${b.status}`).join('; '),
              symptom: 'server_error',
              data: { entries: bad, route: routeOf(bad[0].method, bad[0].path), status: bad[0].status },
            });
          }
          break;
        }
        case 'expectNoPageErrors': {
          const errs = [
            ...(ip?.pageErrors.slice(mark.pageErrors) || []),
            ...(ip?.console.slice(mark.console) || []).filter((c) => c.type === 'error' && !IGNORABLE_CONSOLE.test(c.text)).map((c) => `console.error: ${c.text}`),
          ];
          if (errs.length) {
            fail(i, step, { expected: 'No uncaught JavaScript errors', actual: errs.slice(0, 3).join(' | '), symptom: 'page_error', data: { errors: errs } });
          }
          break;
        }
        case 'expectImagesLoaded': {
          const p = needPage();
          await p.evaluate('window.scrollTo(0, document.body.scrollHeight)').catch(() => undefined);
          await settle(p, 2500);
          const broken = await runInPage<{ src: string; alt: string; selector: string; box: unknown }[]>(p, BROKEN_IMAGES);
          const failedImgs = (ip?.network.slice(mark.network) || []).filter((n) => n.resourceType === 'image' && (n.status >= 400 || n.status === 0));
          if (broken.length || failedImgs.length) {
            const src = broken[0]?.src || failedImgs[0]?.url;
            const status = failedImgs.find((f) => src && f.url === src)?.status ?? failedImgs[0]?.status;
            fail(i, step, {
              expected: 'All images load and render',
              actual: `${broken.length || failedImgs.length} image(s) failed: ${[...new Set([...broken.map((b) => b.src), ...failedImgs.map((f) => `${f.url} (${f.status})`)])].slice(0, 3).join(', ')}`,
              symptom: 'broken_image',
              data: { images: broken, requests: failedImgs, src: src ? new URL(src).pathname : '', status },
            });
          }
          break;
        }
        case 'expectCartMath': {
          const r = await runInPage<{
            rows: { name: string; unit: number; qty: number; line: number }[];
            total: number | null;
            expectedTotal: number;
            sumUnits: number;
            sumLines: number;
            lineProblems: string[];
            totalSelector: string | null;
          }>(needPage(), CART_MATH);
          if (!r.rows.length) {
            fail(i, step, { expected: 'Cart shows at least one line with a quantity', actual: 'No cart lines with quantity controls were found', symptom: 'element_missing', data: r });
          } else if (r.lineProblems.length) {
            fail(i, step, { expected: 'Each line subtotal equals unit price × quantity', actual: r.lineProblems.join('; '), symptom: 'calculation_mismatch', data: r });
          } else if (r.total === null) {
            fail(i, step, { expected: 'A cart total is displayed', actual: 'No total value found on the page', symptom: 'element_missing', data: r });
          } else if (Math.abs(r.total - r.expectedTotal) > 0.011) {
            const qtyDesc = r.rows.map((x) => `${x.qty} × ${x.unit.toFixed(2)}`).join(' + ');
            fail(i, step, {
              expected: `Total = ${qtyDesc} = ${r.expectedTotal.toFixed(2)}`,
              actual: `Total shows ${r.total.toFixed(2)}${Math.abs(r.total - r.sumUnits) < 0.011 ? ' (equals the sum of unit prices — quantity is ignored)' : ''}`,
              symptom: 'calculation_mismatch',
              data: r,
            });
          }
          break;
        }
        case 'expectFullyVisible': {
          const p = needPage();
          const css = step.target.css;
          if (!css) throw new Error('expectFullyVisible requires a css locator');
          await resolveLocator(p, step.target).waitFor({ state: 'attached', timeout: 5000 }).catch(() => undefined);
          const v = await runInPage<{ fraction: number; width: number; visibleWidth: number } | null>(p, ELEMENT_VISIBILITY, css);
          if (!v) fail(i, step, { expected: `${describeLocator(step.target)} exists`, actual: 'Element not found', symptom: 'element_missing' });
          else if (v.fraction < 0.98) {
            fail(i, step, {
              expected: `${step.description || describeLocator(step.target)} is fully visible`,
              actual: `Only ${Math.round(v.fraction * 100)}% visible (${Math.round(v.visibleWidth)}px of ${Math.round(v.width)}px wide)`,
              symptom: 'not_fully_visible',
              data: v,
            });
          }
          break;
        }
        case 'request': {
          api ??= await pwRequest.newContext({ baseURL: opts.apiBaseUrl || opts.baseUrl, ignoreHTTPSErrors: false, timeout: 15000 });
          const started = Date.now();
          const headers: Record<string, string> = { accept: 'application/json', ...(step.headers || {}) };
          let data: string | undefined;
          if (step.rawBody !== undefined) {
            data = step.rawBody;
            headers['content-type'] ??= 'application/json';
          } else if (step.body !== undefined) {
            data = JSON.stringify(step.body);
            headers['content-type'] = 'application/json';
          }
          const res = await api.fetch(step.path.replace(/^\//, ''), { method: step.method, headers, data, failOnStatusCode: false, maxRedirects: 0 });
          const ms = Date.now() - started;
          const text = await res.text().catch(() => '');
          const route = routeOf(step.method, step.path);
          apiResults.push({ status: res.status(), ms, bodySnippet: sanitizeText(text.replace(/\s+/g, ' '), 300), route });
          const common = { route, status: res.status(), ms, responseSnippet: sanitizeText(text.replace(/\s+/g, ' '), 300), request: sanitizeValue(step.body ?? step.rawBody ?? null) };
          if (step.allowAnyBelow500 ? res.status() >= 500 : !step.expectStatus.includes(res.status())) {
            fail(i, step, {
              expected: step.allowAnyBelow500 ? 'Any non-5xx response' : `HTTP ${step.expectStatus.join(' or ')}`,
              actual: `HTTP ${res.status()}${text ? ` — ${sanitizeText(text.replace(/\s+/g, ' '), 140)}` : ''}`,
              symptom: res.status() >= 500 ? 'server_error' : 'unexpected_status',
              data: common,
            });
            break;
          }
          if (step.expectJson) {
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              fail(i, step, { expected: 'JSON response body', actual: `Non-JSON body (${res.headers()['content-type'] || 'no content-type'})`, symptom: 'schema_mismatch', data: common });
              break;
            }
            const missing = (step.requiredKeys || []).filter((k) => !(parsed && typeof parsed === 'object' && k in (parsed as object)));
            if (missing.length) fail(i, step, { expected: `Body has keys: ${step.requiredKeys!.join(', ')}`, actual: `Missing: ${missing.join(', ')}`, symptom: 'schema_mismatch', data: common });
          }
          if (step.maxMs && ms > step.maxMs) {
            fail(i, step, { expected: `Responds within ${step.maxMs} ms`, actual: `Took ${ms} ms`, symptom: 'slow_response', data: common });
          }
          break;
        }
      }
    } catch (err) {
      fail(i, step, {
        expected: describeStep(step),
        actual: `Step could not be completed: ${sanitizeText((err as Error).message.split('\n')[0], 200)}`,
        symptom: 'step_error',
      });
    }
  }

  let screenshot: Buffer | undefined;
  if (failures.length && page) {
    screenshot = await page.screenshot({ fullPage: false }).catch(() => undefined);
  }
  await api?.dispose();
  return {
    passed: failures.length === 0,
    failures,
    stepsRun,
    durationMs: Date.now() - t0,
    network: ip?.network.slice(mark.network) || [],
    console: ip?.console.slice(mark.console) || [],
    pageErrors: ip?.pageErrors.slice(mark.pageErrors) || [],
    screenshot,
    api: apiResults,
  };
}
