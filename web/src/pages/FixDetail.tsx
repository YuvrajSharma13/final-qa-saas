import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { DiffViewer } from '../components/DiffViewer';
import { FIX_LABEL, FixStatusBadge, PrBadge, RepoBadge } from '../components/github';
import { Icon, type IconName } from '../components/icons';
import { Badge, Button, Card, cx, ErrorBox, PageHeader, PageLoader, SeverityBadge, StatusBadge, Textarea } from '../components/ui';
import { api, FIX_ACTIVE, useApi, type AutoFix, type AutoFixStatus, type FixAttempt, type ValidationReport } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime, duration, timeAgo } from '../lib/format';

const STEPS: { key: string; label: string; icon: IconName; statuses: AutoFixStatus[] }[] = [
  { key: 'generate', label: 'Generate fix', icon: 'wand', statuses: ['queued', 'generating'] },
  { key: 'review', label: 'Review diff', icon: 'code', statuses: ['awaiting_approval'] },
  { key: 'branch', label: 'Branch & apply', icon: 'branch', statuses: ['applying'] },
  { key: 'validate', label: 'Tests / lint / build', icon: 'shield', statuses: ['validating'] },
  { key: 'commit', label: 'Commit & push', icon: 'github', statuses: ['committing', 'pushing'] },
  { key: 'pr', label: 'Pull request', icon: 'pr', statuses: ['creating_pr', 'pr_open', 'merged', 'closed'] },
];

