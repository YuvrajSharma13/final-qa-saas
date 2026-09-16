import { Link } from 'react-router-dom';
import { Empty, ErrorBox, LinkButton, PageHeader, PageLoader, ScoreRing, StatusBadge } from '../components/ui';
import { useApi, type Project } from '../lib/api';
import { useAuth } from '../lib/auth';
import { timeAgo } from '../lib/format';

export default function Projects() {
  const { workspace } = useAuth();
  const { data, error, loading } = useApi<{ projects: Project[] }>(`/projects?ws=${workspace?.id}`);
  if (loading) return <PageLoader />;
  return (
    <div>
      <PageHeader
        title="Projects"
        subtitle="Each project is one application under test."
        actions={
          <LinkButton to="/projects/new" variant="primary" icon="plus">
            New project
          </LinkButton>
        }
      />
      <ErrorBox error={error} />
      {data && !data.projects.length && (
        <Empty title="No projects yet" icon="folder" action={<LinkButton to="/projects/new" variant="primary" icon="plus">Create project</LinkButton>}>
          Create a project with your application URL to start testing.
        </Empty>
      )}
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {data?.projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="group rounded-xl border border-ink-700 bg-ink-900 p-5 transition hover:border-ink-600">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <h2 className="truncate font-semibold group-hover:text-accent-300">{p.name}</h2>
                <p className="truncate font-mono text-xs text-ink-400">{p.appUrl}</p>
                {p.repoUrl && <p className="mt-1 truncate font-mono text-xs text-ink-400">repo: {p.repoUrl}</p>}
              </div>
              <ScoreRing score={p.lastRun?.qaScore ?? null} size={52} />
            </div>
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                {p.lastRun?.status ? <StatusBadge status={p.lastRun.status} /> : <span className="text-ink-400">No runs yet</span>}
                <span className="text-xs text-ink-400">{p.lastRun?.at && timeAgo(p.lastRun.at)}</span>
              </span>
              <span className={p.openBugs ? 'text-amber-200' : 'text-ink-400'}>{p.openBugs} open bugs</span>
            </div>
          </Link>
        ))}
      </div>
    </div>
  );
}
