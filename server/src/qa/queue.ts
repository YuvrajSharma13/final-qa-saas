import { config } from '../config.js';
import { TestRun } from '../models/index.js';
import { executeRun } from './orchestrator.js';

// In-process job queue: bounded concurrency protects the host from too many
// browsers at once. Swap for BullMQ/SQS when running several API instances.
const waiting: string[] = [];
const active = new Set<string>();
const canceled = new Set<string>();
const idleWaiters: (() => void)[] = [];

export function enqueueRun(runId: string) {
  waiting.push(runId);
  pump();
}

function pump() {
  while (active.size < config.qaConcurrency && waiting.length) {
    const id = waiting.shift()!;
    if (canceled.has(id)) continue;
    active.add(id);
    executeRun(id, () => canceled.has(id))
      .catch((err) => console.error('[queue] run crashed', id, err))
      .finally(() => {
        active.delete(id);
        canceled.delete(id);
        if (!active.size && !waiting.length) idleWaiters.splice(0).forEach((r) => r());
        pump();
      });
  }
}

export async function cancelRun(runId: string) {
  canceled.add(runId);
  const idx = waiting.indexOf(runId);
  if (idx >= 0) {
    waiting.splice(idx, 1);
    canceled.delete(runId);
    await TestRun.updateOne({ _id: runId }, { status: 'canceled', completedAt: new Date(), error: 'Run canceled by user', progress: { phase: 'canceled', percent: 100 } });
  }
  if (!active.has(runId) && idx < 0) {
    // Orphaned run (e.g. after a restart)
    canceled.delete(runId);
    await TestRun.updateOne({ _id: runId, status: { $in: ['queued', 'running'] } }, { status: 'canceled', completedAt: new Date(), error: 'Run canceled by user' });
  }
}

export function queueIdle(): Promise<void> {
  if (!active.size && !waiting.length) return Promise.resolve();
  return new Promise((r) => idleWaiters.push(r));
}

/** On boot: runs that were in flight when the process stopped cannot resume. */
export async function recoverInterruptedRuns() {
  const stale = await TestRun.find({ status: { $in: ['queued', 'running'] } }, { _id: 1, status: 1 }).lean();
  for (const r of stale) {
    if (r.status === 'queued') enqueueRun(String(r._id));
    else await TestRun.updateOne({ _id: r._id }, { status: 'failed', error: 'Interrupted by a server restart', completedAt: new Date() });
  }
}

export const queueStats = () => ({ active: active.size, waiting: waiting.length, concurrency: config.qaConcurrency });
