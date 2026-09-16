import { useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { Link } from 'react-router-dom';
import type { Severity } from '../lib/api';
import { Icon, type IconName } from './icons';

export const cx = (...xs: (string | false | null | undefined)[]) => xs.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-accent-400 text-ink-950 hover:bg-accent-300 font-semibold',
  secondary: 'bg-ink-800 text-ink-100 border border-ink-600 hover:bg-ink-700',
  ghost: 'text-ink-300 hover:text-ink-100 hover:bg-ink-800',
  danger: 'bg-red-500/10 text-red-300 border border-red-500/30 hover:bg-red-500/20',
};

export function Button({ variant = 'secondary', icon, loading, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; icon?: IconName; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm transition disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-2 focus-visible:outline-accent-400', VARIANTS[variant], className)}
    >
      {loading ? <Spinner size={14} /> : icon ? <Icon name={icon} size={15} /> : null}
      {children}
    </button>
  );
}

export function LinkButton({ to, variant = 'secondary', icon, children, className }: { to: string; variant?: Variant; icon?: IconName; children: ReactNode; className?: string }) {
  return (
    <Link to={to} className={cx('inline-flex items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm transition', VARIANTS[variant], className)}>
      {icon && <Icon name={icon} size={15} />}
      {children}
    </Link>
  );
}

export function Card({ title, actions, children, className, padded = true, subtitle }: { title?: ReactNode; subtitle?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; padded?: boolean }) {
  return (
    <section className={cx('rounded-xl border border-ink-700 bg-ink-900', className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-4 py-3">
          <div>
            {title && <h2 className="text-sm font-semibold text-ink-100">{title}</h2>}
            {subtitle && <p className="text-xs text-ink-400 mt-0.5">{subtitle}</p>}
          </div>
          {actions && <div className="flex items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? 'p-4' : ''}>{children}</div>
    </section>
  );
}

const SEV: Record<Severity, string> = {
  critical: 'bg-red-500/15 text-red-300 ring-red-500/40',
  high: 'bg-orange-500/15 text-orange-300 ring-orange-500/40',
  medium: 'bg-amber-400/15 text-amber-200 ring-amber-400/40',
  low: 'bg-sky-400/15 text-sky-300 ring-sky-400/40',
};
export const SEV_DOT: Record<Severity, string> = { critical: 'bg-red-500', high: 'bg-orange-500', medium: 'bg-amber-400', low: 'bg-sky-400' };

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
  return <span className={cx('inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium ring-1 ring-inset whitespace-nowrap', className || 'bg-ink-800 text-ink-300 ring-ink-600')}>{children}</span>;
}

export function SeverityBadge({ severity }: { severity: Severity }) {
  return (
    <Badge className={SEV[severity]}>
      <span className={cx('h-1.5 w-1.5 rounded-full', SEV_DOT[severity])} />
      {severity}
    </Badge>
  );
}

const STATUS: Record<string, string> = {
  passed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  passing: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  completed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  fixed: 'bg-emerald-500/15 text-emerald-300 ring-emerald-500/40',
  failed: 'bg-red-500/15 text-red-300 ring-red-500/40',
  failing: 'bg-red-500/15 text-red-300 ring-red-500/40',
  open: 'bg-red-500/15 text-red-300 ring-red-500/40',
  error: 'bg-amber-400/15 text-amber-200 ring-amber-400/40',
  running: 'bg-accent-400/15 text-accent-300 ring-accent-400/40',
  queued: 'bg-ink-700 text-ink-300 ring-ink-600',
  pending: 'bg-ink-800 text-ink-400 ring-ink-600',
  skipped: 'bg-ink-800 text-ink-400 ring-ink-600',
  canceled: 'bg-ink-800 text-ink-400 ring-ink-600',
  ignored: 'bg-ink-800 text-ink-400 ring-ink-600',
  new: 'bg-violet-500/15 text-violet-300 ring-violet-500/40',
  reopened: 'bg-fuchsia-500/15 text-fuchsia-300 ring-fuchsia-500/40',
  seen: 'bg-ink-800 text-ink-300 ring-ink-600',
};

export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return (
    <Badge className={STATUS[status] || STATUS.pending}>
      {status === 'running' && <span className="h-1.5 w-1.5 rounded-full bg-accent-400 animate-pulse" />}
      {label || status}
    </Badge>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  const map: Record<string, [IconName, string]> = {
    functional: ['cursor', 'text-violet-300'],
    api: ['plug', 'text-cyan-300'],
    visual: ['eye', 'text-pink-300'],
    regression: ['repeat', 'text-emerald-300'],
  };
  const [icon, color] = map[category] || ['layers', 'text-ink-300'];
  return (
    <span className={cx('inline-flex items-center gap-1 text-xs font-medium', color)}>
      <Icon name={icon} size={13} />
      {category}
    </span>
  );
}

export function Stat({ label, value, hint, tone, icon }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'good' | 'bad' | 'warn'; icon?: IconName }) {
  const color = tone === 'good' ? 'text-emerald-300' : tone === 'bad' ? 'text-red-300' : tone === 'warn' ? 'text-amber-200' : 'text-ink-100';
  return (
    <div className="rounded-xl border border-ink-700 bg-ink-900 p-4">
      <div className="flex items-center gap-1.5 text-xs text-ink-400">
        {icon && <Icon name={icon} size={13} />}
        {label}
      </div>
      <div className={cx('mt-1.5 text-2xl font-semibold tabular-nums', color)}>{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-400">{hint}</div>}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="animate-spin" aria-label="Loading">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" fill="none" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" fill="none" strokeLinecap="round" />
    </svg>
  );
}

export function PageLoader() {
  return (
    <div className="flex h-64 items-center justify-center text-ink-400">
      <Spinner size={24} />
    </div>
  );
}

export function Empty({ title, children, icon = 'layers', action }: { title: string; children?: ReactNode; icon?: IconName; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed border-ink-600 px-6 py-10 text-center">
      <div className="rounded-full bg-ink-800 p-3 text-ink-300">
        <Icon name={icon} size={20} />
      </div>
      <h3 className="font-medium">{title}</h3>
      {children && <p className="max-w-md text-sm text-ink-400">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorBox({ error }: { error: { message: string } | null | undefined }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200">
      <Icon name="alert" size={16} className="mt-0.5 shrink-0" />
      <span>{error.message}</span>
    </div>
  );
}

export function PageHeader({ title, subtitle, actions, crumbs }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; crumbs?: { to?: string; label: string }[] }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {crumbs && (
          <nav className="mb-1 flex flex-wrap items-center gap-1 text-xs text-ink-400" aria-label="Breadcrumb">
            {crumbs.map((c, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <span className="text-ink-600">/</span>}
                {c.to ? (
                  <Link className="hover:text-ink-100" to={c.to}>
                    {c.label}
                  </Link>
                ) : (
                  <span>{c.label}</span>
                )}
              </span>
            ))}
          </nav>
        )}
        <h1 className="text-xl font-semibold tracking-tight break-words">{title}</h1>
        {subtitle && <div className="mt-1 text-sm text-ink-400">{subtitle}</div>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

const width = (cls?: string) => (cls && /(^|\s)w-/.test(cls) ? '' : 'w-full');
const fieldCls = 'rounded-lg border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-ink-100 placeholder:text-ink-400 focus:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-400/30';

export function Field({ label, hint, children, htmlFor }: { label: string; hint?: ReactNode; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-ink-100">
        {label}
      </label>
      {children}
      {hint && <p className="text-xs text-ink-400">{hint}</p>}
    </div>
  );
}
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(fieldCls, width(p.className), p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(fieldCls, width(p.className), p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(fieldCls, width(p.className), 'font-mono', p.className)} />;

export function Toggle({ checked, onChange, label, description, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; description?: string; disabled?: boolean }) {
  return (
    <label className={cx('flex cursor-pointer items-start gap-3 rounded-lg border border-ink-700 bg-ink-850 p-3', disabled && 'opacity-50 cursor-not-allowed')}>
      <input type="checkbox" className="peer sr-only" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className={cx('mt-0.5 flex h-5 w-9 shrink-0 items-center rounded-full p-0.5 transition peer-focus-visible:ring-2 peer-focus-visible:ring-accent-400', checked ? 'bg-accent-400' : 'bg-ink-600')}>
        <span className={cx('h-4 w-4 rounded-full bg-white transition', checked && 'translate-x-4')} />
      </span>
      <span>
        <span className="block text-sm font-medium">{label}</span>
        {description && <span className="block text-xs text-ink-400">{description}</span>}
      </span>
    </label>
  );
}

export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      variant="ghost"
      icon={done ? 'check' : 'copy'}
      className="px-2 py-1 text-xs"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard unavailable */
        }
      }}
    >
      {done ? 'Copied' : label}
    </Button>
  );
}

