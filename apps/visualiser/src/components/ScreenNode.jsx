import { Handle, Position } from '@xyflow/react'

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

export default function ScreenNode({ data, selected }) {
  const { node, img, states = [], badgeText, hue, dimmed, onPath, isCurrent, stateName, chosenState, gesture, onStateSelect } = data
  const broken = BROKEN[node.capture.status]

  // flow playback wins over the manual dropdown; '' = base capture
  const activeState = stateName ?? chosenState
  const shown = activeState ? states.find((s) => s.name === activeState)?.img ?? img : img

  const cls = [
    'screen-node',
    dimmed ? 'dimmed' : '',
    onPath ? 'on-path' : '',
    isCurrent ? 'current' : '',
    selected ? 'selected' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <div className={cls} style={{ '--group-hue': hue }}>
      <Handle type="target" position={Position.Top} className="port" />
      <div className={`phone ${broken ? 'broken' : ''}`}>
        {shown ? (
          <img src={shown} alt={node.urlPath} draggable={false} />
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
      </div>
      <div className="label">
        <span className="dot" />
        <span className="path" title={node.file ?? ''}>{node.urlPath}</span>
      </div>
      {states.length > 0 && !stateName && !isCurrent ? (
        <select
          className="state-select nodrag nopan"
          value={activeState ?? ''}
          onChange={(e) => onStateSelect?.(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          title="switch displayed state"
        >
          <option value="">base screen</option>
          {states.map((s) => (
            <option key={s.name} value={s.name}>{s.name}</option>
          ))}
        </select>
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
