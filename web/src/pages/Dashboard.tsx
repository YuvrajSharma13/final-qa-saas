import { useState } from 'react';
import { Link } from 'react-router-dom';
import { RunBars, ScoreLine, SeverityBars, type TrendPoint } from '../components/charts';
import { Icon } from '../components/icons';
import { Card, Empty, ErrorBox, LinkButton, PageHeader, PageLoader, ScoreRing, Select, Stat, StatusBadge } from '../components/ui';
import { useApi, type RunSummary, type Severity } from '../lib/api';
import { useAuth } from '../lib/auth';
import { duration, timeAgo } from '../lib/format';

interface DashboardData {
  periodDays: number;
  metrics: {
    testsExecuted: number;
    passed: number;
    failed: number;
    passRate: number | null;
    runs: number;
    severity: Record<Severity, number>;
    issues: { visual: number; api: number; functional: number };
    openBugs: number;
  };
  lastRun: null | { _id: string; status: string; projectName?: string; createdAt: string; completedAt?: string; summary?: RunSummary; projectId: string };
  trend: { direction: 'improving' | 'worsening' | 'stable' | 'insufficient-data'; points: TrendPoint[] };
  projects: { id: string; name: string; appUrl: string; openBugs: number; critical: number; lastRun?: { runId?: string; status?: string; qaScore?: number; at?: string } }[];
  plan: { id: string; name: string; runsPerMonth: number; maxProjects: number };
  usage: { runs: number; projects: number; periodEnd: string };
}

const TREND: Record<string, { label: string; tone: 'good' | 'bad' | undefined; hint: string }> = {
  improving: { label: 'Improving', tone: 'good', hint: 'Failures are decreasing across recent runs' },
  worsening: { label: 'Worsening', tone: 'bad', hint: 'Failures are increasing across recent runs' },
  stable: { label: 'Stable', tone: undefined, hint: 'Failure count is flat across recent runs' },
  'insufficient-data': { label: '—', tone: undefined, hint: 'Needs at least two completed runs' },
};