export function CodeBlock({ code, title, language, maxHeight = 420, actions }: { code: string; title?: string; language?: string; maxHeight?: number; actions?: ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
      <div className="flex items-center justify-between border-b border-ink-700 px-3 py-1.5">
        <span className="font-mono text-xs text-ink-400">{title || language}</span>
        <div className="flex items-center gap-1">
          {actions}
          <CopyButton text={code} />
        </div>
      </div>
      <pre className="scroll-thin overflow-auto p-3 font-mono text-[12px] leading-relaxed text-ink-100" style={{ maxHeight }}>
        {language === 'diff'
          ? code.split('\n').map((l, i) => (
              <div key={i} className={l.startsWith('+') && !l.startsWith('+++') ? 'text-emerald-300 bg-emerald-500/10' : l.startsWith('-') && !l.startsWith('---') ? 'text-red-300 bg-red-500/10' : l.startsWith('@@') ? 'text-cyan-300' : ''}>
                {l || ' '}
              </div>
            ))
          : code}
      </pre>
    </div>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: ReactNode }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div role="tablist" className="scroll-thin flex gap-1 overflow-x-auto border-b border-ink-700">
      {tabs.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx('whitespace-nowrap border-b-2 px-3 py-2 text-sm transition', value === t.id ? 'border-accent-400 text-ink-100' : 'border-transparent text-ink-400 hover:text-ink-100')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function ScoreRing({ score, size = 64 }: { score?: number | null; size?: number }) {
  const s = score ?? 0;
  const r = size / 2 - 5;
  const c = 2 * Math.PI * r;
  const color = score == null ? '#2e384b' : s >= 80 ? '#34d399' : s >= 50 ? '#fbbf24' : '#f87171';
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }} aria-label={`QA score ${score ?? 'n/a'}`}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} stroke="#212a3a" strokeWidth="5" fill="none" />
        <circle cx={size / 2} cy={size / 2} r={r} stroke={color} strokeWidth="5" fill="none" strokeDasharray={c} strokeDashoffset={c * (1 - s / 100)} strokeLinecap="round" />
      </svg>
      <div className="absolute inset-0 flex items-center justify-center text-sm font-semibold tabular-nums">{score ?? '—'}</div>
    </div>
  );
}
