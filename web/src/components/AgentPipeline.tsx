import type { AgentRun } from '../lib/api';
import { AGENT_META, duration } from '../lib/format';
import { AGENT_ICON, Icon } from './icons';
import { cx } from './ui';

const STATE: Record<string, string> = {
  pending: 'border-ink-700 bg-ink-900 text-ink-400',
  running: 'border-accent-400/60 bg-accent-400/10 text-ink-100 pulse-ring',
  completed: 'border-emerald-500/40 bg-emerald-500/5 text-ink-100',
  failed: 'border-red-500/50 bg-red-500/10 text-ink-100',
  skipped: 'border-ink-700 bg-ink-900 text-ink-400 opacity-70',
};

function Node({ a, onSelect, selected }: { a?: AgentRun; type: string; onSelect?: (t: string) => void; selected?: boolean }) {
  if (!a) return null;
  const meta = AGENT_META[a.agentType];
  return (
    <button
      onClick={() => onSelect?.(a.agentType)}
      className={cx('w-full min-w-0 rounded-lg border px-3 py-2.5 text-left transition hover:border-accent-400/60', STATE[a.status], selected && 'ring-2 ring-accent-400')}
      title={meta.role}
    >
      <div className="flex items-center gap-2">
        <Icon name={AGENT_ICON[a.agentType]} size={15} className={a.status === 'running' ? 'text-accent-300' : ''} />
        <span className="truncate text-sm font-medium">{meta.name}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-ink-400">
        <span className="capitalize">{a.status === 'completed' && a.engine?.includes('llm') ? 'completed · AI' : a.status}</span>
        {a.durationMs ? <span className="tabular-nums">{duration(a.durationMs)}</span> : null}
      </div>
    </button>
  );
}

const Arrow = ({ vertical }: { vertical?: boolean }) => (
  <div className={cx('flex items-center justify-center text-ink-600', vertical ? 'py-1' : 'px-1')} aria-hidden="true">
    <svg width={vertical ? 12 : 18} height={vertical ? 14 : 12} viewBox={vertical ? '0 0 12 14' : '0 0 18 12'}>
      {vertical ? <path d="M6 0v12M1 8l5 5 5-5" stroke="currentColor" strokeWidth="1.5" fill="none" /> : <path d="M0 6h16M11 1l5 5-5 5" stroke="currentColor" strokeWidth="1.5" fill="none" />}
    </svg>
  </div>
);

/** Planner → (Functional ∥ API ∥ Vision) → Analyzer → Code → Regression */
export function AgentPipeline({ agents, selected, onSelect }: { agents: AgentRun[]; selected?: string; onSelect?: (t: string) => void }) {
  const by = (t: string) => agents.find((a) => a.agentType === t);
  const node = (t: string) => <Node a={by(t)} type={t} onSelect={onSelect} selected={selected === t} />;
  return (
    <div className="flex flex-col items-stretch gap-0 lg:flex-row lg:items-center">
      <div className="lg:w-40">{node('test_planner')}</div>
      <div className="hidden lg:block"><Arrow /></div>
      <div className="lg:hidden"><Arrow vertical /></div>
      <div className="grid grid-cols-1 gap-2 rounded-xl border border-dashed border-ink-700 p-2 sm:grid-cols-3 lg:w-auto lg:flex-1 lg:grid-cols-1 xl:grid-cols-1">
        {node('functional_qa')}
        {node('api_qa')}
        {node('vision_qa')}
      </div>
      <div className="hidden lg:block"><Arrow /></div>
      <div className="lg:hidden"><Arrow vertical /></div>
      <div className="lg:w-40">{node('bug_analyzer')}</div>
      <div className="hidden lg:block"><Arrow /></div>
      <div className="lg:hidden"><Arrow vertical /></div>
      <div className="lg:w-40">{node('code_analysis')}</div>
      <div className="hidden lg:block"><Arrow /></div>
      <div className="lg:hidden"><Arrow vertical /></div>
      <div className="lg:w-40">{node('regression_test')}</div>
    </div>
  );
}
