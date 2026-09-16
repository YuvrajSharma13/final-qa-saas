import fs from 'node:fs/promises';
import path from 'node:path';
import type { Types } from 'mongoose';
import { config } from '../config.js';
import { GitHubClient, GitHubError, repoGitUrl } from '../github/client.js';
import { clientForUser, markConnectionError, tokenForProject } from '../github/connection.js';
import { HttpError } from '../lib/http.js';
import { notifyWorkspace } from '../lib/notify.js';
import { sanitizeText } from '../lib/sanitize.js';
import { AutoFix, Bug, Project, type AutoFixDocument, type AutoFixStatus, type BugDoc } from '../models/index.js';
import { generateFix, type PreviousAttempt } from './generator.js';
import { assertSafePushBranch, branchNameFor, git } from './git.js';
import { applyApprovedDiff, PatchError } from './patch.js';
import { failureFeedback, judge, runValidation, type ValidationReport } from './validation.js';

type FixDoc = AutoFixDocument;

export const ACTIVE_STATUSES: AutoFixStatus[] = ['queued', 'generating', 'applying', 'validating', 'committing', 'pushing', 'creating_pr'];
export const OPEN_STATUSES: AutoFixStatus[] = [...ACTIVE_STATUSES, 'awaiting_approval', 'pr_open'];

// ------------------------------------------------------------------ job queue (one git/validation job at a time)
type Job = { fixId: string; kind: 'generate' | 'apply'; feedback?: string };
const jobs: Job[] = [];
let running: Job | null = null;
const idle: (() => void)[] = [];

function enqueue(job: Job) {
  jobs.push(job);
  pump();
}

function pump() {
  if (running || !jobs.length) return;
  running = jobs.shift()!;
  const job = running;
  (job.kind === 'generate' ? generateJob(job.fixId, job.feedback) : applyJob(job.fixId))
    .catch((err) => console.error('[autofix] job crashed', job, err))
    .finally(() => {
      running = null;
      if (!jobs.length) idle.splice(0).forEach((r) => r());
      pump();
    });
}

export function autofixIdle(): Promise<void> {
  if (!running && !jobs.length) return Promise.resolve();
  return new Promise((r) => idle.push(r));
}

// ------------------------------------------------------------------ helpers
const workRoot = (fixId: string) => path.join(config.autofix.workDir, fixId);
const repoDir = (fixId: string) => path.join(workRoot(fixId), 'repo');

// All writes to a fix document go through one promise chain so concurrent log lines never race.
const chains = new WeakMap<object, Promise<unknown>>();
function persist(fix: FixDoc) {
  const next = (chains.get(fix) || Promise.resolve()).then(() => fix.save()).catch((e) => console.warn('[autofix] save failed', (e as Error).message));
  chains.set(fix, next);
  return next;
}

function event(fix: FixDoc, step: string, message: string, level: 'info' | 'warn' | 'error' = 'info') {
  fix.events.push({ ts: new Date(), step, level, message: sanitizeText(message, 1500) });
  if (fix.events.length > 400) fix.events.splice(0, fix.events.length - 400);
  return persist(fix);
}

async function setStatus(fix: FixDoc, status: AutoFixStatus, message?: string) {
  fix.status = status;
  if (message) await event(fix, status, message);
  else await persist(fix);
}

async function cleanup(fixId: string) {
  await fs.rm(workRoot(fixId), { recursive: true, force: true }).catch(() => undefined);
}

async function contextFor(fix: FixDoc, preferUser?: Types.ObjectId | null) {
  const project = await Project.findById(fix.projectId);
  if (!project) throw new Error('Project no longer exists');
  const auth = await tokenForProject(project, preferUser ?? fix.createdBy);
  if (!auth) throw new Error('No GitHub credentials available for this project. Connect GitHub in Settings.');
  return { project, token: auth.token, tokenUser: auth.userId, client: new GitHubClient(auth.token) };
}

