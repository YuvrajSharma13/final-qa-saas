import { useEffect, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Badge, Button, Card, cx, Empty, ErrorBox, Field, Input, LinkButton, PageHeader, PageLoader, Select, Toggle } from '../components/ui';
import { GithubConnectionPanel, RepoLinker } from '../components/github';
import { Icon } from '../components/icons';
import { api, shotUrl, useApi, type GithubConnection, type Project, type Screenshot } from '../lib/api';
import { useAuth } from '../lib/auth';

function Saved({ msg }: { msg: string }) {
  return msg ? (
    <span role="status" className="text-sm text-emerald-300">
      {msg}
    </span>
  ) : null;
}

function useSaver() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  const run = async (fn: () => Promise<unknown>, ok = 'Saved') => {
    setBusy(true);
    setError(null);
    setMsg('');
    try {
      await fn();
      setMsg(ok);
      setTimeout(() => setMsg(''), 2500);
      return true;
    } catch (e) {
      setError(e as Error);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, msg, run };
}

function Section({ title, subtitle, children, footer }: { title: string; subtitle?: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <Card title={title} subtitle={subtitle}>
      <div className="space-y-4">{children}</div>
      {footer && <div className="mt-4 flex flex-wrap items-center justify-end gap-3 border-t border-ink-700 pt-4">{footer}</div>}
    </Card>
  );
}

