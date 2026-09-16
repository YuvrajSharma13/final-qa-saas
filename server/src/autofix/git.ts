import { spawn } from 'node:child_process';
import { config } from '../config.js';

/**
 * Minimal, explicit environment for child processes: nothing from the API's own environment leaks in
 * (database URLs, JWT/encryption secrets, API keys, ambient GITHUB_TOKEN, credential helpers…).
 */
export function cleanEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'ComSpec', 'PATHEXT', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'https_proxy', 'http_proxy', 'no_proxy', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS', 'GIT_SSL_CAINFO', 'REQUESTS_CA_BUNDLE', 'npm_config_cafile', 'PLAYWRIGHT_BROWSERS_PATH'];
  const env: NodeJS.ProcessEnv = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return { ...env, ...extra };
}

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  durationMs: number;
}

export function redact(text: string, secrets: (string | undefined)[]) {
  let out = text;
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[REDACTED]');
  return out.replace(/(AUTHORIZATION: basic )[A-Za-z0-9+/=]+/gi, '$1[REDACTED]');
}

export function exec(
  cmd: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; secrets?: string[]; maxOutput?: number },
): Promise<ExecResult> {
  const started = Date.now();
  const max = opts.maxOutput ?? 200_000;
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? cleanEnv(), shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = (buf: string, chunk: Buffer) => (buf.length > max ? buf : buf + chunk.toString('utf8'));
    child.stdout.on('data', (c: Buffer) => (stdout = cap(stdout, c)));
    child.stderr.on('data', (c: Buffer) => (stderr = cap(stderr, c)));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, opts.timeoutMs ?? 120_000);
    const done = (code: number) => {
      clearTimeout(timer);
      resolve({
        code,
        stdout: redact(stdout, opts.secrets || []),
        stderr: redact(stderr, opts.secrets || []),
        timedOut,
        durationMs: Date.now() - started,
      });
    };
    child.on('error', (err) => {
      stderr += String(err.message);
      done(127);
    });
    child.on('close', (code) => done(code ?? 1));
  });
}

export class GitError extends Error {}

/** Runs git with the token supplied through an in-memory http.extraHeader scoped to the GitHub host. */
export async function git(args: string[], opts: { cwd: string; token?: string; timeoutMs?: number; allowFail?: boolean }) {
  const extra: Record<string, string> = {
    GIT_TERMINAL_PROMPT: '0',
    GIT_ASKPASS: 'echo',
    GCM_INTERACTIVE: 'never',
    GIT_AUTHOR_NAME: 'AI QA SaaS',
    GIT_AUTHOR_EMAIL: 'ai-qa-saas@users.noreply.github.com',
    GIT_COMMITTER_NAME: 'AI QA SaaS',
    GIT_COMMITTER_EMAIL: 'ai-qa-saas@users.noreply.github.com',
  };
  if (opts.token) {
    const basic = Buffer.from(`x-access-token:${opts.token}`).toString('base64');
    extra.GIT_CONFIG_COUNT = '1';
    extra.GIT_CONFIG_KEY_0 = `http.${config.github.webUrl}/.extraheader`;
    extra.GIT_CONFIG_VALUE_0 = `AUTHORIZATION: basic ${basic}`;
  }
  const res = await exec(
    'git',
    ['-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`, '-c', 'credential.helper=', ...args],
    { cwd: opts.cwd, env: cleanEnv(extra), timeoutMs: opts.timeoutMs ?? 180_000, secrets: [opts.token || ''] },
  );
  if (res.code !== 0 && !opts.allowFail) {
    const msg = (res.stderr || res.stdout).trim().split('\n').slice(-6).join('\n');
    throw new GitError(`git ${args[0]} failed${res.timedOut ? ' (timeout)' : ''}: ${msg}`);
  }
  return res;
}

const PROTECTED = new Set(['main', 'master', 'develop', 'development', 'production', 'prod', 'release', 'trunk', 'staging']);

/** Hard guard: the auto-fix system may only ever push to its own ai-fix/* branches. */
export function assertSafePushBranch(branch: string, baseBranch: string, defaultBranch: string) {
  const b = branch.trim();
  if (!b.startsWith(config.autofix.branchPrefix)) throw new GitError(`Refusing to push to "${b}": only ${config.autofix.branchPrefix}* branches are allowed`);
  if (b === baseBranch || b === defaultBranch || PROTECTED.has(b) || PROTECTED.has(b.replace(config.autofix.branchPrefix, ''))) {
    throw new GitError(`Refusing to push to protected branch "${b}"`);
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(b) || b.includes('..') || b.endsWith('/') || b.endsWith('.lock')) throw new GitError(`Invalid branch name "${b}"`);
}

export function branchNameFor(bugTitle: string, bugId: string) {
  const slug = bugTitle
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const cut = slug.length > 40 ? slug.slice(0, 41).replace(/-[^-]*$/, '') : slug;
  return `${config.autofix.branchPrefix}${cut || 'bug'}-${bugId.slice(-6)}`;
}
