import type { Browser } from 'playwright-core';
import { askJson, llmEnabled } from '../../ai/llm.js';
import { randomId } from '../../lib/crypto.js';
import { sanitizeText } from '../../lib/sanitize.js';
import { instrumentedPage, routeOf, settle } from '../browser.js';
import { DISCOVER_PAGE, runInPage } from '../pageScripts.js';
import type {
  ApiCheck,
  DiscoveredEndpoint,
  DiscoveredField,
  DiscoveredForm,
  Locator,
  PageInfo,
  RunContext,
  Scenario,
  Step,
  TestPlan,
  VisualTarget,
} from '../types.js';

/**
 * Agent 1 — Test Planner.
 * Input: application URL, optional API spec, optional credentials.
 * Output: a shared test plan (workflows, functional scenarios, API checks, visual targets).
 */

interface RawDiscovery {
  title: string;
  headings: string[];
  forms: DiscoveredForm[];
  addToCart: { locator: Locator; count: number } | null;
  links: { href: string; text: string }[];
  scripts: string[];
  images: number;
  hasQuantityInputs: boolean;
  bodyText: string;
}

const SKIP_PATH = /logout|sign-?out|\.(pdf|zip|png|jpe?g|svg|gif|webp|css|js|json|xml|ico)$/i;

export function classifyPage(path: string, d: Pick<RawDiscovery, 'title' | 'headings' | 'forms' | 'addToCart'>): PageInfo['role'] {
  const hay = `${path} ${d.title} ${d.headings.join(' ')}`.toLowerCase();
  if (d.forms.some((f) => f.fields.some((x) => x.semantic === 'password'))) return 'login';
  const orderForm = d.forms.some(
    (f) => f.fields.some((x) => ['address', 'phone'].includes(x.semantic)) && /order|pay|checkout|place|purchase|buy/i.test(f.submitText),
  );
  if (/checkout|payment|shipping details/.test(hay) || orderForm) return 'checkout';
  if (/\b(cart|basket|bag)\b/.test(`${path} ${d.title}`.toLowerCase())) return 'cart';
  if (d.addToCart) return 'catalog';
  if (/confirm|thank|receipt|order-?status/.test(hay)) return 'confirmation';
  return 'content';
}

async function crawl(ctx: RunContext, browser: Browser) {
  const origin = new URL(ctx.appUrl).origin;
  const start = new URL(ctx.appUrl);
  const queue: string[] = [`${start.pathname}${start.search}`];
  const seen = new Set<string>(queue);
  const pages: PageInfo[] = [];
  const scripts = new Set<string>();
  const traffic: DiscoveredEndpoint[] = [];
  const ip = await instrumentedPage(browser, ctx.appUrl, 'desktop');
  try {
    while (queue.length && pages.length < ctx.maxPages) {
      if (ctx.isCanceled()) break;
      const path = queue.shift()!;
      const url = new URL(path, origin).toString();
      let status = 0;
      try {
        const res = await ip.page.goto(url, { waitUntil: 'load' });
        status = res?.status() ?? 0;
        await settle(ip.page);
      } catch (err) {
        ctx.log('test_planner', `Could not open ${path}: ${(err as Error).message.split('\n')[0]}`, 'warn');
        if (pages.length === 0) throw new Error(`Application URL is not reachable: ${(err as Error).message.split('\n')[0]}`);
        continue;
      }
      const d = await runInPage<RawDiscovery>(ip.page, DISCOVER_PAGE);
      const role = classifyPage(path, d);
      const links = [
        ...new Set(
          d.links
            .map((l) => {
              const u = new URL(l.href);
              return u.origin === origin ? `${u.pathname}${u.search}` : '';
            })
            .filter((p) => p && !SKIP_PATH.test(p)),
        ),
      ];
      pages.push({ path, url, title: d.title, status, role, headings: d.headings, forms: d.forms, addToCart: d.addToCart, links, images: d.images });
      d.scripts.forEach((s) => scripts.add(s));
      for (const l of links) {
        const key = l.replace(/\.html$/, '');
        if (!seen.has(l) && !seen.has(key) && !seen.has(`${key}.html`)) {
          seen.add(l);
          queue.push(l);
        }
      }
      ctx.log('test_planner', `Discovered ${path} (${role}, HTTP ${status}, ${d.forms.length} form(s))`);
    }
    for (const n of ip.network) {
      if (['xhr', 'fetch'].includes(n.resourceType) && n.path.startsWith('/')) {
        traffic.push({ method: n.method, path: n.path.split('?')[0], source: 'traffic' });
      }
    }
  } finally {
    await ip.close();
  }
  return { pages, scripts: [...scripts], traffic };
}

