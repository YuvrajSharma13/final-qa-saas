import type { Types } from 'mongoose';
import sharp from 'sharp';
import { randomId } from '../lib/crypto.js';
import { sanitizeValue } from '../lib/sanitize.js';
import { storage } from '../lib/storage.js';
import { Screenshot, TestCase } from '../models/index.js';
import type { RunContext } from './types.js';

export async function saveScreenshot(
  ctx: Pick<RunContext, 'runId' | 'projectId'>,
  png: Buffer,
  meta: {
    kind?: 'capture' | 'failure';
    agentType: string;
    viewport: { name: string; width: number; height: number };
    url?: string;
    pagePath?: string;
    annotations?: unknown[];
    annotated?: Buffer;
  },
) {
  const id = randomId(8);
  const imageRef = await storage.put(`runs/${ctx.runId}/${id}.png`, png, 'image/png');
  const annotatedRef = meta.annotated ? await storage.put(`runs/${ctx.runId}/${id}-annotated.png`, meta.annotated, 'image/png') : undefined;
  const info = await sharp(png).metadata();
  return Screenshot.create({
    runId: ctx.runId,
    projectId: ctx.projectId,
    kind: meta.kind || 'capture',
    agentType: meta.agentType,
    viewport: meta.viewport,
    url: meta.url,
    pagePath: meta.pagePath,
    imageRef,
    annotatedRef,
    width: info.width,
    height: info.height,
    annotations: meta.annotations || [],
  });
}

export async function saveTestCase(
  ctx: Pick<RunContext, 'runId' | 'projectId'>,
  tc: {
    agentType: string;
    category: 'functional' | 'api' | 'visual' | 'regression';
    kind: string;
    name: string;
    target?: string;
    expected: string;
    actual: string;
    status: 'passed' | 'failed' | 'error' | 'skipped';
    durationMs?: number;
    evidence?: Record<string, unknown>;
  },
): Promise<Types.ObjectId> {
  const doc = await TestCase.create({ ...tc, runId: ctx.runId, projectId: ctx.projectId, evidence: sanitizeValue(tc.evidence || {}) });
  return doc._id;
}
