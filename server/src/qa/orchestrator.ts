import type { Browser } from 'playwright-core';
import type { Types } from 'mongoose';
import { llmEnabled } from '../ai/llm.js';
import { decryptSecret } from '../lib/crypto.js';
import { notifyWorkspace } from '../lib/notify.js';
import { planFor } from '../lib/plans.js';
import { sanitizeText, sanitizeValue } from '../lib/sanitize.js';
import { incrementUsage } from '../lib/usage.js';
import { AgentRun, AGENT_TYPES, Bug, Project, TestCase, TestRun, Workspace, type AgentType } from '../models/index.js';
import { runApiAgent } from './agents/api.js';
import { runBugAnalyzer } from './agents/bugAnalyzer.js';
import { runCodeAnalysis } from './agents/codeAnalysis.js';
import { runFunctionalAgent } from './agents/functional.js';
import { runTestPlanner } from './agents/planner.js';
import { runRegressionAgent } from './agents/regression.js';
import { runVisionAgent } from './agents/vision.js';
import { launchBrowser } from './browser.js';
import type { Finding, RunContext, TestPlan } from './types.js';

/**
 * QA Orchestrator:
 *   Test Planner → (Functional ∥ API ∥ Vision) → Bug Analyzer → Code Analysis → Regression Test → Dashboard
 */

export class RunCanceled extends Error {}

const SEVERITY_PENALTY: Record<string, number> = { critical: 15, high: 8, medium: 4, low: 1 };

export function qaScore(passed: number, total: number, openBySeverity: Record<string, number>) {
  if (!total) return 0;
  const base = (passed / total) * 100;
  const penalty = Object.entries(openBySeverity).reduce((s, [k, n]) => s + (SEVERITY_PENALTY[k] || 0) * n, 0);
  return Math.max(0, Math.min(100, Math.round(base - penalty)));
}