/** Static scan of the app's own JS bundles for fetch/axios calls. */
async function scanScripts(scriptUrls: string[]): Promise<DiscoveredEndpoint[]> {
  const out: DiscoveredEndpoint[] = [];
  const re = /(?:fetch|axios(?:\.(get|post|put|patch|delete))?)\(\s*[`'"]([^`'"]+)[`'"]\s*(?:,\s*\{([\s\S]{0,200}?)\})?/g;
  for (const url of scriptUrls.slice(0, 20)) {
    try {
      const src = await (await fetch(url, { signal: AbortSignal.timeout(5000) })).text();
      for (const m of src.matchAll(re)) {
        let path = m[2];
        if (!path.startsWith('/')) continue;
        path = path.replace(/\$\{[^}]*\}/g, ':id').split('?')[0];
        const method = (m[1] || m[3]?.match(/method:\s*['"](\w+)['"]/)?.[1] || 'GET').toUpperCase();
        out.push({ method, path, source: 'script' });
      }
    } catch {
      /* ignore unreachable scripts */
    }
  }
  return out;
}

// ------------------------------------------------------------------ OpenAPI
type Schema = { type?: string; format?: string; example?: unknown; required?: string[]; properties?: Record<string, Schema>; items?: Schema; $ref?: string; enum?: unknown[] };
interface Operation {
  method: string;
  path: string;
  params: { name: string; in: string; example?: unknown }[];
  bodySchema?: Schema;
  successCodes: number[];
  declaredCodes: number[];
  responseSchema?: Schema;
  jsonResponse: boolean;
}

async function loadSpec(ctx: RunContext): Promise<{ url: string; ops: Operation[]; error?: string }> {
  const candidates = ctx.apiSpecUrl ? [ctx.apiSpecUrl] : ['/openapi.json', '/swagger.json', '/api/openapi.json', '/api-docs', '/v3/api-docs'].map((p) => new URL(p, ctx.appUrl).toString());
  for (const url of candidates) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { accept: 'application/json' } });
      if (!res.ok) {
        if (ctx.apiSpecUrl) return { url, ops: [], error: `HTTP ${res.status}` };
        continue;
      }
      const doc = (await res.json()) as { paths?: Record<string, Record<string, unknown>>; components?: unknown };
      if (!doc.paths) continue;
      return { url, ops: parseOps(doc) };
    } catch (err) {
      if (ctx.apiSpecUrl) return { url, ops: [], error: (err as Error).message };
    }
  }
  return { url: '', ops: [] };
}