export default function Dashboard() {
  const [days, setDays] = useState(30);
  const [projectId, setProjectId] = useState('');
  const { workspace } = useAuth();
  const { data, error, loading } = useApi<DashboardData>(`/dashboard?days=${days}${projectId ? `&projectId=${projectId}` : ''}&ws=${workspace?.id}`, {
    pollMs: (d) => (d?.lastRun && ['queued', 'running'].includes(d.lastRun.status) ? 4000 : 20000),
  });

  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const m = data.metrics;
  const t = TREND[data.trend.direction];
  const lr = data.lastRun;

  return (
    <div>
      <PageHeader
        title="QA dashboard"
        subtitle={`${workspace?.name} · last ${data.periodDays} days`}
        actions={
          <>
            <Select aria-label="Project filter" value={projectId} onChange={(e) => setProjectId(e.target.value)} className="w-44">
              <option value="">All projects</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <Select aria-label="Time range" value={days} onChange={(e) => setDays(Number(e.target.value))} className="w-32">
              <option value={1}>24 hours</option>
              <option value={7}>7 days</option>
              <option value={30}>30 days</option>
              <option value={90}>90 days</option>
            </Select>
          </>
        }
      />

      {data.projects.length === 0 ? (
        <Empty
          title="Create your first QA project"
          icon="folder"
          action={
            <LinkButton to="/projects/new" variant="primary" icon="plus">
              New project
            </LinkButton>
          }
        >
          Add your application URL (and optionally a GitHub repo and OpenAPI spec). The agents will plan and run functional, API and visual tests.
        </Empty>
      ) : (
        <div className="space-y-6">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
            <Stat label="Tests executed" value={m.testsExecuted} hint={`${m.runs} run${m.runs === 1 ? '' : 's'}`} icon="layers" />
            <Stat label="Passed" value={m.passed} tone="good" hint={m.passRate !== null ? `${m.passRate}% pass rate` : undefined} icon="check" />
            <Stat label="Failed" value={m.failed} tone={m.failed ? 'bad' : undefined} icon="x" />
            <Stat label="Open bugs" value={m.openBugs} tone={m.openBugs ? 'warn' : 'good'} hint={`${m.severity.critical} critical · ${m.severity.high} high`} icon="bug" />
            <Stat label="Trend" value={t.label} tone={t.tone} hint={t.hint} icon="trend" />
            <Stat label="Runs this period" value={`${data.usage.runs}/${data.plan.runsPerMonth}`} hint={`${data.plan.name} plan`} icon="card" />
          </div>

          <div className="grid gap-6 lg:grid-cols-3">
            <Card title="Last run" className="lg:col-span-1">
              {lr ? (
                <div className="flex items-center gap-4">
                  <ScoreRing score={lr.summary?.qaScore ?? null} size={76} />
                  <div className="min-w-0 space-y-1 text-sm">
                    <div className="flex items-center gap-2">
                      <StatusBadge status={lr.status} />
                      <span className="truncate text-ink-300">{lr.projectName}</span>
                    </div>
                    <div className="text-ink-400">
                      {timeAgo(lr.createdAt)} · {duration(lr.summary?.durationMs)}
                    </div>
                    <div className="text-ink-300">
                      {lr.summary?.passed ?? 0}/{lr.summary?.testsExecuted ?? 0} checks passed · {lr.summary?.bugsFound ?? 0} bugs
                    </div>
                    <Link to={`/runs/${lr._id}`} className="inline-flex items-center gap-1 text-accent-300 hover:underline">
                      Open run <Icon name="external" size={12} />
                    </Link>
                  </div>
                </div>
              ) : (
                <p className="text-sm text-ink-400">No runs yet.</p>
              )}
            </Card>
            <Card title="Open bugs by severity" subtitle="Consolidated by the Bug Analyzer">
              <SeverityBars counts={m.severity} />
            </Card>
            <Card title="Open issues by source">
              <div className="grid grid-cols-3 gap-2 text-center">
                {(
                  [
                    ['Functional', m.issues.functional, 'cursor'],
                    ['API', m.issues.api, 'plug'],
                    ['Visual', m.issues.visual, 'eye'],
                  ] as const
                ).map(([label, v, icon]) => (
                  <Link key={label} to={`/bugs?category=${label.toLowerCase()}&status=open`} className="rounded-lg border border-ink-700 bg-ink-850 p-3 hover:border-ink-600">
                    <Icon name={icon} className="mx-auto text-ink-300" />
                    <div className="mt-1 text-2xl font-semibold tabular-nums">{v}</div>
                    <div className="text-xs text-ink-400">{label} issues</div>
                  </Link>
                ))}
              </div>
            </Card>
          </div>

          <div className="grid gap-6 lg:grid-cols-2">
            <Card title="Checks per run" subtitle="Passed vs failed">
              {data.trend.points.length ? <RunBars points={data.trend.points} /> : <p className="text-sm text-ink-400">No completed runs in this period.</p>}
            </Card>
            <Card title="QA score per run" subtitle="Pass rate minus open-bug severity penalty (0–100)">
              {data.trend.points.length ? <ScoreLine points={data.trend.points} /> : <p className="text-sm text-ink-400">No completed runs in this period.</p>}
            </Card>
          </div>

          <Card title="Projects" padded={false} actions={<LinkButton to="/projects/new" icon="plus">New project</LinkButton>}>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead className="text-left text-xs text-ink-400">
                  <tr>
                    <th className="px-4 py-2 font-medium">Project</th>
                    <th className="px-4 py-2 font-medium">QA score</th>
                    <th className="px-4 py-2 font-medium">Last run</th>
                    <th className="px-4 py-2 font-medium">Open bugs</th>
                    <th className="px-4 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.projects.map((p) => (
                    <tr key={p.id} className="border-t border-ink-700">
                      <td className="px-4 py-3">
                        <Link to={`/projects/${p.id}`} className="font-medium hover:text-accent-300">
                          {p.name}
                        </Link>
                        <div className="font-mono text-xs text-ink-400">{p.appUrl}</div>
                      </td>
                      <td className="px-4 py-3 tabular-nums">{p.lastRun?.qaScore ?? '—'}</td>
                      <td className="px-4 py-3">
                        {p.lastRun?.status ? (
                          <span className="flex items-center gap-2">
                            <StatusBadge status={p.lastRun.status} />
                            <span className="text-xs text-ink-400">{timeAgo(p.lastRun.at)}</span>
                          </span>
                        ) : (
                          <span className="text-ink-400">never</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        {p.openBugs}
                        {p.critical > 0 && <span className="ml-2 text-xs text-red-300">{p.critical} critical</span>}
                      </td>
                      <td className="px-4 py-3 text-right">
                        <LinkButton to={`/projects/${p.id}/run`} variant="secondary" icon="play" className="py-1.5">
                          Run QA
                        </LinkButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
