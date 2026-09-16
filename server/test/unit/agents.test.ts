import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

process.env.AI_DISABLED = '1';
const here = path.dirname(fileURLToPath(import.meta.url));

const { routeOf } = await import('../../src/qa/browser.js');
const { buildApiChecks, classifyPage, buildScenarios } = await import('../../src/qa/agents/planner.js');
const { clusterFindings, describeCluster } = await import('../../src/qa/agents/bugAnalyzer.js');
const { analyzeBugAgainstRepo, loadLocalRepo } = await import('../../src/qa/agents/codeAnalysis.js');
const { toPlaywright, buildRegressionSteps } = await import('../../src/qa/agents/regression.js');
const { decode, verifyClipEdge, regionStats } = await import('../../src/qa/cv/imageOps.js');
const { compareImages } = await import('../../src/qa/cv/diff.js');
const { regionLabel } = await import('../../src/qa/agents/vision.js');
const { sanitizeText, sanitizeValue } = await import('../../src/lib/sanitize.js');
const { encryptSecret, decryptSecret } = await import('../../src/lib/crypto.js');
const { qaScore } = await import('../../src/qa/orchestrator.js');
const { isPrivateIp } = await import('../../src/lib/urlSafety.js');

import type { Finding } from '../../src/qa/types.js';

const base = (over: Partial<Finding>): Finding => ({
  source: 'functional',
  testCaseId: 't',
  title: 'x',
  symptom: 'server_error',
  expected: 'e',
  actual: 'a',
  severityHint: 'medium',
  confidence: 'high',
  screenshotIds: [],
  network: [],
  console: [],
  ...over,
});

describe('routing & planning', () => {
  test('routeOf normalises ids and OpenAPI params', () => {
    assert.equal(routeOf('get', 'http://x/api/orders/7ffb3b45?y=1'), 'GET /api/orders/:id');
    assert.equal(routeOf('GET', '/api/menu/{id}'), 'GET /api/menu/:id');
    assert.equal(routeOf('POST', '/api/orders'), 'POST /api/orders');
    assert.equal(routeOf('GET', '/api/orders/qa-nonexistent-000'), 'GET /api/orders/:id');
  });

  test('page classification', () => {
    const pw = { fields: [{ semantic: 'password' }], submit: null, submitText: '' } as never;
    assert.equal(classifyPage('/login', { title: 'Sign in', headings: [], forms: [pw], addToCart: null }), 'login');
    assert.equal(classifyPage('/checkout', { title: 'Checkout', headings: [], forms: [], addToCart: null }), 'checkout');
    assert.equal(classifyPage('/cart', { title: 'Your cart', headings: [], forms: [], addToCart: null }), 'cart');
    assert.equal(classifyPage('/menu', { title: 'Menu', headings: [], forms: [], addToCart: { locator: {}, count: 3 } }), 'catalog');
  });

  test('API checks derived from an OpenAPI operation include edge cases', () => {
    const ops = [
      {
        method: 'POST',
        path: '/api/orders',
        params: [],
        bodySchema: {
          type: 'object',
          required: ['customer', 'items'],
          properties: {
            customer: { type: 'object', properties: { email: { type: 'string', format: 'email', example: 'a@b.co' } } },
            items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string', example: 'm1' } } } },
          },
        },
        successCodes: [201],
        declaredCodes: [201, 400],
        jsonResponse: false,
      },
    ];
    const checks = buildApiChecks(ops as never, []);
    const kinds = checks.map((c) => c.kind);
    for (const k of ['contract', 'empty_body', 'missing_field', 'wrong_type', 'invalid_format', 'malformed_json', 'unknown_route']) assert.ok(kinds.includes(k as never), k);
    const invalidEmail = checks.find((c) => c.kind === 'invalid_format')!;
    assert.deepEqual((invalidEmail.step.body as { customer: { email: string } }).customer.email, 'not-an-email');
    assert.ok(checks.every((c) => c.route.startsWith('POST /api/orders') || c.kind === 'unknown_route'));
  });

  test('scenario builder never stores the real test password', () => {
    const login = {
      path: '/login',
      role: 'login',
      forms: [
        {
          fields: [
            { locator: { css: '#email' }, type: 'email', name: 'email', label: 'Email', required: true, semantic: 'email' },
            { locator: { css: '#pw' }, type: 'password', name: 'pw', label: 'Password', required: true, semantic: 'password' },
          ],
          submit: { css: 'button' },
          submitText: 'Sign in',
        },
      ],
    };
    const { scenarios, workflows } = buildScenarios([login] as never, { username: 'u@x.io', password: 'TopSecret!' });
    assert.ok(workflows.includes('Login'));
    assert.ok(scenarios.some((s) => s.kind === 'auth_valid_login'));
    assert.ok(!JSON.stringify(scenarios).includes('TopSecret!'));
  });
});