function ProjectSettings({ project, onChange }: { project: Project; onChange: () => void }) {
  const nav = useNavigate();
  const { workspace, can } = useAuth();
  const s = project.settings;
  const [f, setF] = useState({
    name: project.name,
    appUrl: project.appUrl,
    repoUrl: project.repoUrl || '',
    apiSpecUrl: s.apiSpecUrl || '',
    apiBaseUrl: s.apiBaseUrl || '',
    testUsername: s.testUsername || '',
    testPassword: '',
    githubToken: '',
  });
  const [agents, setAgents] = useState(s.agents || { functional: true, api: true, vision: true, code: true });
  const [viewports, setViewports] = useState(s.viewports || ['desktop', 'mobile']);
  const [maxPages, setMaxPages] = useState(s.maxPages || 8);
  const [notify, setNotify] = useState(s.notifyOnCritical !== false);
  const general = useSaver();
  const integ = useSaver();
  const account = useSaver();
  const defaults = useSaver();
  const danger = useSaver();
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const patch = (body: unknown) => api(`/projects/${project.id}`, { method: 'PATCH', body }).then(onChange);
  const editable = can('developer');

  return (
    <div className="space-y-6">
      <Section title="Project" footer={editable && <><Saved msg={general.msg} /><Button variant="primary" loading={general.busy} onClick={() => general.run(() => patch({ name: f.name, appUrl: f.appUrl }))}>Save</Button></>}>
        <ErrorBox error={general.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="s-name">
            <Input id="s-name" value={f.name} onChange={set('name')} />
          </Field>
          <Field label="Application URL" htmlFor="s-url">
            <Input id="s-url" className="font-mono" value={f.appUrl} onChange={set('appUrl')} />
          </Field>
        </div>
      </Section>

      <Section
        title="API & repository configuration"
        subtitle="To pick a repository/branch and enable AI fix PRs, use the GitHub tab. Tokens here are write-only and encrypted at rest."
        footer={
          editable && (
            <>
              <Saved msg={integ.msg} />
              <Button
                variant="primary"
                loading={integ.busy}
                onClick={() =>
                  integ.run(async () => {
                    await patch({ repoUrl: f.repoUrl, settings: { apiSpecUrl: f.apiSpecUrl, apiBaseUrl: f.apiBaseUrl, ...(f.githubToken ? { githubToken: f.githubToken } : {}) } });
                    setF((x) => ({ ...x, githubToken: '' }));
                  })
                }
              >
                Save integrations
              </Button>
            </>
          )
        }
      >
        <ErrorBox error={integ.error} />
        <Field label="GitHub repository" htmlFor="s-repo" hint={workspace?.plan === 'free' ? 'Repository analysis requires the Pro plan.' : 'Read by the Code Analysis agent (never modified).'}>
          <Input id="s-repo" className="font-mono" value={f.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/owner/repo" />
        </Field>
        <Field
          label="GitHub token"
          htmlFor="s-token"
          hint={
            <span className="flex flex-wrap items-center gap-2">
              {s.hasGithubToken ? <Badge className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">configured</Badge> : <Badge>not set</Badge>}
              {s.hasGithubToken && editable && (
                <button className="text-red-300 hover:underline" onClick={() => integ.run(() => patch({ settings: { githubToken: null } }), 'Token removed')}>
                  Remove token
                </button>
              )}
            </span>
          }
        >
          <Input id="s-token" type="password" autoComplete="off" value={f.githubToken} onChange={set('githubToken')} placeholder={s.hasGithubToken ? '•••••••• (enter a new token to replace)' : 'github_pat_…'} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="OpenAPI spec URL" htmlFor="s-spec" hint="Relative paths resolve against the app URL.">
            <Input id="s-spec" className="font-mono" value={f.apiSpecUrl} onChange={set('apiSpecUrl')} placeholder="/openapi.json" />
          </Field>
          <Field label="API base URL" htmlFor="s-base" hint="Leave empty when the API is served from the app origin.">
            <Input id="s-base" className="font-mono" value={f.apiBaseUrl} onChange={set('apiBaseUrl')} placeholder="https://api.staging.example.com" />
          </Field>
        </div>
      </Section>

      <Section
        title="Test account"
        subtitle="Used by the Functional agent to verify a successful login."
        footer={
          editable && (
            <>
              <Saved msg={account.msg} />
              {s.hasTestPassword && (
                <Button variant="ghost" onClick={() => account.run(() => patch({ settings: { testUsername: '', testPassword: null } }), 'Test account removed')}>
                  Remove
                </Button>
              )}
              <Button
                variant="primary"
                loading={account.busy}
                onClick={() => account.run(() => patch({ settings: { testUsername: f.testUsername, ...(f.testPassword ? { testPassword: f.testPassword } : {}) } }))}
              >
                Save account
              </Button>
            </>
          )
        }
      >
        <ErrorBox error={account.error} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Username / email" htmlFor="s-tu">
            <Input id="s-tu" autoComplete="off" value={f.testUsername} onChange={set('testUsername')} />
          </Field>
          <Field label="Password" htmlFor="s-tp" hint={s.hasTestPassword ? 'A password is stored. Enter a new one to replace it.' : undefined}>
            <Input id="s-tp" type="password" autoComplete="new-password" value={f.testPassword} onChange={set('testPassword')} />
          </Field>
        </div>
      </Section>

      <Section
        title="Run defaults & notifications"
        footer={
          editable && (
            <>
              <Saved msg={defaults.msg} />
              <Button variant="primary" loading={defaults.busy} onClick={() => defaults.run(() => patch({ settings: { agents, viewports, maxPages, notifyOnCritical: notify } }))}>
                Save defaults
              </Button>
            </>
          )
        }
      >
        <ErrorBox error={defaults.error} />
        <div className="grid gap-2 sm:grid-cols-2">
          {(['functional', 'api', 'vision', 'code'] as const).map((k) => (
            <Toggle key={k} checked={agents[k]} onChange={(v) => setAgents({ ...agents, [k]: v })} label={`${k === 'code' ? 'Code analysis' : k === 'api' ? 'API QA' : k === 'vision' ? 'Vision QA' : 'Functional QA'} agent`} />
          ))}
        </div>
        <div className="flex flex-wrap gap-2">
          {['desktop', 'tablet', 'mobile'].map((v) => (
            <button
              key={v}
              aria-pressed={viewports.includes(v)}
              onClick={() => setViewports(viewports.includes(v) ? viewports.filter((x) => x !== v) : [...viewports, v])}
              className={cx('rounded-lg border px-3 py-1.5 text-sm', viewports.includes(v) ? 'border-accent-400 bg-accent-400/10' : 'border-ink-600')}
            >
              {v}
            </button>
          ))}
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Max pages" htmlFor="s-mp">
            <Input id="s-mp" type="number" min={1} max={25} value={maxPages} onChange={(e) => setMaxPages(Number(e.target.value) || 1)} />
          </Field>
        </div>
        <Toggle checked={notify} onChange={setNotify} label="Alert me when a run finds critical bugs" description="In-app notification for every member; email on paid plans when SMTP is configured." />
      </Section>

      <References project={project} editable={editable} />

      {can('admin') && (
        <Section title="Danger zone">
          <ErrorBox error={danger.error} />
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm text-ink-300">Archiving stops runs and frees a project slot. History is kept.</p>
            <Button
              variant="danger"
              loading={danger.busy}
              onClick={async () => {
                if (!window.confirm(`Archive ${project.name}?`)) return;
                if (await danger.run(() => api(`/projects/${project.id}`, { method: 'DELETE' }))) nav('/projects');
              }}
            >
              Archive project
            </Button>
          </div>
        </Section>
      )}
    </div>
  );
}

function References({ project, editable }: { project: Project; editable: boolean }) {
  const { data, reload } = useApi<{ baselines: Screenshot[] }>(`/projects/${project.id}`);
  const [pagePath, setPagePath] = useState('/');
  const [viewport, setViewport] = useState('mobile');
  const [file, setFile] = useState<File | null>(null);
  const saver = useSaver();
  const upload = () =>
    saver.run(async () => {
      if (!file) throw new Error('Choose a PNG or JPEG mockup first');
      const b64 = await new Promise<string>((res, rej) => {
        const r = new FileReader();
        r.onload = () => res(String(r.result));
        r.onerror = rej;
        r.readAsDataURL(file);
      });
      await api(`/projects/${project.id}/references`, { method: 'POST', body: { pagePath, viewport, imageBase64: b64 } });
      setFile(null);
      reload();
    }, 'Reference uploaded');
  const list = data?.baselines || [];
  return (
    <Section title="Visual references & baselines" subtitle="Vision QA compares each capture with the reference mockup (or the approved baseline) for the same page and viewport.">
      <ErrorBox error={saver.error} />
      {list.length ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {list.map((s) => (
            <figure key={s._id} className="overflow-hidden rounded-lg border border-ink-700">
              <img src={shotUrl(s._id)} alt={`${s.kind} for ${s.pagePath}`} className="h-32 w-full object-cover object-top" />
              <figcaption className="flex items-center justify-between gap-2 px-3 py-2 text-xs">
                <span className="font-mono">
                  {s.pagePath} · {s.viewport?.name}
                </span>
                <span className="flex items-center gap-2">
                  <Badge>{s.kind === 'reference' ? 'mockup' : 'baseline'}</Badge>
                  {editable && (
                    <button className="text-red-300 hover:underline" onClick={() => saver.run(async () => { await api(`/projects/${project.id}/references/${s._id}`, { method: 'DELETE' }); reload(); }, 'Removed')}>
                      Remove
                    </button>
                  )}
                </span>
              </figcaption>
            </figure>
          ))}
        </div>
      ) : (
        <Empty title="No references yet" icon="image">
          Upload a mockup below, or mark a clean capture as the baseline from a run’s Screenshots tab.
        </Empty>
      )}
      {editable && (
        <div className="grid items-end gap-3 sm:grid-cols-[1fr_140px_1fr_auto]">
          <Field label="Page path" htmlFor="r-path">
            <Input id="r-path" className="font-mono" value={pagePath} onChange={(e) => setPagePath(e.target.value)} />
          </Field>
          <Field label="Viewport" htmlFor="r-vp">
            <Select id="r-vp" value={viewport} onChange={(e) => setViewport(e.target.value)}>
              <option value="desktop">desktop</option>
              <option value="tablet">tablet</option>
              <option value="mobile">mobile</option>
            </Select>
          </Field>
          <Field label="Mockup image" htmlFor="r-file">
            <Input id="r-file" type="file" accept="image/png,image/jpeg" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </Field>
          <div className="flex items-center gap-2">
            <Saved msg={saver.msg} />
            <Button variant="primary" loading={saver.busy} onClick={upload}>
              Upload
            </Button>
          </div>
        </div>
      )}
    </Section>
  );
}

interface WsData {
  workspace: { id: string; name: string; plan: string; role: string };
  members: { id: string; userId: string; role: string; name: string; email: string }[];
}

function WorkspaceSettings() {
  const { can, refresh, user } = useAuth();
  const { data, reload } = useApi<WsData>('/workspaces/current');
  const [name, setName] = useState('');
  const [invite, setInvite] = useState({ email: '', role: 'developer' });
  const ws = useSaver();
  const team = useSaver();
  useEffect(() => {
    if (data) setName(data.workspace.name);
  }, [data]);
  if (!data) return <PageLoader />;
  return (
    <div className="space-y-6">
      <Section
        title="Workspace"
        footer={
          can('admin') && (
            <>
              <Saved msg={ws.msg} />
              <Button variant="primary" loading={ws.busy} onClick={() => ws.run(async () => { await api('/workspaces/current', { method: 'PATCH', body: { name } }); await refresh(); })}>
                Save
              </Button>
            </>
          )
        }
      >
        <ErrorBox error={ws.error} />
        <Field label="Workspace name" htmlFor="w-name">
          <Input id="w-name" value={name} disabled={!can('admin')} onChange={(e) => setName(e.target.value)} />
        </Field>
      </Section>
      <Section title="Team members" subtitle="Owners manage billing; admins manage settings and members; developers run QA and triage bugs; viewers are read-only.">
        <ErrorBox error={team.error} />
        <ul className="divide-y divide-ink-700 rounded-lg border border-ink-700">
          {data.members.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2.5 text-sm">
              <div>
                <div className="font-medium">
                  {m.name} {m.userId === user?.id && <span className="text-xs text-ink-400">(you)</span>}
                </div>
                <div className="text-xs text-ink-400">{m.email}</div>
              </div>
              <div className="flex items-center gap-3">
                <Badge>{m.role}</Badge>
                {can('admin') && m.role !== 'owner' && (
                  <button className="text-xs text-red-300 hover:underline" onClick={() => team.run(async () => { await api(`/workspaces/current/members/${m.id}`, { method: 'DELETE' }); reload(); }, 'Member removed')}>
                    Remove
                  </button>
                )}
              </div>
            </li>
          ))}
        </ul>
        {can('admin') && (
          <div className="grid items-end gap-3 sm:grid-cols-[1fr_160px_auto]">
            <Field label="Invite by email" htmlFor="i-email" hint="The person needs an account already.">
              <Input id="i-email" type="email" value={invite.email} onChange={(e) => setInvite({ ...invite, email: e.target.value })} />
            </Field>
            <Field label="Role" htmlFor="i-role">
              <Select id="i-role" value={invite.role} onChange={(e) => setInvite({ ...invite, role: e.target.value })}>
                <option value="admin">admin</option>
                <option value="developer">developer</option>
                <option value="viewer">viewer</option>
              </Select>
            </Field>
            <div className="flex items-center gap-2 pb-5">
              <Saved msg={team.msg} />
              <Button variant="primary" loading={team.busy} onClick={() => team.run(async () => { await api('/workspaces/current/members', { method: 'POST', body: invite }); setInvite({ email: '', role: 'developer' }); reload(); }, 'Member added')}>
                Add member
              </Button>
            </div>
          </div>
        )}
      </Section>
    </div>
  );
}

