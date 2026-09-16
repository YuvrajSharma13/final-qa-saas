import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AGENT_ICON, Icon } from '../components/icons';
import { Button, Card, cx, ErrorBox, Field, Input, PageHeader, PageLoader, Toggle } from '../components/ui';
import { api, useApi, type Project } from '../lib/api';
import { AGENT_META } from '../lib/format';

interface Billing {
  plan: { id: string; name: string; viewports: string[]; repoAnalysis: boolean; maxPages: number; runsPerMonth: number };
  usage: { runs: number };
}

const VPS = [
  { id: 'desktop', label: 'Desktop', size: '1440×900' },
  { id: 'tablet', label: 'Tablet', size: '768×1024' },
  { id: 'mobile', label: 'Mobile', size: '375×812' },
];

export default function RunConfig() {
  const { id } = useParams();
  const nav = useNavigate();
  const { data, error } = useApi<{ project: Project }>(`/projects/${id}`);
  const { data: billing } = useApi<Billing>('/billing');
  const [agents, setAgents] = useState({ functional: true, api: true, vision: true, code: true });
  const [viewports, setViewports] = useState<string[]>(['desktop', 'mobile']);
  const [maxPages, setMaxPages] = useState(8);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Error | null>(null);

  useEffect(() => {
    if (!data) return;
    const s = data.project.settings;
    if (s.agents) setAgents(s.agents);
    if (s.viewports) setViewports(s.viewports);
    if (s.maxPages) setMaxPages(s.maxPages);
  }, [data]);

  if (error) return <ErrorBox error={error} />;
  if (!data || !billing) return <PageLoader />;
  const p = data.project;
  const plan = billing.plan;
  const remaining = plan.runsPerMonth - billing.usage.runs;

  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const { run } = await api<{ run: { id: string } }>(`/projects/${p.id}/runs`, { method: 'POST', body: { agents, viewports, maxPages } });
      nav(`/runs/${run.id}`);
    } catch (e) {
      setErr(e as Error);
      setBusy(false);
    }
  };

  const agentRows: { key: keyof typeof agents; type: string; disabled?: boolean; note?: string }[] = [
    { key: 'functional', type: 'functional_qa' },
    { key: 'api', type: 'api_qa', note: p.settings.apiSpecUrl ? `Spec: ${p.settings.apiSpecUrl}` : 'No spec configured — endpoints are auto-discovered' },
    { key: 'vision', type: 'vision_qa' },
    {
      key: 'code',
      type: 'code_analysis',
      disabled: !plan.repoAnalysis || !p.repoUrl,
      note: !plan.repoAnalysis ? `Not included in the ${plan.name} plan` : !p.repoUrl ? 'Connect a repository in settings' : p.repoUrl,
    },
  ];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader crumbs={[{ to: '/projects', label: 'Projects' }, { to: `/projects/${p.id}`, label: p.name }, { label: 'Run' }]} title="Start AI QA" subtitle={<span className="font-mono">{p.appUrl}</span>} />
      <ErrorBox error={err} />
      <Card title="Agents" subtitle="The Test Planner, Bug Analyzer and Regression agent always run.">
        <div className="grid gap-2">
          {agentRows.map((r) => (
            <div key={r.key} className="flex items-center gap-3">
              <div className="flex-1">
                <Toggle
                  checked={agents[r.key] && !r.disabled}
                  disabled={r.disabled}
                  onChange={(v) => setAgents({ ...agents, [r.key]: v })}
                  label={AGENT_META[r.type].name}
                  description={`${AGENT_META[r.type].role}${r.note ? ` · ${r.note}` : ''}`}
                />
              </div>
              <Icon name={AGENT_ICON[r.type]} className="hidden text-ink-400 sm:block" size={18} />
            </div>
          ))}
        </div>
      </Card>

      <Card title="Viewports for Vision QA">
        <div className="grid gap-2 sm:grid-cols-3">
          {VPS.map((v) => {
            const locked = !plan.viewports.includes(v.id);
            const on = viewports.includes(v.id) && !locked;
            return (
              <button
                key={v.id}
                type="button"
                aria-pressed={on}
                disabled={locked}
                onClick={() => setViewports(on ? viewports.filter((x) => x !== v.id) : [...viewports, v.id])}
                className={cx('rounded-lg border p-3 text-left text-sm', on ? 'border-accent-400 bg-accent-400/10' : 'border-ink-600 bg-ink-850', locked && 'cursor-not-allowed opacity-50')}
              >
                <div className="font-medium">{v.label}</div>
                <div className="font-mono text-xs text-ink-400">{v.size}</div>
                {locked && <div className="mt-1 text-xs">Upgrade to Pro</div>}
              </button>
            );
          })}
        </div>
        <div className="mt-4 max-w-xs">
          <Field label="Max pages to explore" htmlFor="max-pages" hint={`Your plan allows up to ${plan.maxPages}.`}>
            <Input id="max-pages" type="number" min={1} max={plan.maxPages} value={maxPages} onChange={(e) => setMaxPages(Math.max(1, Math.min(plan.maxPages, Number(e.target.value) || 1)))} />
          </Field>
        </div>
      </Card>

      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-700 bg-ink-900 p-4">
        <div className="text-sm text-ink-300">
          {remaining} of {plan.runsPerMonth} runs left this period on the {plan.name} plan.{' '}
          <Link to="/billing" className="text-accent-300 hover:underline">
            Usage
          </Link>
        </div>
        <Button variant="primary" icon="play" loading={busy} disabled={remaining <= 0 || viewports.length === 0} onClick={start}>
          Start AI QA
        </Button>
      </div>
    </div>
  );
}