describe('bug analyzer', () => {
  test('correlates functional + API failures on the same endpoint into one bug', () => {
    const fs = [
      base({ source: 'functional', scenarioKind: 'auth_invalid_login', workflow: 'Login', route: 'POST /api/login', status: 500, severityHint: 'high', details: { symptoms: ['server_error', 'missing_feedback'] } }),
      base({ source: 'api', route: 'POST /api/login', status: 500, severityHint: 'high', details: { kind: 'invalid_credentials' } }),
      base({ source: 'api', route: 'POST /api/login', status: 500, severityHint: 'high', details: { kind: 'empty_body' } }),
      base({ source: 'vision', symptom: 'clipped_element', page: '/checkout', viewport: 'mobile', element: { selector: '#place-order', text: 'Place order' }, severityHint: 'medium', details: { tag: 'button', likelyCause: 'fixed min-width: 420px' } }),
      base({ source: 'vision', symptom: 'clipped_element', page: '/checkout', viewport: 'tablet', element: { selector: '#place-order', text: 'Place order' }, severityHint: 'medium', details: { tag: 'button' } }),
      base({ source: 'functional', symptom: 'broken_image', page: '/menu', severityHint: 'low', details: { imageSrc: '/img/a.png', imageStatus: 404 } }),
      base({ source: 'vision', symptom: 'broken_image', page: '/menu', viewport: 'mobile', severityHint: 'low', details: { imageSrc: '/img/a.png' } }),
    ];
    const clusters = clusterFindings(fs);
    assert.equal(clusters.length, 3);
    const login = describeCluster(clusters.find((c) => c.key === 'route:POST /api/login')!);
    assert.match(login.title, /Login fails with HTTP 500 .* no error message/);
    assert.equal(login.category, 'functional');
    assert.deepEqual(login.sources.sort(), ['api', 'functional']);
    const visual = describeCluster(clusters.find((c) => c.key.startsWith('visual:'))!);
    assert.match(visual.title, /Checkout UI clipped on mobile & tablet .*button is cut off/);
    assert.equal(visual.category, 'visual');
    const img = describeCluster(clusters.find((c) => c.key.startsWith('asset:'))!);
    assert.match(img.title, /Broken image on \/menu: \/img\/a\.png returns HTTP 404/);
  });

  test('calculation mismatch explains that quantity is ignored', () => {
    const d = describeCluster({
      key: 'flow:Cart:cart_quantity:calculation_mismatch',
      findings: [base({ symptom: 'calculation_mismatch', workflow: 'Cart', scenarioKind: 'cart_quantity', details: { failures: [{ symptom: 'calculation_mismatch', data: { total: 12.5, sumUnits: 12.5 } }] } })],
    });
    assert.equal(d.title, 'Cart total is incorrect after changing item quantity');
    assert.match(d.likelyCause, /quantity is not multiplied/);
  });
});

describe('code analysis (QuickBite repository)', async () => {
  const files = await loadLocalRepo(path.resolve(here, '../../../quickbite'));
  const bug = (over: Record<string, unknown>) => ({ _id: 'b', title: '', category: 'functional', location: {}, rootCause: {}, ...over }) as never;

  test('points the cart bug at cart.js with a patch', async () => {
    const a = await analyzeBugAgainstRepo(bug({ title: 'Cart total is incorrect after changing item quantity', location: { pages: ['/cart'], scenarioKinds: ['cart_quantity'] } }), files);
    assert.equal(a.fileReferences[0].path, 'public/js/cart.js');
    assert.match(a.patch!, /\+.*line\.price \* line\.quantity/);
  });

  test('points the login crash at the missing null check first', async () => {
    const a = await analyzeBugAgainstRepo(bug({ title: 'Login fails', location: { routes: ['POST /api/login'], pages: ['/login'], scenarioKinds: ['auth_invalid_login'] } }), files);
    assert.equal(a.fileReferences[0].path, 'src/routes/auth.js');
    assert.equal(a.fileReferences[0].pattern, 'missing-null-check');
    assert.ok(a.fileReferences.some((f) => f.path === 'public/js/login.js' && f.pattern === 'unchecked-response'));
  });

  test('finds string-built JSON for the special-character bug', async () => {
    const a = await analyzeBugAgainstRepo(bug({ title: 'Order confirmation fails', location: { routes: ['GET /api/orders/:id'], pages: ['/checkout'], scenarioKinds: ['checkout_special_chars'] } }), files);
    assert.equal(a.fileReferences[0].path, 'src/routes/orders.js');
    assert.equal(a.fileReferences[0].pattern, 'string-built-json');
  });

  test('finds the fixed-width CSS rule for the clipped button', async () => {
    const a = await analyzeBugAgainstRepo(bug({ title: 'Checkout UI clipped', category: 'visual', location: { selectors: ['#place-order'], classes: ['btn', 'place-order-btn'], clipper: 'div.checkout-card', pages: ['/checkout'] } }), files);
    assert.equal(a.fileReferences[0].path, 'public/css/styles.css');
    assert.match(a.fileReferences[0].reason, /min-width: 420px/);
    assert.ok(!a.fileReferences[0].reason.includes('/*'), 'comments are not part of the selector');
  });
});