/** Fresh clone (or fast re-sync) of the base branch in the fix's private work directory. */
async function syncBase(fix: FixDoc, token: string) {
  const dir = repoDir(String(fix._id));
  const base = fix.repo!.baseBranch!;
  const url = repoGitUrl(fix.repo!.owner!, fix.repo!.name!);
  const hasClone = await fs
    .stat(path.join(dir, '.git'))
    .then(() => true)
    .catch(() => false);
  if (!hasClone) {
    await fs.mkdir(workRoot(String(fix._id)), { recursive: true });
    await git(['clone', '--no-tags', '--single-branch', '--depth', '50', '--branch', base, url, dir], { cwd: workRoot(String(fix._id)), token, timeoutMs: 300_000 });
  } else {
    await git(['fetch', '--no-tags', '--depth', '50', 'origin', `+refs/heads/${base}:refs/remotes/origin/${base}`], { cwd: dir, token, timeoutMs: 300_000 });
  }
  await git(['checkout', '-q', '-B', `qa-base`, `origin/${base}`], { cwd: dir });
  await git(['reset', '-q', '--hard', `origin/${base}`], { cwd: dir });
  await git(['clean', '-fdq', '-e', 'node_modules', '-e', '.venv'], { cwd: dir });
  const sha = (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
  return { dir, sha };
}

function previousAttempts(fix: FixDoc): PreviousAttempt[] {
  return fix.attempts.map((a) => ({ n: a.n!, explanation: a.explanation || '', diff: a.diff || '', feedback: a.feedback || a.error || '' }));
}

// ------------------------------------------------------------------ public API
export async function createFix(bugId: Types.ObjectId, userId: Types.ObjectId, opts: { baseBranch?: string } = {}) {
  if (!config.autofix.enabled) throw new HttpError(403, 'Auto-fix is disabled on this server');
  const bug = await Bug.findById(bugId);
  if (!bug) throw new HttpError(404, 'Bug not found');
  if (bug.status !== 'open') throw new HttpError(409, `Bug is ${bug.status}; only open bugs can be auto-fixed`);
  const project = await Project.findById(bug.projectId);
  const gh = project?.settings?.github;
  if (!project || !gh?.owner || !gh.repo) throw new HttpError(409, 'Link a GitHub repository to this project first (Settings → GitHub).');
  const active = await AutoFix.findOne({ bugId, status: { $in: [...ACTIVE_STATUSES, 'awaiting_approval'] } }).lean();
  if (active) throw new HttpError(409, 'An auto-fix for this bug is already in progress');
  const conn = await clientForUser(userId);
  if (!conn) throw new HttpError(409, 'Connect your GitHub account first (Settings → GitHub).');
  const baseBranch = opts.baseBranch || gh.baseBranch || gh.defaultBranch || 'main';
  let meta;
  try {
    meta = await conn.client.getRepo(gh.owner, gh.repo);
    await conn.client.getBranch(gh.owner, gh.repo, baseBranch);
  } catch (e) {
    if (e instanceof GitHubError && e.status === 401) await markConnectionError(userId, e.message);
    throw new HttpError(e instanceof GitHubError && e.status === 404 ? 404 : 409, `GitHub: ${(e as Error).message}`);
  }
  if (!meta.permissions?.push) throw new HttpError(403, `@${conn.connection.login} does not have push access to ${meta.full_name}`);
  const fix = await AutoFix.create({
    bugId,
    projectId: project._id,
    workspaceId: project.workspaceId,
    createdBy: userId,
    status: 'queued',
    repo: { owner: meta.owner.login, name: meta.name, baseBranch, defaultBranch: meta.default_branch },
    events: [{ ts: new Date(), level: 'info', step: 'queued', message: `Auto-fix requested for ${meta.full_name}@${baseBranch} by @${conn.connection.login}` }],
  });
  bug.history.push({ at: new Date(), event: 'autofix', message: `AI auto-fix started on ${meta.full_name}@${baseBranch}`, userId });
  await bug.save();
  enqueue({ fixId: String(fix._id), kind: 'generate' });
  return fix;
}

async function generateJob(fixId: string, feedback?: string) {
  const fix = await AutoFix.findById(fixId);
  if (!fix || fix.status === 'canceled') return;
  try {
    await setStatus(fix, 'generating', `Cloning ${fix.repo!.owner}/${fix.repo!.name}@${fix.repo!.baseBranch}`);
    const { token } = await contextFor(fix);
    const { dir, sha } = await syncBase(fix, token);
    fix.repo!.baseSha = sha;
    await event(fix, 'generating', `Base commit ${sha.slice(0, 10)}`);
    const bug = await Bug.findById(fix.bugId).lean();
    if (!bug) throw new Error('Bug was deleted');
    const n = fix.attempts.length + 1;
    const previous = previousAttempts(fix);
    if (feedback && previous.length) previous[previous.length - 1].feedback = `${previous[previous.length - 1].feedback || ''}\nReviewer feedback: ${feedback}`.trim();
    const proposal = await generateFix({ root: dir, bug: bug as unknown as BugDoc, attempt: n, previous, log: (m) => void event(fix, 'generating', m) });
    fix.attempts.push({
      n,
      engine: proposal.engine,
      explanation: proposal.explanation,
      edits: proposal.edits,
      files: proposal.files,
      diff: proposal.diff,
      patchHash: proposal.patchHash,
      status: 'proposed',
      createdAt: new Date(),
    });
    await setStatus(
      fix,
      'awaiting_approval',
      `Attempt ${n} ready (${proposal.engine === 'llm' ? 'AI model' : 'rule engine'}): ${proposal.files.map((f) => `${f.path} +${f.additions}/-${f.deletions}`).join(', ')}. Review the diff and approve to continue.`,
    );
  } catch (err) {
    fix.error = sanitizeText((err as Error).message, 1000);
    await setStatus(fix, 'failed', `Fix generation failed: ${fix.error}`);
    await cleanup(fixId);
  }
}

export async function approveFix(fix: FixDoc, userId: Types.ObjectId, attemptN: number, patchHash: string) {
  if (fix.status !== 'awaiting_approval') throw new HttpError(409, `Fix is ${fix.status}, not awaiting approval`);
  const attempt = fix.attempts[fix.attempts.length - 1];
  if (!attempt || attempt.n !== attemptN || attempt.status !== 'proposed') throw new HttpError(409, 'Only the latest proposed attempt can be approved');
  if (attempt.patchHash !== patchHash) throw new HttpError(409, 'The diff changed since you reviewed it. Reload and review again.');
  const conn = await clientForUser(userId);
  if (!conn) throw new HttpError(409, 'Connect your GitHub account before approving (commits and the PR are created with your GitHub access).');
  attempt.status = 'approved';
  attempt.approvedBy = userId;
  attempt.approvedAt = new Date();
  fix.markModified('attempts');
  await setStatus(fix, 'applying', `Attempt ${attemptN} approved by @${conn.connection.login} (patch ${patchHash.slice(0, 12)})`);
  enqueue({ fixId: String(fix._id), kind: 'apply' });
}

export async function rejectFix(fix: FixDoc, userId: Types.ObjectId, feedback: string, regenerate: boolean) {
  if (fix.status !== 'awaiting_approval') throw new HttpError(409, `Fix is ${fix.status}, not awaiting approval`);
  const attempt = fix.attempts[fix.attempts.length - 1];
  attempt.status = 'rejected';
  attempt.feedback = feedback ? `Reviewer rejected the diff: ${feedback}` : 'Reviewer rejected the diff';
  fix.markModified('attempts');
  if (regenerate && fix.attempts.length < config.autofix.maxAttempts) {
    await setStatus(fix, 'queued', `Attempt ${attempt.n} rejected; generating a new attempt${feedback ? ' with reviewer feedback' : ''}`);
    enqueue({ fixId: String(fix._id), kind: 'generate' });
  } else {
    await setStatus(fix, 'rejected', `Attempt ${attempt.n} rejected by reviewer${feedback ? `: ${feedback}` : ''}. Nothing was pushed.`);
    await cleanup(String(fix._id));
  }
  void userId;
}

export async function cancelFix(fix: FixDoc) {
  if (!OPEN_STATUSES.includes(fix.status as AutoFixStatus) || fix.status === 'pr_open') throw new HttpError(409, `Fix is ${fix.status}`);
  if (running?.fixId === String(fix._id)) throw new HttpError(409, 'The fix is being processed right now; try again in a moment');
  const idx = jobs.findIndex((j) => j.fixId === String(fix._id));
  if (idx >= 0) jobs.splice(idx, 1);
  await setStatus(fix, 'canceled', 'Canceled by user. Nothing was pushed.');
  await cleanup(String(fix._id));
}

function commitMessage(bug: { title: string; _id: unknown }, fix: FixDoc, attempt: FixDoc['attempts'][number]) {
  const subject = `fix: ${bug.title}`.replace(/\s+/g, ' ').slice(0, 72);
  return `${subject}\n\n${(attempt.explanation || '').slice(0, 1500)}\n\nGenerated by AI QA SaaS auto-fix (attempt ${attempt.n}, ${attempt.engine}) for bug ${bug._id}.\nApproved diff sha256: ${attempt.patchHash}\n`;
}

function validationMarkdown(v: ValidationReport | null, baseline: ValidationReport | null, preExisting: string[]) {
  if (!v) return '_Validation was disabled on the server._';
  const rows = v.checks.map((c) => {
    const b = baseline?.checks.find((x) => x.name === c.name);
    const icon = c.status === 'passed' ? '✅' : c.status === 'skipped' ? '⏭️' : '❌';
    return `| ${icon} ${c.name} | \`${c.command.replace(/\|/g, '\\|')}\` | ${c.status}${c.failures != null ? ` (${c.failures} failing)` : ''} | ${b ? b.status + (b.failures != null ? ` (${b.failures} failing)` : '') : '—'} |`;
  });
  return [
    `**${v.summary}**`,
    '',
    '| Check | Command | This branch | Base branch |',
    '|---|---|---|---|',
    ...rows,
    preExisting.length ? `\n> Pre-existing failures (not introduced by this change): ${preExisting.join('; ')}` : '',
  ].join('\n');
}

async function applyJob(fixId: string) {
  const fix = await AutoFix.findById(fixId);
  if (!fix || fix.status !== 'applying') return;
  const attempt = fix.attempts[fix.attempts.length - 1];
  try {
    const { client, token, project } = await contextFor(fix, attempt.approvedBy);
    const repo = fix.repo!;
    const bug = await Bug.findById(fix.bugId);
    if (!bug) throw new Error('Bug was deleted');

    // 1) Fresh base + dedicated ai-fix branch (never main/master).
    const { dir, sha } = await syncBase(fix, token);
    if (repo.baseSha && repo.baseSha !== sha) await event(fix, 'applying', `Base branch moved ${repo.baseSha.slice(0, 7)} → ${sha.slice(0, 7)}; re-checking that the approved patch still applies`, 'warn');
    repo.baseSha = sha;
    if (!fix.branch) {
      let name = branchNameFor(bug.title, String(bug._id));
      for (let i = 2; await client.branchExists(repo.owner!, repo.name!, name); i++) name = `${branchNameFor(bug.title, String(bug._id))}-${i}`;
      fix.branch = name;
    }
    assertSafePushBranch(fix.branch, repo.baseBranch!, repo.defaultBranch || '');
    await git(['checkout', '-q', '-B', fix.branch, `origin/${repo.baseBranch}`], { cwd: dir });
    await event(fix, 'applying', `Created local branch ${fix.branch} from ${repo.baseBranch}@${sha.slice(0, 7)}`);

    // 2) Baseline checks on the untouched base (cached per base commit).
    let baseline = fix.baseline as ValidationReport | null;
    const files = attempt.files.map((f) => f.path!);
    if (config.autofix.runValidation && (!baseline || (baseline as unknown as { baseSha?: string }).baseSha !== sha)) {
      await setStatus(fix, 'validating', 'Running project checks on the base branch (baseline)');
      baseline = await runValidation(dir, [], 'baseline', (m) => void event(fix, 'validating', m));
      fix.baseline = { ...baseline, baseSha: sha };
      fix.markModified('baseline');
      await event(fix, 'validating', `Baseline: ${baseline.summary}`);
      await git(['checkout', '-q', '--', '.'], { cwd: dir });
      await git(['clean', '-fdq', '-e', 'node_modules', '-e', '.venv'], { cwd: dir });
    }

    // 3) Apply exactly the approved diff.
    await setStatus(fix, 'applying', `Applying approved patch (${files.join(', ')})`);
    await applyApprovedDiff(dir, attempt.diff!, attempt.patchHash!, files);
    await event(fix, 'applying', 'Patch applied; working tree matches the approved diff byte-for-byte');

    // 4) Validation of the patched tree.
    let report: ValidationReport | null = null;
    let verdict = { ok: true, problems: [] as string[], preExisting: [] as string[] };
    if (config.autofix.runValidation) {
      await setStatus(fix, 'validating', 'Running project checks on the patched branch');
      const installOk = Boolean(baseline?.checks.find((c) => c.kind === 'install' && c.status === 'passed'));
      report = await runValidation(dir, files, 'patched', (m) => void event(fix, 'validating', m), installOk);
      verdict = judge(baseline, report);
      attempt.validation = { ...report, verdict };
      fix.markModified('attempts');
      await event(fix, 'validating', `Validation: ${report.summary}${verdict.problems.length ? ` · regressions: ${verdict.problems.join(', ')}` : ''}`, verdict.ok ? 'info' : 'warn');
    } else {
      await event(fix, 'validating', 'Validation disabled on this server (AUTOFIX_RUN_VALIDATION=false)', 'warn');
    }

    if (!verdict.ok) {
      attempt.status = 'validation_failed';
      attempt.feedback = `Validation failed after applying this patch:\n${failureFeedback(report!, verdict.problems)}`;
      fix.markModified('attempts');
      await git(['checkout', '-q', '--', '.'], { cwd: dir });
      if (fix.attempts.length < config.autofix.maxAttempts) {
        await setStatus(fix, 'queued', `Attempt ${attempt.n} failed validation; sending the errors back to the fix engine (attempt ${(attempt.n ?? 0) + 1}/${config.autofix.maxAttempts}). The new diff will need your approval.`);
        enqueue({ fixId, kind: 'generate' });
      } else {
        fix.error = `Validation failed after ${fix.attempts.length} attempts: ${verdict.problems.join(', ')}`;
        await setStatus(fix, 'failed', `${fix.error}. Nothing was pushed.`);
        await cleanup(fixId);
      }
      return;
    }

    // Guard: validation scripts must not have altered the approved files.
    const after = (await git(['diff', '--no-color', '--no-ext-diff', '--unified=3', '--', ...files], { cwd: dir })).stdout;
    const { sha256 } = await import('./patch.js');
    if (sha256(after) !== attempt.patchHash) throw new PatchError('Validation scripts modified the approved files; refusing to commit');

    // 5) Commit only the approved files, authored by the approving developer.
    await setStatus(fix, 'committing', 'Committing the approved files');
    await git(['add', '--', ...files], { cwd: dir });
    const staged = (await git(['diff', '--cached', '--name-only'], { cwd: dir })).stdout.split('\n').filter(Boolean).sort();
    if (JSON.stringify(staged) !== JSON.stringify([...files].sort())) throw new PatchError(`Unexpected staged files: ${staged.join(', ')}`);
    const approver = await clientForUser(attempt.approvedBy);
    const login = approver?.connection.login;
    const author = approver ? `${approver.connection.name || login} <${approver.connection.githubUserId}+${login}@users.noreply.github.com>` : 'AI QA SaaS <ai-qa-saas@users.noreply.github.com>';
    await git(['commit', '-q', '--no-verify', `--author=${author}`, '-m', commitMessage(bug, fix, attempt)], { cwd: dir });
    fix.commitSha = (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
    await event(fix, 'committing', `Committed ${fix.commitSha.slice(0, 10)} as ${author.replace(/<.*>/, '').trim()}`);

    // 6) Push the ai-fix branch (explicit refspec, no force).
    await setStatus(fix, 'pushing', `Pushing ${fix.branch} to ${repo.owner}/${repo.name}`);
    assertSafePushBranch(fix.branch, repo.baseBranch!, repo.defaultBranch || '');
    await git(['push', '--porcelain', 'origin', `HEAD:refs/heads/${fix.branch}`], { cwd: dir, token, timeoutMs: 300_000 });
    await event(fix, 'pushing', `Pushed ${fix.branch}`);

    // 7) Pull request.
    await setStatus(fix, 'creating_pr', 'Opening a pull request');
    const appLink = `${config.appUrl.replace(/\/$/, '')}/bugs/${bug._id}`;
    const body = [
      `## 🤖 AI QA auto-fix`,
      '',
      `**Bug:** ${bug.title}`,
      `**Severity:** ${bug.severity} · **Category:** ${bug.category} · [View in AI QA](${appLink})`,
      '',
      `### Root cause & fix`,
      attempt.explanation || '',
      '',
      `### Expected vs actual`,
      `- Expected: ${bug.expected || '—'}`,
      `- Actual: ${(bug.actual || '—').slice(0, 400)}`,
      '',
      `### Validation`,
      validationMarkdown(report, baseline, verdict.preExisting),
      '',
      `### Change summary`,
      ...attempt.files.map((f) => `- \`${f.path}\` (+${f.additions} / -${f.deletions})`),
      '',
      `<sub>Patch attempt ${attempt.n} (${attempt.engine}) · approved by @${login || 'unknown'} · diff sha256 \`${attempt.patchHash!.slice(0, 16)}\` · Generated by AI QA SaaS. Please review before merging.</sub>`,
    ].join('\n');
    let pr;
    try {
      pr = await client.createPull(repo.owner!, repo.name!, { title: `fix: ${bug.title}`.slice(0, 250), head: fix.branch, base: repo.baseBranch!, body, maintainer_can_modify: true });
    } catch (e) {
      if (e instanceof GitHubError && e.status === 422 && /already exists/i.test(e.message)) pr = await client.findOpenPull(repo.owner!, repo.name!, fix.branch);
      if (!pr) throw e;
    }
    await client.addLabels(repo.owner!, repo.name!, pr.number, ['ai-fix', 'bug']).catch(() => undefined);
    fix.pr = { number: pr.number, url: pr.html_url, state: pr.state, merged: pr.merged, draft: pr.draft, title: pr.title, mergeable: pr.mergeable, updatedAt: new Date() };
    await setStatus(fix, 'pr_open', `Pull request #${pr.number} opened: ${pr.html_url}`);
    bug.history.push({ at: new Date(), event: 'autofix', message: `AI fix PR #${pr.number} opened (${fix.branch})`, userId: attempt.approvedBy });
    bug.rootCause = { ...((bug.rootCause as object) || {}), autofix: { fixId: fix._id, prUrl: pr.html_url, prNumber: pr.number, branch: fix.branch } };
    bug.markModified('rootCause');
    await bug.save();
    await notifyWorkspace({
      workspaceId: project.workspaceId,
      type: 'autofix_pr',
      title: `AI fix PR #${pr.number} opened for ${project.name}`,
      body: `${bug.title}\n${pr.html_url}`,
      link: `/fixes/${fix._id}`,
      email: false,
    });
    await cleanup(fixId);
  } catch (err) {
    const msg = sanitizeText((err as Error).message, 1000);
    fix.error = msg;
    if (attempt) {
      attempt.error = msg;
      fix.markModified('attempts');
    }
    const stage = fix.status as string;
    const pushed = stage === 'creating_pr' ? ` Branch ${fix.branch} was pushed but no PR was created.` : stage === 'pushing' ? ' The push did not complete.' : ' Nothing was pushed.';
    await setStatus(fix, 'failed', `${msg}.${pushed}`);
    if (err instanceof GitHubError && err.status === 401) await markConnectionError(attempt?.approvedBy ?? undefined, err.message);
    await cleanup(fixId);
  }
}

/** Retries generation after a failure (keeps previous attempts as context). */
export async function retryFix(fix: FixDoc, feedback: string) {
  if (!['failed', 'rejected'].includes(fix.status)) throw new HttpError(409, `Fix is ${fix.status}`);
  if (fix.attempts.length >= config.autofix.maxAttempts + 2) throw new HttpError(409, 'Too many attempts for this fix; start a new one');
  if (fix.pr?.number) throw new HttpError(409, 'A pull request already exists for this fix');
  fix.error = '';
  await setStatus(fix, 'queued', `Retry requested${feedback ? ` with feedback: ${feedback}` : ''}`);
  enqueue({ fixId: String(fix._id), kind: 'generate', feedback });
}

export async function refreshPrStatus(fix: FixDoc, userId?: Types.ObjectId) {
  if (!fix.pr?.number || !fix.repo?.owner) return fix;
  const project = await Project.findById(fix.projectId);
  if (!project) return fix;
  const auth = await tokenForProject(project, userId ?? fix.createdBy);
  if (!auth) return fix;
  const client = new GitHubClient(auth.token);
  try {
    const pr = await client.getPull(fix.repo.owner, fix.repo.name!, fix.pr.number);
    const checks = await client.checksSummary(fix.repo.owner, fix.repo.name!, pr.head.sha);
    const prev = fix.status;
    fix.pr = { ...fix.pr, state: pr.state, merged: pr.merged, draft: pr.draft, mergeable: pr.mergeable, title: pr.title, checks, updatedAt: new Date() };
    fix.markModified('pr');
    await (chains.get(fix) || Promise.resolve());
    const next: AutoFixStatus = pr.merged ? 'merged' : pr.state === 'closed' ? 'closed' : 'pr_open';
    fix.status = next;
    await persist(fix);
    if (prev !== next && next !== 'pr_open') {
      await event(fix, next, `Pull request #${pr.number} ${next}`);
      if (next === 'merged') {
        await Bug.updateOne(
          { _id: fix.bugId },
          { $push: { history: { at: new Date(), event: 'autofix', message: `AI fix PR #${pr.number} merged — rerun QA to verify the fix` } } },
        );
      }
    }
  } catch (e) {
    fix.pr = { ...fix.pr, updatedAt: new Date() };
    fix.markModified('pr');
    await event(fix, 'pr', `Could not refresh PR status: ${(e as Error).message}`, 'warn');
  }
  return fix;
}

/** Jobs cannot survive a restart: mark in-flight fixes as failed so the user can retry. */
export async function recoverInterruptedFixes() {
  const stale = await AutoFix.find({ status: { $in: ACTIVE_STATUSES } });
  for (const f of stale) {
    f.error = 'Interrupted by a server restart';
    f.events.push({ ts: new Date(), step: 'failed', level: 'error', message: 'Interrupted by a server restart — use Retry to continue. Nothing was pushed.' });
    f.status = 'failed';
    await f.save();
  }
}

