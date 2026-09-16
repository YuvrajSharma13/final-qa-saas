import crypto from 'node:crypto';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { config } from '../config.js';
import { asyncHandler, HttpError, parseBody } from '../lib/http.js';
import { VIEWPORTS } from '../lib/plans.js';
import { assertTargetAllowed, normalizeAppUrl } from '../lib/urlSafety.js';
import { runTestPlanner } from '../qa/agents/planner.js';
import { analyzeGeometry } from '../qa/agents/vision.js';
import { instrumentedPage, launchBrowser, settle } from '../qa/browser.js';
import { decode } from '../qa/cv/imageOps.js';
import { VISUAL_GEOMETRY, runInPage } from '../qa/pageScripts.js';
import { queueStats } from '../qa/queue.js';
import type { RunContext } from '../qa/types.js';

// Internal orchestration endpoints. Server-side only: disabled unless INTERNAL_API_TOKEN
// is configured, and every call must present it. Never called from the browser app.
export const agentsRouter = Router();

function requireInternal(req: Request, _res: Response, next: NextFunction) {
  if (!config.internalToken) return next(new HttpError(404, 'Not found'));
  const given = Buffer.from(req.header('x-internal-token') || '');
  const expected = Buffer.from(config.internalToken);
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return next(new HttpError(401, 'Invalid internal token'));
  next();
}
agentsRouter.use(requireInternal);

agentsRouter.get('/queue', (_req, res) => {
  res.json(queueStats());
});

function scratchCtx(appUrl: string, extra: Partial<RunContext> = {}): RunContext & { logs: string[] } {
  const logs: string[] = [];
  return {
    runId: new Types.ObjectId(),
    projectId: new Types.ObjectId(),
    workspaceId: new Types.ObjectId(),
    appUrl,
    repoUrl: '',
    apiSpecUrl: '',
    apiBaseUrl: '',
    viewports: ['desktop', 'mobile'],
    maxPages: 6,
    credentials: null,
    githubToken: '',
    aiCalls: 0,
    isCanceled: () => false,
    log: (agent, m) => logs.push(`[${agent}] ${m}`),
    logs,
    ...extra,
  };
}

agentsRouter.post(
  '/plan',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ appUrl: z.string(), apiSpecUrl: z.string().optional(), maxPages: z.number().int().min(1).max(10).optional() }), req.body);
    const appUrl = normalizeAppUrl(body.appUrl);
    await assertTargetAllowed(appUrl);
    const browser = await launchBrowser();
    try {
      const ctx = scratchCtx(appUrl, { apiSpecUrl: body.apiSpecUrl || '', maxPages: body.maxPages || 6 });
      const { plan } = await runTestPlanner(ctx, browser);
      res.json({ plan, logs: ctx.logs });
    } finally {
      await browser.close();
    }
  }),
);

agentsRouter.post(
  '/vision',
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ url: z.string(), viewport: z.enum(['desktop', 'tablet', 'mobile']).default('mobile') }), req.body);
    const url = normalizeAppUrl(body.url);
    await assertTargetAllowed(url);
    const browser = await launchBrowser();
    try {
      const ip = await instrumentedPage(browser, url, body.viewport);
      await ip.page.goto(url, { waitUntil: 'load' });
      await settle(ip.page);
      const geo = await runInPage<Parameters<typeof analyzeGeometry>[0]>(ip.page, VISUAL_GEOMETRY);
      const png = await ip.page.screenshot({ fullPage: true });
      const issues = analyzeGeometry(geo, await decode(png), body.viewport);
      res.json({ viewport: VIEWPORTS[body.viewport], issues });
    } finally {
      await browser.close();
    }
  }),
);
