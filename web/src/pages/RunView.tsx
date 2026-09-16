import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AgentPipeline } from '../components/AgentPipeline';
import { AGENT_ICON, Icon } from '../components/icons';
import { ScreenshotCard, ScreenshotModal } from '../components/ScreenshotViewer';
import { Badge, Button, Card, CategoryBadge, CodeBlock, cx, Empty, ErrorBox, PageHeader, PageLoader, ScoreRing, Select, SeverityBadge, Stat, StatusBadge, Tabs } from '../components/ui';
import { api, shotUrl, useApi, type AgentRun, type Bug, type Project, type RegressionTest, type Screenshot, type TestCase, type TestRun } from '../lib/api';
import { useAuth } from '../lib/auth';
import { AGENT_META, duration, timeAgo } from '../lib/format';

interface RunData {
  run: TestRun;
  agentRuns: AgentRun[];
  testCases: TestCase[];
  bugs: Bug[];
  screenshots: Screenshot[];
  regressionTests: RegressionTest[];
}

type Tab = 'bugs' | 'tests' | 'screens' | 'plan' | 'log';

export default function RunView() {
  const { id } = useParams();
  const nav = useNavigate();
  const { can } = useAuth();
  const { data, error, loading } = useApi<RunData>(`/runs/${id}`, {
    pollMs: (d) => (d && ['queued', 'running'].includes(d.run.status) ? 1500 : false),
  });
  const { data: projectData } = useApi<{ project: Project }>(data ? `/projects/${data.run.projectId}` : null);
  const [tab, setTab] = useState<Tab>('bugs');
  const [agent, setAgent] = useState<string>('');
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const autoTab = useRef(false);

  const live = data && ['queued', 'running'].includes(data.run.status);
  useEffect(() => {
    if (!data || autoTab.current) return;
    autoTab.current = true;
    if (['queued', 'running'].includes(data.run.status)) setTab('log');
  }, [data]);
  useEffect(() => {
    if (data && !live && tab === 'log' && autoTab.current && data.bugs.length) setTab('bugs');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [live]);

  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { run, agentRuns, testCases, bugs, screenshots } = data;
  const s = run.summary || {};
  const project = projectData?.project;

  const act = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ to: '/projects', label: 'Projects' }, { to: `/projects/${run.projectId}`, label: project?.name || 'Project' }, { label: 'Run' }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            QA run <StatusBadge status={run.status} />
          </span>
        }
        subtitle={
          <span>
            Started {timeAgo(run.startedAt || run.createdAt)} · {run.config?.viewports?.join(', ')} · {run.trigger}
            {project && <span className="ml-2 font-mono">{project.appUrl}</span>}
          </span>
        }
        actions={
          can('developer') &&
          (live ? (
            <Button variant="danger" icon="stop" loading={busy} onClick={() => act(async () => void (await api(`/runs/${run._id}/cancel`, { method: 'POST' })))}>
              Cancel run
            </Button>
          ) : (
            <Button
              variant="primary"
              icon="refresh"
              loading={busy}
              onClick={() =>
                act(async () => {
                  const r = await api<{ run: { id: string } }>(`/projects/${run.projectId}/runs`, { method: 'POST', body: { trigger: 'rerun' } });
                  autoTab.current = false;
                  nav(`/runs/${r.run.id}`);
                })
              }
            >
              Rerun QA
            </Button>
          ))
        }
      />
      <ErrorBox error={err} />
      {run.error && run.status !== 'completed' && <ErrorBox error={{ message: run.error }} />}
      {run.config?.warnings?.map((w) => (
        <div key={w} className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          {w}
        </div>
      ))}

      {live && (
        <div className="rounded-xl border border-accent-400/30 bg-ink-900 p-4">
          <div className="mb-2 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 font-medium capitalize">
              <span className="h-2 w-2 animate-pulse rounded-full bg-accent-400" /> {run.progress?.phase || 'queued'}
            </span>
            <span className="tabular-nums text-ink-400">{run.progress?.percent ?? 0}%</span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-ink-800">
            <div className="h-full rounded-full bg-accent-400 transition-all duration-700" style={{ width: `${run.progress?.percent ?? 2}%` }} />
          </div>
        </div>
      )}

      {run.status === 'completed' && (
        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div className="col-span-2 flex items-center gap-4 rounded-xl border border-ink-700 bg-ink-900 p-4 md:col-span-1">
            <ScoreRing score={s.qaScore} />
            <div className="text-sm">
              <div className="text-ink-400">QA score</div>
              <div className="text-xs text-ink-400">{duration(s.durationMs)}</div>
            </div>
          </div>
          <Stat label="Tests executed" value={s.testsExecuted} icon="layers" />
          <Stat label="Passed" value={s.passed} tone="good" icon="check" />
          <Stat label="Failed" value={s.failed} tone={s.failed ? 'bad' : undefined} icon="x" />
          <Stat label="Bugs (consolidated)" value={s.bugsFound} tone={s.bugsFound ? 'warn' : 'good'} hint={`${s.newBugs || 0} new · ${s.reopenedBugs || 0} reopened`} icon="bug" />
          <Stat label="Verified fixed" value={s.fixedBugs} tone={s.fixedBugs ? 'good' : undefined} hint="by regression tests" icon="repeat" />
        </div>
      )}

      <Card title="Multi-agent pipeline" subtitle="Click an agent to inspect its structured input and output">
        <AgentPipeline agents={agentRuns} selected={agent} onSelect={(t) => setAgent(agent === t ? '' : t)} />
        {agent && <AgentDetail a={agentRuns.find((x) => x.agentType === agent)!} events={(run.events || []).filter((e) => e.agent === agent)} />}
      </Card>

      <div>
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'bugs', label: `Bugs (${bugs.length})` },
            { id: 'tests', label: `Test cases (${testCases.length})` },
            { id: 'screens', label: `Screenshots (${screenshots.length})` },
            { id: 'plan', label: 'Test plan' },
            { id: 'log', label: `Live log${live ? ' •' : ''}` },
          ]}
        />
        <div className="pt-4">
          {tab === 'bugs' && <BugsTab bugs={bugs} live={Boolean(live)} tests={data.regressionTests} />}
          {tab === 'tests' && <TestsTab cases={testCases} screenshots={screenshots} onShot={setShot} />}
          {tab === 'screens' && <ScreensTab shots={screenshots} onShot={setShot} canEdit={can('developer')} />}
          {tab === 'plan' && <PlanTab run={run} />}
          {tab === 'log' && <LogTab run={run} live={Boolean(live)} />}
        </div>
      </div>
      <ScreenshotModal shot={shot} onClose={() => setShot(null)} />
    </div>
  );
}

