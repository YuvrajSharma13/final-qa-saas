import type { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { config } from '../config.js';
import { HttpError } from '../lib/http.js';
import { Member, Workspace, type Role } from '../models/index.js';

export const SESSION_COOKIE = 'qa_session';

export interface AuthUser {
  id: Types.ObjectId;
  email: string;
  name: string;
}
export interface WorkspaceCtx {
  id: Types.ObjectId;
  role: Role;
  plan: string;
  name: string;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthUser;
      workspace?: WorkspaceCtx;
    }
  }
}

export function signSession(user: { _id: Types.ObjectId; email: string; name: string }) {
  return jwt.sign({ sub: String(user._id), email: user.email, name: user.name }, config.jwtSecret, { expiresIn: '7d' });
}

export function setSessionCookie(res: Response, token: string) {
  res.cookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.isProd,
    maxAge: 7 * 24 * 3600 * 1000,
    path: '/',
  });
}

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : req.cookies?.[SESSION_COOKIE];
  if (!token) return next(new HttpError(401, 'Authentication required'));
  try {
    const payload = jwt.verify(token, config.jwtSecret) as { sub: string; email: string; name: string };
    if (!mongoose.isValidObjectId(payload.sub)) throw new Error('bad subject');
    req.user = { id: new Types.ObjectId(payload.sub), email: payload.email, name: payload.name };
    return next();
  } catch {
    return next(new HttpError(401, 'Session expired or invalid'));
  }
}

const RANK: Record<Role, number> = { viewer: 0, developer: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** Resolves the active workspace from the X-Workspace-Id header (or the user's first workspace). */
export async function withWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const wanted = req.header('x-workspace-id');
    const filter: Record<string, unknown> = { userId: req.user!.id };
    if (wanted && mongoose.isValidObjectId(wanted)) filter.workspaceId = new Types.ObjectId(wanted);
    let membership = await Member.findOne(filter).sort({ createdAt: 1 }).lean();
    if (!membership && wanted) membership = await Member.findOne({ userId: req.user!.id }).sort({ createdAt: 1 }).lean();
    if (!membership) throw new HttpError(403, 'No workspace access');
    const ws = await Workspace.findById(membership.workspaceId).lean();
    if (!ws) throw new HttpError(403, 'Workspace not found');
    req.workspace = { id: ws._id, role: membership.role as Role, plan: ws.plan, name: ws.name };
    next();
  } catch (err) {
    next(err);
  }
}

export function requireWorkspaceRole(min: Role) {
  return (req: Request, _res: Response, next: NextFunction) => {
    if (!req.workspace || !roleAtLeast(req.workspace.role, min)) return next(new HttpError(403, `Requires ${min} role`));
    next();
  };
}

/** Authorization check used by every project/run/bug endpoint: the caller must be a member of the owning workspace. */
export async function assertWorkspaceAccess(userId: Types.ObjectId, workspaceId: Types.ObjectId, min: Role = 'viewer') {
  const m = await Member.findOne({ userId, workspaceId }).lean();
  // 404 rather than 403 so resource existence is not leaked across tenants.
  if (!m) throw new HttpError(404, 'Not found');
  if (!roleAtLeast(m.role as Role, min)) throw new HttpError(403, `Requires ${min} role`);
  return m.role as Role;
}