function Stepper({ fix }: { fix: AutoFix }) {
  const current = STEPS.findIndex((s) => s.statuses.includes(fix.status));
  const terminalBad = ['failed', 'rejected', 'canceled'].includes(fix.status);
  // For failed runs, show progress up to the last known step from events.
  const reached = current >= 0 ? current : Math.max(0, ...fix.events.map((e) => STEPS.findIndex((s) => s.statuses.includes(e.step as AutoFixStatus))));
  return (
    <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-label="Auto-fix progress">
      {STEPS.map((s, i) => {
        const done = i < reached || (i === reached && ['pr_open', 'merged', 'closed'].includes(fix.status));
        const active = i === reached && !done && !terminalBad;
        const failed = terminalBad && i === reached;
        return (
          <li
            key={s.key}
            aria-current={active ? 'step' : undefined}
            className={cx(
              'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm',
              done && 'border-emerald-500/40 bg-emerald-500/5',
              active && 'border-accent-400/60 bg-accent-400/10',
              failed && 'border-red-500/50 bg-red-500/10',
              !done && !active && !failed && 'border-ink-700 text-ink-400',
            )}
          >
            <span className={cx('flex h-6 w-6 shrink-0 items-center justify-center rounded-full', done ? 'bg-emerald-500/20 text-emerald-300' : active ? 'bg-accent-400/20 text-accent-300' : failed ? 'bg-red-500/20 text-red-300' : 'bg-ink-800')}>
              {done ? <Icon name="check" size={13} /> : failed ? <Icon name="x" size={13} /> : <Icon name={s.icon} size={13} />}
            </span>
            <span className="leading-tight">{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function ValidationTable({ report, baseline, compact }: { report: ValidationReport; baseline?: ValidationReport; compact?: boolean }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {report.verdict ? <StatusBadge status={report.verdict.ok ? 'passed' : 'failed'} label={report.verdict.ok ? 'validation passed' : 'validation failed'} /> : null}
        <span className="text-ink-300">{report.summary}</span>
        <span className="text-xs text-ink-400">{duration(report.durationMs)}</span>
      </div>
      {!!report.verdict?.problems.length && <p className="text-sm text-red-300">Regressions: {report.verdict.problems.join(', ')}</p>}
      {!!report.verdict?.preExisting.length && <p className="text-xs text-amber-200">Pre-existing on base branch: {report.verdict.preExisting.join(', ')}</p>}
      <div className="overflow-hidden rounded-lg border border-ink-700">
        {report.checks.map((c) => {
          const b = baseline?.checks.find((x) => x.name === c.name);
          const isOpen = open === c.name;
          return (
            <div key={c.name} className="border-t border-ink-700 first:border-t-0">
              <button className="flex w-full flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-left text-sm hover:bg-ink-850" onClick={() => setOpen(isOpen ? null : c.name)} aria-expanded={isOpen}>
                <StatusBadge status={c.status === 'timeout' ? 'failed' : c.status} label={c.status} />
                <span className="min-w-0 flex-1 truncate">{c.name}</span>
                {!compact && <code className="hidden max-w-72 truncate text-xs text-ink-400 md:block">{c.command}</code>}
                {c.failures != null && <span className="text-xs text-ink-400">{c.failures} failing</span>}
                {b && <span className="text-xs text-ink-400">base: {b.status}{b.failures != null ? ` (${b.failures})` : ''}</span>}
                <span className="w-14 text-right text-xs tabular-nums text-ink-400">{c.durationMs ? duration(c.durationMs) : ''}</span>
              </button>
              {isOpen && (
                <pre className="scroll-thin max-h-72 overflow-auto border-t border-ink-700 bg-ink-950 p-3 font-mono text-[11.5px] leading-relaxed text-ink-300">
                  {c.note ? `${c.note}\n` : ''}
                  {c.output || '(no output)'}
                </pre>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AttemptPanel({ fix, attempt, latest, canAct, onDone }: { fix: AutoFix; attempt: FixAttempt; latest: boolean; canAct: boolean; onDone: () => void }) {
  const [confirmed, setConfirmed] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const awaiting = latest && fix.status === 'awaiting_approval' && attempt.status === 'proposed';
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <Badge>{attempt.engine === 'llm' ? 'AI model' : 'Rule engine'}</Badge>
        <StatusBadge status={attempt.status === 'validation_failed' ? 'failed' : attempt.status === 'approved' ? 'passed' : attempt.status === 'rejected' ? 'ignored' : 'pending'} label={attempt.status.replace('_', ' ')} />
        <span className="text-ink-400">{dateTime(attempt.createdAt)}</span>
        {attempt.approvedAt && (
          <span className="text-ink-400">
            · approved by {attempt.approvedByName} {timeAgo(attempt.approvedAt)}
          </span>
        )}
        <code className="ml-auto text-xs text-ink-400" title="sha256 of the exact diff">
          sha256 {attempt.patchHash.slice(0, 16)}…
        </code>
      </div>
      <p className="text-sm text-ink-100">{attempt.explanation}</p>
      <DiffViewer diff={attempt.diff} title={`Attempt ${attempt.n} diff against ${fix.repo.baseBranch}@${fix.repo.baseSha?.slice(0, 7) || ''}`} />

      {attempt.validation && (
        <div>
          <h3 className="mb-2 text-sm font-semibold">Validation of this attempt</h3>
          <ValidationTable report={attempt.validation} baseline={fix.baseline} />
        </div>
      )}
      {attempt.error && <ErrorBox error={{ message: attempt.error }} />}

      {awaiting && canAct && (
        <div className="space-y-3 rounded-xl border border-amber-400/40 bg-amber-400/5 p-4">
          <div className="flex items-start gap-2">
            <Icon name="shield" className="mt-0.5 shrink-0 text-amber-200" />
            <div className="text-sm">
              <div className="font-semibold text-amber-100">Your approval is required</div>
              <p className="text-ink-300">
                Approving lets the platform create <code className="font-mono">ai-fix/…</code> from <code className="font-mono">{fix.repo.baseBranch}</code>, apply exactly this diff, run the project’s checks, and — only if they pass — commit, push and open a pull request. It never pushes to{' '}
                <code className="font-mono">{fix.repo.baseBranch}</code> or any other protected branch. If validation fails, a new diff is generated and shown here for approval again.
              </p>
            </div>
          </div>
          <ErrorBox error={err} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} className="h-4 w-4 accent-teal-400" />I reviewed this exact diff ({attempt.files.length} file{attempt.files.length === 1 ? '' : 's'}, sha256 {attempt.patchHash.slice(0, 12)})
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              icon="check"
              disabled={!confirmed}
              loading={busy === 'approve'}
              onClick={() => act('approve', () => api(`/autofixes/${fix._id}/approve`, { method: 'POST', body: { attempt: attempt.n, patchHash: attempt.patchHash, confirm: true } }))}
            >
              Approve · branch, validate, commit, push & open PR
            </Button>
          </div>
          <div className="grid gap-2 border-t border-amber-400/20 pt-3">
            <Textarea aria-label="Feedback for the next attempt" rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="Optional feedback, e.g. “keep the change inside the handler”" className="font-sans" />
            <div className="flex flex-wrap gap-2">
              <Button
                loading={busy === 'regen'}
                icon="refresh"
                disabled={fix.attempts.length >= (fix.maxAttempts || 3)}
                onClick={() => act('regen', () => api(`/autofixes/${fix._id}/reject`, { method: 'POST', body: { feedback, regenerate: true } }))}
              >
                Reject & regenerate
              </Button>
              <Button variant="danger" loading={busy === 'reject'} onClick={() => act('reject', () => api(`/autofixes/${fix._id}/reject`, { method: 'POST', body: { feedback, regenerate: false } }))}>
                Reject
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function FixDetail() {
  const { id } = useParams();
  const { can } = useAuth();
  const { data, error, loading, reload } = useApi<{ fix: AutoFix }>(`/autofixes/${id}`, {
    pollMs: (d) => (d && (FIX_ACTIVE.includes(d.fix.status) || d.fix.status === 'awaiting_approval') ? 1500 : d?.fix.status === 'pr_open' ? 30000 : false),
  });
  const [tab, setTab] = useState<number | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [retryNote, setRetryNote] = useState('');
  const logRef = useRef<HTMLDivElement>(null);
  const attempts = data?.fix.attempts.length || 0;
  useEffect(() => setTab(null), [attempts]);
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [data?.fix.events.length]);

  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const fix = data.fix;
  const selected = fix.attempts[tab ?? fix.attempts.length - 1];
  const active = FIX_ACTIVE.includes(fix.status);
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
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
        crumbs={[{ to: '/fixes', label: 'AI fixes' }, ...(fix.bug ? [{ to: `/bugs/${fix.bug._id}`, label: 'Bug' }] : []), { label: 'Fix' }]}
        title={
          <span className="flex flex-wrap items-center gap-3">
            AI fix <FixStatusBadge status={fix.status} />
          </span>
        }
        subtitle={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            {fix.bug && (
              <Link to={`/bugs/${fix.bug._id}`} className="inline-flex items-center gap-2 hover:text-ink-100">
                <SeverityBadge severity={fix.bug.severity} /> {fix.bug.title}
              </Link>
            )}
            <RepoBadge owner={fix.repo.owner} repo={fix.repo.name} branch={fix.repo.baseBranch} url={fix.repoUrl} />
            <span>
              started by {fix.createdByName} {timeAgo(fix.createdAt)}
            </span>
          </span>
        }
        actions={
          can('developer') && (
            <>
              {['queued', 'awaiting_approval'].includes(fix.status) && (
                <Button variant="danger" icon="stop" loading={busy === 'cancel'} onClick={() => act('cancel', () => api(`/autofixes/${fix._id}/cancel`, { method: 'POST' }))}>
                  Cancel
                </Button>
              )}
              {fix.pr?.number && (
                <Button icon="refresh" loading={busy === 'refresh'} onClick={() => act('refresh', () => api(`/autofixes/${fix._id}/refresh`, { method: 'POST' }))}>
                  Refresh PR status
                </Button>
              )}
            </>
          )
        }
      />
      <ErrorBox error={err} />
      <Stepper fix={fix} />

      {fix.status === 'failed' && (
        <div className="space-y-3 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
          <div className="text-sm text-red-200">{fix.error}</div>
          {can('developer') && !fix.pr?.number && (
            <div className="flex flex-wrap items-center gap-2">
              <input aria-label="Retry feedback" value={retryNote} onChange={(e) => setRetryNote(e.target.value)} placeholder="Optional guidance for the next attempt" className="min-w-64 flex-1 rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm" />
              <Button icon="refresh" loading={busy === 'retry'} onClick={() => act('retry', () => api(`/autofixes/${fix._id}/retry`, { method: 'POST', body: { feedback: retryNote } }))}>
                Retry
              </Button>
            </div>
          )}
        </div>
      )}

      {fix.pr?.number && (
        <Card title="Pull request" subtitle={fix.pr.updatedAt ? `status checked ${timeAgo(fix.pr.updatedAt)}` : undefined}>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <a href={fix.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 text-lg font-semibold hover:text-accent-300">
                <Icon name={fix.pr.merged ? 'merge' : 'pr'} /> #{fix.pr.number} {fix.pr.title}
              </a>
              <div className="flex flex-wrap items-center gap-3 text-sm text-ink-300">
                <PrBadge pr={fix.pr} />
                {fix.branch && (
                  <a href={fix.branchUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 font-mono text-xs hover:text-ink-100">
                    <Icon name="branch" size={12} />
                    {fix.branch} → {fix.repo.baseBranch}
                  </a>
                )}
                {fix.commitSha && (
                  <a href={fix.commitUrl} target="_blank" rel="noreferrer" className="font-mono text-xs hover:text-ink-100">
                    commit {fix.commitSha.slice(0, 10)}
                  </a>
                )}
              </div>
            </div>
            <a href={fix.pr.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-lg bg-ink-100 px-3.5 py-2 text-sm font-semibold text-ink-950 hover:bg-white">
              <Icon name="github" /> Open on GitHub
            </a>
          </div>
          {!!fix.pr.checks?.runs.length && (
            <ul className="mt-3 grid gap-1 text-xs sm:grid-cols-2">
              {fix.pr.checks.runs.map((r) => (
                <li key={r.name} className="flex items-center gap-2">
                  <StatusBadge status={r.conclusion === 'success' ? 'passed' : r.conclusion ? 'failed' : 'running'} label={r.conclusion || r.status} />
                  <a href={r.url} target="_blank" rel="noreferrer" className="truncate hover:underline">
                    {r.name}
                  </a>
                </li>
              ))}
            </ul>
          )}
          {fix.pr.merged && <p className="mt-3 text-sm text-violet-200">Merged. Rerun QA on the project to verify the bug is gone — the regression test will mark it fixed.</p>}
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[1fr_360px]">
        <div className="min-w-0">
          <Card
            title="Proposed changes"
            subtitle={fix.attempts.length ? `${fix.attempts.length} of up to ${fix.maxAttempts} attempts` : undefined}
            actions={
              fix.attempts.length > 1 && (
                <div className="flex rounded-lg border border-ink-600 p-0.5 text-xs" role="tablist">
                  {fix.attempts.map((a, i) => (
                    <button key={a.n} role="tab" aria-selected={selected?.n === a.n} onClick={() => setTab(i)} className={cx('rounded-md px-2 py-1', selected?.n === a.n && 'bg-ink-700')}>
                      Attempt {a.n}
                    </button>
                  ))}
                </div>
              )
            }
          >
            {selected ? (
              <AttemptPanel fix={fix} attempt={selected} latest={selected.n === fix.attempts.length} canAct={can('developer')} onDone={reload} />
            ) : (
              <div className="flex items-center gap-3 py-8 text-sm text-ink-300">
                {fix.status === 'failed' ? 'No diff was produced.' : (
                  <>
                    <span className="h-2 w-2 animate-pulse rounded-full bg-accent-400" /> {FIX_LABEL[fix.status]}…
                  </>
                )}
              </div>
            )}
          </Card>
        </div>
        <div className="space-y-6">
          {fix.baseline && (
            <Card title="Baseline checks" subtitle={`${fix.repo.baseBranch}@${fix.repo.baseSha?.slice(0, 7)} before any change`}>
              <ValidationTable report={fix.baseline} compact />
            </Card>
          )}
          <Card title="Activity">
            <div ref={logRef} className="scroll-thin max-h-[32rem] space-y-2 overflow-y-auto text-xs" aria-live="polite">
              {fix.events.map((e, i) => (
                <div key={i} className={cx('flex gap-2', e.level === 'warn' && 'text-amber-200', e.level === 'error' && 'text-red-300')}>
                  <span className="shrink-0 font-mono text-ink-400">{new Date(e.ts).toLocaleTimeString()}</span>
                  <span className="min-w-0 break-words">{e.message}</span>
                </div>
              ))}
              {active && (
                <div className="flex items-center gap-2 text-ink-400">
                  <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" /> {FIX_LABEL[fix.status]}…
                </div>
              )}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
