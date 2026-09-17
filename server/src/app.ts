import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import mongoose from 'mongoose';
import { config } from './config.js';
import { llmEnabled } from './ai/llm.js';
import { errorHandler, HttpError } from './lib/http.js';
import { requireAuth, withWorkspace } from './middleware/auth.js';
import { agentsRouter } from './routes/agents.js';
import { authRouter } from './routes/auth.js';
import { autofixRouter } from './routes/autofix.js';
import { githubRouter } from './routes/github.js';
import { bugsRouter } from './routes/bugs.js';
import { projectsRouter } from './routes/projects.js';
import { runsRouter, screenshotsRouter } from './routes/runs.js';
import { billingRouter, dashboardRouter, notificationsRouter, workspaceRouter } from './routes/saas.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'blob:', 'https://avatars.githubusercontent.com'],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          scriptSrc: ["'self'"],
          connectSrc: ["'self'", '*'],
        },
      },
      crossOriginEmbedderPolicy: false,
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );
  app.use(
    cors({
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (config.corsOrigins.includes(origin) || config.corsOrigins.includes('*')) {
          return callback(null, true);
        }
        if (!config.isProd || config.corsOrigins.length === 0) {
          return callback(null, true);
        }
        try {
          const host = new URL(origin).hostname;
          if (host.endsWith('.vercel.app') || host === 'localhost') {
            return callback(null, true);
          }
        } catch {
          /* ignore URL parse error */
        }
        return callback(null, true);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Workspace-Id', 'Accept'],
    }),
  );
  app.use(express.json({ limit: '15mb' }));
  app.use(cookieParser());
  if (process.env.NODE_ENV !== 'test') {
    // Log method/path/status only — never bodies or auth headers.
    app.use(morgan(':method :url :status :response-time ms', { skip: (req) => req.url?.startsWith('/api/runs/') && req.method === 'GET' }));
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      db: mongoose.connection.readyState === 1,
      ai: llmEnabled() ? 'llm+deterministic' : 'deterministic',
      // Optional one-click demo target (QuickBite) for local installs.
      demo: process.env.DEMO_APP_URL ? { appUrl: process.env.DEMO_APP_URL, repoUrl: process.env.DEMO_REPO_PATH || '', apiSpecUrl: '/openapi.json' } : null,
    });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/agents', agentsRouter);
  app.use('/api/github', githubRouter);

  const authed = express.Router();
  authed.use(requireAuth, withWorkspace);
  authed.use('/projects', projectsRouter);
  authed.use('/runs', runsRouter);
  authed.use('/bugs', bugsRouter);
  authed.use('/screenshots', screenshotsRouter);
  authed.use('/dashboard', dashboardRouter);
  authed.use('/billing', billingRouter);
  authed.use('/workspaces', workspaceRouter);
  authed.use('/notifications', notificationsRouter);
  authed.use('/autofixes', autofixRouter);
  app.use('/api', authed);
  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));

  // Serve the built web app (single-origin deployment).
  if (fs.existsSync(path.join(config.webDist, 'index.html'))) {
    app.use(express.static(config.webDist, { index: false, maxAge: '1h' }));
    app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(path.join(config.webDist, 'index.html'), { dotfiles: 'allow' }));
  }

  app.use(errorHandler);
  return app;
}
