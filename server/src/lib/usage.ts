import type { Types } from 'mongoose';
import { Project, Workspace } from '../models/index.js';
import { HttpError } from './http.js';
import { planFor } from './plans.js';

const PERIOD_MS = 30 * 24 * 3600 * 1000;

/** Rolls the usage period forward when it has expired and returns the workspace. */
export async function currentUsage(workspaceId: Types.ObjectId) {
  const ws = await Workspace.findById(workspaceId);
  if (!ws) throw new HttpError(404, 'Workspace not found');
  const start = ws.usage?.periodStart ? new Date(ws.usage.periodStart).getTime() : 0;
  if (Date.now() - start > PERIOD_MS) {
    ws.set('usage', { periodStart: new Date(), runs: 0, aiCalls: 0, browserSeconds: 0, checks: 0 });
    await ws.save();
  }
  const projects = await Project.countDocuments({ workspaceId, status: 'active' });
  const plan = planFor(ws.plan);
  return {
    workspace: ws,
    plan,
    usage: {
      periodStart: ws.usage!.periodStart,
      periodEnd: new Date(new Date(ws.usage!.periodStart!).getTime() + PERIOD_MS),
      runs: ws.usage!.runs ?? 0,
      aiCalls: ws.usage!.aiCalls ?? 0,
      browserSeconds: Math.round(ws.usage!.browserSeconds ?? 0),
      checks: ws.usage!.checks ?? 0,
      projects,
    },
  };
}

export async function assertCanCreateProject(workspaceId: Types.ObjectId) {
  const { plan, usage } = await currentUsage(workspaceId);
  if (usage.projects >= plan.maxProjects) {
    throw new HttpError(402, `The ${plan.name} plan allows ${plan.maxProjects} project(s). Upgrade to add more.`);
  }
}

export async function assertCanStartRun(workspaceId: Types.ObjectId) {
  const { plan, usage } = await currentUsage(workspaceId);
  if (usage.runs >= plan.runsPerMonth) {
    throw new HttpError(402, `Monthly QA run limit reached (${plan.runsPerMonth} on the ${plan.name} plan).`);
  }
  return plan;
}

export async function incrementUsage(workspaceId: Types.ObjectId, inc: Partial<Record<'runs' | 'aiCalls' | 'browserSeconds' | 'checks', number>>) {
  const $inc: Record<string, number> = {};
  for (const [k, v] of Object.entries(inc)) if (v) $inc[`usage.${k}`] = v;
  if (Object.keys($inc).length) await Workspace.updateOne({ _id: workspaceId }, { $inc });
}
