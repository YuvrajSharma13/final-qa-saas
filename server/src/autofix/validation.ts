import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { cleanEnv, exec } from './git.js';

/**
 * Detects and runs the repository's own checks (install → lint → typecheck → test → build) plus syntax checks
 * of the changed files. Checks run in a scrubbed environment: no platform secrets or tokens are visible.
 */

export interface CheckResult {
  name: string;
  kind: 'install' | 'lint' | 'typecheck' | 'test' | 'build' | 'syntax';
  command: string;
  status: 'passed' | 'failed' | 'skipped' | 'timeout';
  exitCode?: number;
  durationMs?: number;
  failures?: number | null;
  output?: string;
  note?: string;
}

export interface ValidationReport {
  phase: 'baseline' | 'patched';
  checks: CheckResult[];
  passed: boolean;
  summary: string;
  startedAt: Date;
  durationMs: number;
}

interface PlannedCheck {
  name: string;
  kind: CheckResult['kind'];
  cmd: string;
  args: string[];
  timeoutMs: number;
}

const tail = (s: string, n = 6000) => (s.length > n ? `…${s.slice(-n)}` : s);

async function exists(p: string) {
  return fs
    .access(p)
    .then(() => true)
    .catch(() => false);
}

async function hasBinary(bin: string) {
  const r = await exec(process.platform === 'win32' ? 'where' : 'which', [bin], { cwd: process.cwd(), timeoutMs: 5000 });
  return r.code === 0;
}

const PLACEHOLDER_TEST = /no test specified/i;

export async function planChecks(root: string): Promise<{ checks: PlannedCheck[]; notes: string[] }> {
  const checks: PlannedCheck[] = [];
  const notes: string[] = [];
  const step = config.autofix.stepTimeoutMs;
  const pkgPath = path.join(root, 'package.json');
  if (await exists(pkgPath)) {
    let pkg: { scripts?: Record<string, string>; dependencies?: object; devDependencies?: object; packageManager?: string } = {};
    try {
      pkg = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
    } catch {
      notes.push('package.json is not valid JSON');
    }
    const scripts = pkg.scripts || {};
    const hasDeps = Object.keys(pkg.dependencies || {}).length + Object.keys(pkg.devDependencies || {}).length > 0;
    let pm = 'npm';
    if ((await exists(path.join(root, 'pnpm-lock.yaml'))) && (await hasBinary('pnpm'))) pm = 'pnpm';
    else if ((await exists(path.join(root, 'yarn.lock'))) && (await hasBinary('yarn'))) pm = 'yarn';
    const ignoreScripts = process.env.AUTOFIX_INSTALL_SCRIPTS === 'true' ? [] : ['--ignore-scripts'];
    if (hasDeps) {
      if (pm === 'pnpm') checks.push({ name: 'Install dependencies', kind: 'install', cmd: 'pnpm', args: ['install', '--frozen-lockfile', ...ignoreScripts], timeoutMs: config.autofix.installTimeoutMs });
      else if (pm === 'yarn') checks.push({ name: 'Install dependencies', kind: 'install', cmd: 'yarn', args: ['install', '--frozen-lockfile', '--non-interactive', ...ignoreScripts], timeoutMs: config.autofix.installTimeoutMs });
      else if (await exists(path.join(root, 'package-lock.json')))
        checks.push({ name: 'Install dependencies', kind: 'install', cmd: 'npm', args: ['ci', '--no-audit', '--no-fund', ...ignoreScripts], timeoutMs: config.autofix.installTimeoutMs });
      else checks.push({ name: 'Install dependencies', kind: 'install', cmd: 'npm', args: ['install', '--no-audit', '--no-fund', '--no-package-lock', ...ignoreScripts], timeoutMs: config.autofix.installTimeoutMs });
    }
    const run = (script: string) => (pm === 'npm' ? { cmd: 'npm', args: ['run', script, '--if-present'] } : { cmd: pm, args: ['run', script] });
    const pick = (names: string[]) => names.find((n) => scripts[n]);
    const lint = pick(['lint', 'lint:ci', 'eslint']);
    if (lint) checks.push({ name: `Lint (${lint})`, kind: 'lint', ...run(lint), timeoutMs: step });
    const tc = pick(['typecheck', 'type-check', 'check-types', 'tsc']);
    if (tc) checks.push({ name: `Type check (${tc})`, kind: 'typecheck', ...run(tc), timeoutMs: step });
    if (scripts.test && !PLACEHOLDER_TEST.test(scripts.test)) checks.push({ name: 'Tests (test)', kind: 'test', ...run('test'), timeoutMs: step });
    else notes.push('No test script found in package.json');
    if (scripts.build) checks.push({ name: 'Build (build)', kind: 'build', ...run('build'), timeoutMs: step });
    if (!lint) notes.push('No lint script found');
    if (!scripts.build) notes.push('No build script found');
  }
  const py = (await exists(path.join(root, 'pyproject.toml'))) || (await exists(path.join(root, 'setup.py'))) || (await exists(path.join(root, 'requirements.txt')));
  if (py) {
    const hasTests = (await exists(path.join(root, 'tests'))) || (await exists(path.join(root, 'pytest.ini'))) || (await exists(path.join(root, 'test')));
    const pytest = hasTests && (await exec('python3', ['-c', 'import pytest'], { cwd: root, timeoutMs: 10000 })).code === 0;
    if (pytest) checks.push({ name: 'Tests (pytest)', kind: 'test', cmd: 'python3', args: ['-m', 'pytest', '-q'], timeoutMs: step });
    else notes.push('Python project detected but pytest is not available on the validation host');
  }
  if ((await exists(path.join(root, 'go.mod'))) && (await hasBinary('go'))) {
    checks.push({ name: 'Build (go build)', kind: 'build', cmd: 'go', args: ['build', './...'], timeoutMs: step });
    checks.push({ name: 'Tests (go test)', kind: 'test', cmd: 'go', args: ['test', './...'], timeoutMs: step });
  }
  return { checks, notes };
}

