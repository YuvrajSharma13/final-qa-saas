import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from '../config.js';
import { VIEWPORTS } from '../lib/plans.js';
import { sanitizeText, sanitizeValue } from '../lib/sanitize.js';
import type { ConsoleEntry, NetworkEntry } from './types.js';

export async function launchBrowser(): Promise<Browser> {
  return chromium.launch({
    executablePath: config.chromiumPath,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox', '--hide-scrollbars', '--font-render-hinting=none'],
  });
}

const ID_SEGMENT = /^(\d+|[0-9a-f]{6,}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|qa-[\w-]+)$/i;

/** "GET https://x/api/orders/7ffb3b45?x=1" -> "GET /api/orders/:id" */
export function routeOf(method: string, urlOrPath: string): string {
  let pathname = urlOrPath.replace(/\{[^}/]+\}/g, ':id');
  try {
    pathname = new URL(pathname, 'http://placeholder').pathname;
  } catch {
    /* keep */
  }
  const norm = pathname
    .split('/')
    .map((seg) => (ID_SEGMENT.test(seg) ? ':id' : seg))
    .join('/')
    .replace(/\{[^}]+\}/g, ':id');
  return `${method.toUpperCase()} ${norm || '/'}`;
}

export interface Instrumented {
  context: BrowserContext;
  page: Page;
  network: NetworkEntry[];
  console: ConsoleEntry[];
  pageErrors: string[];
  mark(): { network: number; console: number; pageErrors: number };
  close(): Promise<void>;
}

export async function instrumentedPage(browser: Browser, appUrl: string, viewportName = 'desktop'): Promise<Instrumented> {
  const vp = VIEWPORTS[viewportName] || VIEWPORTS.desktop;
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    deviceScaleFactor: 1,
    isMobile: vp.isMobile,
    hasTouch: vp.isMobile,
    userAgent: `Mozilla/5.0 (AI-QA-SaaS Bot; ${vp.name}) Chrome/141 Safari/537.36`,
    ignoreHTTPSErrors: false,
  });
  context.setDefaultTimeout(8000);
  context.setDefaultNavigationTimeout(15000);
  const page = await context.newPage();
  const origin = new URL(appUrl).origin;
  const network: NetworkEntry[] = [];
  const consoleEntries: ConsoleEntry[] = [];
  const pageErrors: string[] = [];
  const started = new Map<unknown, number>();

  page.on('request', (req) => started.set(req, Date.now()));
  page.on('response', async (res) => {
    const req = res.request();
    const url = req.url();
    if (!url.startsWith('http')) return;
    const entry: NetworkEntry = {
      method: req.method(),
      url: sanitizeText(url, 500),
      path: sameOriginPath(url, origin),
      status: res.status(),
      resourceType: req.resourceType(),
      durationMs: started.has(req) ? Date.now() - (started.get(req) as number) : undefined,
    };
    const post = req.postData();
    if (post) {
      try {
        entry.requestBody = sanitizeValue(JSON.parse(post));
      } catch {
        entry.requestBody = sanitizeText(post, 500);
      }
    }
    network.push(entry);
    if (res.status() >= 400 && ['xhr', 'fetch', 'document'].includes(req.resourceType())) {
      try {
        entry.responseSnippet = sanitizeText((await res.text()).replace(/\s+/g, ' '), 400);
      } catch {
        /* body unavailable */
      }
    }
  });
  page.on('requestfailed', (req) => {
    network.push({
      method: req.method(),
      url: sanitizeText(req.url(), 500),
      path: sameOriginPath(req.url(), origin),
      status: 0,
      resourceType: req.resourceType(),
      responseSnippet: req.failure()?.errorText,
    });
  });
  page.on('console', (msg) => {
    if (['error', 'warning'].includes(msg.type())) consoleEntries.push({ type: msg.type(), text: sanitizeText(msg.text(), 500) });
  });
  page.on('pageerror', (err) => pageErrors.push(sanitizeText(`${err.name}: ${err.message}`, 500)));

  return {
    context,
    page,
    network,
    console: consoleEntries,
    pageErrors,
    mark: () => ({ network: network.length, console: consoleEntries.length, pageErrors: pageErrors.length }),
    close: () => context.close().catch(() => undefined),
  };
}

function sameOriginPath(url: string, origin: string) {
  try {
    const u = new URL(url);
    return u.origin === origin ? `${u.pathname}${u.search}` : u.toString();
  } catch {
    return url;
  }
}

export async function settle(page: Page, ms = 4000) {
  await page.waitForLoadState('load', { timeout: ms }).catch(() => undefined);
  await page.waitForLoadState('networkidle', { timeout: ms }).catch(() => undefined);
}

export function absoluteUrl(base: string, path: string) {
  return new URL(path, base).toString();
}
