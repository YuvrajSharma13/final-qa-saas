import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, API_BASE, useApi, type AutoFix, type AutoFixStatus, type GithubConnection, type Project, type PullInfo } from '../lib/api';
import { timeAgo } from '../lib/format';
import { Icon } from './icons';
import { Badge, Button, cx, ErrorBox, Field, Input, Select, Spinner } from './ui';

export const FIX_LABEL: Record<AutoFixStatus, string> = {
  queued: 'Queued',
  generating: 'Generating fix',
  awaiting_approval: 'Awaiting your approval',
  applying: 'Applying patch',
  validating: 'Running tests / lint / build',
  committing: 'Committing',
  pushing: 'Pushing branch',
  creating_pr: 'Opening PR',
  pr_open: 'PR open',
  merged: 'Merged',
  closed: 'PR closed',
  rejected: 'Rejected',
  failed: 'Failed',
  canceled: 'Canceled',
};

const FIX_TONE: Record<string, string> = {
  awaiting_approval: 'bg-amber-400/15 text-amber-200 ring-amber-400/40',
  pr_open: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  merged: 'bg-violet-500/15 text-violet-300 ring-violet-500/40',
  closed: 'bg-ink-800 text-ink-300 ring-ink-600',
  rejected: 'bg-ink-800 text-ink-300 ring-ink-600',
  canceled: 'bg-ink-800 text-ink-300 ring-ink-600',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/40',
};

