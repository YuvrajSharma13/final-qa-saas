import { useState } from 'react';
import { Link } from 'react-router-dom';
import { FixStatusBadge, PrBadge, RepoBadge } from '../components/github';
import { Empty, ErrorBox, LinkButton, PageHeader, PageLoader, Select, SeverityBadge } from '../components/ui';
import { useApi, type AutoFix } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

export default function Fixes() {
  const { workspace } = useAuth();
  const [open, setOpen] = useState('');
  const { data, error, loading } = useApi<{ fixes: AutoFix[] }>(`/autofixes?refresh=1${open ? '&open=1' : ''}&ws=${workspace?.id}`, { pollMs: 15000 });
  return (
    <div>
      <PageHeader
        title="AI fixes"
        subtitle="Every AI-generated fix, its approval state, validation and GitHub pull request."
        actions={
          <Select aria-label="Filter" value={open} onChange={(e) => setOpen(e.target.value)} className="w-40">
            <option value="">All fixes</option>
            <option value="1">Open only</option>
          </Select>
        }
      />
      <ErrorBox error={error} />
      {loading && !data ? (
        <PageLoader />
      ) : !data?.fixes.length ? (
        <Empty title="No AI fixes yet" icon="wand" action={<LinkButton to="/bugs" variant="primary">Open the bug tracker</LinkButton>}>
          Link a GitHub repository in Settings, then use “Generate AI fix” on any open bug.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-900">
          <table className="w-full min-w-[860px] text-sm">
            <thead className="text-left text-xs text-ink-400">
              <tr>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Bug</th>
                <th className="px-4 py-2 font-medium">Repository</th>
                <th className="px-4 py-2 font-medium">Pull request</th>
                <th className="px-4 py-2 font-medium">Attempts</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.fixes.map((f) => (
                <tr key={f._id} className="border-t border-ink-700 hover:bg-ink-850">
                  <td className="px-4 py-3">
                    <FixStatusBadge status={f.status} />
                  </td>
                  <td className="max-w-sm px-4 py-3">
                    <Link to={`/fixes/${f._id}`} className="flex items-center gap-2 font-medium hover:text-accent-300">
                      {f.bugSeverity && <SeverityBadge severity={f.bugSeverity} />}
                      <span className="truncate">{f.bugTitle}</span>
                    </Link>
                    <div className="text-xs text-ink-400">{f.projectName}</div>
                  </td>
                  <td className="px-4 py-3">
                    <RepoBadge owner={f.repo.owner} repo={f.repo.name} branch={f.branch || f.repo.baseBranch} />
                  </td>
                  <td className="px-4 py-3">{f.pr?.number ? <PrBadge pr={f.pr} /> : <span className="text-ink-400">—</span>}</td>
                  <td className="px-4 py-3 tabular-nums">{f.attemptsCount}</td>
                  <td className="px-4 py-3 text-ink-400">{timeAgo(f.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