function parseOps(doc: { paths?: Record<string, Record<string, unknown>> } & Record<string, unknown>): Operation[] {
  const resolve = (s: Schema | undefined, depth = 0): Schema | undefined => {
    if (!s || depth > 6) return s;
    if (s.$ref?.startsWith('#/')) {
      const target = s.$ref
        .slice(2)
        .split('/')
        .reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], doc) as Schema | undefined;
      return resolve(target, depth + 1);
    }
    if (s.properties) {
      return { ...s, properties: Object.fromEntries(Object.entries(s.properties).map(([k, v]) => [k, resolve(v, depth + 1)!])) };
    }
    if (s.items) return { ...s, items: resolve(s.items, depth + 1) };
    return s;
  };
  const ops: Operation[] = [];
  for (const [path, item] of Object.entries(doc.paths || {})) {
    for (const [method, raw] of Object.entries(item)) {
      if (!['get', 'post', 'put', 'patch', 'delete'].includes(method)) continue;
      const op = raw as {
        parameters?: { name: string; in: string; example?: unknown; schema?: Schema }[];
        requestBody?: { content?: Record<string, { schema?: Schema }> };
        responses?: Record<string, { content?: Record<string, { schema?: Schema }> }>;
      };
      const codes = Object.keys(op.responses || {}).map(Number).filter(Boolean);
      const okCode = codes.find((c) => c >= 200 && c < 300);
      const okResp = okCode ? op.responses![String(okCode)] : undefined;
      ops.push({
        method: method.toUpperCase(),
        path,
        params: (op.parameters || []).map((p) => ({ name: p.name, in: p.in, example: p.example ?? p.schema?.example })),
        bodySchema: resolve(op.requestBody?.content?.['application/json']?.schema),
        successCodes: codes.filter((c) => c >= 200 && c < 300),
        declaredCodes: codes,
        responseSchema: resolve(okResp?.content?.['application/json']?.schema),
        jsonResponse: Boolean(okResp?.content?.['application/json']),
      });
    }
  }
  return ops;
}

function exampleFor(s: Schema | undefined): { value: unknown; complete: boolean } {
  if (!s) return { value: undefined, complete: false };
  if (s.example !== undefined) return { value: s.example, complete: true };
  if (s.enum?.length) return { value: s.enum[0], complete: true };
  if (s.type === 'object' || s.properties) {
    const out: Record<string, unknown> = {};
    let complete = true;
    for (const [k, v] of Object.entries(s.properties || {})) {
      const e = exampleFor(v);
      if (e.value !== undefined) out[k] = e.value;
      else if (s.required?.includes(k)) complete = false;
    }
    return { value: out, complete };
  }
  if (s.type === 'array') {
    const e = exampleFor(s.items);
    return { value: e.value === undefined ? [] : [e.value], complete: e.complete };
  }
  return { value: undefined, complete: false };
}

function wrongTypeValue(s: Schema | undefined): unknown {
  switch (s?.type) {
    case 'string':
      return 12345;
    case 'integer':
    case 'number':
      return 'not-a-number';
    case 'array':
      return 'not-an-array';
    case 'boolean':
      return 'not-a-boolean';
    default:
      return 'not-an-object';
  }
}

function findEmailPath(s: Schema | undefined, prefix: string[] = []): string[] | null {
  for (const [k, v] of Object.entries(s?.properties || {})) {
    if (v?.format === 'email' || /email/i.test(k)) return [...prefix, k];
    if (v?.properties) {
      const nested = findEmailPath(v, [...prefix, k]);
      if (nested) return nested;
    }
  }
  return null;
}

function setPath(obj: unknown, path: string[], value: unknown): unknown {
  const clone = structuredClone(obj) as Record<string, unknown>;
  let cur = clone;
  for (const k of path.slice(0, -1)) cur = cur[k] as Record<string, unknown>;
  cur[path[path.length - 1]] = value;
  return clone;
}

const range = (a: number, b: number) => Array.from({ length: b - a }, (_, i) => a + i);
const CLIENT_ERR = [400, 422];
const isAuthPath = (p: string) => /log-?in|sign-?in|session|auth|token/i.test(p);

