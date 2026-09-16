import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, HttpError, objectId, parseBody } from '../lib/http.js';
import { PLANS, planFor, type PlanId } from '../lib/plans.js';
import { currentUsage } from '../lib/usage.js';
import { requireWorkspaceRole } from '../middleware/auth.js';
import { Bug, Member, Notification, Project, TestRun, User, Workspace } from '../models/index.js';

// ------------------------------------------------------------------ dashboard
export const dashboardRouter = Router();

dashboardRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const wsId = req.workspace!.id;
    const days = Math.min(365, Math.max(1, Number(req.query.days || 30)));
    const since = new Date(Date.now() - days * 24 * 3600 * 1000);
    const runFilter: Record<string, unknown> = { workspaceId: wsId };
    const bugFilter: Record<string, unknown> = { workspaceId: wsId };
    if (typeof req.query.projectId === 'string' && req.query.projectId) {
      runFilter.projectId = objectId(req.query.projectId, 'Project');
      bugFilter.projectId = runFilter.projectId;
    }
    const [projects, runs, lastRun, openBugs, { plan, usage }, unread] = await Promise.all([
      Project.find({ workspaceId: wsId, status: 'active' }).lean(),
      TestRun.find({ ...runFilter, status: 'completed', createdAt: { $gte: since } }, { events: 0, plan: 0 }).sort({ createdAt: 1 }).lean(),
      TestRun.findOne(runFilter, { events: 0, plan: 0 }).sort({ createdAt: -1 }).lean(),
      Bug.find({ ...bugFilter, status: 'open' }, { severity: 1, category: 1, projectId: 1 }).lean(),
      currentUsage(wsId),
      Notification.countDocuments({ userId: req.user!.id, read: false }),
    ]);

    type Summary = { testsExecuted?: number; passed?: number; failed?: number; qaScore?: number; bugsFound?: number };
    const totals = runs.reduce(
      (acc, r) => {
        const s = (r.summary || {}) as Summary;
        acc.testsExecuted += s.testsExecuted || 0;
        acc.passed += s.passed || 0;
        acc.failed += s.failed || 0;
        return acc;
      },
      { testsExecuted: 0, passed: 0, failed: 0 },
    );
    const count = (key: 'severity' | 'category', value: string) => openBugs.filter((b) => b[key] === value).length;
    const trendPoints = runs.slice(-15).map((r) => {
      const s = (r.summary || {}) as Summary;
      return {
        runId: r._id,
        projectId: r.projectId,
        at: r.completedAt || r.createdAt,
        failed: s.failed || 0,
        passed: s.passed || 0,
        qaScore: s.qaScore ?? null,
      };
    });
    const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
    const recent = trendPoints.slice(-3).map((p) => p.failed);
    const previous = trendPoints.slice(-6, -3).map((p) => p.failed);
    let direction: 'improving' | 'worsening' | 'stable' | 'insufficient-data' = 'insufficient-data';
    if (recent.length && previous.length) {
      const d = avg(recent) - avg(previous);
      direction = d < -0.5 ? 'improving' : d > 0.5 ? 'worsening' : 'stable';
    } else if (trendPoints.length >= 2) {
      const d = trendPoints.at(-1)!.failed - trendPoints.at(-2)!.failed;
      direction = d < 0 ? 'improving' : d > 0 ? 'worsening' : 'stable';
    }

    res.json({
      periodDays: days,
      metrics: {
        ...totals,
        passRate: totals.testsExecuted ? Math.round((totals.passed / totals.testsExecuted) * 100) : null,
        runs: runs.length,
        severity: { critical: count('severity', 'critical'), high: count('severity', 'high'), medium: count('severity', 'medium'), low: count('severity', 'low') },
        issues: { visual: count('category', 'visual'), api: count('category', 'api'), functional: count('category', 'functional') },
        openBugs: openBugs.length,
      },
      lastRun: lastRun && { ...lastRun, projectName: projects.find((p) => String(p._id) === String(lastRun.projectId))?.name },
      trend: { direction, points: trendPoints },
      projects: projects.map((p) => ({
        id: p._id,
        name: p.name,
        appUrl: p.appUrl,
        lastRun: p.lastRun,
        openBugs: openBugs.filter((b) => String(b.projectId) === String(p._id)).length,
        critical: openBugs.filter((b) => String(b.projectId) === String(p._id) && b.severity === 'critical').length,
      })),
      plan: { id: plan.id, name: plan.name, runsPerMonth: plan.runsPerMonth, maxProjects: plan.maxProjects },
      usage,
      unreadNotifications: unread,
    });
  }),
);

// ------------------------------------------------------------------ billing
export const billingRouter = Router();

billingRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const { workspace, plan, usage } = await currentUsage(req.workspace!.id);
    const members = await Member.countDocuments({ workspaceId: workspace._id });
    res.json({
      plan,
      plans: Object.values(PLANS),
      usage: { ...usage, members },
      billing: workspace.billing,
      testMode: true,
    });
  }),
);