function AgentDetail({ a, events }: { a: AgentRun; events: NonNullable<TestRun['events']> }) {
  const meta = AGENT_META[a.agentType];
  return (
    <div className="mt-4 rounded-xl border border-ink-700 bg-ink-850 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <Icon name={AGENT_ICON[a.agentType]} className="text-accent-300" />
        <h3 className="font-semibold">{meta.name}</h3>
        <StatusBadge status={a.status} />
        <Badge>{a.engine || 'deterministic'}</Badge>
        {a.durationMs ? <span className="text-xs text-ink-400">{duration(a.durationMs)}</span> : null}
      </div>
      <p className="mt-1 text-sm text-ink-400">{meta.role}</p>
      {a.error && <div className="mt-2"><ErrorBox error={{ message: a.error }} /></div>}
      <div className="mt-3 grid gap-3 lg:grid-cols-[1fr_2fr]">
        <CodeBlock title="input" code={JSON.stringify(a.inputRef || {}, null, 2)} maxHeight={260} />
        <CodeBlock title="output (structured)" code={JSON.stringify(a.output || {}, null, 2)} maxHeight={260} />
      </div>
      {events.length > 0 && (
        <div className="scroll-thin mt-3 max-h-48 overflow-y-auto rounded-lg border border-ink-700 bg-ink-950 p-2 font-mono text-xs">
          {events.map((e, i) => (
            <div key={i} className={cx(e.level === 'warn' && 'text-amber-200', e.level === 'error' && 'text-red-300')}>
              <span className="text-ink-400">{new Date(e.ts).toLocaleTimeString()}</span> {e.message}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function BugsTab({ bugs, live, tests }: { bugs: Bug[]; live: boolean; tests: RegressionTest[] }) {
  if (!bugs.length) {
    return live ? (
      <Empty title="Agents are still testing" icon="layers">
        Bugs appear after the Bug Analyzer consolidates the failures.
      </Empty>
    ) : (
      <Empty title="No bugs in this run" icon="check">
        Every check passed or no open issue was reproduced.
      </Empty>
    );
  }
  const rank = { critical: 0, high: 1, medium: 2, low: 3 };
  const sorted = [...bugs].sort((a, b) => rank[a.severity] - rank[b.severity]);
  return (
    <div className="grid gap-3">
      {sorted.map((b) => {
        const rt = tests.find((t) => t.bugId === b._id);
        return (
          <Link key={b._id} to={`/bugs/${b._id}`} className="block rounded-xl border border-ink-700 bg-ink-900 p-4 transition hover:border-ink-600">
            <div className="flex flex-wrap items-center gap-2">
              <SeverityBadge severity={b.severity} />
              <CategoryBadge category={b.category} />
              <StatusBadge status={b.runRelation || 'seen'} label={b.runRelation === 'fixed' ? 'verified fixed' : b.runRelation} />
              {b.status !== 'open' && b.runRelation !== 'fixed' && <StatusBadge status={b.status} />}
              <span className="text-xs text-ink-400">from {b.sources?.join(' + ')} agent{(b.sources?.length || 0) > 1 ? 's' : ''}</span>
            </div>
            <h3 className="mt-2 font-medium">{b.title}</h3>
            {b.rootCause?.likelyCause && (
              <p className="mt-1.5 text-sm text-ink-300">
                <span className="text-ink-400">Likely cause: </span>
                {b.rootCause.likelyCause}
              </p>
            )}
            <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
              {b.rootCause?.fileReferences?.slice(0, 3).map((f) => (
                <span key={`${f.path}:${f.line}`} className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-cyan-300">
                  {f.path}:{f.line}
                </span>
              ))}
              {rt && (
                <span className="flex items-center gap-1 text-ink-400">
                  <Icon name="repeat" size={12} /> regression test <StatusBadge status={rt.status} />
                </span>
              )}
            </div>
          </Link>
        );
      })}
    </div>
  );
}

function TestsTab({ cases, screenshots, onShot }: { cases: TestCase[]; screenshots: Screenshot[]; onShot: (s: Screenshot) => void }) {
  const [cat, setCat] = useState('');
  const [status, setStatus] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const filtered = cases.filter((c) => (!cat || c.category === cat) && (!status || c.status === status));
  const counts = useMemo(() => {
    const out: Record<string, { p: number; f: number }> = {};
    for (const c of cases) {
      out[c.category] ??= { p: 0, f: 0 };
      if (c.status === 'passed') out[c.category].p++;
      else if (c.status !== 'skipped') out[c.category].f++;
    }
    return out;
  }, [cases]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select aria-label="Category" value={cat} onChange={(e) => setCat(e.target.value)} className="w-40">
          <option value="">All categories</option>
          {['functional', 'api', 'visual', 'regression'].map((c) => (
            <option key={c} value={c}>
              {c} ({(counts[c]?.p || 0) + (counts[c]?.f || 0)})
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={status} onChange={(e) => setStatus(e.target.value)} className="w-36">
          <option value="">All statuses</option>
          <option value="passed">passed</option>
          <option value="failed">failed</option>
          <option value="error">error</option>
        </Select>
        <span className="text-xs text-ink-400">{filtered.length} shown</span>
      </div>
      <div className="overflow-hidden rounded-xl border border-ink-700">
        {filtered.map((c) => {
          const ev = (c.evidence || {}) as {
            screenshotIds?: string[];
            steps?: string[];
            failures?: { step: number; description: string; expected: string; actual: string }[];
            network?: { method: string; path: string; status: number }[];
            request?: unknown;
            response?: unknown;
            pageErrors?: string[];
          };
          const isOpen = open === c._id;
          return (
            <div key={c._id} className="border-t border-ink-700 first:border-t-0">
              <button onClick={() => setOpen(isOpen ? null : c._id)} className="flex w-full items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-850" aria-expanded={isOpen}>
                <StatusBadge status={c.status} />
                <span className="w-24 shrink-0">
                  <CategoryBadge category={c.category} />
                </span>
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                {c.target && <span className="hidden max-w-56 truncate font-mono text-xs text-ink-400 md:block">{c.target}</span>}
                <span className="hidden w-16 text-right text-xs tabular-nums text-ink-400 sm:block">{duration(c.durationMs)}</span>
              </button>
              {isOpen && (
                <div className="space-y-3 bg-ink-900 px-4 pb-4 pt-1 text-sm">
                  <div className="grid gap-3 md:grid-cols-2">
                    <div>
                      <div className="text-xs text-ink-400">Expected</div>
                      <div>{c.expected}</div>
                    </div>
                    <div>
                      <div className="text-xs text-ink-400">Actual</div>
                      <div className={c.status === 'passed' ? '' : 'text-red-200'}>{c.actual}</div>
                    </div>
                  </div>
                  {ev.steps && (
                    <div>
                      <div className="mb-1 text-xs text-ink-400">Steps</div>
                      <ol className="list-decimal space-y-0.5 pl-5 text-ink-300">
                        {ev.steps.map((s, i) => (
                          <li key={i} className={ev.failures?.some((f) => f.step === i + 1) ? 'text-red-300' : ''}>
                            {s}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                  {ev.request !== undefined && (
                    <div className="grid gap-3 md:grid-cols-2">
                      <CodeBlock title="request" code={JSON.stringify(ev.request, null, 2)} maxHeight={200} />
                      <CodeBlock title="response" code={JSON.stringify(ev.response, null, 2)} maxHeight={200} />
                    </div>
                  )}
                  {!!ev.network?.length && <CodeBlock title="network (xhr / failing requests)" code={ev.network.map((n) => `${n.status}  ${n.method.padEnd(6)} ${n.path}`).join('\n')} maxHeight={160} />}
                  {!!ev.pageErrors?.length && <CodeBlock title="page errors" code={ev.pageErrors.join('\n')} maxHeight={120} />}
                  {!!ev.screenshotIds?.length && (
                    <div className="flex flex-wrap gap-2">
                      {ev.screenshotIds.map((sid) => {
                        const s = screenshots.find((x) => x._id === sid);
                        return (
                          s && (
                            <button key={sid} onClick={() => onShot(s)} className="overflow-hidden rounded-lg border border-ink-600">
                              <img src={shotUrl(sid, Boolean(s.annotatedRef))} alt="evidence" className="h-28 w-48 object-cover object-top" />
                            </button>
                          )
                        );
                      })}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
        {!filtered.length && <p className="p-4 text-sm text-ink-400">No test cases yet.</p>}
      </div>
    </div>
  );
}

function ScreensTab({ shots, onShot, canEdit }: { shots: Screenshot[]; onShot: (s: Screenshot) => void; canEdit: boolean }) {
  const [vp, setVp] = useState('');
  const [local, setLocal] = useState<Record<string, boolean>>({});
  const list = shots.filter((s) => !vp || s.viewport?.name === vp);
  if (!shots.length) return <Empty title="No screenshots yet" icon="image" />;
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Select aria-label="Viewport" value={vp} onChange={(e) => setVp(e.target.value)} className="w-40">
          <option value="">All viewports</option>
          <option value="desktop">Desktop</option>
          <option value="tablet">Tablet</option>
          <option value="mobile">Mobile</option>
        </Select>
        <span className="text-xs text-ink-400">Mark a clean capture as the baseline to enable visual regression comparison on future runs.</span>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((s) => (
          <ScreenshotCard
            key={s._id}
            shot={{ ...s, isBaseline: local[s._id] ?? s.isBaseline }}
            onOpen={() => onShot(s)}
            actions={
              canEdit &&
              s.kind === 'capture' &&
              !(local[s._id] ?? s.isBaseline) && (
                <button
                  className="text-accent-300 hover:underline"
                  onClick={async () => {
                    await api(`/screenshots/${s._id}/baseline`, { method: 'POST' });
                    setLocal({ ...local, [s._id]: true });
                  }}
                >
                  Set baseline
                </button>
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

function PlanTab({ run }: { run: TestRun }) {
  const p = run.plan;
  if (!p) return <Empty title="The Test Planner has not produced a plan yet" icon="compass" />;
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Discovered pages" subtitle={`Workflows: ${p.workflows.join(', ')}`}>
        <ul className="space-y-1.5 text-sm">
          {p.pages.map((pg) => (
            <li key={pg.path} className="flex items-center justify-between gap-2">
              <span className="font-mono">{pg.path}</span>
              <span className="flex items-center gap-2">
                <Badge>{pg.role}</Badge>
                <span className="text-xs text-ink-400">HTTP {pg.status}</span>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="API surface" subtitle={p.spec.loaded ? `OpenAPI: ${p.spec.url} (${p.spec.operations} operations)` : p.spec.error ? `Spec error: ${p.spec.error}` : 'No spec — discovered from traffic & scripts'}>
        <ul className="space-y-1 font-mono text-xs">
          {p.endpoints.map((e) => (
            <li key={`${e.method} ${e.path}`} className="flex justify-between gap-2">
              <span>
                <span className="inline-block w-14 text-cyan-300">{e.method}</span>
                {e.path}
              </span>
              <span className="text-ink-400">{e.source}</span>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={`Functional scenarios (${p.scenarios.length})`}>
        <ul className="space-y-1.5 text-sm">
          {p.scenarios.map((s) => (
            <li key={s.id} className="flex items-start justify-between gap-2">
              <span>{s.name}</span>
              <Badge>{s.workflow}</Badge>
            </li>
          ))}
        </ul>
      </Card>
      <Card title={`API checks (${p.apiChecks.length})`}>
        <ul className="scroll-thin max-h-80 space-y-1 overflow-y-auto text-sm">
          {p.apiChecks.map((c) => (
            <li key={c.id} className="flex items-start justify-between gap-2">
              <span>{c.name}</span>
              <Badge>{c.kind}</Badge>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Visual targets" subtitle={`Viewports: ${run.config?.viewports.join(', ')}`}>
        <div className="flex flex-wrap gap-2">
          {p.visualTargets.map((v) => (
            <Badge key={v.id}>{v.path}</Badge>
          ))}
        </div>
      </Card>
      <Card title="Planner notes" subtitle={`Engine: ${p.engine}`}>
        {p.notes.length ? (
          <ul className="list-disc space-y-1 pl-5 text-sm text-ink-300">
            {p.notes.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-400">No notes.</p>
        )}
      </Card>
    </div>
  );
}

function LogTab({ run, live }: { run: TestRun; live: boolean }) {
  const [agent, setAgent] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const events = (run.events || []).filter((e) => !agent || e.agent === agent);
  useEffect(() => {
    if (live && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [events.length, live]);
  return (
    <div className="space-y-2">
      <Select aria-label="Agent filter" value={agent} onChange={(e) => setAgent(e.target.value)} className="w-48">
        <option value="">All agents</option>
        {Object.entries(AGENT_META).map(([k, v]) => (
          <option key={k} value={k}>
            {v.name}
          </option>
        ))}
      </Select>
      <div ref={ref} className="scroll-thin h-[28rem] overflow-y-auto rounded-xl border border-ink-700 bg-ink-950 p-3 font-mono text-xs leading-relaxed" aria-live="polite">
        {events.map((e, i) => (
          <div key={i} className={cx('flex gap-2', e.level === 'warn' && 'text-amber-200', e.level === 'error' && 'text-red-300')}>
            <span className="shrink-0 text-ink-400">{new Date(e.ts).toLocaleTimeString()}</span>
            <span className="w-28 shrink-0 truncate text-cyan-300">{AGENT_META[e.agent]?.short || e.agent}</span>
            <span className="min-w-0 break-words">{e.message}</span>
          </div>
        ))}
        {live && (
          <div className="mt-1 flex items-center gap-2 text-ink-400">
            <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" /> waiting for agents…
          </div>
        )}
      </div>
    </div>
  );
}
