import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { approveFix, cancelFix, createFix, OPEN_STATUSES, refreshPrStatus, rejectFix, retryFix } from '../autofix/service.js';
import { config } from '../config.js';
import { asyncHandler, HttpError, objectId, parseBody } from '../lib/http.js';
import { assertWorkspaceAccess, type AuthUser } from '../middleware/auth.js';
import { AutoFix, Bug, Project, User } from '../models/index.js';

export const autofixRouter = Router();
const startLimiter = rateLimit({
  windowMs: 60_000,
  limit: Number(process.env.AUTOFIX_RATE_LIMIT || 10),
  keyGenerator: (req) => String(req.user?.id),
  message: { error: 'Too many auto-fix requests, please wait a minute.' },
  standardHeaders: 'draft-7',
  legacyHeaders: false,
});

async function loadFix(user: AuthUser, id: unknown, min: Parameters<typeof assertWorkspaceAccess>[2] = 'viewer') {
  const fix = await AutoFix.findById(objectId(id, 'Fix'));
  if (!fix) throw new HttpError(404, 'Fix not found');
  await assertWorkspaceAccess(user.id, fix.workspaceId, min);
  return fix;
}

async function present(fix: InstanceType<typeof AutoFix>) {
  const [bug, project] = await Promise.all([
    Bug.findById(fix.bugId, { title: 1, severity: 1, category: 1, status: 1, expected: 1, actual: 1 }).lean(),
    Project.findById(fix.projectId, { name: 1 }).lean(),
  ]);
  const approverIds = fix.attempts.map((a) => a.approvedBy).filter(Boolean);
  const users = await User.find({ _id: { $in: [fix.createdBy, ...approverIds] } }, { name: 1 }).lean();
  const name = (id: unknown) => users.find((u) => String(u._id) === String(id))?.name;
  const o = fix.toObject();
  return {
    ...o,
    createdByName: name(o.createdBy),
    attempts: o.attempts.map((a) => ({ ...a, approvedByName: a.approvedBy ? name(a.approvedBy) : undefined })),
    bug,
    project: project && { _id: project._id, name: project.name },
    maxAttempts: config.autofix.maxAttempts,
    repoUrl: `${config.github.webUrl}/${o.repo?.owner}/${o.repo?.name}`,
    branchUrl: o.branch ? `${config.github.webUrl}/${o.repo?.owner}/${o.repo?.name}/tree/${o.branch}` : undefined,
    commitUrl: o.commitSha ? `${config.github.webUrl}/${o.repo?.owner}/${o.repo?.name}/commit/${o.commitSha}` : undefined,
  };
}

// POST /api/autofixes  { bugId, baseBranch? }
autofixRouter.post(
  '/',
  startLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(z.object({ bugId: z.string(), baseBranch: z.string().trim().min(1).max(250).optional() }), req.body);
    const bug = await Bug.findById(objectId(body.bugId, 'Bug')).lean();
    if (!bug) throw new HttpError(404, 'Bug not found');
    await assertWorkspaceAccess(req.user!.id, bug.workspaceId, 'developer');
    const fix = await createFix(bug._id, req.user!.id, { baseBranch: body.baseBranch });
    res.status(202).json({ fix: await present(fix) });
  }),
);

autofixRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { workspaceId: req.workspace!.id };
    if (typeof req.query.projectId === 'string' && req.query.projectId) filter.projectId = objectId(req.query.projectId, 'Project');
    if (typeof req.query.bugId === 'string' && req.query.bugId) filter.bugId = objectId(req.query.bugId, 'Bug');
    if (req.query.open === '1') filter.status = { $in: OPEN_STATUSES };
    const fixes = await AutoFix.find(filter, { 'attempts.files': 0, 'attempts.edits': 0, 'attempts.validation': 0, events: 0, baseline: 0 })
      .sort({ updatedAt: -1 })
      .limit(Math.min(100, Number(req.query.limit || 50)));
    if (req.query.refresh === '1') {
      const stale = fixes.filter((f) => f.status === 'pr_open' && (!f.pr?.updatedAt || Date.now() - new Date(f.pr.updatedAt).getTime() > 60_000)).slice(0, 8);
      await Promise.all(stale.map((f) => AutoFix.findById(f._id).then((full) => full && refreshPrStatus(full, req.user!.id))));
    }
    const fresh = await AutoFix.find({ _id: { $in: fixes.map((f) => f._id) } }, { 'attempts.files': 0, 'attempts.edits': 0, 'attempts.diff': 0, 'attempts.validation': 0, events: 0, baseline: 0 }).sort({ updatedAt: -1 }).lean();
    const bugs = await Bug.find({ _id: { $in: fresh.map((f) => f.bugId) } }, { title: 1, severity: 1 }).lean();
    const projects = await Project.find({ _id: { $in: fresh.map((f) => f.projectId) } }, { name: 1 }).lean();
    res.json({
      fixes: fresh.map((f) => ({
        ...f,
        attemptsCount: f.attempts.length,
        attempts: undefined,
        bugTitle: bugs.find((b) => String(b._id) === String(f.bugId))?.title,
        bugSeverity: bugs.find((b) => String(b._id) === String(f.bugId))?.severity,
        projectName: projects.find((p) => String(p._id) === String(f.projectId))?.name,
      })),
    });
  }),
);

autofixRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    let fix = await loadFix(req.user!, req.params.id);
    if (req.query.refresh === '1' && fix.pr?.number) fix = await refreshPrStatus(fix, req.user!.id);
    res.json({ fix: await present(fix) });
  }),
);

autofixRouter.post(
  '/:id/approve',
  asyncHandler(async (req, res) => {
    const fix = await loadFix(req.user!, req.params.id, 'developer');
    const body = parseBody(z.object({ attempt: z.number().int().min(1), patchHash: z.string().regex(/^[a-f0-9]{64}$/), confirm: z.literal(true) }), req.body);
    await approveFix(fix, req.user!.id, body.attempt, body.patchHash);
    res.json({ fix: await present(fix) });
  }),
);

autofixRouter.post(
  '/:id/reject',
  asyncHandler(async (req, res) => {
    const fix = await loadFix(req.user!, req.params.id, 'developer');
    const body = parseBody(z.object({ feedback: z.string().trim().max(2000).default(''), regenerate: z.boolean().default(false) }), req.body || {});
    await rejectFix(fix, req.user!.id, body.feedback, body.regenerate);
    res.json({ fix: await present(fix) });
  }),
);

autofixRouter.post(
  '/:id/retry',
  startLimiter,
  asyncHandler(async (req, res) => {
    const fix = await loadFix(req.user!, req.params.id, 'developer');
    const body = parseBody(z.object({ feedback: z.string().trim().max(2000).default('') }), req.body || {});
    await retryFix(fix, body.feedback);
    res.json({ fix: await present(fix) });
  }),
);

autofixRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const fix = await loadFix(req.user!, req.params.id, 'developer');
    await cancelFix(fix);
    res.json({ fix: await present(fix) });
  }),
);

autofixRouter.post(
  '/:id/refresh',
  asyncHandler(async (req, res) => {
    const fix = await loadFix(req.user!, req.params.id);
    res.json({ fix: await present(await refreshPrStatus(fix, req.user!.id)) });
  }),
);
