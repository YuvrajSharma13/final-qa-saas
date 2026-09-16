import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RunBars, ScoreLine } from '../components/charts';
import { Icon } from '../components/icons';
import { Button, Card, CategoryBadge, Empty, ErrorBox, LinkButton, PageHeader, PageLoader, ScoreRing, SeverityBadge, Stat, StatusBadge, Tabs } from '../components/ui';
import { FixList } from '../components/github';
import { api, useApi, type AutoFix, type Bug, type Project, type RegressionTest, type Screenshot, type TestRun } from '../lib/api';
import { useAuth } from '../lib/auth';
import { duration, timeAgo } from '../lib/format';

interface ProjectData {
  project: Project;
  role: string;
  runs: TestRun[];
  bugs: Bug[];
  regressionTests: RegressionTest[];
  baselines: Screenshot[];
}

export default function ProjectOverview() {
  const { id } = useParams();
  const { can } = useAuth();
  const nav = useNavigate();
  const [tab, setTab] = useState<'open' | 'fixed' | 'all'>('open');
  const [err, setErr] = useState<Error | null>(null);
  const { data: fixes } = useApi<{ fixes: AutoFix[] }>(`/autofixes?projectId=${id}&refresh=1`, { pollMs: 20000 });
  const { data, error, loading } = useApi<ProjectData>(`/projects/${id}`, {
    pollMs: (d) => (d?.runs.some((r) => ['queued', 'running'].includes(r.status)) ? 3000 : 30000),
  });
  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { project, runs, bugs, regressionTests } = data;
  const active = runs.find((r) => ['queued', 'running'].includes(r.status));
  const completed = runs.filter((r) => r.status === 'completed').reverse();
  const points = completed.slice(-15).map((r) => ({ runId: r._id, at: r.completedAt || r.createdAt, passed: r.summary?.passed || 0, failed: r.summary?.failed || 0, qaScore: r.summary?.qaScore ?? null }));
  const open = bugs.filter((b) => b.status === 'open');
  const shown = tab === 'all' ? bugs : bugs.filter((b) => b.status === tab);
  const passing = regressionTests.filter((t) => t.status === 'passing').length;

  const rerun = async () => {
    setErr(null);
    try {
      const { run } = await api<{ run: { id: string } }>(`/projects/${project.id}/runs`, { method: 'POST', body: { trigger: 'rerun' } });
      nav(`/runs/${run.id}`);
    } catch (e) {
      setErr(e as Error);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ to: '/projects', label: 'Projects' }, { label: project.name }]}
        title={project.name}
        subtitle={
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs">
            <a href={project.appUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:text-ink-100">
              {project.appUrl} <Icon name="external" size={11} />
            </a>
            {project.repoUrl && (
              <span className="inline-flex items-center gap-1">
                <Icon name="github" size={12} /> {project.repoUrl}
              </span>
            )}
            {project.settings.apiSpecUrl && <span>spec: {project.settings.apiSpecUrl}</span>}
            {project.settings.github?.baseBranch && (
              <span className="inline-flex items-center gap-1">
                <Icon name="branch" size={12} /> {project.settings.github.baseBranch}
              </span>
            )}
          </div>
        }
        actions={
          <>
            <LinkButton to={`/settings?project=${project.id}`} icon="settings">
              Settings
            </LinkButton>
            {can('developer') &&
              (active ? (
                <LinkButton to={`/runs/${active._id}`} variant="primary" icon="play">
                  View live run
                </LinkButton>
              ) : (
                <>
                  <LinkButton to={`/projects/${project.id}/run`}>Configure run</LinkButton>
                  <Button variant="primary" icon="play" onClick={rerun}>
                    {runs.length ? 'Rerun AI QA' : 'Start AI QA'}
                  </Button>
                </>
              ))}
          </>
        }
      />
      <ErrorBox error={err} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <div className="col-span-2 flex items-center gap-4 rounded-xl border border-ink-700 bg-ink-900 p-4 lg:col-span-1">
          <ScoreRing score={project.lastRun?.qaScore ?? null} size={64} />
          <div className="text-sm">
            <div className="text-ink-400">QA score</div>
            <div>{project.lastRun?.at ? timeAgo(project.lastRun.at) : 'no runs yet'}</div>
          </div>
        </div>
        <Stat label="Open bugs" value={open.length} tone={open.length ? 'warn' : 'good'} hint={`${open.filter((b) => b.severity === 'critical').length} critical`} icon="bug" />
        <Stat label="Fixed bugs" value={bugs.filter((b) => b.status === 'fixed').length} tone="good" icon="check" />
        <Stat label="Regression tests" value={`${passing}/${regressionTests.length}`} hint="passing" icon="repeat" />
        <Stat label="QA runs" value={runs.length} hint={completed.at(-1) ? `last took ${duration(completed.at(-1)!.summary?.durationMs)}` : undefined} icon="layers" />
      </div>

      {points.length > 0 && (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card title="Checks per run">
            <RunBars points={points} height={140} />
          </Card>
          <Card title="QA score trend">
            <ScoreLine points={points} />
          </Card>
        </div>
      )}

      <div className="grid gap-6 xl:grid-cols-[1.3fr_1fr]">
        <Card title="Bugs" padded={false} actions={<LinkButton to={`/bugs?projectId=${project.id}`} variant="ghost">All bugs →</LinkButton>}>
          <div className="px-4">
            <Tabs
              value={tab}
              onChange={setTab}
              tabs={[
                { id: 'open', label: `Open (${open.length})` },
                { id: 'fixed', label: `Fixed (${bugs.filter((b) => b.status === 'fixed').length})` },
                { id: 'all', label: `All (${bugs.length})` },
              ]}
            />
          </div>
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">{runs.length ? 'Nothing here.' : 'Run AI QA to find bugs.'}</p>
          ) : (
            <ul>
              {shown.map((b) => (
                <li key={b._id} className="border-t border-ink-700 first:border-t-0">
                  <Link to={`/bugs/${b._id}`} className="flex items-start gap-3 px-4 py-3 hover:bg-ink-850">
                    <SeverityBadge severity={b.severity} />
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium">{b.title}</div>
                      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-ink-400">
                        <CategoryBadge category={b.category} />
                        <span>seen {b.occurrences}×</span>
                        <span>updated {timeAgo(b.updatedAt)}</span>
                      </div>
                    </div>
                    <StatusBadge status={b.status} />
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <div className="space-y-6">
        <Card
          title={<span className="inline-flex items-center gap-2"><Icon name="wand" className="text-accent-300" /> AI fixes & pull requests</span>}
          subtitle={project.settings.github ? `${project.settings.github.owner}/${project.settings.github.repo} → ${project.settings.github.baseBranch}` : 'No GitHub repository linked'}
          actions={!project.settings.github && <LinkButton to={`/settings?tab=github&project=${project.id}`} variant="ghost">Link repository →</LinkButton>}
          padded={false}
        >
          <FixList fixes={fixes?.fixes || []} empty={project.settings.github ? 'No AI fixes yet. Open a bug and choose “Generate AI fix”.' : 'Link a GitHub repository to enable AI fixes.'} />
        </Card>
        <Card title="Regression tests" subtitle="Generated by the Regression agent and re-executed on every run" padded={false}>
          {regressionTests.length === 0 ? (
            <p className="p-4 text-sm text-ink-400">Tests appear here once bugs are found.</p>
          ) : (
            <ul>
              {regressionTests.map((t) => (
                <li key={t._id} className="flex items-center gap-3 border-t border-ink-700 px-4 py-3 first:border-t-0">
                  <StatusBadge status={t.status} />
                  <Link to={`/bugs/${t.bugId}`} className="min-w-0 flex-1 truncate text-sm hover:text-accent-300">
                    {t.name.replace(/^Regression: /, '')}
                  </Link>
                  <span className="shrink-0 text-xs text-ink-400">{timeAgo(t.lastRunAt)}</span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        </div>
      </div>

      <Card title="Run history" padded={false}>
        {runs.length === 0 ? (
          <div className="p-4">
            <Empty title="No runs yet" icon="play">
              Start an AI QA run to plan and execute tests.
            </Empty>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-ink-400">
                <tr>
                  <th className="px-4 py-2 font-medium">Started</th>
                  <th className="px-4 py-2 font-medium">Status</th>
                  <th className="px-4 py-2 font-medium">Checks</th>
                  <th className="px-4 py-2 font-medium">Bugs</th>
                  <th className="px-4 py-2 font-medium">Score</th>
                  <th className="px-4 py-2 font-medium">Duration</th>
                  <th className="px-4 py-2 font-medium">Trigger</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r._id} className="border-t border-ink-700 hover:bg-ink-850">
                    <td className="px-4 py-2.5">
                      <Link to={`/runs/${r._id}`} className="hover:text-accent-300">
                        {new Date(r.createdAt).toLocaleString()}
                      </Link>
                    </td>
                    <td className="px-4 py-2.5">
                      <StatusBadge status={r.status} label={r.status === 'running' ? `${r.progress?.phase} ${r.progress?.percent}%` : undefined} />
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">
                      {r.summary?.testsExecuted != null ? (
                        <>
                          <span className="text-emerald-300">{r.summary.passed}</span> / {r.summary.testsExecuted}
                        </>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-xs">
                      {r.summary?.bugsFound != null ? (
                        <span>
                          {r.summary.bugsFound} found
                          {!!r.summary.newBugs && <span className="text-violet-300"> · {r.summary.newBugs} new</span>}
                          {!!r.summary.fixedBugs && <span className="text-emerald-300"> · {r.summary.fixedBugs} fixed</span>}
                          {!!r.summary.reopenedBugs && <span className="text-fuchsia-300"> · {r.summary.reopenedBugs} reopened</span>}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-2.5 tabular-nums">{r.summary?.qaScore ?? '—'}</td>
                    <td className="px-4 py-2.5 tabular-nums">{duration(r.summary?.durationMs)}</td>
                    <td className="px-4 py-2.5 text-ink-400">{r.trigger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
