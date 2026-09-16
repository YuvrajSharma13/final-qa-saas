import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Icon } from '../components/icons';
import { ScreenshotCard, ScreenshotModal } from '../components/ScreenshotViewer';
import { Badge, Button, Card, CategoryBadge, CodeBlock, ErrorBox, PageHeader, PageLoader, Select, SeverityBadge, StatusBadge } from '../components/ui';
import { api, useApi, type Bug, type GithubLink, type RegressionTest, type Screenshot, type TestCase } from '../lib/api';
import { AutoFixCard } from '../components/AutoFixCard';
import { useAuth } from '../lib/auth';
import { dateTime, timeAgo } from '../lib/format';

interface BugData {
  bug: Bug;
  project: { _id: string; name: string; appUrl: string; repoUrl?: string; settings?: { github?: GithubLink | null } } | null;
  regressionTests: RegressionTest[];
  screenshots: Screenshot[];
  testCases: TestCase[];
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function slug(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

export default function BugDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<BugData>(`/bugs/${id}`);
  const [shot, setShot] = useState<Screenshot | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [runResult, setRunResult] = useState<{ status: string; detail: string } | null>(null);

  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const { bug, project, regressionTests, screenshots } = data;
  const rc = bug.rootCause || {};
  const rt = regressionTests[0];
  const ev = bug.evidence || {};

  const update = async (body: Record<string, string>) => {
    setBusy('update');
    setErr(null);
    try {
      await api(`/bugs/${bug._id}`, { method: 'PATCH', body });
      reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };
  const regenerate = async (run: boolean) => {
    setBusy(run ? 'run' : 'regen');
    setErr(null);
    try {
      const r = await api<{ result: { status: string; detail: string } | null }>(`/bugs/${bug._id}/regression${run ? '?run=1' : ''}`, { method: 'POST', body: {} });
      setRunResult(r.result);
      reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ to: '/bugs', label: 'Bugs' }, ...(project ? [{ to: `/projects/${project._id}`, label: project.name }] : []), { label: 'Bug' }]}
        title={bug.title}
        subtitle={
          <span className="flex flex-wrap items-center gap-2">
            <SeverityBadge severity={bug.severity} />
            <StatusBadge status={bug.status} />
            <CategoryBadge category={bug.category} />
            <span>
              detected {timeAgo(bug.createdAt)} · seen {bug.occurrences}× · by {bug.sources?.join(' + ')} agent{(bug.sources?.length || 0) > 1 ? 's' : ''}
            </span>
          </span>
        }
        actions={
          can('developer') && (
            <>
              <Select aria-label="Severity" value={bug.severity} disabled={busy === 'update'} onChange={(e) => update({ severity: e.target.value })} className="w-32">
                {['critical', 'high', 'medium', 'low'].map((s) => (
                  <option key={s}>{s}</option>
                ))}
              </Select>
              <Select aria-label="Status" value={bug.status} disabled={busy === 'update'} onChange={(e) => update({ status: e.target.value })} className="w-32">
                <option value="open">open</option>
                <option value="fixed">fixed</option>
                <option value="ignored">ignored</option>
              </Select>
            </>
          )
        }
      />
      <ErrorBox error={err} />

      <div className="grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0 space-y-6">
          <Card title="Summary">
            <p className="text-sm text-ink-300">{bug.description}</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
                <div className="text-xs font-medium text-emerald-300">Expected</div>
                <div className="mt-1 text-sm">{bug.expected}</div>
              </div>
              <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3">
                <div className="text-xs font-medium text-red-300">Actual</div>
                <div className="mt-1 break-words text-sm">{bug.actual}</div>
              </div>
            </div>
            {!!bug.reproSteps?.length && (
              <div className="mt-4">
                <div className="mb-1 text-xs font-medium text-ink-400">Steps to reproduce</div>
                <ol className="list-decimal space-y-1 pl-5 text-sm">
                  {bug.reproSteps.map((s, i) => (
                    <li key={i}>{s}</li>
                  ))}
                </ol>
              </div>
            )}
          </Card>

          <Card title="Root cause" subtitle={rc.codeAnalysis ? `Code Analysis agent · ${rc.codeAnalysis.source} · ${rc.codeAnalysis.filesScanned} files scanned · ${rc.codeAnalysis.engine}` : 'Bug Analyzer (connect a repository for file-level analysis)'}>
            <div className="flex items-start gap-2">
              <Icon name="code" className="mt-0.5 shrink-0 text-accent-300" />
              <div>
                <p className="text-sm">{rc.likelyCause}</p>
                {rc.confidence && <Badge className="mt-2 bg-ink-800 text-ink-300 ring-ink-600">confidence: {rc.confidence}</Badge>}
                {rc.llmExplanation && <p className="mt-2 text-sm text-ink-300">{rc.llmExplanation}</p>}
              </div>
            </div>
            {rc.fileReferences?.length ? (
              <div className="mt-4 space-y-3">
                {rc.fileReferences.map((f) => (
                  <div key={`${f.path}:${f.line}`}>
                    <div className="mb-1 text-xs text-ink-400">{f.reason}</div>
                    <CodeBlock title={`${f.path}:${f.line}`} code={f.snippet} maxHeight={200} />
                  </div>
                ))}
              </div>
            ) : null}
            {rc.suggestedFix && (
              <div className="mt-4 rounded-lg border border-accent-400/30 bg-accent-400/5 p-3 text-sm">
                <div className="mb-1 text-xs font-medium text-accent-300">Suggested fix</div>
                {rc.suggestedFix}
              </div>
            )}
            {rc.suggestedPatch && (
              <div className="mt-4">
                <div className="mb-1 text-xs text-ink-400">Suggested patch — review before applying. Nothing is changed in your repository automatically.</div>
                <CodeBlock
                  title="suggested.patch"
                  language="diff"
                  code={rc.suggestedPatch}
                  actions={
                    <Button variant="ghost" icon="download" className="px-2 py-1 text-xs" onClick={() => download(`${slug(bug.title)}.patch`, rc.suggestedPatch!)}>
                      .patch
                    </Button>
                  }
                />
              </div>
            )}
          </Card>

          <Card title="Evidence">
            {screenshots.length > 0 && (
              <div className="grid gap-3 sm:grid-cols-2">
                {screenshots.map((s) => (
                  <ScreenshotCard key={s._id} shot={s} onOpen={() => setShot(s)} />
                ))}
              </div>
            )}
            {!!ev.network?.length && (
              <div className="mt-4">
                <CodeBlock
                  title="network"
                  code={ev.network.map((n) => `${n.status}  ${n.method.padEnd(6)} ${n.path}${n.responseSnippet ? `\n      ↳ ${n.responseSnippet.slice(0, 220)}` : ''}${n.requestBody ? `\n      body: ${JSON.stringify(n.requestBody).slice(0, 200)}` : ''}`).join('\n')}
                  maxHeight={260}
                />
              </div>
            )}
            {!!ev.console?.length && (
              <div className="mt-4">
                <CodeBlock title="console / page errors" code={ev.console.map((c) => `[${c.type}] ${c.text}`).join('\n')} maxHeight={160} />
              </div>
            )}
            {!!ev.agentOutputs?.length && (
              <div className="mt-4">
                <CodeBlock title="structured agent outputs" code={ev.agentOutputs.map((o) => JSON.stringify(o)).join('\n')} maxHeight={260} />
              </div>
            )}
            {data.testCases.length > 0 && (
              <div className="mt-4">
                <div className="mb-1 text-xs text-ink-400">Failing checks consolidated into this bug</div>
                <ul className="space-y-1 text-sm">
                  {data.testCases.map((t) => (
                    <li key={t._id} className="flex items-center gap-2">
                      <CategoryBadge category={t.category} /> <span className="truncate">{t.name}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </div>

        <div className="min-w-0 space-y-6">
          <AutoFixCard bug={bug} project={project} />
          <Card
            title="Regression test"
            subtitle="Executed automatically on every QA run"
            actions={
              can('developer') && (
                <>
                  <Button variant="ghost" className="px-2 py-1 text-xs" loading={busy === 'regen'} onClick={() => regenerate(false)}>
                    Regenerate
                  </Button>
                  <Button className="px-2 py-1 text-xs" icon="play" loading={busy === 'run'} onClick={() => regenerate(true)}>
                    Run now
                  </Button>
                </>
              )
            }
          >
            {rt ? (
              <div className="space-y-3">
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <StatusBadge status={rt.status} />
                  <span className="text-ink-400">last run {timeAgo(rt.lastRunAt)}</span>
                </div>
                {runResult && (
                  <div className="rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm">
                    Run now: <StatusBadge status={runResult.status} /> <span className="text-ink-300">{runResult.detail}</span>
                  </div>
                )}
                <div className="text-sm">
                  <div className="text-xs text-ink-400">Expected</div>
                  {rt.expected}
                </div>
                {rt.lastResult?.failures?.length ? (
                  <div className="rounded-lg border border-red-500/20 bg-red-500/5 p-3 text-xs">
                    {rt.lastResult.failures.map((f) => (
                      <div key={f.step}>
                        Step {f.step}: {f.description} — <span className="text-red-200">{f.actual}</span>
                      </div>
                    ))}
                  </div>
                ) : null}
                {rt.code && (
                  <CodeBlock
                    title="regression.spec.ts (@playwright/test)"
                    code={rt.code}
                    maxHeight={380}
                    actions={
                      <Button variant="ghost" icon="download" className="px-2 py-1 text-xs" onClick={() => download(`${slug(bug.title)}.spec.ts`, rt.code!)}>
                        .spec.ts
                      </Button>
                    }
                  />
                )}
                {!!rt.results?.length && (
                  <div>
                    <div className="mb-1 text-xs text-ink-400">History</div>
                    <ul className="space-y-1 text-xs">
                      {[...rt.results].reverse().slice(0, 8).map((r, i) => (
                        <li key={i} className="flex items-center gap-2">
                          <StatusBadge status={r.status} />
                          <span className="text-ink-400">{dateTime(r.at)}</span>
                          {r.runId && (
                            <Link to={`/runs/${r.runId}`} className="text-accent-300 hover:underline">
                              run
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-sm text-ink-400">No regression test yet.</p>
            )}
          </Card>

          <Card title="Location">
            <dl className="grid grid-cols-[100px_1fr] gap-x-3 gap-y-2 text-sm">
              {Object.entries(bug.location || {})
                .filter(([k, v]) => v && (!Array.isArray(v) || v.length) && !['styles', 'responseSnippets', 'texts', 'classes'].includes(k))
                .map(([k, v]) => (
                  <div key={k} className="contents">
                    <dt className="text-ink-400">{k}</dt>
                    <dd className="break-words font-mono text-xs">{Array.isArray(v) ? v.join(', ') : String(v)}</dd>
                  </div>
                ))}
            </dl>
          </Card>

          <Card title="History">
            <ol className="relative space-y-3 border-l border-ink-700 pl-4">
              {[...(bug.history || [])].reverse().map((h, i) => (
                <li key={i} className="text-sm">
                  <span className="absolute -left-[5px] mt-1.5 h-2.5 w-2.5 rounded-full border-2 border-ink-900 bg-ink-600" />
                  <div className="flex flex-wrap items-center gap-2">
                    <StatusBadge status={h.event?.startsWith('status:') ? h.event.slice(7) : h.event === 'detected' ? 'new' : h.event || 'seen'} label={h.event} />
                    <span className="text-xs text-ink-400">{dateTime(h.at)}</span>
                  </div>
                  <div className="mt-0.5 text-ink-300">
                    {h.message}
                    {h.userName && <span className="text-ink-400"> — {h.userName}</span>}
                    {h.runId && (
                      <Link to={`/runs/${h.runId}`} className="ml-1 text-accent-300 hover:underline">
                        run
                      </Link>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          </Card>
        </div>
      </div>
      <ScreenshotModal shot={shot} onClose={() => setShot(null)} />
    </div>
  );
}