export async function executeRun(runId: string, isCanceled: () => boolean) {
  const run = await TestRun.findById(runId);
  if (!run || run.status !== 'queued') return;
  const project = await Project.findById(run.projectId);
  if (!project) {
    await TestRun.updateOne({ _id: runId }, { status: 'failed', error: 'Project was deleted', completedAt: new Date() });
    return;
  }
  const ws = await Workspace.findById(run.workspaceId).lean();
  const plan = planFor(ws?.plan);
  const cfg = run.config as { agents: Record<string, boolean>; viewports: string[]; maxPages: number };
  const started = Date.now();

  // Buffered event log flushed to the run document so the UI can stream progress.
  const pending: { ts: Date; agent: string; level: string; message: string }[] = [];
  let flushing: Promise<unknown> = Promise.resolve();
  const flush = () => {
    if (!pending.length) return flushing;
    const batch = pending.splice(0);
    flushing = flushing.then(() => TestRun.updateOne({ _id: runId }, { $push: { events: { $each: batch } } })).catch(() => undefined);
    return flushing;
  };
  const timer = setInterval(flush, 700);
  const setProgress = (phase: string, percent: number) => {
    flushing = flushing.then(() => TestRun.updateOne({ _id: runId }, { progress: { phase, percent } })).catch(() => undefined);
  };

  const s = project.settings!;
  let credentials: RunContext['credentials'] = null;
  let githubToken = '';
  try {
    if (s.testUsername && s.testPasswordEnc) credentials = { username: s.testUsername, password: decryptSecret(s.testPasswordEnc) };
    githubToken = s.githubTokenEnc ? decryptSecret(s.githubTokenEnc) : '';
  } catch {
    pending.push({ ts: new Date(), agent: 'orchestrator', level: 'warn', message: 'Stored secrets could not be decrypted (encryption key changed?) — continuing without them' });
  }

  const ctx: RunContext = {
    runId: run._id,
    projectId: project._id,
    workspaceId: project.workspaceId,
    appUrl: project.appUrl,
    repoUrl: project.repoUrl || '',
    apiSpecUrl: s.apiSpecUrl || '',
    apiBaseUrl: s.apiBaseUrl || '',
    viewports: cfg.viewports,
    maxPages: cfg.maxPages,
    credentials,
    githubToken,
    aiCalls: 0,
    isCanceled,
    // Secrets are scrubbed from every log line before it is stored or displayed.
    log: (agent, message, level = 'info') => {
      const clean = [credentials?.password, githubToken].filter((x): x is string => Boolean(x && x.length > 3)).reduce((m, secret) => m.split(secret).join('[REDACTED]'), sanitizeText(message, 600));
      pending.push({ ts: new Date(), agent, level, message: clean });
    },
  };

  const agentDocs = new Map<AgentType, Types.ObjectId>();
  for (const type of AGENT_TYPES) {
    const doc = await AgentRun.create({ runId: run._id, agentType: type, status: 'pending' });
    agentDocs.set(type, doc._id);
  }

  async function agent<T>(type: AgentType, inputRef: Record<string, unknown>, fn: () => Promise<T & { output: Record<string, unknown> }>): Promise<T | null> {
    if (isCanceled()) throw new RunCanceled();
    const id = agentDocs.get(type)!;
    const t0 = Date.now();
    const aiBefore = ctx.aiCalls;
    await AgentRun.updateOne({ _id: id }, { status: 'running', startedAt: new Date(), inputRef: sanitizeValue(inputRef) });
    ctx.log(type, 'Started');
    try {
      const result = await fn();
      await AgentRun.updateOne(
        { _id: id },
        {
          status: 'completed',
          output: sanitizeValue(result.output),
          completedAt: new Date(),
          durationMs: Date.now() - t0,
          engine: ctx.aiCalls > aiBefore ? 'deterministic+llm' : 'deterministic',
        },
      );
      ctx.log(type, `Completed in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      if (err instanceof RunCanceled) throw err;
      const message = sanitizeText((err as Error).message, 500);
      await AgentRun.updateOne({ _id: id }, { status: 'failed', error: message, completedAt: new Date(), durationMs: Date.now() - t0 });
      ctx.log(type, `Failed: ${message}`, 'error');
      return null;
    }
  }
  const skip = (type: AgentType, reason: string) => {
    ctx.log(type, `Skipped: ${reason}`);
    return AgentRun.updateOne({ _id: agentDocs.get(type) }, { status: 'skipped', output: { reason }, completedAt: new Date() });
  };

  let browser: Browser | null = null;
  try {
    await TestRun.updateOne({ _id: runId }, { status: 'running', startedAt: new Date(), progress: { phase: 'planning', percent: 5 } });
    project.set('lastRun', { runId: run._id, status: 'running', at: new Date() });
    await project.save();
    ctx.log('orchestrator', `Run started for ${project.name} (${project.appUrl}) · viewports: ${cfg.viewports.join(', ')} · AI model: ${llmEnabled() ? 'enabled' : 'deterministic engines'}`);
    browser = await launchBrowser();

    // 1. Test Planner
    const planned = await agent('test_planner', { appUrl: ctx.appUrl, apiSpecUrl: ctx.apiSpecUrl || '(auto-discover)', maxPages: ctx.maxPages, viewports: ctx.viewports, hasCredentials: Boolean(credentials) }, () =>
      runTestPlanner(ctx, browser!),
    );
    if (!planned) throw new Error('Test Planner could not build a test plan (is the application URL reachable?)');
    const testPlan: TestPlan = planned.plan;
    await TestRun.updateOne({ _id: runId }, { plan: sanitizeValue(testPlan), progress: { phase: 'testing', percent: 20 } });

    // 2. Functional, API and Vision agents in parallel, each consuming the shared plan.
    const findings: Finding[] = [];
    const ran = { functional: false, api: false, vision: false };
    const planRef = { planId: String(run._id), workflows: testPlan.workflows };
    const tasks: Promise<unknown>[] = [];
    if (cfg.agents.functional) {
      ran.functional = true;
      tasks.push(
        agent('functional_qa', { ...planRef, scenarios: testPlan.scenarios.length }, () => runFunctionalAgent(ctx, browser!, testPlan)).then((r) => {
          if (r) findings.push(...r.findings);
          else ran.functional = false;
        }),
      );
    } else tasks.push(skip('functional_qa', 'Disabled for this run'));
    if (cfg.agents.api && testPlan.apiChecks.length) {
      ran.api = true;
      tasks.push(
        agent('api_qa', { ...planRef, checks: testPlan.apiChecks.length, spec: testPlan.spec.url || null }, () => runApiAgent(ctx, testPlan)).then((r) => {
          if (r) findings.push(...r.findings);
          else ran.api = false;
        }),
      );
    } else tasks.push(skip('api_qa', cfg.agents.api ? 'No API endpoints discovered (add an OpenAPI spec URL in settings)' : 'Disabled for this run'));
    if (cfg.agents.vision) {
      ran.vision = true;
      tasks.push(
        agent('vision_qa', { ...planRef, targets: testPlan.visualTargets.map((t) => t.path), viewports: ctx.viewports }, () => runVisionAgent(ctx, browser!, testPlan)).then((r) => {
          if (r) findings.push(...r.findings);
          else ran.vision = false;
        }),
      );
    } else tasks.push(skip('vision_qa', 'Disabled for this run'));
    await Promise.all(tasks);
    if (isCanceled()) throw new RunCanceled();
    setProgress('analyzing', 65);

    // 3. Bug Analyzer
    const analysis = await agent('bug_analyzer', { failures: findings.length, bySource: countBy(findings.map((f) => f.source)) }, () => runBugAnalyzer(ctx, findings, ran));
    setProgress('root-cause', 75);

    // 4. Code Analysis
    if (!analysis?.bugIds.length) await skip('code_analysis', 'No bugs to analyse');
    else if (!cfg.agents.code) await skip('code_analysis', 'Disabled for this run');
    else if (!project.repoUrl) await skip('code_analysis', 'No repository connected — add a GitHub URL in project settings');
    else if (!plan.repoAnalysis) await skip('code_analysis', `Repository analysis is not included in the ${plan.name} plan`);
    else await agent('code_analysis', { repo: project.repoUrl, bugs: analysis.bugIds.length }, () => runCodeAnalysis(ctx, analysis.bugIds));
    setProgress('regression', 85);

    // 5. Regression Test
    const regression = await agent('regression_test', { bugs: analysis?.bugIds.length || 0, verify: analysis?.notReproduced.length || 0 }, () =>
      runRegressionAgent(ctx, browser!, project, { bugIds: analysis?.bugIds || [], notReproduced: analysis?.notReproduced || [] }),
    );

    // 6. Summary for the dashboard
    const cases = await TestCase.find({ runId: run._id }, { status: 1, category: 1 }).lean();
    const countStatus = (st: string, cat?: string) => cases.filter((c) => c.status === st && (!cat || c.category === cat)).length;
    const openBugs = await Bug.find({ projectId: project._id, status: 'open' }, { severity: 1, category: 1, lastSeenRunId: 1 }).lean();
    const foundThisRun = await Bug.find({ lastSeenRunId: run._id }, { severity: 1, category: 1, status: 1 }).lean();
    const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 } as Record<string, number>;
    for (const b of openBugs) bySeverity[b.severity]++;
    const executed = cases.filter((c) => c.status !== 'skipped').length;
    const passed = countStatus('passed');
    const summary = {
      testsExecuted: executed,
      passed,
      failed: countStatus('failed'),
      errors: countStatus('error'),
      byCategory: Object.fromEntries(
        ['functional', 'api', 'visual', 'regression'].map((cat) => [cat, { executed: cases.filter((c) => c.category === cat).length, passed: countStatus('passed', cat), failed: countStatus('failed', cat) }]),
      ),
      bugs: bySeverity,
      openBugs: openBugs.length,
      bugsFound: foundThisRun.length,
      issues: {
        functional: foundThisRun.filter((b) => b.category === 'functional' && b.status === 'open').length,
        api: foundThisRun.filter((b) => b.category === 'api' && b.status === 'open').length,
        visual: foundThisRun.filter((b) => b.category === 'visual' && b.status === 'open').length,
      },
      newBugs: analysis?.created.length || 0,
      reopenedBugs: analysis?.reopened.length || 0,
      fixedBugs: regression?.fixedBugIds.length || 0,
      qaScore: qaScore(passed, executed, bySeverity),
      durationMs: Date.now() - started,
      aiCalls: ctx.aiCalls,
      engine: llmEnabled() ? 'multi-agent + LLM' : 'multi-agent (deterministic)',
    };
    ctx.log('orchestrator', `Run completed: ${summary.passed}/${summary.testsExecuted} checks passed · ${summary.bugsFound} bug(s) · QA score ${summary.qaScore}`);
    await flush();
    await TestRun.updateOne({ _id: runId }, { status: 'completed', completedAt: new Date(), summary, progress: { phase: 'completed', percent: 100 } });
    project.set('lastRun', { runId: run._id, status: 'completed', qaScore: summary.qaScore, at: new Date() });
    await project.save();
    await incrementUsage(project.workspaceId, { aiCalls: ctx.aiCalls, browserSeconds: (Date.now() - started) / 1000, checks: executed });

    const critical = await Bug.find({ lastSeenRunId: run._id, severity: 'critical', status: 'open' }).lean();
    if (critical.length && s.notifyOnCritical !== false) {
      await notifyWorkspace({
        workspaceId: project.workspaceId,
        type: 'critical_bugs',
        title: `${critical.length} critical bug(s) in ${project.name}`,
        body: critical.map((b) => `• ${b.title}`).join('\n'),
        link: `/runs/${run._id}`,
        email: plan.emailNotifications,
      });
    }
    if (summary.fixedBugs) {
      await notifyWorkspace({
        workspaceId: project.workspaceId,
        type: 'bugs_fixed',
        title: `${summary.fixedBugs} bug(s) verified fixed in ${project.name}`,
        body: 'Regression tests passed for previously open bugs.',
        link: `/runs/${run._id}`,
        email: false,
      });
    }
  } catch (err) {
    const canceled = err instanceof RunCanceled || isCanceled();
    const message = canceled ? 'Run canceled by user' : sanitizeText((err as Error).message, 500);
    ctx.log('orchestrator', message, canceled ? 'warn' : 'error');
    await flush();
    await AgentRun.updateMany({ runId: run._id, status: { $in: ['pending', 'running'] } }, { status: 'skipped', output: { reason: canceled ? 'Run canceled' : 'Run aborted' } });
    const passed = await TestCase.countDocuments({ runId: run._id, status: 'passed' });
    const total = await TestCase.countDocuments({ runId: run._id });
    await TestRun.updateOne(
      { _id: runId },
      {
        status: canceled ? 'canceled' : 'failed',
        error: message,
        completedAt: new Date(),
        summary: { testsExecuted: total, passed, failed: total - passed, durationMs: Date.now() - started },
        progress: { phase: canceled ? 'canceled' : 'failed', percent: 100 },
      },
    );
    project.set('lastRun', { runId: run._id, status: canceled ? 'canceled' : 'failed', at: new Date() });
    await project.save();
    if (!canceled) {
      await notifyWorkspace({ workspaceId: project.workspaceId, type: 'run_failed', title: `QA run failed for ${project.name}`, body: message, link: `/runs/${run._id}`, email: false });
    }
  } finally {
    clearInterval(timer);
    await flush();
    await browser?.close().catch(() => undefined);
  }
}

function countBy(xs: string[]) {
  return xs.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x]: (acc[x] || 0) + 1 }), {});
}
