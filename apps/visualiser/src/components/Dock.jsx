import { RotateCcw, ChevronLeft, ChevronRight, Copy } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Badge } from '@/components/ui/badge'
import { RowMark } from './SidePanel'
import { cn } from '@/lib/utils'

// The bottom dock: one of three cards depending on what's selected.
function DockShell({ children, className }) {
  return (
    <footer
      className={cn(
        'panel pointer-events-auto absolute bottom-[18px] left-1/2 z-10 w-[min(560px,calc(100vw-320px))] -translate-x-1/2 px-[18px] py-3.5 animate-in fade-in-0 slide-in-from-bottom-2 duration-300',
        className
      )}
    >
      {children}
    </footer>
  )
}

export function Playhead({
  title, neighbours, neighbourCount, toggles, pos, total, onReplay, onPrev, onNext, onSeek, stepDescription, onCopy,
}) {
  return (
    <DockShell>
      <div className="flex items-center justify-between gap-3">
        <b className="truncate text-[13px] font-semibold">{title}</b>
        {toggles && (
          <ToggleGroup type="single" size="sm" variant="outline" spacing={0} value={toggles.value} onValueChange={(v) => v && toggles.onChange(v)} className="shrink-0">
            {toggles.options.map((o) => (
              <ToggleGroupItem key={o.value} value={o.value} className="text-[11px] data-[state=on]:bg-primary/12 data-[state=on]:text-primary">
                {o.label}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
        {!neighbours && <span className="tnum font-mono text-[11px] text-muted-foreground">{pos + 1} / {total}</span>}
      </div>
      {neighbours ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {neighbourCount} screen{neighbourCount === 1 ? '' : 's'} reachable in one action — highlighted with their edges
        </p>
      ) : (
        <>
          <div className="mt-2.5 mb-1.5 flex items-center gap-2.5">
            <Button variant="outline" size="icon" onClick={onReplay} disabled={pos === 0} aria-label="Replay from the first step"><RotateCcw aria-hidden="true" /></Button>
            <Button variant="outline" size="icon" onClick={onPrev} disabled={pos === 0} aria-label="Previous step"><ChevronLeft aria-hidden="true" /></Button>
            <div className="flex flex-1 flex-wrap justify-center gap-1.5">
              {Array.from({ length: total }).map((_, k) => (
                <button key={k} type="button" className={cn('ph-dot', k === pos ? 'now' : k < pos ? 'done' : '')} onClick={() => onSeek(k)} aria-label={`Step ${k + 1}`} />
              ))}
            </div>
            <Button variant="outline" size="icon" onClick={onNext} disabled={pos === total - 1} aria-label="Next step"><ChevronRight aria-hidden="true" /></Button>
          </div>
          <div className="flex items-center gap-2.5">
            <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{stepDescription}</p>
            <Button size="sm" onClick={onCopy}><Copy data-icon="inline-start" aria-hidden="true" />Copy replay</Button>
          </div>
        </>
      )}
    </DockShell>
  )
}

export function TransitionCard({ from, to, diffStatus, observed, flows, raws, file, gestureKnown }) {
  return (
    <DockShell className="w-[min(520px,calc(100vw-320px))]">
      <div className="flex items-center gap-2.5 font-mono text-[13px] font-semibold">
        {diffStatus && <RowMark kind={diffStatus} />}
        <span className="truncate">{from}</span>
        <span className="shrink-0 text-primary">⟶</span>
        <span className="truncate">{to}</span>
      </div>
      <div className="mt-2 flex flex-wrap items-baseline gap-1.5">
        {observed ? (
          <>
            <span className="font-mono text-[10.5px] text-muted-foreground">not in static code analysis — observed by the agent in</span>
            {flows.slice(0, 3).map((f) => <Badge key={f} variant="secondary" className="font-mono">{f}</Badge>)}
            {flows.length > 3 && <span className="font-mono text-[10.5px] text-muted-foreground">+{flows.length - 3} more flows</span>}
          </>
        ) : (
          <>
            {raws.map((r) => <Badge key={r} variant="secondary" className="font-mono">{r}</Badge>)}
            {file && <span className="font-mono text-[10.5px] text-muted-foreground">in {file}</span>}
          </>
        )}
      </div>
      <p className={cn('mt-2 text-[11px]', gestureKnown ? 'text-primary' : 'text-muted-foreground')}>
        {gestureKnown ? '◉ trigger position shown on the source screen' : 'trigger position not recorded — an interactive flow through this transition would pin it'}
      </p>
    </DockShell>
  )
}

const DIFF_LABEL = { A: 'added', M: 'changed', D: 'removed' }

export function ChangeCard({ urlPath, diff, states }) {
  return (
    <DockShell>
      <div className="flex items-center gap-2.5 font-mono text-[13px] font-semibold">
        {diff && <RowMark kind={diff.status} />}
        <span className="truncate">{urlPath}</span>
        <span className="ml-auto shrink-0 font-sans text-[11px] font-normal text-muted-foreground">
          {diff ? DIFF_LABEL[diff.status] : 'unchanged in this diff'}
        </span>
      </div>
      {diff?.note && <p className="mt-2 text-[12.5px] leading-relaxed text-foreground">{diff.note}</p>}
      {diff && (
        <div className="mt-2 flex flex-wrap items-baseline gap-1.5">
          <span className="font-mono text-[10.5px] text-muted-foreground">{diff.reason}</span>
          {(diff.via ?? []).map((f) => <Badge key={f} variant="secondary" className="font-mono">{f}</Badge>)}
        </div>
      )}
      {states?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {states.map((s) => (
            <Badge
              key={s.name + s.status}
              variant="outline"
              title={s.note ?? undefined}
              className={cn('font-mono', s.status === 'A' && 'border-added/40 text-added', s.status === 'M' && 'border-changed/40 text-changed', s.status === 'D' && 'border-removed/40 text-removed')}
            >
              {s.status === 'A' ? '+' : s.status === 'D' ? '−' : '±'} {s.name === '' ? 'base screen' : s.name}
            </Badge>
          ))}
        </div>
      )}
    </DockShell>
  )
}

export function CommandSheet({ title, cmd, onCopy, onClose }) {
  return (
    <div className="absolute inset-0 z-30 grid place-items-center bg-background/60 backdrop-blur-sm animate-in fade-in-0 duration-200" onClick={onClose}>
      <div className="panel w-[min(560px,92vw)] p-5" onClick={(e) => e.stopPropagation()}>
        <h2 className="mb-3 text-sm font-semibold">Replay · {title}</h2>
        <pre className="m-0 overflow-x-auto rounded-lg border bg-muted/50 p-3.5 font-mono text-[11.5px] leading-relaxed select-all">{cmd}</pre>
        <div className="mt-3.5 flex gap-2.5">
          <Button className="flex-1" onClick={onCopy}><Copy data-icon="inline-start" aria-hidden="true" />Copy</Button>
          <Button variant="outline" className="flex-1" onClick={onClose}>Close</Button>
        </div>
      </div>
    </div>
  )
}