export function buildApiChecks(ops: Operation[], discovered: DiscoveredEndpoint[]): ApiCheck[] {
  const checks: ApiCheck[] = [];
  const add = (c: Omit<ApiCheck, 'id' | 'route'> & { routePath?: string }) => {
    const { routePath, ...rest } = c;
    checks.push({ ...rest, id: `api_${checks.length + 1}`, route: routeOf(c.method, routePath || c.path) });
  };
  for (const op of ops) {
    const hasPathParams = /\{[^}]+\}/.test(op.path);
    const concrete = (fallback: string) =>
      op.path.replace(/\{([^}]+)\}/g, (_, name) => {
        const p = op.params.find((x) => x.name === name);
        return encodeURIComponent(String(p?.example ?? fallback));
      });
    const route = op.path;
    if (op.method === 'GET') {
      const allExamples = op.params.filter((p) => p.in === 'path').every((p) => p.example !== undefined);
      if (!hasPathParams || allExamples) {
        add({
          kind: 'contract',
          name: `${op.method} ${op.path} returns a valid response`,
          method: op.method,
          path: concrete(''),
          routePath: route,
          expected: `HTTP ${op.successCodes.join('/') || 200}${op.jsonResponse ? ' with JSON body' : ''}`,
          step: {
            action: 'request',
            method: 'GET',
            path: concrete(''),
            expectStatus: op.successCodes.length ? op.successCodes : [200],
            expectJson: op.jsonResponse,
            requiredKeys: op.responseSchema?.required,
            maxMs: 2000,
          },
        });
      }
      if (hasPathParams) {
        const p = concrete('qa-nonexistent-000').replace(/[^/]+$/, 'qa-nonexistent-000');
        add({
          kind: 'not_found',
          name: `${op.method} ${op.path} with an unknown id returns 404`,
          method: 'GET',
          path: p,
          routePath: route,
          expected: 'HTTP 404 (or 400) — never 5xx',
          step: { action: 'request', method: 'GET', path: p, expectStatus: [404, 400] },
        });
      }
      continue;
    }
    if (!['POST', 'PUT', 'PATCH'].includes(op.method) || !op.bodySchema) continue;
    const path = concrete('qa-sample');
    const ex = exampleFor(op.bodySchema);
    const invalidCodes = [...new Set([...CLIENT_ERR, ...op.declaredCodes.filter((c) => c === 400 || c === 422)])];
    if (ex.complete && op.successCodes.length) {
      add({
        kind: 'contract',
        name: `${op.method} ${op.path} accepts a valid payload`,
        method: op.method,
        path,
        routePath: route,
        expected: `HTTP ${op.successCodes.join('/')}`,
        step: { action: 'request', method: op.method, path, body: ex.value, expectStatus: op.successCodes, maxMs: 3000 },
      });
      if (isAuthPath(op.path)) {
        const emailPath = findEmailPath(op.bodySchema);
        let body = ex.value;
        if (emailPath) body = setPath(body, emailPath, `qa-nobody-${randomId(3)}@example.com`);
        const pw = Object.keys(op.bodySchema.properties || {}).find((k) => /pass/i.test(k));
        if (pw) body = setPath(body, [pw], 'Wrong-Password-123!');
        add({
          kind: 'invalid_credentials',
          name: `${op.method} ${op.path} rejects unknown credentials`,
          method: op.method,
          path,
          routePath: route,
          expected: 'HTTP 401/400/403 with an error message',
          step: { action: 'request', method: op.method, path, body, expectStatus: [400, 401, 403, 404, 422] },
        });
      }
    }
    add({
      kind: 'empty_body',
      name: `${op.method} ${op.path} rejects an empty object`,
      method: op.method,
      path,
      routePath: route,
      expected: `HTTP ${invalidCodes.join('/')} validation error`,
      step: { action: 'request', method: op.method, path, body: {}, expectStatus: isAuthPath(op.path) ? [...invalidCodes, 401] : invalidCodes },
    });
    for (const field of (op.bodySchema.required || []).slice(0, 2)) {
      if (!ex.value || typeof ex.value !== 'object') break;
      const body = { ...(ex.value as Record<string, unknown>) };
      delete body[field];
      add({
        kind: 'missing_field',
        name: `${op.method} ${op.path} rejects a payload without "${field}"`,
        method: op.method,
        path,
        routePath: route,
        expected: `HTTP ${invalidCodes.join('/')}`,
        step: { action: 'request', method: op.method, path, body, expectStatus: isAuthPath(op.path) ? [...invalidCodes, 401] : invalidCodes },
      });
    }
    const firstReq = op.bodySchema.required?.[0];
    if (firstReq && ex.value && typeof ex.value === 'object') {
      const body = { ...(ex.value as Record<string, unknown>), [firstReq]: wrongTypeValue(op.bodySchema.properties?.[firstReq]) };
      add({
        kind: 'wrong_type',
        name: `${op.method} ${op.path} rejects a wrong type for "${firstReq}"`,
        method: op.method,
        path,
        routePath: route,
        expected: `HTTP ${invalidCodes.join('/')}`,
        step: { action: 'request', method: op.method, path, body, expectStatus: isAuthPath(op.path) ? [...invalidCodes, 401] : invalidCodes },
      });
    }
    const emailPath = findEmailPath(op.bodySchema);
    if (emailPath && ex.complete && !isAuthPath(op.path)) {
      add({
        kind: 'invalid_format',
        name: `${op.method} ${op.path} rejects an invalid email (${emailPath.join('.')})`,
        method: op.method,
        path,
        routePath: route,
        expected: `HTTP ${invalidCodes.join('/')}`,
        step: { action: 'request', method: op.method, path, body: setPath(ex.value, emailPath, 'not-an-email'), expectStatus: invalidCodes },
      });
    }
    add({
      kind: 'malformed_json',
      name: `${op.method} ${op.path} rejects malformed JSON`,
      method: op.method,
      path,
      routePath: route,
      expected: 'HTTP 400',
      step: { action: 'request', method: op.method, path, rawBody: '{"broken": ', expectStatus: [400] },
    });
  }

  // Endpoints seen in traffic/scripts but missing from the spec: smoke-test them.
  const specRoutes = new Set(ops.map((o) => routeOf(o.method, o.path)));
  const seenRoutes = new Set<string>();
  for (const e of discovered) {
    const route = routeOf(e.method, e.path);
    if (specRoutes.has(route) || seenRoutes.has(route)) continue;
    seenRoutes.add(route);
    const path = e.path.replace(/:id/g, 'qa-nonexistent-000');
    if (e.method === 'GET') {
      add({ kind: 'discovered_get', name: `GET ${e.path} does not error`, method: 'GET', path, routePath: e.path, expected: 'Any non-5xx response', step: { action: 'request', method: 'GET', path, expectStatus: range(200, 500), allowAnyBelow500: true } });
    } else if (['POST', 'PUT', 'PATCH'].includes(e.method)) {
      add({
        kind: 'discovered_post',
        name: `${e.method} ${e.path} handles an empty payload`,
        method: e.method,
        path,
        routePath: e.path,
        expected: 'A 4xx validation error, never 5xx',
        step: { action: 'request', method: e.method, path, body: {}, expectStatus: range(200, 500), allowAnyBelow500: true },
      });
    }
  }
  const all = [...ops.map((o) => o.path), ...discovered.map((d) => d.path)];
  const prefix = all.length && all.every((p) => p.startsWith('/api/')) ? '/api' : '';
  if (all.length) {
    const p = `${prefix}/qa-nonexistent-route-000`;
    add({ kind: 'unknown_route', name: `Unknown route ${p} returns 404`, method: 'GET', path: p, expected: 'HTTP 404', step: { action: 'request', method: 'GET', path: p, expectStatus: [404] } });
  }
  return checks.slice(0, 45);
}