billingRouter.post(
  '/plan',
  requireWorkspaceRole('owner'),
  asyncHandler(async (req, res) => {
    const { plan } = parseBody(z.object({ plan: z.enum(['free', 'pro', 'team']) }), req.body);
    const ws = await Workspace.findById(req.workspace!.id);
    if (!ws) throw new HttpError(404, 'Workspace not found');
    const target = planFor(plan);
    const { usage } = await currentUsage(ws._id);
    if (usage.projects > target.maxProjects) {
      throw new HttpError(409, `Archive projects first: ${target.name} allows ${target.maxProjects} project(s).`);
    }
    const members = await Member.countDocuments({ workspaceId: ws._id });
    if (members > target.maxMembers) throw new HttpError(409, `Remove members first: ${target.name} allows ${target.maxMembers} member(s).`);
    ws.plan = plan as PlanId;
    ws.set('billing', {
      status: 'active',
      provider: 'test-mode',
      renewsAt: plan === 'free' ? undefined : new Date(Date.now() + 30 * 24 * 3600 * 1000),
    });
    await ws.save();
    // Keep project viewports inside the new plan.
    const projects = await Project.find({ workspaceId: ws._id });
    for (const p of projects) {
      const current = (p.settings?.viewports || []) as string[];
      const allowed = current.filter((v) => target.viewports.includes(v));
      if (allowed.length !== current.length) {
        p.set('settings.viewports', allowed.length ? allowed : ['desktop']);
        await p.save();
      }
    }
    res.json({ plan: target, message: `Switched to ${target.name} (test mode — no payment was taken).` });
  }),
);

// ------------------------------------------------------------------ workspace & team
export const workspaceRouter = Router();

workspaceRouter.get(
  '/current',
  asyncHandler(async (req, res) => {
    const ws = await Workspace.findById(req.workspace!.id).lean();
    const members = await Member.find({ workspaceId: req.workspace!.id }).lean();
    const users = await User.find({ _id: { $in: members.map((m) => m.userId) } }, { name: 1, email: 1 }).lean();
    res.json({
      workspace: { id: ws!._id, name: ws!.name, plan: ws!.plan, role: req.workspace!.role },
      members: members.map((m) => {
        const u = users.find((x) => String(x._id) === String(m.userId));
        return { id: m._id, userId: m.userId, role: m.role, name: u?.name, email: u?.email };
      }),
    });
  }),
);

workspaceRouter.patch(
  '/current',
  requireWorkspaceRole('admin'),
  asyncHandler(async (req, res) => {
    const { name } = parseBody(z.object({ name: z.string().trim().min(1).max(80) }), req.body);
    await Workspace.updateOne({ _id: req.workspace!.id }, { name });
    res.json({ ok: true });
  }),
);

workspaceRouter.post(
  '/current/members',
  requireWorkspaceRole('admin'),
  asyncHandler(async (req, res) => {
    const body = parseBody(
      z.object({ email: z.string().trim().toLowerCase().email(), role: z.enum(['admin', 'developer', 'viewer']) }),
      req.body,
    );
    const plan = planFor(req.workspace!.plan);
    const count = await Member.countDocuments({ workspaceId: req.workspace!.id });
    if (count >= plan.maxMembers) throw new HttpError(402, `The ${plan.name} plan allows ${plan.maxMembers} member(s). Upgrade to Team to invite developers.`);
    const user = await User.findOne({ email: body.email }).lean();
    if (!user) throw new HttpError(404, 'No account with that email. Ask them to sign up first.');
    const member = await Member.create({ workspaceId: req.workspace!.id, userId: user._id, role: body.role });
    res.status(201).json({ member });
  }),
);

workspaceRouter.delete(
  '/current/members/:memberId',
  requireWorkspaceRole('admin'),
  asyncHandler(async (req, res) => {
    const m = await Member.findOne({ _id: objectId(req.params.memberId), workspaceId: req.workspace!.id });
    if (!m) throw new HttpError(404, 'Member not found');
    if (m.role === 'owner') throw new HttpError(400, 'The workspace owner cannot be removed');
    await m.deleteOne();
    res.json({ ok: true });
  }),
);

// ------------------------------------------------------------------ notifications
export const notificationsRouter = Router();

notificationsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const items = await Notification.find({ userId: req.user!.id }).sort({ createdAt: -1 }).limit(50).lean();
    res.json({ notifications: items, unread: items.filter((n) => !n.read).length });
  }),
);

notificationsRouter.post(
  '/read-all',
  asyncHandler(async (req, res) => {
    await Notification.updateMany({ userId: req.user!.id, read: false }, { read: true });
    res.json({ ok: true });
  }),
);

notificationsRouter.post(
  '/:id/read',
  asyncHandler(async (req, res) => {
    await Notification.updateOne({ _id: objectId(req.params.id), userId: req.user!.id }, { read: true });
    res.json({ ok: true });
  }),
);