/** Parses the number of failing tests from common runners' output (node:test, jest/vitest, mocha, pytest, go). */
export function countFailures(output: string): number | null {
  const pats = [/^# fail (\d+)/m, /Tests?:\s+(\d+) failed/, /(\d+) failing/, /(\d+) failed/, /ℹ fail (\d+)/];
  for (const re of pats) {
    const m = output.match(re);
    if (m) return Number(m[1]);
  }
  const goFails = output.match(/^--- FAIL:/gm);
  if (goFails) return goFails.length;
  return null;
}

async function syntaxChecks(root: string, changedFiles: string[]): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  for (const f of changedFiles) {
    const abs = path.join(root, f);
    const t0 = Date.now();
    if (/\.(c|m)?js$/.test(f)) {
      const r = await exec(process.execPath, ['--check', abs], { cwd: root, timeoutMs: 20000, env: cleanEnv() });
      out.push({ name: `Syntax: ${f}`, kind: 'syntax', command: `node --check ${f}`, status: r.code === 0 ? 'passed' : 'failed', exitCode: r.code, durationMs: r.durationMs, output: tail(r.stderr || r.stdout, 2000) });
    } else if (/\.json$/.test(f)) {
      try {
        JSON.parse(await fs.readFile(abs, 'utf8'));
        out.push({ name: `Syntax: ${f}`, kind: 'syntax', command: 'JSON.parse', status: 'passed', durationMs: Date.now() - t0 });
      } catch (e) {
        out.push({ name: `Syntax: ${f}`, kind: 'syntax', command: 'JSON.parse', status: 'failed', output: (e as Error).message, durationMs: Date.now() - t0 });
      }
    } else if (/\.py$/.test(f)) {
      const r = await exec('python3', ['-m', 'py_compile', abs], { cwd: root, timeoutMs: 20000, env: cleanEnv() });
      out.push({ name: `Syntax: ${f}`, kind: 'syntax', command: `python3 -m py_compile ${f}`, status: r.code === 0 ? 'passed' : r.code === 127 ? 'skipped' : 'failed', exitCode: r.code, output: tail(r.stderr, 2000) });
    } else if (/\.css$/.test(f)) {
      const css = (await fs.readFile(abs, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
      const balanced = (css.match(/\{/g) || []).length === (css.match(/\}/g) || []).length;
      out.push({ name: `Syntax: ${f}`, kind: 'syntax', command: 'css brace balance', status: balanced ? 'passed' : 'failed', output: balanced ? '' : 'Unbalanced { } in stylesheet' });
    }
  }
  return out;
}

export async function runValidation(root: string, changedFiles: string[], phase: ValidationReport['phase'], log: (m: string) => void, reuseInstall = false): Promise<ValidationReport> {
  const started = Date.now();
  const { checks: planned, notes } = await planChecks(root);
  const results: CheckResult[] = [];
  const env = cleanEnv({ CI: 'true', FORCE_COLOR: '0', NO_COLOR: '1', npm_config_update_notifier: 'false', HUSKY: '0' });
  let installFailed = false;
  for (const c of planned) {
    const command = `${c.cmd} ${c.args.join(' ')}`;
    if (c.kind === 'install' && reuseInstall) {
      results.push({ name: c.name, kind: c.kind, command, status: 'skipped', note: 'Reused dependencies installed for the baseline' });
      continue;
    }
    if (installFailed) {
      results.push({ name: c.name, kind: c.kind, command, status: 'skipped', note: 'Skipped because dependency installation failed' });
      continue;
    }
    log(`${phase === 'baseline' ? 'Baseline' : 'Validation'}: ${command}`);
    const r = await exec(c.cmd, c.args, { cwd: root, env, timeoutMs: c.timeoutMs, maxOutput: 400_000 });
    const output = tail(`${r.stdout}\n${r.stderr}`.trim());
    const status: CheckResult['status'] = r.timedOut ? 'timeout' : r.code === 0 ? 'passed' : 'failed';
    results.push({ name: c.name, kind: c.kind, command, status, exitCode: r.code, durationMs: r.durationMs, output, failures: c.kind === 'test' ? countFailures(output) : undefined });
    if (c.kind === 'install' && status !== 'passed') installFailed = true;
    log(`  → ${status} (${(r.durationMs / 1000).toFixed(1)}s)`);
  }
  if (phase === 'patched' || changedFiles.length) results.push(...(await syntaxChecks(root, changedFiles)));
  const failed = results.filter((r) => r.status === 'failed' || r.status === 'timeout');
  return {
    phase,
    checks: results,
    passed: failed.length === 0,
    summary: planned.length
      ? `${results.filter((r) => r.status === 'passed').length} passed, ${failed.length} failed, ${results.filter((r) => r.status === 'skipped').length} skipped${notes.length ? ` · ${notes.join('; ')}` : ''}`
      : `No project checks detected (${notes.join('; ') || 'no package.json / pytest / go.mod'}); syntax checks only`,
    startedAt: new Date(started),
    durationMs: Date.now() - started,
  };
}

/**
 * A patch is accepted when nothing that passed before fails now, syntax checks pass, and failing test suites do
 * not gain failures (a suite that was already red may stay red only if the failure count does not increase).
 */
export function judge(baseline: ValidationReport | null, patched: ValidationReport) {
  const problems: string[] = [];
  const preExisting: string[] = [];
  for (const c of patched.checks) {
    if (c.status === 'passed' || c.status === 'skipped') continue;
    const before = baseline?.checks.find((b) => b.name === c.name);
    if (c.kind === 'syntax' || !before || before.status === 'passed' || before.status === 'skipped') {
      problems.push(c.name);
      continue;
    }
    if (c.kind === 'test' && before.failures != null && c.failures != null) {
      if (c.failures > before.failures) problems.push(`${c.name} (${before.failures} → ${c.failures} failures)`);
      else preExisting.push(`${c.name} (${before.failures} → ${c.failures} failures)`);
    } else if (c.kind === 'test' && (before.failures == null || c.failures == null)) {
      // Cannot compare precisely: treat as still broken only if baseline also failed.
      preExisting.push(`${c.name} (failing before and after)`);
    } else {
      preExisting.push(`${c.name} (already failing on the base branch)`);
    }
  }
  return { ok: problems.length === 0, problems, preExisting };
}

export function failureFeedback(report: ValidationReport, problems: string[]) {
  const failing = report.checks.filter((c) => problems.some((p) => p.startsWith(c.name)));
  return failing
    .map((c) => `### ${c.name} — ${c.status} (exit ${c.exitCode ?? '?'})\n$ ${c.command}\n${(c.output || '').slice(-2500)}`)
    .join('\n\n');
}