describe('computer vision primitives', () => {
  test('pixel-edge analysis confirms a button cut by its container', async () => {
    // 200×100 white page; card clips at x=120; red "button" painted from x=40 up to the clip edge.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#ffffff"/><rect x="118" y="0" width="2" height="100" fill="#dddddd"/><rect x="40" y="40" width="80" height="30" fill="#dc2626"/></svg>`;
    const png = await sharp(Buffer.from(svg)).png().toBuffer();
    const img = await decode(png);
    const cut = verifyClipEdge(img, { x: 40, y: 40, width: 140, height: 30 }, 'right', 118);
    assert.equal(cut.confirmed, true, JSON.stringify(cut));
    // A button that ends well before the edge is not "cut".
    const notCut = verifyClipEdge(img, { x: 40, y: 40, width: 60, height: 30 }, 'right', 160);
    assert.equal(notCut.confirmed, false);
  });

  test('region statistics separate flat and detailed regions', async () => {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect width="100" height="50" fill="#ffffff"/><rect width="50" height="50" fill="#f3f4f6"/>${Array.from({ length: 10 }, (_, i) => `<rect x="${50 + i * 5}" y="0" width="2" height="50" fill="#000"/>`).join('')}</svg>`;
    const img = await decode(await sharp(Buffer.from(svg)).png().toBuffer());
    const flat = regionStats(img, { x: 0, y: 0, width: 50, height: 50 });
    const busy = regionStats(img, { x: 50, y: 0, width: 50, height: 50 });
    assert.ok(flat.stdLum < 2 && flat.edgeDensity === 0, JSON.stringify(flat));
    assert.ok(busy.stdLum > 50 && busy.edgeDensity > 0.2, JSON.stringify(busy));
  });

  test('reference diff clusters the changed region', async () => {
    const mk = (x: number) => sharp(Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200"><rect width="300" height="200" fill="#fff"/><rect x="${x}" y="50" width="80" height="40" fill="#1d4ed8"/></svg>`)).png().toBuffer();
    const same = await compareImages(await mk(20), await mk(20));
    assert.equal(same.changedPixels, 0);
    const moved = await compareImages(await mk(20), await mk(180));
    assert.ok(moved.ratio > 0.05);
    assert.ok(moved.regions.length >= 1);
  });

  test('region labels', () => {
    assert.equal(regionLabel({ x: 300, y: 700, width: 60, height: 40 }, 375, 812), 'bottom-right');
    assert.equal(regionLabel({ x: 0, y: 0, width: 50, height: 20 }, 375, 812), 'top-left');
  });
});

describe('regression export & security helpers', () => {
  test('regression steps and Playwright export', () => {
    const { steps } = buildRegressionSteps({
      category: 'visual',
      location: {},
      evidence: { clusterKey: 'visual:/checkout', findings: [{ source: 'vision', symptom: 'clipped_element', page: '/checkout', viewport: 'mobile', element: { selector: '#place-order', text: 'Place order' }, details: { setup: [] } }] },
    } as never);
    assert.deepEqual(steps.map((s) => s.action), ['setViewport', 'goto', 'expectFullyVisible']);
    const code = toPlaywright('Clipped button', [...steps, { action: 'request', method: 'POST', path: '/api/orders', body: {}, expectStatus: [400, 422] }], 'http://localhost:4100/');
    assert.match(code, /import \{ test, expect \} from '@playwright\/test'/);
    assert.match(code, /setViewportSize\(\{ width: 375, height: 812 \}\)/);
    assert.match(code, /request\.fetch/);
    assert.match(code, /toBeGreaterThan\(0\.98\)/);
  });

  test('secrets are encrypted and sanitised', () => {
    const enc = encryptSecret('ghp_abcdefghijklmnopqrstuvwxyz123456');
    assert.ok(!enc.includes('ghp_'));
    assert.equal(decryptSecret(enc), 'ghp_abcdefghijklmnopqrstuvwxyz123456');
    assert.equal(sanitizeText('token ghp_abcdefghijklmnopqrstuvwxyz123456 used'), 'token [REDACTED_GITHUB_TOKEN] used');
    assert.match(sanitizeText('Authorization: Bearer abc.def.ghijklmnop'), /Bearer \[REDACTED\]/);
    assert.deepEqual(sanitizeValue({ email: 'a@b.c', password: 'x', nested: { apiKey: 'k' } }), { email: 'a@b.c', password: '[REDACTED]', nested: { apiKey: '[REDACTED]' } });
  });

  test('SSRF guard recognises private addresses', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '192.168.1.1', '172.20.0.1', '169.254.169.254', '::1']) assert.ok(isPrivateIp(ip), ip);
    for (const ip of ['8.8.8.8', '1.1.1.1']) assert.ok(!isPrivateIp(ip), ip);
  });

  test('QA score', () => {
    assert.equal(qaScore(50, 50, {}), 100);
    assert.equal(qaScore(29, 45, { critical: 1, high: 3, medium: 1, low: 1 }), 20);
    assert.equal(qaScore(0, 0, {}), 0);
  });
});
