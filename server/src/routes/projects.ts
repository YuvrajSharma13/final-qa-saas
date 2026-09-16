import path from 'node:path';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import sharp from 'sharp';
import { z } from 'zod';
import { config } from '../config.js';
import { parseGithubRepoUrl } from '../github/client.js';
import { encryptSecret } from '../lib/crypto.js';
import { asyncHandler, HttpError, objectId, parseBody } from '../lib/http.js';
import { planFor, VIEWPORTS } from '../lib/plans.js';
import { storage } from '../lib/storage.js';
import { assertCanCreateProject, assertCanStartRun, incrementUsage } from '../lib/usage.js';
import { assertTargetAllowed, normalizeAppUrl } from '../lib/urlSafety.js';
import { assertWorkspaceAccess, requireWorkspaceRole } from '../middleware/auth.js';
import { Bug, Project, RegressionTest, Screenshot, TestRun, type ProjectDoc } from '../models/index.js';
import { enqueueRun } from '../qa/queue.js';

export const projectsRouter = Router();

const viewportEnum = z.enum(['desktop', 'tablet', 'mobile']);
const settingsSchema = z
  .object({
    apiSpecUrl: z.string().trim().max(500).optional(),
    apiBaseUrl: z.string().trim().max(500).optional(),
    viewports: z.array(viewportEnum).min(1).max(3).optional(),
    maxPages: z.number().int().min(1).max(25).optional(),
    agents: z
      .object({ functional: z.boolean(), api: z.boolean(), vision: z.boolean(), code: z.boolean() })
      .partial()
      .optional(),
    testUsername: z.string().trim().max(200).optional(),
    testPassword: z.string().max(200).nullable().optional(),
    githubToken: z.string().trim().max(300).nullable().optional(),
    notifyOnCritical: z.boolean().optional(),
  })
  .strict();

const projectSchema = z.object({
  name: z.string().trim().min(1).max(80),
  appUrl: z.string().trim().min(1).max(500),
  repoUrl: z.string().trim().max(500).optional().default(''),
  settings: settingsSchema.optional(),
});

export function validateRepoUrl(repoUrl: string): string {
  if (!repoUrl) return '';
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+?(\.git)?\/?$/.test(repoUrl)) return repoUrl.replace(/\.git$|\/$/g, '');
  const ghe = parseGithubRepoUrl(repoUrl);
  if (ghe && repoUrl.startsWith(config.github.webUrl)) return `${config.github.webUrl}/${ghe.owner}/${ghe.repo}`;
  const isLocal = repoUrl.startsWith('file://') || path.isAbsolute(repoUrl);
  if (isLocal) {
    if (!config.allowLocalRepos) throw new HttpError(400, 'Local repository paths are disabled on this server');
    return repoUrl;
  }
  throw new HttpError(400, 'Repository must be a GitHub URL like https://github.com/owner/repo');
}

export function serializeProject(p: ProjectDoc) {
  const s = (p.settings || {}) as NonNullable<ProjectDoc["settings"]>;
  return {
    id: p._id,
    workspaceId: p.workspaceId,
    name: p.name,
    appUrl: p.appUrl,
    repoUrl: p.repoUrl,
    status: p.status,
    lastRun: p.lastRun,
    createdAt: (p as { createdAt?: Date }).createdAt,
    settings: {
      apiSpecUrl: s.apiSpecUrl,
      apiBaseUrl: s.apiBaseUrl,
      viewports: s.viewports,
      maxPages: s.maxPages,
      agents: s.agents,
      testUsername: s.testUsername,
      notifyOnCritical: s.notifyOnCritical,
      // Secrets are write-only: the browser only learns whether they exist.
      hasTestPassword: Boolean(s.testPasswordEnc),
      hasGithubToken: Boolean(s.githubTokenEnc),
      github: s.github?.owner
        ? { owner: s.github.owner, repo: s.github.repo, baseBranch: s.github.baseBranch, defaultBranch: s.github.defaultBranch, private: s.github.private, linkedAt: s.github.linkedAt }
        : null,
    },
  };
}

function applySettings(target: Record<string, unknown>, input: z.infer<typeof settingsSchema> | undefined, planId: string) {
  if (!input) return;
  const plan = planFor(planId);
  const { testPassword, githubToken, agents, viewports, maxPages, ...rest } = input;
  Object.assign(target, rest);
  if (agents) target.agents = { ...(target.agents as object), ...agents };
  if (viewports) {
    const blocked = viewports.filter((v) => !plan.viewports.includes(v));
    if (blocked.length) throw new HttpError(402, `The ${plan.name} plan does not include the ${blocked.join(', ')} viewport`);
    target.viewports = viewports;
  }
  if (maxPages !== undefined) target.maxPages = Math.min(maxPages, plan.maxPages);
  if (testPassword !== undefined) target.testPasswordEnc = testPassword ? encryptSecret(testPassword) : '';
  if (githubToken !== undefined) target.githubTokenEnc = githubToken ? encryptSecret(githubToken) : '';
}