// ------------------------------------------------------------------ functional scenarios
const SAMPLE: Record<DiscoveredField['semantic'], string> = {
  email: 'asha.qa@example.com',
  username: 'qa-tester',
  password: 'Wrong-Password-123!',
  name: 'Asha Rao',
  phone: '+1 555 010 2020',
  address: '12 Market Street, Springfield',
  text: 'QA automated test',
  number: '1',
  other: 'QA',
};

function fillForm(form: DiscoveredForm, overrides: Partial<Record<DiscoveredField['semantic'], string>> = {}): Step[] {
  return form.fields
    .filter((f) => !['checkbox', 'radio', 'select-one', 'select', 'file'].includes(f.type))
    .map((f) => ({ action: 'fill', target: f.locator, value: overrides[f.semantic] ?? SAMPLE[f.semantic] }) as Step);
}

const PASSIVE: Step[] = [{ action: 'expectNoServerErrors' }, { action: 'expectNoPageErrors' }];
const CONFIRMATION_RE = 'order (is )?(confirmed|placed|received|successful)|thank(s| you)|order (number|#)|payment successful';

export function buildScenarios(pages: PageInfo[], credentials: RunContext['credentials']): { scenarios: Scenario[]; workflows: string[] } {
  const scenarios: Scenario[] = [];
  const add = (s: Omit<Scenario, 'id'>) => scenarios.push({ ...s, id: `fn_${scenarios.length + 1}` });
  const byRole = (r: PageInfo['role']) => pages.find((p) => p.role === r);
  const login = byRole('login');
  const catalog = byRole('catalog');
  const cart = byRole('cart');
  const checkout = byRole('checkout');
  const workflows = new Set<string>();
  const addItem: Step[] = catalog?.addToCart ? [{ action: 'goto', path: catalog.path }, { action: 'click', target: catalog.addToCart.locator, description: `the first "${catalog.addToCart.locator.name}" button` }] : [];

  for (const p of pages) {
    add({
      kind: 'page_health',
      name: `Page loads cleanly: ${p.path}`,
      workflow: p.role === 'content' ? 'Navigation' : roleLabel(p.role),
      page: p.path,
      expected: 'Page returns 2xx, all images render, no 5xx calls, no JavaScript errors',
      steps: [{ action: 'goto', path: p.path }, { action: 'expectImagesLoaded' }, ...PASSIVE],
    });
  }

  if (login) {
    workflows.add('Login');
    const form = login.forms.find((f) => f.fields.some((x) => x.semantic === 'password'))!;
    const id = form.fields.find((f) => f.semantic !== 'password');
    const pw = form.fields.find((f) => f.semantic === 'password')!;
    const submit: Step = form.submit ? { action: 'click', target: form.submit, description: `the "${form.submitText || 'submit'}" button` } : { action: 'press', target: pw.locator, key: 'Enter' };
    add({
      kind: 'auth_invalid_login',
      name: 'Login with invalid credentials shows an error',
      workflow: 'Login',
      page: login.path,
      expected: 'A clear error message is shown; the API answers 4xx; no crash',
      steps: [
        { action: 'goto', path: login.path },
        ...(id ? [{ action: 'fill', target: id.locator, value: id.semantic === 'email' ? `qa-nobody-${randomId(3)}@example.com` : `qa-nobody-${randomId(3)}` } as Step] : []),
        { action: 'fill', target: pw.locator, value: 'Wrong-Password-123!' },
        submit,
        {
          action: 'expectAnyVisible',
          description: 'an error message for invalid credentials',
          timeoutMs: 4000,
          targets: [{ role: 'alert' }, { css: '.error:not(:empty), .alert-error:not(:empty), .invalid-feedback, [aria-invalid="true"]' }, { text: 'invalid' }, { text: 'incorrect' }],
        },
        ...PASSIVE,
      ],
    });
    if (credentials && id) {
      add({
        kind: 'auth_valid_login',
        name: 'Login with the configured test account succeeds',
        workflow: 'Login',
        page: login.path,
        expected: 'The user is signed in',
        steps: [
          { action: 'goto', path: login.path },
          { action: 'fill', target: id.locator, value: credentials.username },
          // The real password never enters the stored plan: it is resolved from encrypted settings at execution time.
          { action: 'fill', target: pw.locator, value: '{{secret:testPassword}}', secret: true },
          submit,
          { action: 'expectText', pattern: 'welcome|signed in|logged in|log ?out|sign ?out|dashboard|my account', timeoutMs: 6000, description: 'a signed-in state' },
          ...PASSIVE,
        ],
      });
    }
  }

  if (catalog) workflows.add('Menu');
  if (catalog?.addToCart && cart) {
    workflows.add('Cart');
    add({
      kind: 'cart_quantity',
      name: 'Changing an item quantity updates the cart total',
      workflow: 'Cart',
      page: cart.path,
      expected: 'Line subtotal and cart total equal unit price × quantity after setting quantity to 2',
      steps: [
        ...addItem,
        { action: 'goto', path: cart.path },
        { action: 'fill', target: { css: 'input[type=number], input[name*=qty i], input[name*=quantity i]' }, value: '2' },
        { action: 'press', target: { css: 'input[type=number], input[name*=qty i], input[name*=quantity i]' }, key: 'Tab' },
        { action: 'wait', ms: 300 },
        { action: 'expectCartMath' },
        ...PASSIVE,
      ],
    });
  }

  if (checkout) {
    workflows.add('Checkout');
    workflows.add('Order confirmation');
    const form = checkout.forms[0];
    if (form?.submit) {
      const submit: Step = { action: 'click', target: form.submit, description: `the "${form.submitText || 'submit'}" button` };
      add({
        kind: 'checkout_happy_path',
        name: 'Checkout with valid details shows an order confirmation',
        workflow: 'Checkout',
        page: checkout.path,
        expected: 'Order is accepted and a confirmation message is shown',
        steps: [...addItem, { action: 'goto', path: checkout.path }, ...fillForm(form), submit, { action: 'expectText', pattern: CONFIRMATION_RE, timeoutMs: 8000, description: 'an order confirmation message' }, ...PASSIVE],
      });
      add({
        kind: 'checkout_special_chars',
        name: 'Checkout with quotes/apostrophes/accents in the name still confirms the order',
        workflow: 'Order confirmation',
        page: checkout.path,
        expected: 'Customer names such as Zoë "QA" O\'Brien are accepted and the confirmation is shown',
        steps: [
          ...addItem,
          { action: 'goto', path: checkout.path },
          ...fillForm(form, { name: 'Zoë "QA" O\'Brien & Sons' }),
          submit,
          { action: 'expectText', pattern: CONFIRMATION_RE, timeoutMs: 8000, description: 'an order confirmation message' },
          ...PASSIVE,
        ],
      });
      add({
        kind: 'checkout_empty_submit',
        name: 'Submitting an empty checkout form is handled gracefully',
        workflow: 'Checkout',
        page: checkout.path,
        expected: 'Validation prevents submission or shows errors; no 5xx or crash',
        steps: [{ action: 'goto', path: checkout.path }, submit, { action: 'wait', ms: 500 }, ...PASSIVE],
      });
    }
  }

  for (const p of pages.filter((x) => x.role === 'content')) {
    for (const form of p.forms.slice(0, 1)) {
      if (!form.submit) continue;
      workflows.add('Forms');
      add({
        kind: 'form_smoke',
        name: `Form on ${p.path} submits without errors`,
        workflow: 'Forms',
        page: p.path,
        expected: 'Submitting valid data causes no 5xx and no JavaScript errors',
        steps: [{ action: 'goto', path: p.path }, ...fillForm(form), { action: 'click', target: form.submit }, { action: 'wait', ms: 500 }, ...PASSIVE],
      });
    }
  }
  if (!workflows.size) workflows.add('Navigation');
  return { scenarios, workflows: [...workflows] };
}

