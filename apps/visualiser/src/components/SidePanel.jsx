import { ChevronDown, ChevronUp } from 'lucide-react'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'

// Marker glyph for a list row: diff status (A/M/D) or a flow.
export function RowMark({ kind }) {
  const map = {
    A: ['+', 'bg-added/15 text-added'],
    M: ['±', 'bg-changed/15 text-changed'],
    D: ['−', 'bg-removed/15 text-removed'],
    flow: ['✦', 'bg-secondary text-primary'],
  }
  const [glyph, cls] = map[kind] ?? ['·', 'bg-muted text-muted-foreground']
  return (
    <span className={cn('inline-flex size-[18px] shrink-0 items-center justify-center rounded-md text-xs font-bold', cls)} aria-hidden="true">
      {glyph}
    </span>
  )
}

export default function SidePanel({ title, count, open, onToggle, items, footer }) {
  // The top offset clears the top bar, which stacks into two rows below 520px.
  return (
    <aside
      className="panel pointer-events-auto absolute left-4 top-[140px] z-10 flex w-[min(252px,calc(100vw-32px))] max-h-[calc(100%-170px)] flex-col animate-in fade-in-0 slide-in-from-top-2 duration-400 delay-75 fill-mode-both min-[520px]:top-[88px] min-[520px]:max-h-[calc(100%-118px)]"
    >
      <button
        type="button"
        className="flex min-h-10 items-center justify-between px-4 py-2.5 text-left"
        onClick={onToggle}
        aria-expanded={open}
      >
        <span className="flex items-baseline gap-2">
          <span className="text-[11.5px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">{title}</span>
          {count != null && <span className="tnum font-mono text-[11px] text-muted-foreground/70">{count}</span>}
        </span>
        {open ? <ChevronUp className="size-3.5 text-muted-foreground" aria-hidden="true" /> : <ChevronDown className="size-3.5 text-muted-foreground" aria-hidden="true" />}
      </button>
      {open && (
        <ScrollArea className="min-h-0 flex-1 px-2 pb-2">
          <div className="flex flex-col gap-0.5">
            {items.map((it) => (
              <button
                key={it.key}
                type="button"
                title={it.title}
                onClick={(e) => { e.currentTarget.blur(); it.onClick() }}
                className={cn(
                  'flex min-h-[34px] w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-[12.5px] transition-[background-color,scale] duration-150 active:scale-[0.98]',
                  // Either/or, never both: a hover variant outranks a flat
                  // background, so pairing them painted pale grey under the
                  // active row's paper label for as long as the pointer stayed
                  // where you clicked, which is exactly where it ends up.
                  it.active ? 'bg-foreground text-background' : 'hover:bg-muted/70'
                )}
              >
                <RowMark kind={it.kind} />
                <span className={cn('truncate', it.mono && 'font-mono text-[12px]')}>{it.label}</span>
              </button>
            ))}
          </div>
          {footer}
        </ScrollArea>
      )}
    </aside>
  )
}