function GithubSettings({ projects, projectId, project, onProject, onLinked }: { projects: Project[]; projectId: string; project?: Project; onProject: (id: string) => void; onLinked: () => void }) {
  const { data, reload } = useApi<{ connection: GithubConnection }>('/github/status');
  const connected = Boolean(data?.connection.connected);
  return (
    <div className="space-y-6">
      <Section title="GitHub account" subtitle="Used to list repositories, create ai-fix branches, push approved commits and open pull requests. The token is encrypted server-side and never sent to the browser.">
        <GithubConnectionPanel onChange={reload} />
      </Section>
      <Section title="Repository & branch" subtitle="Pick the repository and the base branch that AI fix pull requests should target. Code Analysis also reads this branch.">
        {projects.length ? (
          <>
            <div className="max-w-xs">
              <Field label="Project" htmlFor="gh-proj">
                <Select id="gh-proj" value={projectId} onChange={(e) => onProject(e.target.value)}>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </Select>
              </Field>
            </div>
            {project ? <RepoLinker key={project.id} project={project} connected={connected} onLinked={onLinked} /> : <PageLoader />}
          </>
        ) : (
          <Empty title="Create a project first" icon="folder" />
        )}
      </Section>
      <Section title="Safety rules" subtitle="Enforced server-side for every AI fix">
        <ul className="grid gap-2 text-sm text-ink-300 sm:grid-cols-2">
          {[
            'Only ai-fix/* branches are ever pushed — never main, master or the base branch',
            'You see the exact diff (sha256-pinned) before anything is applied',
            'Commit & push happen only after your explicit approval',
            'Only existing files are edited; lockfiles, CI config and secrets are off-limits',
            'Tests, lint and build run before the PR; failures go back to the AI and need re-approval',
            'Validation runs with a scrubbed environment — no tokens or API keys',
          ].map((t) => (
            <li key={t} className="flex gap-2">
              <Icon name="shield" className="mt-0.5 shrink-0 text-accent-300" />
              {t}
            </li>
          ))}
        </ul>
      </Section>
    </div>
  );
}

