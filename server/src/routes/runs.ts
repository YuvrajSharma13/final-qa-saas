import { Router } from 'express';
import { asyncHandler, HttpError, objectId } from '../lib/http.js';
import { storage } from '../lib/storage.js';
import { assertWorkspaceAccess } from '../middleware/auth.js';
import { AgentRun, AGENT_TYPES, Bug, RegressionTest, Screenshot, TestCase, TestRun } from '../models/index.js';
import { cancelRun } from '../qa/queue.js';

export const runsRouter = Router();

async function loadRun(userId: Parameters<typeof assertWorkspaceAccess>[0], id: unknown, min: Parameters<typeof assertWorkspaceAccess>[2] = 'viewer') {
  const run = await TestRun.findById(objectId(id, 'Run'));
  if (!run) throw new HttpError(404, 'Run not found');
  await assertWorkspaceAccess(userId, run.workspaceId, min);
  return run;
}

runsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const run = await loadRun(req.user!.id, req.params.id);
    const since = Number(req.query.eventsSince || 0);
    const [agentRuns, testCases, bugs, screenshots] = await Promise.all([
      AgentRun.find({ runId: run._id }).lean(),
      TestCase.find({ runId: run._id }).sort({ createdAt: 1 }).lean(),
      Bug.find({ $or: [{ runId: run._id }, { lastSeenRunId: run._id }, { 'history.runId': run._id }] }, { evidence: 0 }).lean(),
      Screenshot.find({ runId: run._id }).sort({ createdAt: 1 }).lean(),
    ]);
    const order = (t: string) => AGENT_TYPES.indexOf(t as (typeof AGENT_TYPES)[number]);
    const regressionTests = await RegressionTest.find({ $or: [{ lastRunId: run._id }, { bugId: { $in: bugs.map((b) => b._id) } }] }, { code: 0 }).lean();
    const obj = run.toObject();
    res.json({
      run: { ...obj, events: obj.events.slice(since) },
      eventsTotal: obj.events.length,
      agentRuns: agentRuns.sort((a, b) => order(a.agentType) - order(b.agentType)),
      testCases,
      bugs: bugs.map((b) => ({ ...b, runRelation: relation(b, String(run._id)) })),
      screenshots,
      regressionTests,
    });
  }),
);

function relation(b: { runId?: unknown; history?: { runId?: unknown; event?: string | null }[] }, runId: string) {
  const h = (b.history || []).filter((x) => String(x.runId) === runId).map((x) => x.event);
  if (String(b.runId) === runId) return 'new';
  if (h.includes('reopened')) return 'reopened';
  if (h.includes('fixed')) return 'fixed';
  return 'seen';
}

runsRouter.post(
  '/:id/cancel',
  asyncHandler(async (req, res) => {
    const run = await loadRun(req.user!.id, req.params.id, 'developer');
    if (!['queued', 'running'].includes(run.status)) throw new HttpError(409, `Run is already ${run.status}`);
    await cancelRun(String(run._id));
    res.json({ ok: true });
  }),
);

export const screenshotsRouter = Router();

screenshotsRouter.get(
  '/:id/image',
  asyncHandler(async (req, res) => {
    const shot = await Screenshot.findById(objectId(req.params.id, 'Screenshot')).lean();
    if (!shot) throw new HttpError(404, 'Screenshot not found');
    const { Project } = await import('../models/index.js');
    const project = await Project.findById(shot.projectId).lean();
    if (!project) throw new HttpError(404, 'Screenshot not found');
    await assertWorkspaceAccess(req.user!.id, project.workspaceId);
    const key = req.query.variant === 'annotated' && shot.annotatedRef ? shot.annotatedRef : shot.imageRef;
    const buf = await storage.get(key);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type('png').send(buf);
  }),
);

screenshotsRouter.post(
  '/:id/baseline',
  asyncHandler(async (req, res) => {
    const shot = await Screenshot.findById(objectId(req.params.id, 'Screenshot'));
    if (!shot || shot.kind !== 'capture') throw new HttpError(404, 'Screenshot not found');
    const { Project } = await import('../models/index.js');
    const project = await Project.findById(shot.projectId).lean();
    if (!project) throw new HttpError(404, 'Screenshot not found');
    await assertWorkspaceAccess(req.user!.id, project.workspaceId, 'developer');
    await Screenshot.updateMany(
      { projectId: shot.projectId, pagePath: shot.pagePath, 'viewport.name': shot.viewport?.name, isBaseline: true },
      { isBaseline: false },
    );
    shot.isBaseline = true;
    await shot.save();
    res.json({ screenshot: shot });
  }),
);
