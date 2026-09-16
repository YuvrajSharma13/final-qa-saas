import { useEffect, useState } from 'react';
import { shotUrl, type Screenshot } from '../lib/api';
import { Icon } from './icons';
import { Badge, Button, cx, SeverityBadge } from './ui';

export function ScreenshotCard({ shot, onOpen, actions }: { shot: Screenshot; onOpen: () => void; actions?: React.ReactNode }) {
  const issues = shot.annotations?.length || 0;
  return (
    <figure className="overflow-hidden rounded-lg border border-ink-700 bg-ink-900">
      <button onClick={onOpen} className="block w-full bg-ink-950" aria-label={`Open screenshot of ${shot.pagePath}`}>
        <img src={shotUrl(shot._id, Boolean(shot.annotatedRef))} alt={`${shot.pagePath} at ${shot.viewport?.name}`} loading="lazy" className="h-44 w-full object-cover object-top" />
      </button>
      <figcaption className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-xs">
        <span className="font-mono text-ink-300">
          {shot.pagePath} · {shot.viewport?.width}×{shot.viewport?.height}
        </span>
        <span className="flex items-center gap-1.5">
          {shot.isBaseline && <Badge className="bg-cyan-500/10 text-cyan-300 ring-cyan-500/30">baseline</Badge>}
          {shot.kind === 'failure' && <Badge className="bg-red-500/10 text-red-300 ring-red-500/30">failure</Badge>}
          {shot.kind === 'capture' && (issues ? <Badge className="bg-red-500/10 text-red-300 ring-red-500/30">{issues} issue{issues > 1 ? 's' : ''}</Badge> : <Badge className="bg-emerald-500/10 text-emerald-300 ring-emerald-500/30">clean</Badge>)}
          {actions}
        </span>
      </figcaption>
    </figure>
  );
}

export function ScreenshotModal({ shot, onClose }: { shot: Screenshot | null; onClose: () => void }) {
  const [annotated, setAnnotated] = useState(true);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  if (!shot) return null;
  const hasAnn = Boolean(shot.annotatedRef);
  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center bg-black/80 p-2 sm:p-6" role="dialog" aria-modal="true" aria-label="Screenshot viewer" onClick={onClose}>
      <div className="flex w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-ink-600 bg-ink-900" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-ink-700 px-4 py-2.5">
          <div className="min-w-0">
            <div className="truncate font-mono text-sm">{shot.url || shot.pagePath}</div>
            <div className="text-xs text-ink-400">
              {shot.viewport?.name} · {shot.viewport?.width}×{shot.viewport?.height} · captured by {shot.agentType?.replace('_', ' ')}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {hasAnn && (
              <div className="flex rounded-lg border border-ink-600 p-0.5 text-xs">
                <button onClick={() => setAnnotated(true)} className={cx('rounded-md px-2 py-1', annotated && 'bg-ink-700')}>
                  Annotated
                </button>
                <button onClick={() => setAnnotated(false)} className={cx('rounded-md px-2 py-1', !annotated && 'bg-ink-700')}>
                  Original
                </button>
              </div>
            )}
            <a className="rounded-lg p-2 text-ink-300 hover:bg-ink-800" href={shotUrl(shot._id, annotated && hasAnn)} target="_blank" rel="noreferrer" aria-label="Open image in new tab">
              <Icon name="external" />
            </a>
            <Button variant="ghost" icon="x" onClick={onClose} aria-label="Close" />
          </div>
        </div>
        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_320px]">
          <div className="scroll-thin min-h-0 overflow-auto bg-ink-950 p-3">
            <img src={shotUrl(shot._id, annotated && hasAnn)} alt="" className="mx-auto max-w-full" />
          </div>
          <aside className="scroll-thin max-h-72 overflow-y-auto border-t border-ink-700 p-4 lg:max-h-none lg:border-l lg:border-t-0">
            <h3 className="text-sm font-semibold">Computer-vision findings</h3>
            {!shot.annotations?.length && <p className="mt-2 text-sm text-ink-400">No visual defects detected in this capture.</p>}
            <ol className="mt-3 space-y-3">
              {shot.annotations?.map((a) => (
                <li key={a.n} className="rounded-lg border border-ink-700 bg-ink-850 p-3 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="flex h-5 w-5 items-center justify-center rounded bg-ink-700 text-xs font-semibold">{a.n}</span>
                    <span className="font-medium">{a.type.replace(/_/g, ' ')}</span>
                    <SeverityBadge severity={a.severity} />
                  </div>
                  <p className="mt-1.5 text-ink-300">{a.label}</p>
                  <dl className="mt-2 grid grid-cols-2 gap-x-2 gap-y-1 text-xs text-ink-400">
                    <dt>Region</dt>
                    <dd className="text-ink-100">{a.region}</dd>
                    <dt>Confidence</dt>
                    <dd className="text-ink-100">{a.confidence}</dd>
                    <dt>Box</dt>
                    <dd className="font-mono text-ink-100">
                      {Math.round(a.box.x)},{Math.round(a.box.y)} {Math.round(a.box.width)}×{Math.round(a.box.height)}
                    </dd>
                    {a.method && (
                      <>
                        <dt>Method</dt>
                        <dd className="text-ink-100">{a.method.join(', ')}</dd>
                      </>
                    )}
                  </dl>
                </li>
              ))}
            </ol>
          </aside>
        </div>
      </div>
    </div>
  );
}
