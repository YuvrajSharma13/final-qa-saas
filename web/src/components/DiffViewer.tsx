import { useMemo, useState } from 'react';
import { Icon } from './icons';
import { CopyButton, cx } from './ui';

type Line = { type: 'ctx' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number };
type Hunk = { header: string; lines: Line[] };
type FileDiff = { path: string; hunks: Hunk[]; additions: number; deletions: number };

export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  let file: FileDiff | null = null;
  let hunk: Hunk | null = null;
  let oldNo = 0;
  let newNo = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      const m = raw.match(/ b\/(.+)$/);
      file = { path: m ? m[1] : raw, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = m ? Number(m[1]) : 0;
      newNo = m ? Number(m[2]) : 0;
      hunk = { header: raw, lines: [] };
      file.hunks.push(hunk);
      continue;
    }
    if (!hunk || raw.startsWith('---') || raw.startsWith('+++') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+')) {
      hunk.lines.push({ type: 'add', text: raw.slice(1), newNo: newNo++ });
      file.additions++;
    } else if (raw.startsWith('-')) {
      hunk.lines.push({ type: 'del', text: raw.slice(1), oldNo: oldNo++ });
      file.deletions++;
    } else if (raw.startsWith(' ')) {
      hunk.lines.push({ type: 'ctx', text: raw.slice(1), oldNo: oldNo++, newNo: newNo++ });
    }
  }
  return files;
}

const ROW = {
  add: 'bg-emerald-500/10',
  del: 'bg-red-500/10',
  ctx: '',
  empty: 'bg-ink-900/60',
};

function splitRows(h: Hunk) {
  const rows: { left?: Line; right?: Line }[] = [];
  let dels: Line[] = [];
  let adds: Line[] = [];
  const flush = () => {
    const n = Math.max(dels.length, adds.length);
    for (let i = 0; i < n; i++) rows.push({ left: dels[i], right: adds[i] });
    dels = [];
    adds = [];
  };
  for (const l of h.lines) {
    if (l.type === 'del') dels.push(l);
    else if (l.type === 'add') adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

const Num = ({ n }: { n?: number }) => <span className="inline-block w-10 shrink-0 select-none pr-2 text-right text-ink-400">{n ?? ''}</span>;

export function DiffViewer({ diff, title = 'Proposed change' }: { diff: string; title?: string }) {
  const files = useMemo(() => parseUnifiedDiff(diff), [diff]);
  const [mode, setMode] = useState<'split' | 'unified'>(() => (typeof window !== 'undefined' && window.innerWidth < 900 ? 'unified' : 'split'));
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm text-ink-300">
          {title} · {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
          <span className="text-emerald-300">+{files.reduce((s, f) => s + f.additions, 0)}</span> <span className="text-red-300">−{files.reduce((s, f) => s + f.deletions, 0)}</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex rounded-lg border border-ink-600 p-0.5 text-xs" role="group" aria-label="Diff layout">
            {(['split', 'unified'] as const).map((m) => (
              <button key={m} aria-pressed={mode === m} onClick={() => setMode(m)} className={cx('rounded-md px-2 py-1 capitalize', mode === m && 'bg-ink-700')}>
                {m === 'split' ? 'Before / After' : 'Unified'}
              </button>
            ))}
          </div>
          <CopyButton text={diff} label="Copy patch" />
        </div>
      </div>
      {files.map((f) => (
        <div key={f.path} className="overflow-hidden rounded-lg border border-ink-700 bg-ink-950">
          <div className="flex items-center justify-between gap-2 border-b border-ink-700 bg-ink-900 px-3 py-2 text-xs">
            <span className="flex min-w-0 items-center gap-2 font-mono text-ink-100">
              <Icon name="code" size={13} className="shrink-0 text-ink-400" />
              <span className="truncate">{f.path}</span>
            </span>
            <span className="shrink-0 font-mono">
              <span className="text-emerald-300">+{f.additions}</span> <span className="text-red-300">−{f.deletions}</span>
            </span>
          </div>
          <div className="scroll-thin overflow-x-auto font-mono text-[12px] leading-5">
            {f.hunks.map((h, hi) => (
              <div key={hi}>
                <div className="bg-cyan-500/5 px-3 py-0.5 text-cyan-300">{h.header}</div>
                {mode === 'unified'
                  ? h.lines.map((l, i) => (
                      <div key={i} className={cx('flex min-w-max', ROW[l.type])}>
                        <Num n={l.oldNo} />
                        <Num n={l.newNo} />
                        <span className={cx('w-4 shrink-0 select-none', l.type === 'add' ? 'text-emerald-300' : l.type === 'del' ? 'text-red-300' : 'text-ink-600')}>{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                        <span className="whitespace-pre pr-4">{l.text || ' '}</span>
                      </div>
                    ))
                  : (
                    <div className="grid min-w-[760px] grid-cols-2">
                      <div className="border-r border-ink-700 bg-red-500/5 px-3 py-0.5 font-sans text-[11px] font-medium uppercase tracking-wide text-red-300/80">Before</div>
                      <div className="bg-emerald-500/5 px-3 py-0.5 font-sans text-[11px] font-medium uppercase tracking-wide text-emerald-300/80">After</div>
                      {splitRows(h).map((r, i) => (
                        <div key={i} className="contents">
                          <div className={cx('flex border-r border-ink-700', r.left ? ROW[r.left.type === 'add' ? 'ctx' : r.left.type] : ROW.empty)}>
                            <Num n={r.left?.oldNo} />
                            <span className="whitespace-pre-wrap break-all pr-3">{r.left ? r.left.text || ' ' : ''}</span>
                          </div>
                          <div className={cx('flex', r.right ? ROW[r.right.type === 'del' ? 'ctx' : r.right.type] : ROW.empty)}>
                            <Num n={r.right?.newNo} />
                            <span className="whitespace-pre-wrap break-all pr-3">{r.right ? r.right.text || ' ' : ''}</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