export default function Settings() {
  const [params, setParams] = useSearchParams();
  const { workspace } = useAuth();
  const { data, error, loading } = useApi<{ projects: Project[] }>(`/projects?ws=${workspace?.id}`);
  const projectId = params.get('project') || data?.projects[0]?.id || '';
  const tab = params.get('tab') || 'project';
  const { data: pd, reload } = useApi<{ project: Project }>(projectId && (tab === 'project' || tab === 'github') ? `/projects/${projectId}` : null);
  const ghError = params.get('githubError');
  const ghConnected = params.get('github') === 'connected';

  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Settings"
        subtitle="GitHub/API configuration, project settings and team."
        actions={
          <div className="flex rounded-lg border border-ink-600 p-0.5 text-sm">
            {[
              ['project', 'Project'],
              ['github', 'GitHub'],
              ['workspace', 'Workspace & team'],
            ].map(([id, label]) => (
              <button key={id} onClick={() => setParams({ tab: id, ...(projectId ? { project: projectId } : {}) })} className={cx('rounded-md px-3 py-1.5', tab === id ? 'bg-ink-700' : 'text-ink-300')}>
                {label}
              </button>
            ))}
          </div>
        }
      />
      <ErrorBox error={error || (ghError ? { message: `GitHub: ${ghError}` } : null)} />
      {ghConnected && (
        <div role="status" className="mb-4 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          GitHub account connected.
        </div>
      )}
      {tab === 'workspace' ? (
        <WorkspaceSettings />
      ) : tab === 'github' ? (
        <GithubSettings projects={data?.projects || []} projectId={projectId} project={pd?.project} onProject={(id) => setParams({ tab: 'github', project: id })} onLinked={reload} />
      ) : loading ? (
        <PageLoader />
      ) : !data?.projects.length ? (
        <Empty title="No projects yet" icon="folder" action={<LinkButton to="/projects/new" variant="primary">New project</LinkButton>} />
      ) : (
        <>
          <div className="mb-4 max-w-xs">
            <Field label="Project" htmlFor="proj-select">
              <Select id="proj-select" value={projectId} onChange={(e) => setParams({ tab: 'project', project: e.target.value })}>
                {data.projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {pd ? <ProjectSettings key={pd.project.id} project={pd.project} onChange={reload} /> : <PageLoader />}
        </>
      )}
    </div>
  );
}