function roleLabel(role: PageInfo['role']) {
  return { login: 'Login', catalog: 'Menu', cart: 'Cart', checkout: 'Checkout', confirmation: 'Order confirmation', content: 'Navigation' }[role];
}

export function buildVisualTargets(pages: PageInfo[]): VisualTarget[] {
  const priority: PageInfo['role'][] = ['checkout', 'cart', 'catalog', 'login', 'confirmation', 'content'];
  const catalog = pages.find((p) => p.role === 'catalog' && p.addToCart);
  const sorted = [...pages].sort((a, b) => priority.indexOf(a.role) - priority.indexOf(b.role));
  return sorted.slice(0, 6).map((p, i) => ({
    id: `vis_${i + 1}`,
    name: `${roleLabel(p.role)} page (${p.path})`,
    path: p.path,
    setup:
      (p.role === 'cart' || p.role === 'checkout') && catalog?.addToCart
        ? [
            { action: 'goto', path: catalog.path },
            { action: 'click', target: catalog.addToCart.locator },
          ]
        : [],
  }));
}

// ------------------------------------------------------------------ agent entry
export async function runTestPlanner(ctx: RunContext, browser: Browser): Promise<{ plan: TestPlan; output: Record<string, unknown> }> {
  ctx.log('test_planner', `Exploring ${ctx.appUrl} (up to ${ctx.maxPages} pages)`);
  const { pages, scripts, traffic } = await crawl(ctx, browser);
  const [spec, scripted] = await Promise.all([loadSpec(ctx), scanScripts(scripts)]);
  if (spec.url) ctx.log('test_planner', spec.error ? `API spec ${spec.url} could not be loaded: ${spec.error}` : `Loaded API spec ${spec.url} (${spec.ops.length} operations)`, spec.error ? 'warn' : 'info');
  const endpointMap = new Map<string, DiscoveredEndpoint>();
  for (const e of [...spec.ops.map((o) => ({ method: o.method, path: o.path.replace(/\{[^}]+\}/g, ':id'), source: 'spec' as const })), ...traffic, ...scripted]) {
    const key = routeOf(e.method, e.path);
    if (!endpointMap.has(key)) endpointMap.set(key, e);
  }
  const endpoints = [...endpointMap.values()];
  const { scenarios, workflows } = buildScenarios(pages, ctx.credentials);
  const apiChecks = buildApiChecks(spec.ops, [...traffic, ...scripted]);
  const visualTargets = buildVisualTargets(pages);
  const notes: string[] = [];
  if (!spec.ops.length) notes.push('No OpenAPI spec found — API checks are derived from observed traffic and script analysis.');
  if (apiChecks.some((c) => c.method !== 'GET')) notes.push('API checks send write requests; point projects at staging environments.');
  if (!ctx.credentials && pages.some((p) => p.role === 'login')) notes.push('Add a test account in project settings to also verify successful login.');

  let engine = 'heuristic';
  if (llmEnabled()) {
    ctx.aiCalls++;
    const extra = await askJson<{ notes?: string[]; risks?: string[] }>({
      system: 'You are a senior QA engineer planning automated tests for a small web application.',
      prompt: `Pages discovered:\n${pages.map((p) => `- ${p.path} [${p.role}] "${p.title}" headings=${JSON.stringify(p.headings)} forms=${p.forms.map((f) => f.fields.map((x) => x.semantic).join('/')).join(';')}`).join('\n')}\nAPI endpoints: ${endpoints.map((e) => `${e.method} ${e.path}`).join(', ')}\nWorkflows planned: ${workflows.join(', ')}.\nReturn {"notes": [up to 3 short additional test ideas], "risks": [up to 3 highest-risk areas]}.`,
      maxTokens: 500,
    });
    if (extra) {
      engine = 'heuristic+llm';
      for (const n of [...(extra.notes || []), ...(extra.risks || []).map((r) => `Risk: ${r}`)].slice(0, 6)) notes.push(sanitizeText(n, 200));
    }
  }

  const plan: TestPlan = {
    appUrl: ctx.appUrl,
    engine,
    pages,
    workflows,
    scenarios,
    apiChecks,
    visualTargets,
    viewports: ctx.viewports,
    endpoints,
    spec: { url: spec.url, loaded: spec.ops.length > 0, operations: spec.ops.length, error: spec.error },
    notes,
  };
  ctx.log('test_planner', `Plan ready: ${workflows.join(', ')} · ${scenarios.length} functional scenarios · ${apiChecks.length} API checks · ${visualTargets.length}×${ctx.viewports.length} visual captures`);
  return {
    plan,
    output: {
      workflows,
      pages: pages.map((p) => ({ path: p.path, role: p.role, status: p.status, forms: p.forms.length })),
      scenarios: scenarios.map((s) => ({ id: s.id, kind: s.kind, name: s.name, workflow: s.workflow })),
      apiChecks: apiChecks.map((c) => ({ id: c.id, kind: c.kind, name: c.name })),
      visualTargets: visualTargets.map((v) => ({ id: v.id, path: v.path })),
      viewports: ctx.viewports,
      endpoints,
      spec: plan.spec,
      notes,
      engine,
    },
  };
}
