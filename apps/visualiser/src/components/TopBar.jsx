import { Moon, Sun, Monitor, Upload, X, Map as MapIcon, GitCompareArrows } from 'lucide-react'
import { useTheme } from '@/lib/theme'
import { Button } from '@/components/ui/button'
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu'
import { Separator } from '@/components/ui/separator'
import { Wordmark } from './Brand'
import { cn } from '@/lib/utils'

function Stat({ value, label, tone }) {
  return (
    <span className={cn('inline-flex items-baseline gap-1 text-xs text-muted-foreground', tone)}>
      <b className={cn('tnum font-mono text-[13px] font-semibold', tone ? '' : 'text-foreground')}>{value}</b>
      {label}
    </span>
  )
}

function ThemeMenu() {
  const { theme, setTheme } = useTheme()
  const Icon = theme === 'light' ? Sun : theme === 'system' ? Monitor : Moon
  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label="Theme">
              <Icon aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent>Theme</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="end">
        <DropdownMenuGroup>
          <DropdownMenuItem onSelect={() => setTheme('dark')}><Moon aria-hidden="true" /> Dark</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('light')}><Sun aria-hidden="true" /> Light</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setTheme('system')}><Monitor aria-hidden="true" /> System</DropdownMenuItem>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default function TopBar({ manifest, mode, setMode, hasChanges, overlaid, stats, diffStats, onOpenBuffer, onCloseChanges }) {
  const diffMode = mode === 'changes'
  const sub = diffMode
    ? `${manifest.pr ? `PR #${manifest.pr.number} · ` : ''}${manifest.pr?.title ?? `${(manifest.base?.commit ?? 'base').slice(0, 7)} → ${(manifest.head?.commit ?? 'head').slice(0, 7)}`}${overlaid ? '' : ' · no map backdrop'}`
    : `${manifest.app.mode ?? 'map'} · ${manifest.app.device ?? 'unknown device'} · ${new Date(manifest.generatedAt).toLocaleDateString()}`

  return (
    <header className="pointer-events-none absolute inset-x-4 top-4 z-10 flex items-start justify-between gap-3">
      <div className="panel pointer-events-auto flex max-w-[min(760px,calc(100vw-120px))] items-center gap-4 px-4 py-2.5 animate-in fade-in-0 slide-in-from-top-2 duration-400">
        <div className="flex min-w-0 items-center gap-3">
          <Wordmark />
          <Separator orientation="vertical" className="h-5" />
          <div className="min-w-0 leading-tight">
            <div className="truncate text-[13px] font-semibold">{manifest.app.name}</div>
            <div className="truncate text-[11px] text-muted-foreground">{sub}</div>
          </div>
        </div>

        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          spacing={0}
          value={mode}
          onValueChange={(v) => v && setMode(v)}
          aria-label="View"
          className="shrink-0"
        >
          <ToggleGroupItem value="map" aria-label="Map" className="data-[state=on]:bg-primary/12 data-[state=on]:text-primary">
            <MapIcon data-icon="inline-start" aria-hidden="true" /> Map
          </ToggleGroupItem>
          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <ToggleGroupItem value="changes" aria-label="Changes" disabled={!hasChanges} className="data-[state=on]:bg-changed/15 data-[state=on]:text-changed">
                  <GitCompareArrows data-icon="inline-start" aria-hidden="true" /> Changes
                </ToggleGroupItem>
              </span>
            </TooltipTrigger>
            {!hasChanges && <TooltipContent>Open an .appmapdiff to review a PR</TooltipContent>}
          </Tooltip>
        </ToggleGroup>

        <div className="hidden items-center gap-3 md:flex">
          {diffMode && diffStats ? (
            <>
              <Stat value={`+${diffStats.A}`} label="added" tone="text-added" />
              <Stat value={`±${diffStats.M}`} label="changed" tone="text-changed" />
              <Stat value={`−${diffStats.D}`} label="removed" tone="text-removed" />
              <Stat value={diffStats.edges} label={diffStats.edges === 1 ? 'edge' : 'edges'} />
            </>
          ) : (
            <>
              <Stat value={stats.screens} label="screens" />
              <Stat value={stats.captured} label="captured" />
              <Stat value={stats.flows} label="flows" />
            </>
          )}
        </div>
      </div>

      <div className="panel pointer-events-auto flex items-center gap-1 p-1.5 animate-in fade-in-0 slide-in-from-top-2 duration-400">
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" asChild>
              <label className="cursor-pointer">
                <input
                  type="file"
                  accept=".appmap,.appmapdiff,.zip"
                  className="sr-only"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    if (f) onOpenBuffer(await f.arrayBuffer())
                    e.target.value = ''
                  }}
                />
                <Upload data-icon="inline-start" aria-hidden="true" />
                Open
              </label>
            </Button>
          </TooltipTrigger>
          <TooltipContent>Open an .appmap or .appmapdiff — or drop one anywhere</TooltipContent>
        </Tooltip>
        {hasChanges && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Close changes" onClick={onCloseChanges}>
                <X aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Close the Changes overlay</TooltipContent>
          </Tooltip>
        )}
        <ThemeMenu />
      </div>
    </header>
  )
}
