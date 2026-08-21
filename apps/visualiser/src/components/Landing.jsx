import { useState } from 'react'
import { FolderOpen, Map as MapIcon, GitCompareArrows } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Kbd } from '@/components/ui/kbd'
import { Wordmark } from './Brand'
import { cn } from '@/lib/utils'

export default function Landing({ onOpenBuffer, onLoadDemo, demoAvailable, busy, error }) {
  const [dragging, setDragging] = useState(false)
  return (
    <div
      className={cn('landing-grid flex h-full items-center justify-center p-6 transition-colors duration-300', dragging && 'bg-primary/5')}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={async (e) => {
        e.preventDefault()
        setDragging(false)
        const f = e.dataTransfer.files?.[0]
        if (f) onOpenBuffer(await f.arrayBuffer())
      }}
    >
      <Card className="w-[min(520px,92vw)] animate-in fade-in-0 slide-in-from-bottom-2 duration-500">
        <CardContent className="flex flex-col gap-6 pt-2">
          <div className="flex flex-col gap-3">
            <Wordmark className="[&_svg]:size-7 [&>span]:text-2xl" />
            <p className="text-pretty text-[15px] leading-relaxed text-muted-foreground">
              Every screen of your app as a map — real screenshots, the links between them, and replayable flows.
              Drop an <span className="font-mono text-foreground">.appmap</span> to explore it, or an{' '}
              <span className="font-mono text-foreground">.appmapdiff</span> to review what a pull request changed.
            </p>
          </div>

          <label
            className={cn(
              'group flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-5 py-8 text-center transition-colors',
              'hover:border-primary hover:bg-primary/5',
              dragging && 'border-primary bg-primary/5'
            )}
          >
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
            <div className="flex items-center gap-3 text-muted-foreground group-hover:text-primary">
              <MapIcon className="size-5" aria-hidden="true" />
              <GitCompareArrows className="size-5" aria-hidden="true" />
            </div>
            <span className="text-sm font-medium">{dragging ? 'Drop it' : 'Drop a bundle here, or click to browse'}</span>
            <span className="text-xs text-muted-foreground">Parsed in your browser — nothing is uploaded.</span>
          </label>

          <div className="flex items-center justify-between gap-3">
            <span className="text-xs text-muted-foreground">
              Tip: with both loaded, switch <Kbd>Map</Kbd> ⇄ <Kbd>Changes</Kbd> in the top bar.
            </span>
            {demoAvailable && (
              <Button variant="outline" size="sm" onClick={onLoadDemo} disabled={busy}>
                <FolderOpen data-icon="inline-start" aria-hidden="true" />
                {busy ? 'Loading…' : 'Open the demo map'}
              </Button>
            )}
          </div>

          {error && (
            <Alert variant="destructive">
              <AlertTitle>That file didn't open</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
