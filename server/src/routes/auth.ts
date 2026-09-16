import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler, HttpError, parseBody } from '../lib/http.js';
import { planFor } from '../lib/plans.js';
import { requireAuth, SESSION_COOKIE, setSessionCookie, signSession } from '../middleware/auth.js';
import { Member, User, Workspace } from '../models/index.js';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 100),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many authentication attempts, try again later.' },
});

const registerSchema = z.object({
  name: z.string().trim().min(1).max(80),
  email: z.string().trim().toLowerCase().email().max(200),
  password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  workspaceName: z.string().trim().max(80).optional(),
});

authRouter.post(
  '/register',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(registerSchema, req.body);
    if (await User.exists({ email: body.email })) throw new HttpError(409, 'An account with this email already exists');
    const user = await User.create({
      name: body.name,
      email: body.email,
      passwordHash: await bcrypt.hash(body.password, 10),
      authProvider: 'password',
    });
    const ws = await Workspace.create({ name: body.workspaceName || `${body.name}'s workspace`, ownerId: user._id, plan: 'free' });
    await Member.create({ workspaceId: ws._id, userId: user._id, role: 'owner' });
    const token = signSession(user);
    setSessionCookie(res, token);
    res.status(201).json({ user: publicUser(user), token });
  }),
);

const loginSchema = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1) });

authRouter.post(
  '/login',
  authLimiter,
  asyncHandler(async (req, res) => {
    const body = parseBody(loginSchema, req.body);
    const user = await User.findOne({ email: body.email });
    const ok = user?.passwordHash ? await bcrypt.compare(body.password, user.passwordHash) : false;
    if (!user || !ok) throw new HttpError(401, 'Invalid email or password');
    const token = signSession(user);
    setSessionCookie(res, token);
    res.json({ user: publicUser(user), token });
  }),
);

authRouter.post('/logout', (_req, res) => {
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user!.id).lean();
    if (!user) throw new HttpError(401, 'Account no longer exists');
    const memberships = await Member.find({ userId: user._id }).sort({ createdAt: 1 }).lean();
    const workspaces = await Workspace.find({ _id: { $in: memberships.map((m) => m.workspaceId) } }).lean();
    res.json({
      user: publicUser(user),
      workspaces: memberships
        .map((m) => {
          const ws = workspaces.find((w) => String(w._id) === String(m.workspaceId));
          return ws && { id: ws._id, name: ws.name, plan: ws.plan, planName: planFor(ws.plan).name, role: m.role };
        })
        .filter(Boolean),
    });
  }),
);

function publicUser(u: { _id: unknown; name: string; email: string; createdAt?: Date }) {
  return { id: u._id, name: u.name, email: u.email, createdAt: u.createdAt };
}
