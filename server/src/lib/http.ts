import type { NextFunction, Request, Response, RequestHandler } from 'express';
import mongoose from 'mongoose';
import { ZodError, type ZodType } from 'zod';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const asyncHandler =
  (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => {
    fn(req, res, next).catch(next);
  };

export function parseBody<T>(schema: ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success) {
    throw new HttpError(400, 'Validation failed', r.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`));
  }
  return r.data;
}

export function objectId(id: unknown, what = 'id'): mongoose.Types.ObjectId {
  if (typeof id !== 'string' || !mongoose.isValidObjectId(id)) throw new HttpError(404, `${what} not found`);
  return new mongoose.Types.ObjectId(id);
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, details: err.details });
    return;
  }
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'Validation failed', details: err.issues });
    return;
  }
  const e = err as { type?: string; status?: number; code?: number; message?: string };
  if (e?.type === 'entity.parse.failed') {
    res.status(400).json({ error: 'Malformed JSON body' });
    return;
  }
  if (e?.code === 11000) {
    res.status(409).json({ error: 'Already exists' });
    return;
  }
  console.error('[api] unhandled error', err);
  res.status(500).json({ error: 'Internal server error' });
}
