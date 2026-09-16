import { Link, useSearchParams } from 'react-router-dom';
import { CategoryBadge, Empty, ErrorBox, PageHeader, PageLoader, Select, SeverityBadge, StatusBadge } from '../components/ui';
import { useApi, type Bug, type Project } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

export default function Bugs() {
  const [params, setParams] = useSearchParams();
  const { workspace } = useAuth();
  const filters = { status: params.get('status') ?? 'open', severity: params.get('severity') || '', category: params.get('category') || '', projectId: params.get('projectId') || '' };
  const qs = new URLSearchParams(Object.entries(filters).filter(([, v]) => v)).toString();
  const { data, error, loading } = useApi<{ bugs: Bug[] }>(`/bugs?${qs}&ws=${workspace?.id}`, { pollMs: 20000 });
  const { data: projects } = useApi<{ projects: Project[] }>(`/projects?ws=${workspace?.id}`);
  const set = (k: string, v: string) => {
    const next = new URLSearchParams(params);
    next.set(k, v);
    setParams(next, { replace: true });
  };

  return (
    <div>
      <PageHeader title="Bug tracker" subtitle="Consolidated, de-duplicated bugs across projects. Status is updated automatically when regression tests pass." />
      <div className="mb-4 flex flex-wrap gap-2">
        <Select aria-label="Project" value={filters.projectId} onChange={(e) => set('projectId', e.target.value)} className="w-44">
          <option value="">All projects</option>
          {projects?.projects.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
        <Select aria-label="Status" value={filters.status} onChange={(e) => set('status', e.target.value)} className="w-32">
          <option value="">Any status</option>
          <option value="open">Open</option>
          <option value="fixed">Fixed</option>
          <option value="ignored">Ignored</option>
        </Select>
        <Select aria-label="Severity" value={filters.severity} onChange={(e) => set('severity', e.target.value)} className="w-36">
          <option value="">Any severity</option>
          {['critical', 'high', 'medium', 'low'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
        <Select aria-label="Category" value={filters.category} onChange={(e) => set('category', e.target.value)} className="w-36">
          <option value="">Any category</option>
          {['functional', 'api', 'visual'].map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </Select>
      </div>
      <ErrorBox error={error} />
      {loading && !data ? (
        <PageLoader />
      ) : !data?.bugs.length ? (
        <Empty title="No bugs match these filters" icon="bug">
          Run AI QA on a project, or change the filters.
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-ink-700 bg-ink-900">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="text-left text-xs text-ink-400">
              <tr>
                <th className="px-4 py-2 font-medium">Severity</th>
                <th className="px-4 py-2 font-medium">Bug</th>
                <th className="px-4 py-2 font-medium">Category</th>
                <th className="px-4 py-2 font-medium">Project</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Seen</th>
                <th className="px-4 py-2 font-medium">Updated</th>
              </tr>
            </thead>
            <tbody>
              {data.bugs.map((b) => (
                <tr key={b._id} className="border-t border-ink-700 hover:bg-ink-850">
                  <td className="px-4 py-3">
                    <SeverityBadge severity={b.severity} />
                  </td>
                  <td className="max-w-md px-4 py-3">
                    <Link to={`/bugs/${b._id}`} className="font-medium hover:text-accent-300">
                      {b.title}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <CategoryBadge category={b.category} />
                  </td>
                  <td className="px-4 py-3 text-ink-300">{b.projectName}</td>
                  <td className="px-4 py-3">
                    <StatusBadge status={b.status} />
                  </td>
                  <td className="px-4 py-3 tabular-nums text-ink-300">{b.occurrences}×</td>
                  <td className="px-4 py-3 text-ink-400">{timeAgo(b.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
