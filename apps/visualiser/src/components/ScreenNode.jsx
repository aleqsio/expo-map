import { useEffect, useRef, useState } from 'react'
import { Handle, Position } from '@xyflow/react'
import { visualDiff } from '../lib/visualDiff'

const BROKEN = {
  'error-boundary': { icon: '⛌', label: 'crashes on deep link' },
  'not-found': { icon: '∅', label: 'params hit nothing real' },
  loading: { icon: '◌', label: 'stuck loading' },
  'auth-wall': { icon: '🔒', label: 'behind sign-in' },
  missing: { icon: '⚠', label: 'no capture' },
}

function fixHint(node) {
  if (node.capture.note) return node.capture.note
  if (node.capture.needsNavigation) return 'Reach via in-app navigation — see its flow.'
  if (node.capture.status === 'loading') return 'Re-capture with a longer wait or real data.'
  return 'Re-run the sweep for this route.'
}

const DIFF_TAG = { A: '+ added', M: '± changed', D: '− removed' }
const STATE_DIFF = new Set(['A', 'M', 'D']) // 'unchanged' and null get no dot

function StatusDot({ status }) {
  if (!STATE_DIFF.has(status)) return null
  return <span className={`st-dot st-${status.toLowerCase()}`} />
}

// Custom dropdown for a node's capture states. Each option carries a status
// dot (amber = changed, green = added, red = removed); the trigger shows the
// active state's dot and lights up amber when any state changed.
function StatePicker({ states, active, baseDiffStatus, onSelect }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (!ref.current?.contains(e.target)) setOpen(false)
    }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [open])

  const options = [
    { name: '', label: 'base screen', diff: baseDiffStatus },
    ...states.map((s) => ({ name: s.name, label: s.name, diff: s.diff ?? null })),
  ]
  const activeName = active ?? ''
  const current = options.find((o) => o.name === activeName) ?? options[0]
  const anyDiff = options.some((o) => STATE_DIFF.has(o.diff))

  return (
    <div
      ref={ref}
      className={`state-picker nodrag nopan ${anyDiff ? 'has-diff' : ''} ${open ? 'open' : ''}`}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button className="sp-trigger" onClick={() => setOpen((o) => !o)} title="switch displayed state">
        <StatusDot status={current.diff} />
        <span className="sp-label">{current.label}</span>
        <span className="sp-chev">▾</span>
      </button>
      {open && (
        <div className="sp-menu">
          {options.map((o) => (
            <button
              key={o.name}
              className={`sp-item ${o.name === activeName ? 'on' : ''}`}
              onClick={() => {
                onSelect?.(o.name)
                setOpen(false)
              }}
            >
              <span className="sp-check">{o.name === activeName ? '✓' : ''}</span>
              <span className="sp-label">{o.label}</span>
              <StatusDot status={o.diff} />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function ScreenNode({ data, selected }) {
  const { node, img, imgBase = null, states = [], baseStates = [], badgeText, hue, dimmed, onPath, isCurrent, stateName, chosenState, gesture, onStateSelect, diffMode, diff, baseDiffStatus = null, flip = false } = data
  const broken = BROKEN[node.capture.status]

  // flow playback wins over the manual dropdown; '' = base capture
  const activeState = stateName ?? chosenState
  const shown = activeState ? states.find((s) => s.name === activeState)?.img ?? img : img

  // in-place comparator for changed screens: alternate base/head on the shared
  // 2s clock; on hover freeze and show the red changed-pixels render instead
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

  const cls = [
    'screen-node',
    dimmed ? 'dimmed' : '',
    onPath ? 'on-path' : '',
    isCurrent ? 'current' : '',
    selected ? 'selected' : '',
    diff ? `diff-${diff.status.toLowerCase()}` : diffMode ? 'diff-unchanged' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} style={{ '--group-hue': hue }}>
      <Handle type="target" position={Position.Top} className="port" />
      <div
        className={`phone ${broken ? 'broken' : ''}`}
        onMouseEnter={canSwap ? () => setHovered(true) : undefined}
        onMouseLeave={canSwap ? () => setHovered(false) : undefined}
      >
        {displayed ? (
          <img src={displayed} alt={node.urlPath} draggable={false} />
        ) : (
          <div className="no-shot">
            <span>{node.capture.status === 'missing' ? 'no capture' : node.capture.status}</span>
          </div>
        )}
        {broken && !activeState && (
          <div className="fix-overlay">
            <span className="fix-icon">{broken.icon}</span>
            <span className="fix-status">{broken.label}</span>
            <span className="fix-hint">{fixHint(node)}</span>
          </div>
        )}
        {gesture?.type === 'tap' && (
          <div
            className="tap-marker"
            style={{ left: `${gesture.x * 100}%`, top: `${gesture.y * 100}%` }}
            title={gesture.label ?? 'tap'}
          />
        )}
        {gesture?.type === 'swipe' && (
          <svg className="swipe-marker" viewBox="0 0 100 100" preserveAspectRatio="none">
            <defs>
              <marker id="swipe-head" viewBox="0 0 8 8" refX="6" refY="4" markerWidth="5" markerHeight="5" orient="auto">
                <path d="M0,0 L8,4 L0,8 z" fill="#67e8f9" />
              </marker>
            </defs>
            <line
              x1={gesture.x1 * 100} y1={gesture.y1 * 100}
              x2={gesture.x2 * 100} y2={gesture.y2 * 100}
              markerEnd="url(#swipe-head)"
            />
          </svg>
        )}
        {stateName && <div className="state-tag">{stateName}</div>}
        {diff && <div className={`diff-tag chg-${diff.status.toLowerCase()}`}>{DIFF_TAG[diff.status]}</div>}
        {canSwap && (
          <div className={`swap-tag ${hovered ? 'delta' : flip ? 'base' : 'head'}`}>
            {hovered
              ? diffImg
                ? `Δ ${diffImg.changed} changed${diffImg.moved ? ` · ${diffImg.moved} moved` : ''}`
                : 'computing…'
              : flip ? 'base' : 'head'}
          </div>
        )}
      </div>
      <div className="label">
        <span className="dot" />
        <span className="path" title={node.file ?? ''}>{node.urlPath}</span>
      </div>
      {states.length > 0 && !stateName && !isCurrent ? (
        <StatePicker
          states={states}
          active={activeState}
          baseDiffStatus={baseDiffStatus}
          onSelect={onStateSelect}
        />
      ) : states.length > 0 && (stateName || isCurrent) ? (
        <div className="state-select static" title="controlled by flow playback">
          {activeState ?? 'base screen'}
        </div>
      ) : null}
      {badgeText && <div className="badge-row">{badgeText}</div>}
      <Handle type="source" position={Position.Bottom} className="port" />
    </div>
  )
}
