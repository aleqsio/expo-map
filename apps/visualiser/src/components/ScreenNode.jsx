import { useEffect, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { Check, ChevronDown } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { visualDiff } from '../lib/visualDiff'
import { cn } from '@/lib/utils'

const BROKEN = {
  'error-boundary': { icon: '⛌', label: 'crashes on deep link' },
  'not-found': { icon: '∅', label: 'params hit nothing real' },
  loading: { icon: '◌', label: 'stuck loading' },
  'auth-wall': { icon: '🔒', label: 'behind sign-in' },
  missing: { icon: '⚠', label: 'no capture' },
}
const DIFF_TAG = { A: '+ added', M: '± changed', D: '− removed' }
const STATE_DIFF = new Set(['A', 'M', 'D'])

function fixHint(node) {
  if (node.capture.note) return node.capture.note
  if (node.capture.needsNavigation) return 'Reach via in-app navigation — see its flow.'
  if (node.capture.status === 'loading') return 'Re-capture with a longer wait or real data.'
  return 'Re-run the sweep for this route.'
}

function StatusDot({ status }) {
  if (!STATE_DIFF.has(status)) return null
  return <span className={`st-dot ${status.toLowerCase()}`} aria-hidden="true" />
}

// State picker: a chip on the node that opens a menu of this screen's capture
// states. Each row carries a status dot in Changes mode (amber changed, green
// added, red removed); the chip lights amber when any state changed.
function StatePicker({ states, active, baseDiffStatus, onSelect }) {
  const [open, setOpen] = useState(false)
  const options = [
    { name: '', label: 'base screen', diff: baseDiffStatus },
    ...states.map((s) => ({ name: s.name, label: s.name, diff: s.diff ?? null })),
  ]
  const activeName = active ?? ''
  const current = options.find((o) => o.name === activeName) ?? options[0]
  const anyDiff = options.some((o) => STATE_DIFF.has(o.diff))
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn('state-chip nodrag nopan', anyDiff && 'has-diff')}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          title="Switch displayed state"
        >
          <StatusDot status={current.diff} />
          <span className="lbl">{current.label}</span>
          <ChevronDown className="size-2.5 opacity-70" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      {/* Radix portals this, but React events still bubble up the component
          tree — without this the pick would also read as a click on the node. */}
      <PopoverContent
        align="center"
        sideOffset={6}
        className="w-44 gap-0 p-1"
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {options.map((o) => (
          <button
            key={o.name}
            type="button"
            className={cn(
              'flex min-h-7 w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] font-medium hover:bg-muted',
              o.name === activeName && 'text-primary'
            )}
            onClick={() => { setOpen(false); onSelect?.(o.name) }}
          >
            <span className="w-3 shrink-0 text-primary">{o.name === activeName && <Check className="size-3" aria-hidden="true" />}</span>
            <span className="flex-1 truncate">{o.label}</span>
            <StatusDot status={o.diff} />
          </button>
        ))}
      </PopoverContent>
    </Popover>
  )
}

export default function ScreenNode({ data, selected }) {
  const {
    node, img, imgBase = null, states = [], baseStates = [], badgeText, hue, dimmed, onPath, isCurrent,
    stateName, chosenState, gesture, onStateSelect, statePickable = true,
    diffMode, diff, baseDiffStatus = null, flip = false,
  } = data
  const broken = BROKEN[node.capture.status]

  // flow playback wins over the manual choice; '' = base capture
  const activeState = stateName ?? chosenState
  const shown = activeState ? states.find((s) => s.name === activeState)?.img ?? img : img

  // in-place comparator for changed screens: alternate base/head on the shared
  // clock; on hover freeze and show the region-aware diff render instead
  const shownBase = activeState ? baseStates.find((s) => s.name === activeState)?.img ?? null : imgBase
  const canSwap = diff?.status === 'M' && !!shown && !!shownBase
  const [hovered, setHovered] = useState(false)
  const [diffImg, setDiffImg] = useState(null)
  useEffect(() => {
    if (!(hovered && canSwap)) { setDiffImg(null); return }
    let live = true
    visualDiff(shown, shownBase).then((d) => { if (live) setDiffImg(d) }, () => {})
    return () => { live = false }
  }, [hovered, canSwap, shown, shownBase])
  const displayed = canSwap ? (hovered ? diffImg?.url ?? shown : flip ? shownBase : shown) : shown

  const cls = cn(
    'screen-node',
    dimmed && 'dimmed',
    onPath && 'on-path',
    isCurrent && 'current',
    selected && 'selected',
    diff ? `diff-${diff.status.toLowerCase()}` : diffMode ? 'diff-unchanged' : ''
  )

  return (
    <div className={cls} style={{ '--group-hue': hue }}>
      <Handle type="target" position={Position.Top} className="port" />
      <div
        className={cn('phone', broken && 'broken')}
        onMouseEnter={canSwap ? () => setHovered(true) : undefined}
        onMouseLeave={canSwap ? () => setHovered(false) : undefined}
      >
        {displayed ? (
          <img src={displayed} alt={node.urlPath} draggable={false} />
        ) : (
          <div className="no-shot"><span>{node.capture.status === 'missing' ? 'no capture' : node.capture.status}</span></div>
        )}
        {broken && !activeState && (
          <div className="fix-overlay">
            <span className="fix-icon">{broken.icon}</span>
            <span className="fix-status">{broken.label}</span>
            <span className="fix-hint">{fixHint(node)}</span>
          </div>
        )}
        {gesture?.type === 'tap' && (
          <div className="tap-marker" style={{ left: `${gesture.x * 100}%`, top: `${gesture.y * 100}%` }} title={gesture.label ?? 'tap'} />
        )}
        {gesture?.type === 'swipe' && (
          <svg className="swipe-marker" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <marker id="swipe-head" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="currentColor" />
              </marker>
            </defs>
            <line x1={gesture.x1 * 100} y1={gesture.y1 * 100} x2={gesture.x2 * 100} y2={gesture.y2 * 100} markerEnd="url(#swipe-head)" />
          </svg>
        )}
        {stateName && <div className="phone-tag bottom state">{stateName}</div>}
        {diff && <div className={`phone-tag top ${diff.status.toLowerCase()}`}>{DIFF_TAG[diff.status]}</div>}
        {canSwap && (
          <div className={cn('phone-tag bottom side', hovered ? 'delta' : flip ? 'base' : 'head')}>
            {hovered
              ? diffImg ? `Δ ${diffImg.changed} changed${diffImg.moved ? ` · ${diffImg.moved} moved` : ''}` : 'computing…'
              : flip ? 'base' : 'head'}
          </div>
        )}
      </div>
      <div className="node-label">
        <span className="dot" />
        <span className="path" title={node.file ?? ''}>{node.urlPath}</span>
      </div>
      {states.length === 0 ? null : statePickable ? (
        <StatePicker states={states} active={activeState} baseDiffStatus={baseDiffStatus} onSelect={onStateSelect} />
      ) : (
        <div className="state-chip static" title="controlled by flow playback"><span className="lbl">{activeState ?? 'base screen'}</span></div>
      )}
      {badgeText && <div className="node-badge">{badgeText}</div>}
      <Handle type="source" position={Position.Bottom} className="port" />
    </div>
  )
}