export function FixStatusBadge({ status }: { status: AutoFixStatus }) {
  const active = !FIX_TONE[status];
  return (
    <Badge className={FIX_TONE[status] || 'bg-accent-400/15 text-accent-300 ring-accent-400/40'}>
      {active && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent-400" />}
      {FIX_LABEL[status] || status}
    </Badge>
  );
}

export function PrBadge({ pr }: { pr?: PullInfo }) {
  if (!pr?.number) return null;
  const state = pr.merged ? 'merged' : pr.state;
  const tone = state === 'merged' ? 'text-violet-300' : state === 'open' ? 'text-emerald-300' : 'text-ink-400';
  const checks = pr.checks?.state;
  return (
    <a href={pr.url} target="_blank" rel="noreferrer" className={cx('inline-flex items-center gap-1.5 text-xs font-medium hover:underline', tone)}>
      <Icon name={state === 'merged' ? 'merge' : 'pr'} size={13} />#{pr.number} {state}
      {checks && checks !== 'none' && (
        <span className={cx('ml-1', checks === 'success' ? 'text-emerald-300' : checks === 'failure' ? 'text-red-300' : 'text-amber-200')}>
          · checks {checks}
        </span>
      )}
    </a>
  );
}

export function RepoBadge({ owner, repo, branch, url }: { owner: string; repo: string; branch?: string; url?: string }) {
  const body = (
    <>
      <Icon name="github" size={12} /> {owner}/{repo}
      {branch && (
        <span className="inline-flex items-center gap-1 text-ink-400">
          <Icon name="branch" size={12} />
          {branch}
        </span>
      )}
    </>
  );
  return url ? (
    <a href={url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-300 hover:text-ink-100">
      {body}
    </a>
  ) : (
    <span className="inline-flex items-center gap-1.5 font-mono text-xs text-ink-300">{body}</span>
  );
}

// ------------------------------------------------------------------ connection
export function GithubConnectionPanel({ onChange }: { onChange?: () => void }) {
  const { data, reload, error } = useApi<{ oauthConfigured: boolean; connection: GithubConnection }>('/github/status');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const c = data?.connection;
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setErr(null);
    try {
      await fn();
      reload();
      onChange?.();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  return (
    <div className="space-y-4">
      <ErrorBox error={err} />
      {c?.connected ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-ink-700 bg-ink-850 p-3">
          <div className="flex items-center gap-3">
            {c.avatarUrl ? <img src={c.avatarUrl} alt="" className="h-10 w-10 rounded-full" /> : <span className="flex h-10 w-10 items-center justify-center rounded-full bg-ink-700"><Icon name="github" /></span>}
            <div>
              <div className="font-medium">
                @{c.login} {c.name && <span className="text-ink-400">· {c.name}</span>}
              </div>
              <div className="text-xs text-ink-400">
                Connected via {c.method === 'oauth' ? 'GitHub sign-in' : 'personal access token'} · {c.scopes?.length ? `scopes: ${c.scopes.join(', ')}` : 'fine-grained permissions'} · last used {timeAgo(c.lastUsedAt)}
              </div>
              {c.lastError && <div className="mt-1 text-xs text-red-300">{c.lastError}</div>}
            </div>
          </div>
          <Button variant="danger" loading={busy === 'disconnect'} onClick={() => act('disconnect', () => api('/github/connection', { method: 'DELETE' }))}>
            Disconnect
          </Button>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-3">
            {data.oauthConfigured ? (
              <a href={`${API_BASE}/api/github/oauth/start?mode=connect`} className="inline-flex items-center gap-2 rounded-lg bg-ink-100 px-3.5 py-2 text-sm font-semibold text-ink-950 hover:bg-white">
                <Icon name="github" /> Connect with GitHub
              </a>
            ) : (
              <p className="text-sm text-ink-400">GitHub sign-in isn’t configured on this server (set GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET). You can connect with a token instead.</p>
            )}
          </div>
          <form
            className="grid items-end gap-3 sm:grid-cols-[1fr_auto]"
            onSubmit={(e) => {
              e.preventDefault();
              void act('token', async () => {
                await api('/github/token', { method: 'POST', body: { token } });
                setToken('');
              });
            }}
          >
            <Field label="…or use a personal access token" htmlFor="gh-pat" hint="Fine-grained token with Contents: Read & write and Pull requests: Read & write on the repositories you want to fix. Stored encrypted; never shown again.">
              <Input id="gh-pat" type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" />
            </Field>
            <Button type="submit" variant="primary" loading={busy === 'token'} disabled={token.length < 20} className="mb-6">
              Connect token
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ repository linking
interface RepoItem {
  owner: string;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  canPush: boolean;
  pushedAt: string;
}
interface BranchItem {
  name: string;
  sha: string;
  protected: boolean;
  isDefault: boolean;
}

export function RepoLinker({ project, onLinked, connected }: { project: Project; onLinked: () => void; connected: boolean }) {
  const link = project.settings.github;
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [full, setFull] = useState(link ? `${link.owner}/${link.repo}` : '');
  const [branch, setBranch] = useState(link?.baseBranch || '');
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q), 300);
    return () => clearTimeout(t);
  }, [q]);
  const repos = useApi<{ repos: RepoItem[] }>(connected ? `/github/repos?q=${encodeURIComponent(debounced)}` : null);
  const [owner, name] = full.split('/');
  const branches = useApi<{ branches: BranchItem[]; defaultBranch: string; canPush: boolean }>(connected && owner && name ? `/github/repos/${owner}/${name}/branches` : null);
  useEffect(() => {
    if (branches.data && !branches.data.branches.some((b) => b.name === branch)) setBranch(branches.data.defaultBranch);
  }, [branches.data]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = async () => {
    setBusy('save');
    setErr(null);
    setMsg('');
    try {
      await api(`/github/projects/${project.id}/repository`, { method: 'PUT', body: { owner, repo: name, baseBranch: branch } });
      setMsg(`Linked ${full} @ ${branch}`);
      onLinked();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };

  if (!connected) return <p className="text-sm text-ink-400">Connect GitHub above to choose a repository and branch.</p>;
  const options = repos.data?.repos || [];
  const selectedMissing = full && !options.some((r) => r.fullName === full);
  return (
    <div className="space-y-4">
      <ErrorBox error={err || repos.error || branches.error} />
      {link && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-sm">
          <span className="flex items-center gap-2">
            Linked: <RepoBadge owner={link.owner} repo={link.repo} branch={link.baseBranch} />
            {link.private && <Badge>private</Badge>}
          </span>
          <button
            className="text-xs text-red-300 hover:underline"
            onClick={async () => {
              await api(`/github/projects/${project.id}/repository`, { method: 'DELETE' });
              setFull('');
              onLinked();
            }}
          >
            Unlink
          </button>
        </div>
      )}
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_200px]">
        <Field label="Search repositories" htmlFor="repo-q">
          <Input id="repo-q" value={q} onChange={(e) => setQ(e.target.value)} placeholder="owner/name" />
        </Field>
        <Field label="Repository" htmlFor="repo-select" hint={repos.loading ? 'Loading repositories…' : `${options.length} repositories you can access`}>
          <Select id="repo-select" value={full} onChange={(e) => setFull(e.target.value)}>
            <option value="">Select a repository…</option>
            {selectedMissing && <option value={full}>{full}</option>}
            {options.map((r) => (
              <option key={r.fullName} value={r.fullName} disabled={!r.canPush}>
                {r.fullName}
                {r.private ? ' (private)' : ''}
                {!r.canPush ? ' (read-only)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Base branch" htmlFor="branch-select" hint={branches.data ? `Fix PRs target this branch${branches.data.branches.find((b) => b.name === branch)?.protected ? ' (protected)' : ''}` : undefined}>
          <Select id="branch-select" value={branch} onChange={(e) => setBranch(e.target.value)} disabled={!branches.data}>
            {branches.data?.branches.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
                {b.isDefault ? ' (default)' : ''}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex items-center justify-end gap-3">
        {msg && (
          <span role="status" className="text-sm text-emerald-300">
            {msg}
          </span>
        )}
        <Button variant="primary" icon="github" loading={busy === 'save'} disabled={!owner || !name || !branch} onClick={save}>
          Link repository
        </Button>
      </div>
    </div>
  );
}

export function FixList({ fixes, empty = 'No AI fixes yet.' }: { fixes: AutoFix[]; empty?: string }) {
  if (!fixes.length) return <p className="p-4 text-sm text-ink-400">{empty}</p>;
  return (
    <ul>
      {fixes.map((f) => (
        <li key={f._id} className="border-t border-ink-700 first:border-t-0">
          <Link to={`/fixes/${f._id}`} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 hover:bg-ink-850">
            <FixStatusBadge status={f.status} />
            <span className="min-w-0 flex-1 truncate text-sm">{f.bugTitle || f.bug?.title}</span>
            <span className="flex items-center gap-3 text-xs text-ink-400">
              {f.branch && (
                <span className="inline-flex items-center gap-1 font-mono">
                  <Icon name="branch" size={12} />
                  {f.branch.length > 36 ? `${f.branch.slice(0, 36)}…` : f.branch}
                </span>
              )}
              {f.pr?.number ? <PrBadge pr={f.pr} /> : null}
              <span>{timeAgo(f.updatedAt)}</span>
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
