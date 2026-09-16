import { useState } from 'react';
import { Icon } from '../components/icons';
import { Badge, Button, Card, cx, ErrorBox, PageHeader, PageLoader } from '../components/ui';
import { api, useApi } from '../lib/api';
import { useAuth } from '../lib/auth';
import { dateTime } from '../lib/format';

interface Plan {
  id: string;
  name: string;
  priceLabel: string;
  maxProjects: number;
  runsPerMonth: number;
  maxMembers: number;
  features: string[];
}
interface BillingData {
  plan: Plan;
  plans: Plan[];
  usage: { runs: number; projects: number; members: number; aiCalls: number; browserSeconds: number; checks: number; periodStart: string; periodEnd: string };
  billing: { status: string; provider: string; renewsAt?: string };
  testMode: boolean;
}

function Meter({ label, used, limit, unit }: { label: string; used: number; limit?: number; unit?: string }) {
  const pct = limit ? Math.min(100, Math.round((used / limit) * 100)) : 0;
  return (
    <div>
      <div className="flex items-baseline justify-between text-sm">
        <span className="text-ink-300">{label}</span>
        <span className="tabular-nums">
          {used.toLocaleString()}
          {limit !== undefined && <span className="text-ink-400"> / {limit.toLocaleString()}</span>} {unit}
        </span>
      </div>
      {limit !== undefined && (
        <div className="mt-1.5 h-2 rounded-full bg-ink-800" role="meter" aria-valuenow={used} aria-valuemax={limit} aria-label={label}>
          <div className={cx('h-2 rounded-full', pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-400' : 'bg-accent-400')} style={{ width: `${Math.max(pct, used ? 2 : 0)}%` }} />
        </div>
      )}
    </div>
  );
}

export default function Billing() {
  const { workspace, can, refresh } = useAuth();
  const { data, error, loading, reload } = useApi<BillingData>(`/billing?ws=${workspace?.id}`);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState<Error | null>(null);
  const [msg, setMsg] = useState('');
  if (loading && !data) return <PageLoader />;
  if (error) return <ErrorBox error={error} />;
  if (!data) return null;
  const u = data.usage;

  const change = async (plan: string) => {
    setBusy(plan);
    setErr(null);
    setMsg('');
    try {
      const r = await api<{ message: string }>('/billing/plan', { method: 'POST', body: { plan } });
      setMsg(r.message);
      await refresh();
      reload();
    } catch (e) {
      setErr(e as Error);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader title="Billing & usage" subtitle={`${workspace?.name} · usage period ${dateTime(u.periodStart)} – ${dateTime(u.periodEnd)}`} />
      {data.testMode && (
        <div className="flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-sm text-amber-100">
          <Icon name="alert" className="mt-0.5 shrink-0" /> Billing is in test mode: plan changes apply immediately and no payment is collected. Connect a payment provider before going live.
        </div>
      )}
      <ErrorBox error={err} />
      {msg && (
        <div role="status" className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-200">
          {msg}
        </div>
      )}
      <div className="grid gap-6 lg:grid-cols-[1fr_2fr]">
        <Card title="Current plan">
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold">{data.plan.name}</span>
            <Badge className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">{data.billing?.status || 'active'}</Badge>
          </div>
          <div className="mt-1 text-sm text-ink-400">
            {data.plan.priceLabel}
            {data.billing?.renewsAt && ` · renews ${dateTime(data.billing.renewsAt)}`}
          </div>
          <div className="mt-5 space-y-4">
            <Meter label="QA runs this period" used={u.runs} limit={data.plan.runsPerMonth} />
            <Meter label="Active projects" used={u.projects} limit={data.plan.maxProjects} />
            <Meter label="Team members" used={u.members} limit={data.plan.maxMembers} />
            <Meter label="Checks executed" used={u.checks} />
            <Meter label="Browser time" used={Math.round(u.browserSeconds / 60)} unit="min" />
            <Meter label="AI model calls" used={u.aiCalls} />
          </div>
        </Card>
        <div className="grid gap-4 md:grid-cols-3">
          {data.plans.map((p) => {
            const current = p.id === data.plan.id;
            return (
              <div key={p.id} className={cx('flex flex-col rounded-xl border p-5', current ? 'border-accent-400/60 bg-accent-400/5' : 'border-ink-700 bg-ink-900')}>
                <div className="flex items-center justify-between">
                  <h3 className="font-semibold">{p.name}</h3>
                  {current && <Badge className="bg-accent-400/15 text-accent-300 ring-accent-400/30">current</Badge>}
                </div>
                <div className="mt-2 text-2xl font-semibold">{p.priceLabel}</div>
                <ul className="mt-4 flex-1 space-y-2 text-sm text-ink-300">
                  {p.features.map((f) => (
                    <li key={f} className="flex gap-2">
                      <Icon name="check" className="mt-0.5 shrink-0 text-accent-300" /> {f}
                    </li>
                  ))}
                </ul>
                {!current && can('owner') && (
                  <Button className="mt-5" variant={p.id === 'free' ? 'secondary' : 'primary'} loading={busy === p.id} onClick={() => change(p.id)}>
                    {p.id === 'free' ? 'Downgrade' : `Switch to ${p.name}`}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
