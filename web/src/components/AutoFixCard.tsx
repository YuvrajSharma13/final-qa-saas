import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, FIX_ACTIVE, useApi, type AutoFix, type Bug, type GithubConnection, type GithubLink } from '../lib/api';
import { useAuth } from '../lib/auth';
import { FixList, RepoBadge } from './github';
import { Icon } from './icons';
import { Button, Card, ErrorBox, LinkButton } from './ui';

/** "Generate AI fix" entry point on the bug page. */
export function AutoFixCard({ bug, project }: { bug: Bug; project: { _id: string; settings?: { github?: GithubLink | null } } | null }) {
  const { can } = useAuth();
  const nav = useNavigate();
  const link = project?.settings?.github;
  const { data: status } = useApi<{ connection: GithubConnection }>('/github/status');
  const { data } = useApi<{ fixes: AutoFix[] }>(`/autofixes?bugId=${bug._id}`, { pollMs: (d) => (d?.fixes.some((f) => FIX_ACTIVE.includes(f.status)) ? 3000 : false) });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);
  const fixes = data?.fixes || [];
  const current = fixes.find((f) => [...FIX_ACTIVE, 'awaiting_approval'].includes(f.status));
  const connected = status?.connection.connected;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ fix: AutoFix }>('/autofixes', { method: 'POST', body: { bugId: bug._id } });
      nav(`/fixes/${r.fix._id}`);
    } catch (e) {
      setErr(e as Error);
      setBusy(false);
    }
  };

  return (
    <Card title={<span className="inline-flex items-center gap-2"><Icon name="wand" className="text-accent-300" /> AI auto-fix</span>} subtitle="Diff review → your approval → ai-fix branch → validation → pull request" padded={false}>
      <div className="space-y-3 p-4">
        <ErrorBox error={err} />
        {!link?.owner ? (
          <div className="text-sm text-ink-300">
            Link this project to a GitHub repository and branch first.
            <div className="mt-2">
              <LinkButton to={`/settings?tab=github&project=${project?._id || ''}`} icon="github">
                Connect repository
              </LinkButton>
            </div>
          </div>
        ) : !connected ? (
          <div className="text-sm text-ink-300">
            <RepoBadge owner={link.owner} repo={link.repo} branch={link.baseBranch} />
            <p className="mt-2">Connect your GitHub account to generate fixes and open pull requests with your access.</p>
            <div className="mt-2">
              <LinkButton to="/settings?tab=github" icon="github">
                Connect GitHub
              </LinkButton>
            </div>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
              <RepoBadge owner={link.owner} repo={link.repo} branch={link.baseBranch} />
              <span className="text-xs text-ink-400">as @{status?.connection.login}</span>
            </div>
            {current ? (
              <Link to={`/fixes/${current._id}`} className="flex items-center justify-between gap-2 rounded-lg border border-accent-400/40 bg-accent-400/5 px-3 py-2 text-sm hover:border-accent-400">
                <span>{current.status === 'awaiting_approval' ? 'A fix is waiting for your review' : 'A fix is in progress'}</span>
                <span className="text-accent-300">Open →</span>
              </Link>
            ) : (
              can('developer') &&
              bug.status === 'open' && (
                <Button variant="primary" icon="wand" loading={busy} onClick={start} className="w-full">
                  Generate AI fix
                </Button>
              )
            )}
            {bug.status !== 'open' && !current && <p className="text-xs text-ink-400">Only open bugs can be auto-fixed.</p>}
          </>
        )}
      </div>
      {fixes.length > 0 && (
        <div className="border-t border-ink-700">
          <FixList fixes={fixes} />
        </div>
      )}
    </Card>
  );
}