export async function loadProject(userId: Parameters<typeof assertWorkspaceAccess>[0], id: unknown, min: Parameters<typeof assertWorkspaceAccess>[2] = 'viewer') {
  const project = await Project.findById(objectId(id, 'Project'));
  if (!project) throw new HttpError(404, 'Project not found');
  const role = await assertWorkspaceAccess(userId, project.workspaceId, min);
  return { project, role };
}

projectsRouter.post(
  '/',
  requireWorkspaceRole('developer'),
  asyncHandler(async (req, res) => {
    const body = parseBody(projectSchema, req.body);
    const ws = req.workspace!;
    await assertCanCreateProject(ws.id);
    const appUrl = normalizeAppUrl(body.appUrl);
    await assertTargetAllowed(appUrl);
    const settings: Record<string, unknown> = {
      viewports: ['desktop', 'mobile'],
      maxPages: Math.min(8, planFor(ws.plan).maxPages),
      agents: { functional: true, api: true, vision: true, code: true },
    };
    applySettings(settings, body.settings, ws.plan);
    if (settings.apiSpecUrl) settings.apiSpecUrl = resolveSpecUrl(String(settings.apiSpecUrl), appUrl);
    const project = await Project.create({
      workspaceId: ws.id,
      name: body.name,
      appUrl,
      repoUrl: validateRepoUrl(body.repoUrl),
      settings,
      createdBy: req.user!.id,
    });
    res.status(201).json({ project: serializeProject(project.toObject() as ProjectDoc) });
  }),
);

function resolveSpecUrl(spec: string, appUrl: string) {
  try {
    const u = new URL(spec, appUrl);
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
    return u.toString();
  } catch {
    throw new HttpError(400, 'API spec URL is invalid');
  }
}

projectsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const projects = await Project.find({ workspaceId: req.workspace!.id, status: 'active' }).sort({ createdAt: -1 }).lean();
    const openBugs = await Bug.find({ workspaceId: req.workspace!.id, status: 'open' }, { projectId: 1, severity: 1 }).lean();
    res.json({
      projects: projects.map((p) => ({
        ...serializeProject(p as ProjectDoc),
        openBugs: openBugs.filter((b) => String(b.projectId) === String(p._id)).length,
      })),
    });
  }),
);

projectsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { project, role } = await loadProject(req.user!.id, req.params.id);
    const [runs, bugs, regressionTests, baselines] = await Promise.all([
      TestRun.find({ projectId: project._id }, { events: 0, plan: 0 }).sort({ createdAt: -1 }).limit(30).lean(),
      Bug.find({ projectId: project._id }, { evidence: 0, history: 0 }).sort({ updatedAt: -1 }).lean(),
      RegressionTest.find({ projectId: project._id }, { code: 0 }).sort({ updatedAt: -1 }).lean(),
      Screenshot.find({ projectId: project._id, $or: [{ isBaseline: true }, { kind: 'reference' }] }, { annotations: 0 }).lean(),
    ]);
    res.json({ project: serializeProject(project.toObject() as ProjectDoc), role, runs, bugs, regressionTests, baselines });
  }),
);

projectsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    const body = parseBody(projectSchema.partial(), req.body);
    if (body.name) project.name = body.name;
    if (body.appUrl) {
      project.appUrl = normalizeAppUrl(body.appUrl);
      await assertTargetAllowed(project.appUrl);
    }
    if (body.repoUrl !== undefined) project.repoUrl = validateRepoUrl(body.repoUrl);
    if (body.settings) {
      const settings = project.toObject().settings as Record<string, unknown>;
      const { Workspace } = await import('../models/index.js');
      const ws = await Workspace.findById(project.workspaceId).lean();
      applySettings(settings, body.settings, ws?.plan || 'free');
      if (body.settings.apiSpecUrl) settings.apiSpecUrl = resolveSpecUrl(body.settings.apiSpecUrl, project.appUrl);
      project.set('settings', settings);
    }
    await project.save();
    res.json({ project: serializeProject(project.toObject() as ProjectDoc) });
  }),
);

projectsRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'admin');
    project.status = 'archived';
    await project.save();
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ runs
const runLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.RUN_RATE_LIMIT || 6),
  keyGenerator: (req) => String(req.user?.id),
  message: { error: 'Too many QA runs started, please wait a minute.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

const runSchema = z
  .object({
    agents: z
      .object({ functional: z.boolean(), api: z.boolean(), vision: z.boolean(), code: z.boolean() })
      .partial()
      .optional(),
    viewports: z.array(viewportEnum).min(1).max(3).optional(),
    maxPages: z.number().int().min(1).max(25).optional(),
    trigger: z.enum(['manual', 'rerun', 'api']).optional(),
  })
  .strict();

projectsRouter.post(
  '/:id/runs',
  runLimiter,
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    if (project.status !== 'active') throw new HttpError(400, 'Project is archived');
    const body = parseBody(runSchema, req.body || {});
    const plan = await assertCanStartRun(project.workspaceId);
    const active = await TestRun.countDocuments({ projectId: project._id, status: { $in: ['queued', 'running'] } });
    if (active > 0) throw new HttpError(409, 'A QA run is already in progress for this project');
    await assertTargetAllowed(project.appUrl);

    const s = project.settings!;
    const agents = { functional: true, api: true, vision: true, code: true, ...(s.agents as object), ...(body.agents || {}) };
    const warnings: string[] = [];
    if (agents.code && !plan.repoAnalysis) {
      agents.code = false;
      warnings.push(`Repository analysis is not included in the ${plan.name} plan.`);
    }
    const viewports = (body.viewports || s.viewports || ['desktop', 'mobile']).filter((v) => {
      const ok = plan.viewports.includes(v) && VIEWPORTS[v];
      if (!ok) warnings.push(`Viewport "${v}" is not included in the ${plan.name} plan.`);
      return ok;
    });
    const run = await TestRun.create({
      projectId: project._id,
      workspaceId: project.workspaceId,
      triggeredBy: req.user!.id,
      trigger: body.trigger || 'manual',
      status: 'queued',
      config: {
        agents,
        viewports: viewports.length ? viewports : ['desktop'],
        maxPages: Math.min(body.maxPages || s.maxPages || 8, plan.maxPages),
        plan: plan.id,
        warnings,
      },
      events: [{ ts: new Date(), agent: 'orchestrator', level: 'info', message: 'Run queued' }, ...warnings.map((w) => ({ ts: new Date(), agent: 'orchestrator', level: 'warn', message: w }))],
    });
    await incrementUsage(project.workspaceId, { runs: 1 });
    project.set('lastRun', { runId: run._id, status: 'queued', at: new Date() });
    await project.save();
    enqueueRun(String(run._id));
    res.status(202).json({ run: { id: run._id, status: run.status, config: run.config } });
  }),
);

projectsRouter.get(
  '/:id/runs',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id);
    const runs = await TestRun.find({ projectId: project._id }, { events: 0, plan: 0 }).sort({ createdAt: -1 }).limit(100).lean();
    res.json({ runs });
  }),
);

// ------------------------------------------------------------------ bugs & regression tests
projectsRouter.get(
  '/:id/bugs',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id);
    const filter: Record<string, unknown> = { projectId: project._id };
    for (const k of ['status', 'severity', 'category'] as const) if (typeof req.query[k] === 'string') filter[k] = req.query[k];
    const bugs = await Bug.find(filter, { evidence: 0, history: 0 }).sort({ updatedAt: -1 }).lean();
    res.json({ bugs });
  }),
);

projectsRouter.get(
  '/:id/regression-tests',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id);
    res.json({ regressionTests: await RegressionTest.find({ projectId: project._id }).sort({ updatedAt: -1 }).lean() });
  }),
);

// ------------------------------------------------------------------ visual references / baselines
const referenceSchema = z.object({
  pagePath: z.string().trim().min(1).max(300),
  viewport: viewportEnum,
  imageBase64: z.string().min(20).max(12_000_000),
});

projectsRouter.post(
  '/:id/references',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    const body = parseBody(referenceSchema, req.body);
    const raw = Buffer.from(body.imageBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64');
    let png: Buffer;
    let meta: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
    try {
      png = await sharp(raw).png().toBuffer();
      meta = await sharp(png).metadata();
    } catch {
      throw new HttpError(400, 'Reference must be a PNG or JPEG image');
    }
    const vp = VIEWPORTS[body.viewport];
    const pagePath = body.pagePath.startsWith('/') ? body.pagePath : `/${body.pagePath}`;
    await Screenshot.deleteMany({ projectId: project._id, kind: 'reference', pagePath, 'viewport.name': vp.name });
    const key = await storage.put(`projects/${project._id}/references/${vp.name}-${Date.now()}.png`, png, 'image/png');
    const shot = await Screenshot.create({
      projectId: project._id,
      kind: 'reference',
      viewport: { name: vp.name, width: vp.width, height: vp.height },
      pagePath,
      imageRef: key,
      width: meta.width,
      height: meta.height,
    });
    res.status(201).json({ screenshot: shot });
  }),
);

projectsRouter.delete(
  '/:id/references/:shotId',
  asyncHandler(async (req, res) => {
    const { project } = await loadProject(req.user!.id, req.params.id, 'developer');
    const shot = await Screenshot.findOne({ _id: objectId(req.params.shotId), projectId: project._id });
    if (!shot) throw new HttpError(404, 'Reference not found');
    if (shot.kind === 'reference') {
      await storage.remove(shot.imageRef);
      await shot.deleteOne();
    } else {
      shot.isBaseline = false;
      await shot.save();
    }
    res.json({ ok: true });
  }),
);
