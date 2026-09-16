import { useState } from 'react';
import { Link } from 'react-router-dom';

// Status palette (validated reference instance): good / critical; single-series line uses sequential blue.
const C = { passed: '#0ca30c', failed: '#d03b3b', line: '#3987e5', grid: '#212a3a', axis: '#7d879c' };

export interface TrendPoint {
  runId: string;
  at: string;
  passed: number;
  failed: number;
  qaScore: number | null;
}

const fmtDate = (s: string) => new Date(s).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

function Tooltip({ xPct, yPct, children }: { xPct: number; yPct: number; children: React.ReactNode }) {
  const left = `clamp(70px, ${xPct}%, calc(100% - 70px))`;
  return (
    <div className="pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded-md border border-ink-600 bg-ink-850 px-2.5 py-1.5 text-xs shadow-lg" style={{ left, top: `calc(${yPct}% - 8px)` }}>
      {children}
    </div>
  );
}

function TableView({ points }: { points: TrendPoint[] }) {
  return (
    <details className="mt-2 text-xs text-ink-400">
      <summary className="cursor-pointer select-none hover:text-ink-100">View as table</summary>
      <table className="mt-2 w-full text-left">
        <thead>
          <tr className="text-ink-400">
            <th className="py-1 font-medium">Run</th>
            <th className="font-medium">Passed</th>
            <th className="font-medium">Failed</th>
            <th className="font-medium">QA score</th>
          </tr>
        </thead>
        <tbody className="text-ink-100">
          {points.map((p) => (
            <tr key={p.runId} className="border-t border-ink-700">
              <td className="py-1">
                <Link className="hover:text-accent-300" to={`/runs/${p.runId}`}>
                  {fmtDate(p.at)}
                </Link>
              </td>
              <td className="tabular-nums">{p.passed}</td>
              <td className="tabular-nums">{p.failed}</td>
              <td className="tabular-nums">{p.qaScore ?? '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}

/** Passed/failed checks per run as stacked bars (one y-axis: check count). */
export function RunBars({ points, height = 160 }: { points: TrendPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 560;
  const pad = { l: 30, r: 8, t: 10, b: 20 };
  const max = Math.max(1, ...points.map((p) => p.passed + p.failed));
  const ih = height - pad.t - pad.b;
  const slot = (W - pad.l - pad.r) / Math.max(points.length, 1);
  const bw = Math.min(28, slot * 0.6);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const ticks = [0, Math.round(max / 2), max];
  return (
    <div>
      <div className="mb-2 flex items-center gap-4 text-xs text-ink-300">
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.passed }} /> Passed
        </span>
        <span className="flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-sm" style={{ background: C.failed }} /> Failed
        </span>
      </div>
      <div className="relative">
        <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="Passed and failed checks per run">
          {ticks.map((t) => (
            <g key={t}>
              <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
              <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill={C.axis}>
                {t}
              </text>
            </g>
          ))}
          {points.map((p, i) => {
            const cx = pad.l + slot * i + slot / 2;
            const x = cx - bw / 2;
            const hp = (p.passed / max) * ih;
            const hf = (p.failed / max) * ih;
            const gap = p.passed && p.failed ? 2 : 0;
            return (
              <g key={p.runId} onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(null)}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={ih} fill="transparent" />
                {p.passed > 0 && <path d={roundedTop(x, y(p.passed), bw, hp, p.failed ? 0 : 4)} fill={C.passed} opacity={hover === null || hover === i ? 1 : 0.45} />}
                {p.failed > 0 && <path d={roundedTop(x, y(p.passed + p.failed), bw, Math.max(0, hf - gap), 4)} fill={C.failed} opacity={hover === null || hover === i ? 1 : 0.45} />}
                {(i === points.length - 1 || points.length <= 6) && (
                  <text x={cx} y={height - 6} textAnchor="middle" fontSize={9} fill={C.axis}>
                    {new Date(p.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                  </text>
                )}
              </g>
            );
          })}
        </svg>
        {hover !== null && points[hover] && (
          <Tooltip xPct={((pad.l + slot * hover + slot / 2) / W) * 100} yPct={(y(points[hover].passed + points[hover].failed) / height) * 100}>
            <div className="text-ink-400">{fmtDate(points[hover].at)}</div>
            <div className="text-ink-100">
              {points[hover].passed} passed · {points[hover].failed} failed
            </div>
          </Tooltip>
        )}
      </div>
      <TableView points={points} />
    </div>
  );
}

function roundedTop(x: number, y: number, w: number, h: number, r: number) {
  if (h <= 0) return '';
  const rr = Math.min(r, h, w / 2);
  return `M${x},${y + h} V${y + rr} Q${x},${y} ${x + rr},${y} H${x + w - rr} Q${x + w},${y} ${x + w},${y + rr} V${y + h} Z`;
}

/** QA score per run (0–100) with crosshair tooltip. */
export function ScoreLine({ points, height = 120 }: { points: TrendPoint[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const data = points.filter((p) => p.qaScore !== null);
  const W = 560;
  const pad = { l: 30, r: 10, t: 10, b: 14 };
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length <= 1 ? (W - pad.l - pad.r) / 2 : (i / (data.length - 1)) * (W - pad.l - pad.r));
  const y = (v: number) => pad.t + ih - (v / 100) * ih;
  const d = data.map((p, i) => `${i ? 'L' : 'M'}${x(i)},${y(p.qaScore!)}`).join(' ');
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        className="w-full"
        role="img"
        aria-label="QA score per run"
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * W;
          let best = 0;
          data.forEach((_, i) => {
            if (Math.abs(x(i) - px) < Math.abs(x(best) - px)) best = i;
          });
          setHover(data.length ? best : null);
        }}
        onMouseLeave={() => setHover(null)}
      >
        {[0, 50, 100].map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={C.grid} strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize={10} fill={C.axis}>
              {t}
            </text>
          </g>
        ))}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={C.axis} strokeDasharray="3 3" />}
        <path d={d} fill="none" stroke={C.line} strokeWidth={2} strokeLinejoin="round" />
        {data.map((p, i) => (
          <circle key={p.runId} cx={x(i)} cy={y(p.qaScore!)} r={hover === i ? 5 : 4} fill={C.line} stroke="#0d1119" strokeWidth={2} />
        ))}
        {data.length > 0 && (
          <text x={x(data.length - 1)} y={y(data.at(-1)!.qaScore!) - 9} textAnchor="end" fontSize={11} fill="#e6e9f0" fontWeight={600}>
            {data.at(-1)!.qaScore}
          </text>
        )}
      </svg>
      {hover !== null && data[hover] && (
        <Tooltip xPct={(x(hover) / W) * 100} yPct={(y(data[hover].qaScore!) / height) * 100}>
          <div className="text-ink-400">{fmtDate(data[hover].at)}</div>
          <div className="text-ink-100">QA score {data[hover].qaScore}</div>
        </Tooltip>
      )}
    </div>
  );
}

const SEV_COLORS = { critical: '#d03b3b', high: '#ec835a', medium: '#fab219', low: '#3987e5' } as const;

/** Open bugs by severity — horizontal bars with direct labels. */
export function SeverityBars({ counts }: { counts: Record<keyof typeof SEV_COLORS, number> }) {
  const max = Math.max(1, ...Object.values(counts));
  return (
    <div className="space-y-2.5">
      {(Object.keys(SEV_COLORS) as (keyof typeof SEV_COLORS)[]).map((k) => (
        <div key={k} className="grid grid-cols-[64px_1fr_28px] items-center gap-2 text-xs" title={`${counts[k]} ${k}`}>
          <span className="capitalize text-ink-300">{k}</span>
          <div className="h-2.5 rounded-full bg-ink-800">
            <div className="h-2.5 rounded-full" style={{ width: `${(counts[k] / max) * 100}%`, background: SEV_COLORS[k], minWidth: counts[k] ? 6 : 0 }} />
          </div>
          <span className="text-right tabular-nums text-ink-100">{counts[k]}</span>
        </div>
      ))}
    </div>
  );
}
