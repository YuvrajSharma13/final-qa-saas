import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { Icon } from '../components/icons';
import { Button, Card, cx, ErrorBox, Field, Input, PageHeader } from '../components/ui';
import { api, useApi, type Project } from '../lib/api';
import { useAuth } from '../lib/auth';

const VPS = [
  { id: 'desktop', label: 'Desktop', size: '1440×900' },
  { id: 'tablet', label: 'Tablet', size: '768×1024' },
  { id: 'mobile', label: 'Mobile', size: '375×812' },
];

export default function NewProject() {
  const nav = useNavigate();
  const { workspace } = useAuth();
  const { data: health } = useApi<{ demo: null | { appUrl: string; repoUrl: string; apiSpecUrl: string } }>('/health');
  const paid = workspace?.plan !== 'free';
  const [f, setF] = useState({ name: '', appUrl: '', repoUrl: '', apiSpecUrl: '', githubToken: '', testUsername: '', testPassword: '' });
  const [viewports, setViewports] = useState<string[]>(['desktop', 'mobile']);
  const [error, setError] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });

  const submit = async (e: FormEvent, startRun = false) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const settings: Record<string, unknown> = { viewports };
      if (f.apiSpecUrl) settings.apiSpecUrl = f.apiSpecUrl;
      if (f.githubToken) settings.githubToken = f.githubToken;
      if (f.testUsername) settings.testUsername = f.testUsername;
      if (f.testPassword) settings.testPassword = f.testPassword;
      const { project } = await api<{ project: Project }>('/projects', { method: 'POST', body: { name: f.name, appUrl: f.appUrl, repoUrl: f.repoUrl, settings } });
      if (startRun) {
        const { run } = await api<{ run: { id: string } }>(`/projects/${project.id}/runs`, { method: 'POST', body: {} });
        nav(`/runs/${run.id}`);
      } else nav(`/projects/${project.id}`);
    } catch (err) {
      setError(err as Error);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl">
      <PageHeader title="New QA project" subtitle="One project per application. Secrets are encrypted server-side and never sent back to the browser." crumbs={[{ to: '/projects', label: 'Projects' }, { label: 'New' }]} />
      {health?.demo && (
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent-400/30 bg-accent-400/5 p-4">
          <div className="text-sm">
            <div className="font-medium">Try the QuickBite demo app</div>
            <div className="text-ink-400">A small restaurant ordering site with a few intentional bugs.</div>
          </div>
          <Button
            type="button"
            onClick={() =>
              setF({ ...f, name: 'QuickBite', appUrl: health.demo!.appUrl, repoUrl: health.demo!.repoUrl, apiSpecUrl: health.demo!.apiSpecUrl })
            }
          >
            Fill demo values
          </Button>
        </div>
      )}
      <form onSubmit={(e) => submit(e)} className="space-y-6" noValidate>
        <ErrorBox error={error} />
        <Card title="Application">
          <div className="space-y-4">
            <Field label="Project name" htmlFor="p-name">
              <Input id="p-name" value={f.name} onChange={set('name')} placeholder="Storefront" required />
            </Field>
            <Field label="Application URL" htmlFor="p-url" hint="The Test Planner starts here and explores same-origin pages. Use a staging URL — API checks send write requests.">
              <Input id="p-url" type="url" value={f.appUrl} onChange={set('appUrl')} placeholder="https://staging.example.com" required className="font-mono" />
            </Field>
          </div>
        </Card>

        <Card title="Developer integrations" subtitle="Optional — improves API coverage and root-cause analysis">
          <div className="space-y-4">
            <Field label="OpenAPI / Swagger spec URL" htmlFor="p-spec" hint="Absolute URL or a path relative to the app. If empty, common locations like /openapi.json are auto-discovered.">
              <Input id="p-spec" value={f.apiSpecUrl} onChange={set('apiSpecUrl')} placeholder="/openapi.json" className="font-mono" />
            </Field>
            <Field
              label="GitHub repository"
              htmlFor="p-repo"
              hint={paid ? 'Used by the Code Analysis agent to point to likely files and propose a patch. Read-only.' : 'Repository analysis is part of the Pro plan — you can add the repo now and upgrade later.'}
            >
              <Input id="p-repo" value={f.repoUrl} onChange={set('repoUrl')} placeholder="https://github.com/acme/storefront" className="font-mono" />
            </Field>
            <Field label="GitHub token (private repos)" htmlFor="p-token" hint="Fine-grained, read-only “Contents” permission is enough. Stored encrypted (AES-256-GCM).">
              <Input id="p-token" type="password" autoComplete="off" value={f.githubToken} onChange={set('githubToken')} placeholder="github_pat_…" />
            </Field>
          </div>
        </Card>

        <Card title="Test account" subtitle="Optional — lets the Functional agent verify a successful login too">
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Username / email" htmlFor="p-user">
              <Input id="p-user" autoComplete="off" value={f.testUsername} onChange={set('testUsername')} />
            </Field>
            <Field label="Password" htmlFor="p-pass">
              <Input id="p-pass" type="password" autoComplete="new-password" value={f.testPassword} onChange={set('testPassword')} />
            </Field>
          </div>
        </Card>

        <Card title="Visual QA viewports">
          <div className="grid gap-2 sm:grid-cols-3">
            {VPS.map((v) => {
              const locked = v.id === 'tablet' && !paid;
              const on = viewports.includes(v.id);
              return (
                <button
                  type="button"
                  key={v.id}
                  disabled={locked}
                  aria-pressed={on}
                  onClick={() => setViewports(on ? viewports.filter((x) => x !== v.id) : [...viewports, v.id])}
                  className={cx('rounded-lg border p-3 text-left text-sm transition', on ? 'border-accent-400 bg-accent-400/10' : 'border-ink-600 bg-ink-850', locked && 'cursor-not-allowed opacity-50')}
                >
                  <div className="flex items-center justify-between font-medium">
                    {v.label}
                    {on && <Icon name="check" className="text-accent-300" />}
                  </div>
                  <div className="font-mono text-xs text-ink-400">{v.size}</div>
                  {locked && <div className="mt-1 text-xs text-ink-400">Pro plan</div>}
                </button>
              );
            })}
          </div>
        </Card>

        <div className="flex flex-wrap justify-end gap-2">
          <Button type="submit" loading={busy}>
            Create project
          </Button>
          <Button type="button" variant="primary" icon="play" loading={busy} onClick={(e) => submit(e as unknown as FormEvent, true)}>
            Create & start AI QA
          </Button>
        </div>
      </form>
    </div>
  );
}
