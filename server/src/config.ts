import fs from 'node:fs';
import path from 'node:path';

const envFile = path.resolve(process.cwd(), '.env');
if (fs.existsSync(envFile)) {
  // Node >= 20.12 ships a dotenv-compatible loader.
  process.loadEnvFile(envFile);
}

const bool = (v: string | undefined, def: boolean) => (v === undefined || v === '' ? def : ['1', 'true', 'yes'].includes(v.toLowerCase()));
const isProd = process.env.NODE_ENV === 'production';

function required(name: string, devDefault: string): string {
  const v = process.env[name];
  if (v) return v;
  if (isProd) throw new Error(`Missing required environment variable ${name}`);
  return devDefault;
}

export const config = {
  isProd,
  port: Number(process.env.PORT || 4000),
  mongoUri: process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/ai_qa_saas',
  jwtSecret: required('JWT_SECRET', 'dev-only-jwt-secret'),
  encryptionKey: required('APP_ENCRYPTION_KEY', 'dev-only-encryption-key'),
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  chromiumPath: process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined),
  allowPrivateTargets: bool(process.env.ALLOW_PRIVATE_TARGETS, !isProd),
  allowLocalRepos: bool(process.env.ALLOW_LOCAL_REPOS, !isProd),
  qaConcurrency: Math.max(1, Number(process.env.QA_CONCURRENCY || 1)),
  anthropicKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5',
  aiDisabled: bool(process.env.AI_DISABLED, false),
  storageDir: path.resolve(process.env.STORAGE_DIR || './storage'),
  s3: {
    bucket: process.env.S3_BUCKET || '',
    region: process.env.S3_REGION || 'us-east-1',
    endpoint: process.env.S3_ENDPOINT || undefined,
    accessKeyId: process.env.S3_ACCESS_KEY_ID || '',
    secretAccessKey: process.env.S3_SECRET_ACCESS_KEY || '',
  },
  smtpUrl: process.env.SMTP_URL || '',
  mailFrom: process.env.MAIL_FROM || 'AI QA <qa@example.com>',
  internalToken: process.env.INTERNAL_API_TOKEN || '',
  webDist: path.resolve(process.env.WEB_DIST || path.join(process.cwd(), '..', 'web', 'dist')),
};
