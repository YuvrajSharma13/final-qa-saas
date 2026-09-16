import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, objectId, parseBody } from '../lib/http.js';
import { assertWorkspaceAccess } from '../middleware/auth.js';
import { Bug, Project, RegressionTest, Screenshot, TestCase, User } from '../models/index.js';
import { generateRegressionForBug, executeRegressionTest } from '../qa/agents/regression.js';

export const bugsRouter = Router();

async function loadBug(userId: Parameters<typeof assertWorkspaceAccess>[0], id: unknown, min: Parameters<typeof assertWorkspaceAccess>[2] = 'viewer') {
  const bug = await Bug.findById(objectId(id, 'Bug'));
  if (!bug) throw new HttpError(404, 'Bug not found');
  await assertWorkspaceAccess(userId, bug.workspaceId, min);
  return bug;
}

bugsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filter: Record<string, unknown> = { workspaceId: req.workspace!.id };
    for (const k of ['status', 'severity', 'category'] as const) if (typeof req.query[k] === 'string' && req.query[k]) filter[k] = req.query[k];
    if (typeof req.query.projectId === 'string' && req.query.projectId) filter.projectId = objectId(req.query.projectId, 'Project');
    const bugs = await Bug.find(filter, { evidence: 0, history: 0 }).sort({ updatedAt: -1 }).limit(500).lean();
    const projects = await Project.find({ workspaceId: req.workspace!.id }, { name: 1 }).lean();
    const names = Object.fromEntries(projects.map((p) => [String(p._id), p.name]));
    const rank = { critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>;
    bugs.sort((a, b) => (a.status === b.status ? rank[a.severity] - rank[b.severity] : a.status === 'open' ? -1 : 1));
    res.json({ bugs: bugs.map((b) => ({ ...b, projectName: names[String(b.projectId)] })) });
  }),
);

bugsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const bug = await loadBug(req.user!.id, req.params.id);
    const ev = (bug.evidence || {}) as { screenshotIds?: string[]; testCaseIds?: string[] };
    const [project, regressionTests, screenshots, testCases] = await Promise.all([
      Project.findById(bug.projectId, { name: 1, appUrl: 1, repoUrl: 1 }).lean(),
      RegressionTest.find({ bugId: bug._id }).sort({ createdAt: -1 }).lean(),
      Screenshot.find({ _id: { $in: (ev.screenshotIds || []).map((i) => objectId(String(i))) } }).lean(),
      TestCase.find({ _id: { $in: (ev.testCaseIds || []).map((i) => objectId(String(i))) } }).lean(),
    ]);
    const plain = bug.toObject();
    const userIds = plain.history.map((h) => h.userId).filter(Boolean);
    const users = await User.find({ _id: { $in: userIds } }, { name: 1 }).lean();
    const history = plain.history.map((h) => ({ ...h, userName: users.find((u) => String(u._id) === String(h.userId))?.name }));
    res.json({ bug: { ...plain, history }, project, regressionTests, screenshots, testCases });
  }),
);

const patchSchema = z
  .object({
    status: z.enum(['open', 'fixed', 'ignored']).optional(),
    severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

bugsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const bug = await loadBug(req.user!.id, req.params.id, 'developer');
    const body = parseBody(patchSchema, req.body);
    const now = new Date();
    if (body.status && body.status !== bug.status) {
      bug.history.push({ at: now, event: `status:${body.status}`, message: `Status changed from ${bug.status} to ${body.status}`, userId: req.user!.id });
      bug.status = body.status;
    }
    if (body.severity && body.severity !== bug.severity) {
      bug.history.push({ at: now, event: 'severity', message: `Severity changed from ${bug.severity} to ${body.severity}`, userId: req.user!.id });
      bug.severity = body.severity;
    }
    if (body.note) bug.history.push({ at: now, event: 'note', message: body.note, userId: req.user!.id });
    await bug.save();
    res.json({ bug });
  }),
);

bugsRouter.post(
  '/:id/regression',
  asyncHandler(async (req, res) => {
    const bug = await loadBug(req.user!.id, req.params.id, 'developer');
    const test = await generateRegressionForBug(bug);
    let result = null;
    if (req.query.run === '1' || req.body?.run === true) {
      const project = await Project.findById(bug.projectId);
      if (!project) throw new HttpError(404, 'Project not found');
      result = await executeRegressionTest(test, project, null);
    }
    res.status(201).json({ regressionTest: await RegressionTest.findById(test._id).lean(), result });
  }),
);
