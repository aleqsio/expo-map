import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Background, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow, ReactFlowProvider } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import ScreenNode from './components/ScreenNode'
import { flowResolution, isInteractive, loadBundle, mergeBundles } from './lib/loadBundle'
import { layoutGraph, NODE_H, NODE_W } from './lib/layout'
import { flowForNode, replayCommand } from './lib/replay'

const nodeTypes = { screen: ScreenNode }

function hueFor(group) {
  let h = 0
  for (const c of group) h = (h * 31 + c.charCodeAt(0)) % 360
  return h
}

function statusBadge(node) {
  const c = node.capture
  if (c.needsNavigation) return '⚠ needs navigation'
  if (c.status && c.status !== 'ok') return `⚠ ${c.status}`
  return null
}

const DIFF_LABEL = { A: 'added', M: 'changed', D: 'removed' }

function Graph({ bundle, onOpenBuffer, onCloseDiff }) {
  const { manifest, map, images, diff } = bundle
  const diffMode = !!diff
  const [positions, setPositions] = useState(null)
  const [selectedFlow, setSelectedFlow] = useState(null)
  const [step, setStep] = useState(0)
  const [selectedNode, setSelectedNode] = useState(null)
  const [selectedEdge, setSelectedEdge] = useState(null) // { key, from, to, raws }
  // nodeId → chosen state name. In diff mode, screens whose bare capture is
  // unaffected but carry a changed state open ON that state — the change is
  // visible immediately instead of hiding behind the dropdown.
  const [chosenStates, setChosenStates] = useState(() => {
    if (!diff) return {}
    const init = {}
    const changed = (s) => ['A', 'M', 'D'].includes(s?.status)
    for (const n of map.nodes) {
      if (!n.stateDiff || changed(n.stateDiff[''])) continue
      const first = Object.entries(n.stateDiff).find(([name, sd]) => name !== '' && changed(sd))
      if (first) init[n.id] = first[0]
    }
    return init
  })
  const [neighboursMode, setNeighboursMode] = useState(false)
  const [toast, setToast] = useState(null)
  const [flowsOpen, setFlowsOpen] = useState(() => window.innerWidth > 900)
  const toastTimer = useRef(null)
  const { fitView, setCenter, getZoom } = useReactFlow()

  // shared clock for the in-place base/head comparator on changed screens —
  // one interval so every node flips in sync
  const [flip, setFlip] = useState(false)
  useEffect(() => {
    if (!diffMode) return
    const t = setInterval(() => setFlip((f) => !f), 1000)
    return () => clearInterval(t)
  }, [diffMode])

  const { paths, nodeAtStep } = useMemo(() => flowResolution(map), [map])
  const routeById = useMemo(() => Object.fromEntries(map.nodes.map((n) => [n.id, n])), [map])
  const flow = selectedFlow ? map.flows.find((f) => f.name === selectedFlow) : null
  const path = flow ? paths[flow.name] ?? [] : []

  // transitions observed in flow recordings but absent from static analysis
  // (e.g. drawer links living in shared components) — permanent dashed edges
  const observedEdges = useMemo(() => {
    const staticKeys = new Set(map.edges.filter((e) => e.to).map((e) => `${e.from}→${e.to}`))
    const out = new Map()
    for (const f of map.flows) {
      const at = nodeAtStep[f.name] ?? []
      ;(f.steps ?? []).forEach((st, i) => {
        if ((st.action === 'tap' || st.action === 'swipe') && st.screen) {
          const from = at[i - 1] ?? f.route
          if (!from || from === st.screen) return
          const key = `${from}→${st.screen}`
          if (staticKeys.has(key)) return
          if (!out.has(key)) out.set(key, { key, from, to: st.screen, raws: [], observed: true, flows: [] })
          if (!out.get(key).flows.includes(f.name)) out.get(key).flows.push(f.name)
        }
      })
    }
    return [...out.values()]
  }, [map, nodeAtStep])

  useEffect(() => {
    layoutGraph(map.nodes, [...map.edges, ...observedEdges]).then(setPositions)
  }, [map, observedEdges])

  // neighbours mode: the subject screen + everything one action away
  const subjectId = selectedNode ?? flow?.route ?? null
  const neighbourhood = useMemo(() => {
    if (!neighboursMode || !subjectId) return null
    const nodes = new Set([subjectId])
    const edgeKeys = new Set()
    for (const e of [...map.edges, ...observedEdges]) {
      if (!e.to || e.from !== subjectId || e.to === subjectId) continue
      nodes.add(e.to)
      edgeKeys.add(`${e.from}→${e.to}`)
    }
    return { nodes, edgeKeys }
  }, [neighboursMode, subjectId, map, observedEdges])

  useEffect(() => {
    if (!neighbourhood) return
    fitView({ nodes: [...neighbourhood.nodes].map((id) => ({ id })), padding: 0.3, duration: 500 })
  }, [neighbourhood, fitView])

  // playhead → which node is "current", which state capture is showing, and the
  // gesture (tap/swipe position) the current step performs on that screen
  const { currentNodeId, stateOverrides, gesture } = useMemo(() => {
    if (!flow) return { currentNodeId: null, stateOverrides: {}, gesture: null }
    const overrides = {}
    for (let i = 0; i <= step && i < flow.steps.length; i++) {
      const st = flow.steps[i]
      if (st.action === 'screenshot' && st.file) {
        const owner = map.nodes.find((n) =>
          n.capture.states.some((s) => s.screenshot === 'screens/' + st.file)
        )
        if (owner) {
          const state = owner.capture.states.find((s) => s.screenshot === 'screens/' + st.file)
          overrides[owner.id] = state
        }
      }
    }
    // each position is a screen STATE; the gesture drawn on it is the NEXT
    // action performed from that state (tap ripples belong to the screen you
    // tap ON, not the screen the tap lands on)
    const HIDDEN = ['wait', 'screenshot']
    let ni = step + 1
    while (ni < flow.steps.length && HIDDEN.includes(flow.steps[ni]?.action)) ni++
    const st = flow.steps[ni]
    const pt = flow.pointSize ?? [402, 874] // device points of the recorded device
    let g = null
    if (st?.action === 'tap' && st.coordinate)
      g = { type: 'tap', x: st.coordinate[0] / pt[0], y: st.coordinate[1] / pt[1], label: st.target }
    else if (st?.action === 'swipe' && st.from && st.to)
      g = {
        type: 'swipe',
        x1: st.from[0] / pt[0], y1: st.from[1] / pt[1],
        x2: st.to[0] / pt[0], y2: st.to[1] / pt[1],
      }
    const cur = nodeAtStep[flow.name]?.[step] ?? flow.route ?? path[0] ?? null
    return { currentNodeId: cur, stateOverrides: overrides, gesture: g }
  }, [flow, step, path, map, nodeAtStep])

  // when an edge is selected: does any recorded flow tap through this exact
  // transition? If so we know WHERE on the source screen the trigger sits.
  const edgeGesture = useMemo(() => {
    if (!selectedEdge) return null
    for (const f of map.flows) {
      const steps = f.steps ?? []
      const at = nodeAtStep[f.name] ?? []
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]
        if (
          st.action === 'tap' && st.coordinate && st.screen === selectedEdge.to &&
          (at[i - 1] ?? f.route) === selectedEdge.from
        ) {
          const pt = f.pointSize ?? [402, 874]
          return { type: 'tap', x: st.coordinate[0] / pt[0], y: st.coordinate[1] / pt[1], label: st.target }
        }
      }
    }
    return null
  }, [selectedEdge, map, nodeAtStep])

  // the playhead scrubs only meaningful steps (open_url/tap/swipe/…) — waits and
  // screenshot bookkeeping are absorbed into the preceding visible step
  const stepView = useMemo(() => {
    if (!flow) return null
    const HIDDEN = ['wait', 'screenshot']
    const visibleIdx = flow.steps.map((_, i) => i).filter((i) => !HIDDEN.includes(flow.steps[i].action))
    if (!visibleIdx.length) visibleIdx.push(0)
    const effectiveEnd = (k) => (visibleIdx[k + 1] ?? flow.steps.length) - 1
    const pos = Math.max(0, visibleIdx.filter((i) => i <= step).length - 1)
    return {
      visibleIdx,
      effectiveEnd,
      pos,
      visStep: flow.steps[visibleIdx[pos]],
      nextStep: flow.steps[visibleIdx[pos + 1]] ?? null,
    }
  }, [flow, step])

  // focus a node by panning/zooming straight to its layout position — bypasses
  // fitView, which silently no-ops in some store states; setCenter (the same
  // primitive the minimap uses) always lands
  const focusNode = useCallback(
    (id) => {
      const pos = positions?.[id]
      if (!pos) return
      const zoom = Math.max(getZoom(), Math.min(1.8, (window.innerHeight * 0.85) / NODE_H))
      setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom, duration: 500 })
    },
    [positions, setCenter, getZoom]
  )

  const showToast = useCallback((msg) => {
    clearTimeout(toastTimer.current)
    setToast(msg)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  const [commandSheet, setCommandSheet] = useState(null)
  const copyFlow = useCallback(
    (f) => {
      if (!f) return showToast('No flow recorded for this screen')
      const cmd = replayCommand(f, manifest.app.name)
      navigator.clipboard.writeText(cmd).then(
        () => showToast(`Copied replay · ${f.name}${isInteractive(f) ? ' (interactive)' : ''}`),
        () => setCommandSheet({ flow: f, cmd })
      )
    },
    [manifest, showToast]
  )

  // used on NODE CLICK when the node has a manually chosen state: activates the
  // flow that produced that state, at the exact step that captured it. Returns
  // false when no flow owns the capture.
  const jumpToState = useCallback(
    (nodeId, stateName) => {
      const node = map.nodes.find((n) => n.id === nodeId)
      const state = node?.capture.states.find((s) => s.name === stateName)
      if (!state) return false
      for (const f of map.flows) {
        const idx = (f.steps ?? []).findIndex(
          (st) => st.action === 'screenshot' && 'screens/' + st.file === state.screenshot
        )
        if (idx >= 0) {
          setSelectedFlow(f.name)
          setStep(idx)
          return true
        }
      }
      return false
    },
    [map]
  )

  const rfNodes = useMemo(() => {
    if (!positions) return []
    return map.nodes.map((n) => {
      const override = stateOverrides[n.id]
      // state options with their diff status; base-only (removed) variants are
      // appended so the dropdown can still show what disappeared
      const stateList = n.capture.states.map((s) => ({
        name: s.name,
        img: images.get(s.screenshot),
        diff: n.stateDiff?.[s.name]?.status ?? null,
      }))
      if (diffMode && n.stateDiff) {
        for (const [name, sd] of Object.entries(n.stateDiff)) {
          if (name === '' || stateList.some((s) => s.name === name)) continue
          const baseState = (n.captureBase?.states ?? []).find((s) => s.name === name)
          if (baseState) stateList.push({ name, img: images.get(baseState.screenshot), diff: sd.status })
        }
      }
      return {
        id: n.id,
        type: 'screen',
        position: positions[n.id] ?? { x: 0, y: 0 },
        width: NODE_W,
        height: NODE_H,
        selected: n.id === selectedNode,
        data: {
          node: n,
          img: n.capture.screenshot ? images.get(n.capture.screenshot) : null,
          imgBase: n.captureBase?.screenshot ? images.get(n.captureBase.screenshot) : null,
          states: stateList,
          baseStates: (n.captureBase?.states ?? []).map((s) => ({ name: s.name, img: images.get(s.screenshot) })),
          baseDiffStatus: n.stateDiff?.['']?.status ?? null,
          flip,
          stateName: override?.name ?? null,
          chosenState: chosenStates[n.id] ?? null,
          onStateSelect: (stateName) =>
            setChosenStates((prev) => ({ ...prev, [n.id]: stateName || undefined })),
          badgeText: statusBadge(n),
          diffMode,
          diff: n.diff ?? null,
          hue: hueFor(n.group || 'root'),
          dimmed: neighbourhood
            ? !neighbourhood.nodes.has(n.id)
            : (!!flow && !path.includes(n.id)) ||
              (!!selectedEdge && n.id !== selectedEdge.from && n.id !== selectedEdge.to),
          onPath: neighbourhood
            ? neighbourhood.nodes.has(n.id) && n.id !== subjectId
            : (!!flow && path.includes(n.id)) ||
              (!!selectedEdge && (n.id === selectedEdge.from || n.id === selectedEdge.to)),
          isCurrent: neighbourhood ? n.id === subjectId : n.id === currentNodeId,
          gesture: neighbourhood
            ? null
            : flow ? (n.id === currentNodeId ? gesture : null)
            : selectedEdge && n.id === selectedEdge.from ? edgeGesture
            : null,
        },
      }
    })
  }, [positions, map, images, flow, path, currentNodeId, stateOverrides, selectedNode, chosenStates, selectedEdge, edgeGesture, neighbourhood, subjectId, diffMode, flip])

  const rfEdges = useMemo(() => {
    const infos = new Map()
    for (const e of map.edges) {
      if (!e.to || e.from === e.to) continue
      const key = `${e.from}→${e.to}`
      if (!infos.has(key)) infos.set(key, { key, from: e.from, to: e.to, raws: [] })
      const info = infos.get(key)
      if (e.raw && !info.raws.includes(e.raw)) info.raws.push(e.raw)
      if (e.diffStatus) info.diffStatus = e.diffStatus
    }
    for (const oe of observedEdges) infos.set(oe.key, oe)
    const anySelection = !!flow || !!selectedEdge || !!neighbourhood
    const out = []
    for (const info of infos.values()) {
      const onPath = neighbourhood
        ? neighbourhood.edgeKeys.has(info.key)
        : flow && path.some((id, i) => id === info.from && path[i + 1] === info.to)
      const active = onPath || (!neighbourhood && selectedEdge?.key === info.key)
      out.push({
        id: info.key,
        source: info.from,
        target: info.to,
        animated: !!active,
        className: `${active ? 'edge-on-path' : anySelection ? 'edge-faded' : 'edge-normal'}${info.observed ? ' edge-observed' : ''}${info.diffStatus === 'A' ? ' edge-added' : info.diffStatus === 'D' ? ' edge-removed' : ''}`,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 16,
          height: 16,
          color: active ? '#a5b4fc' : anySelection ? 'rgba(255,255,255,0.08)' : 'rgba(255,255,255,0.3)',
        },
        data: info,
      })
    }
    // synthetic edges for flow hops with no static link
    if (flow) {
      for (let i = 0; i + 1 < path.length; i++) {
        const key = `${path[i]}→${path[i + 1]}`
        if (!infos.has(key)) {
          out.push({
            id: 'syn-' + key,
            source: path[i],
            target: path[i + 1],
            animated: true,
            className: 'edge-on-path edge-synthetic',
            markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: '#a5b4fc' },
          })
        }
      }
    }
    return out
  }, [map, flow, path, selectedEdge, observedEdges, neighbourhood])

  const selectFlow = useCallback(
    (name) => {
      setSelectedFlow((cur) => (cur === name ? null : name))
      const f = name ? map.flows.find((x) => x.name === name) : null
      setStep(Math.max(0, (f?.steps?.length ?? 1) - 1)) // open at arrival; replay button rewinds
      setSelectedNode(null)
      setSelectedEdge(null)
      setNeighboursMode(false)
    },
    [map]
  )

  useEffect(() => {
    document.querySelector('.flow-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [selectedFlow])

  // camera follows the playhead: every step focuses the screen it acts on
  useEffect(() => {
    if (!flow || !currentNodeId || neighboursMode) return
    fitView({ nodes: [{ id: currentNodeId }], padding: 0.5, duration: 450, maxZoom: 1.15 })
  }, [flow, currentNodeId, fitView, neighboursMode])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSelectedEdge(null)
        setSelectedNode(null)
        setSelectedFlow(null)
        setNeighboursMode(false)
        return
      }
      if (!flow || !stepView) return
      if (e.key === 'ArrowRight')
        setStep(stepView.effectiveEnd(Math.min(stepView.pos + 1, stepView.visibleIdx.length - 1)))
      if (e.key === 'ArrowLeft') setStep(stepView.effectiveEnd(Math.max(stepView.pos - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flow, selectFlow, stepView])

  const interactiveFlows = map.flows.filter(isInteractive)
  const stats = {
    screens: map.nodes.length,
    captured: map.nodes.filter((n) => n.capture.screenshot && (n.capture.status ?? 'ok') === 'ok').length,
    flows: map.flows.length,
  }
  const diffStats = diffMode
    ? {
        A: diff.nodes.filter((n) => n.status === 'A').length,
        M: diff.nodes.filter((n) => n.status === 'M').length,
        D: diff.nodes.filter((n) => n.status === 'D').length,
        edges: diff.edges.length,
      }
    : null
  const selectedDiffNode = diffMode && selectedNode ? map.nodes.find((n) => n.id === selectedNode) : null

  if (!positions) return <div className="loading">laying out {map.nodes.length} screens…</div>

  return (
    <div className="graph-root">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.1 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, n) => {
          setSelectedEdge(null)
          setNeighboursMode(false)
          if (selectedNode === n.id) {
            setSelectedNode(null)
            setSelectedFlow(null)
            return
          }
          setSelectedNode(n.id)
          // a manually chosen state wins: open the flow that produced it, at
          // the step that captured it
          const chosen = chosenStates[n.id]
          if (chosen && jumpToState(n.id, chosen)) return
          const f = flowForNode(map, n.id)
          if (f) {
            // select the flow that ARRIVES at this screen, opened at its last
            // step — scrub backwards to see how you got here
            setSelectedFlow(f.name)
            setStep(Math.max(0, (f.steps?.length ?? 1) - 1))
          } else {
            setSelectedFlow(null)
            // diff review wants the screen big enough to actually read the
            // base⇄head flip; plain maps keep the gentler context zoom
            if (diffMode) focusNode(n.id)
            else fitView({ nodes: [{ id: n.id }], padding: 0.6, duration: 500, maxZoom: 1.1 })
          }
        }}
        onPaneClick={() => {
          setSelectedNode(null)
          setSelectedFlow(null)
          setSelectedEdge(null)
          setNeighboursMode(false)
        }}
        onEdgeClick={(_, e) => {
          if (!e.data?.key) return
          setSelectedFlow(null)
          setSelectedNode(null)
          setNeighboursMode(false)
          setSelectedEdge((cur) => {
            if (cur?.key === e.data.key) return null
            fitView({ nodes: [{ id: e.data.from }, { id: e.data.to }], padding: 0.45, duration: 500 })
            return e.data
          })
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background gap={28} size={1.6} color="rgba(255,255,255,0.05)" />
        <Controls showInteractive={false} />
        <MiniMap
          pannable
          zoomable
          onClick={(_, pos) => setCenter(pos.x, pos.y, { duration: 400, zoom: Math.max(getZoom(), 0.55) })}
          nodeColor={(n) => `hsl(${n.data?.hue ?? 220} 60% 45%)`}
          maskColor="rgba(8,10,15,0.82)"
          bgColor="rgba(14,17,23,0.9)"
        />
      </ReactFlow>

      <header className="hud hud-top">
        <div className="brand">
          <span className="mark" />
          <div>
            <h1>
              {manifest.app.name}
              {diffMode && (
                <span className="diff-mode-tag">
                  {manifest.pr ? `PR #${manifest.pr.number}` : 'diff'}
                </span>
              )}
            </h1>
            <p className="sub">
              {diffMode
                ? `${manifest.pr?.title ??
                    `${(manifest.base?.commit ?? 'base').slice(0, 7)} → ${(manifest.head?.commit ?? 'head').slice(0, 7)}`}${bundle.backdrop ? ' · over full map' : ''}`
                : `${manifest.app.mode} · ${manifest.app.device ?? 'unknown device'} · ${new Date(manifest.generatedAt).toLocaleDateString()}`}
            </p>
          </div>
        </div>
        {diffMode ? (
          <div className="stats">
            <span className="diff-a"><b>+{diffStats.A}</b> added</span>
            <span className="diff-m"><b>±{diffStats.M}</b> changed</span>
            <span className="diff-d"><b>−{diffStats.D}</b> removed</span>
            <span><b>{diffStats.edges}</b> edge{diffStats.edges === 1 ? '' : 's'}</span>
          </div>
        ) : (
          <div className="stats">
            <span><b>{stats.screens}</b> screens</span>
            <span><b>{stats.captured}</b> captured</span>
            <span><b>{stats.flows}</b> flows</span>
          </div>
        )}
        <label className="open-chip" title="open a different .appmap or .appmapdiff bundle">
          <input
            type="file"
            accept=".appmap,.appmapdiff,.zip"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) onOpenBuffer(await f.arrayBuffer())
              e.target.value = ''
            }}
          />
          ⇆ open bundle
        </label>
        {diffMode && (
          <button className="open-chip" title="close the diff overlay" onClick={onCloseDiff}>
            ✕ close diff
          </button>
        )}
      </header>

      <aside className={`hud flows-panel ${flowsOpen ? '' : 'collapsed'}`}>
        <button className="panel-head" onClick={() => setFlowsOpen((o) => !o)}>
          <h2>{diffMode ? 'Changes' : 'Agent flows'}</h2>
          <span className="chev">{flowsOpen ? '−' : '+'}</span>
        </button>
        {flowsOpen && diffMode && (
          <div className="flow-list">
            {diff.nodes.map((d) => (
              <button
                key={d.id}
                className={`flow-item ${selectedNode === d.id ? 'active' : ''}`}
                onClick={(e) => {
                  e.currentTarget.blur()
                  setSelectedEdge(null)
                  setSelectedNode(d.id)
                  focusNode(d.id)
                }}
                title={d.reason}
              >
                <span className={`chg-badge chg-${d.status.toLowerCase()}`}>
                  {d.status === 'A' ? '+' : d.status === 'D' ? '−' : '±'}
                </span>
                <span className="flow-name">{routeById[d.id]?.urlPath ?? d.id}</span>
              </button>
            ))}
            {diff.broadFiles?.length > 0 && (
              <p className="broad-note" title={diff.broadFiles.map((b) => b.file).join('\n')}>
                {diff.broadFiles.length} broadly-imported changed file
                {diff.broadFiles.length === 1 ? '' : 's'} excluded from suspect marking
              </p>
            )}
          </div>
        )}
        {flowsOpen && !diffMode && (
          <div className="flow-list">
            {interactiveFlows.map((f) => (
              <button
                key={f.name}
                className={`flow-item ${selectedFlow === f.name ? 'active' : ''}`}
                onClick={(e) => { e.currentTarget.blur(); selectFlow(f.name) }}
                title={f.title}
              >
                <span className="flow-kind interactive">✦</span>
                <span className="flow-name">{f.title ?? f.name}</span>
              </button>
            ))}
          </div>
        )}
      </aside>

      {flow && (
        <footer className="hud playhead">
          <div className="ph-title">
            <b>
              {neighboursMode
                ? `Neighbours of ${routeById[subjectId]?.urlPath ?? subjectId}`
                : flow.title ?? flow.name}
            </b>
            {(() => {
              const nav = map.flows.find((f) => f.route === flow.route && f.name.startsWith('nav-'))
              const visit = map.flows.find((f) => f.route === flow.route && f.name.startsWith('visit-'))
              const pick = (f) => {
                setNeighboursMode(false)
                setSelectedFlow(f.name)
                setStep(Math.max(0, (f.steps?.length ?? 1) - 1))
              }
              // mode semantics: any interactive flow (nav-* or a recorded
              // interaction) is "navigate" mode; visit-* is "deep link"
              const isVisit = flow.name.startsWith('visit-')
              return (
                <div className="ph-toggle">
                  {(nav || !isVisit) && (
                    <button
                      className={!neighboursMode && !isVisit ? 'on' : ''}
                      onClick={() => nav && pick(nav)}
                    >navigate</button>
                  )}
                  {visit && (
                    <button className={!neighboursMode && isVisit ? 'on' : ''} onClick={() => pick(visit)}>deep link</button>
                  )}
                  <button className={neighboursMode ? 'on' : ''} onClick={() => setNeighboursMode(true)}>neighbours</button>
                </div>
              )
            })()}
            {!neighboursMode && <span className="ph-count">{stepView.pos + 1} / {stepView.visibleIdx.length}</span>}
          </div>
          {neighboursMode ? (
            <p className="ph-step">
              {(neighbourhood?.nodes.size ?? 1) - 1} screen{(neighbourhood?.nodes.size ?? 1) - 1 === 1 ? '' : 's'} reachable
              in one action — highlighted with their edges
            </p>
          ) : (
            <>
          <div className="ph-controls">
            <button className="ph-replay" title="replay from the first step" onClick={() => setStep(stepView.effectiveEnd(0))} disabled={stepView.pos === 0}>↺</button>
            <button onClick={() => setStep(stepView.effectiveEnd(Math.max(stepView.pos - 1, 0)))} disabled={stepView.pos === 0}>‹</button>
            <div className="ph-dots">
              {stepView.visibleIdx.map((si, k) => (
                <button
                  key={si}
                  className={`ph-dot ${k === stepView.pos ? 'now' : k < stepView.pos ? 'done' : ''}`}
                  onClick={() => setStep(stepView.effectiveEnd(k))}
                  title={flow.steps[si].action}
                />
              ))}
            </div>
            <button
              onClick={() => setStep(stepView.effectiveEnd(Math.min(stepView.pos + 1, stepView.visibleIdx.length - 1)))}
              disabled={stepView.pos === stepView.visibleIdx.length - 1}
            >›</button>
          </div>
          <div className="ph-step-row">
            <p className="ph-step">
              {(() => {
                const describe = (st) => {
                  if (st.action === 'open_url') return `deep link ${st.url}`
                  if (st.action === 'tap') return `tap ${st.target ?? st.coordinate?.join(',')}`
                  if (st.action === 'swipe') return `swipe ${st.from?.join(',')} → ${st.to?.join(',')}`
                  return st.action
                }
                return stepView.nextStep
                  ? describe(stepView.nextStep)
                  : `arrived — ${describe(stepView.visStep)}`
              })()}
            </p>
            <button className="ph-copy" onClick={() => copyFlow(flow)}>Copy replay</button>
          </div>
            </>
          )}
        </footer>
      )}

      {selectedDiffNode && !selectedEdge && (
        <footer className="hud diff-card">
          <div className="tc-route">
            {selectedDiffNode.diff && (
              <span className={`chg-badge chg-${selectedDiffNode.diff.status.toLowerCase()}`}>
                {selectedDiffNode.diff.status === 'A' ? '+' : selectedDiffNode.diff.status === 'D' ? '−' : '±'}
              </span>
            )}
            <span className="tc-screen">{selectedDiffNode.urlPath}</span>
            <span className="dc-status">
              {selectedDiffNode.diff ? DIFF_LABEL[selectedDiffNode.diff.status] : 'unchanged in this diff'}
            </span>
          </div>
          {selectedDiffNode.diff?.note && <p className="dc-note">{selectedDiffNode.diff.note}</p>}
          {selectedDiffNode.diff && (
            <div className="tc-triggers">
              <span className="tc-file">{selectedDiffNode.diff.reason}</span>
              {(selectedDiffNode.diff.via ?? []).map((f) => (
                <code key={f}>{f}</code>
              ))}
            </div>
          )}
          {(() => {
            const marks = { A: '+', M: '±', D: '−' }
            const states = (diff.states ?? []).filter((s) => s.node === selectedDiffNode.id && marks[s.status])
            if (!states.length) return null
            return (
              <div className="tc-triggers">
                {states.map((s) => (
                  <code key={s.name + s.status} className={`chg-${s.status.toLowerCase()}`} title={s.note ?? undefined}>
                    {marks[s.status]} {s.name === '' ? 'base screen' : s.name}
                  </code>
                ))}
              </div>
            )
          })()}
        </footer>
      )}

      {selectedEdge && !flow && (
        <footer className="hud transition-card">
          <div className="tc-route">
            {selectedEdge.diffStatus && (
              <span className={`chg-badge chg-${selectedEdge.diffStatus.toLowerCase()}`}>
                {selectedEdge.diffStatus === 'A' ? '+' : '−'}
              </span>
            )}
            <span className="tc-screen">{routeById[selectedEdge.from]?.urlPath ?? selectedEdge.from}</span>
            <span className="tc-arrow">⟶</span>
            <span className="tc-screen">{routeById[selectedEdge.to]?.urlPath ?? selectedEdge.to}</span>
          </div>
          <div className="tc-triggers">
            {selectedEdge.observed ? (
              <>
                <span className="tc-file">not in static code analysis — observed by the agent in</span>
                {selectedEdge.flows.slice(0, 3).map((f) => (
                  <code key={f}>{f}</code>
                ))}
                {selectedEdge.flows.length > 3 && (
                  <span className="tc-file">+{selectedEdge.flows.length - 3} more flows</span>
                )}
              </>
            ) : (
              <>
                {selectedEdge.raws.map((r) => (
                  <code key={r}>{r}</code>
                ))}
                <span className="tc-file">in {routeById[selectedEdge.from]?.file}</span>
              </>
            )}
          </div>
          <p className={`tc-note ${edgeGesture ? 'known' : ''}`}>
            {edgeGesture
              ? '◉ trigger position shown on the source screen'
              : 'trigger position not recorded — an interactive flow through this transition would pin it'}
          </p>
        </footer>
      )}

      {commandSheet && (
        <div className="sheet-scrim" onClick={() => setCommandSheet(null)}>
          <div className="command-sheet" onClick={(e) => e.stopPropagation()}>
            <h2>Replay · {commandSheet.flow.title ?? commandSheet.flow.name}</h2>
            <pre>{commandSheet.cmd}</pre>
            <div className="sheet-actions">
              <button
                className="copy-btn"
                onClick={() =>
                  navigator.clipboard.writeText(commandSheet.cmd).then(
                    () => { showToast('Copied'); setCommandSheet(null) },
                    () => showToast('Select the text and copy manually')
                  )
                }
              >
                Copy
              </button>
              <button className="ghost-btn" onClick={() => setCommandSheet(null)}>Close</button>
            </div>
          </div>
        </div>
      )}

      <div className={`toast ${toast ? 'show' : ''}`}>{toast}</div>
    </div>
  )
}

export default function App() {
  // a plain .appmap and an .appmapdiff can be loaded side by side: the diff is
  // rendered overlaid on the plain bundle's captures (unchanged screens dimmed
  // but showing their real screenshots) whenever both describe the same app
  const [plain, setPlain] = useState(null)
  const [diffBundle, setDiffBundle] = useState(null)
  const [error, setError] = useState(null)
  const [dragging, setDragging] = useState(false)
  const [busy, setBusy] = useState(false)
  const [demoAvailable, setDemoAvailable] = useState(false)
  const [gen, setGen] = useState(0)

  const bundle = useMemo(() => {
    if (!diffBundle) return plain
    if (plain && plain.manifest.app.name === diffBundle.manifest.app.name)
      return mergeBundles(plain, diffBundle)
    return diffBundle
  }, [plain, diffBundle])

  // when a demo bundle ships with the deployment, open it straight away —
  // the landing page is only for instances with nothing baked in. It also
  // serves as the backdrop for a dropped .appmapdiff of the same app.
  useEffect(() => {
    fetch('demo.appmap', { method: 'HEAD' })
      .then(async (res) => {
        const type = res.headers.get('content-type') ?? ''
        const size = parseInt(res.headers.get('content-length') ?? '0', 10)
        // a real bundle, not an SPA-fallback index.html
        const ok = res.ok && !type.includes('text/html') && (size > 10000 || /zip|octet-stream/.test(type))
        setDemoAvailable(ok)
        if (ok) {
          const buf = await (await fetch('demo.appmap')).arrayBuffer()
          const demo = await loadBundle(buf)
          setPlain((cur) => cur ?? demo) // never clobber a user-opened bundle
        }
      })
      .catch(() => {})
  }, [])

  const open = useCallback(async (buffer) => {
    setBusy(true)
    try {
      const loaded = await loadBundle(buffer)
      if (loaded.diff) setDiffBundle(loaded)
      else setPlain(loaded)
      setGen((g) => g + 1) // remount the graph with clean selection state
      setError(null)
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [])

  const onDrop = useCallback(
    async (e) => {
      e.preventDefault()
      setDragging(false)
      const file = e.dataTransfer.files?.[0]
      if (file) open(await file.arrayBuffer())
    },
    [open]
  )

  // dropping a bundle anywhere — including over an already-open graph — loads
  // it; without this the browser's default kicks in and downloads the file
  useEffect(() => {
    const over = (e) => e.preventDefault()
    const drop = async (e) => {
      if (e.defaultPrevented) return // the landing drop zone already took it
      e.preventDefault()
      const f = e.dataTransfer?.files?.[0]
      if (f) open(await f.arrayBuffer())
    }
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragover', over)
      document.removeEventListener('drop', drop)
    }
  }, [open])

  if (bundle)
    return (
      <ReactFlowProvider key={gen}>
        <Graph
          bundle={bundle}
          onOpenBuffer={open}
          onCloseDiff={() => { setDiffBundle(null); setGen((g) => g + 1) }}
        />
      </ReactFlowProvider>
    )

  return (
    <div
      className={`landing ${dragging ? 'dragging' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDragging(true) }}
      onDragLeave={() => setDragging(false)}
      onDrop={onDrop}
    >
      <div className="landing-card">
        <span className="mark big" />
        <h1>appmap visualiser</h1>
        <p>Drop an <code>.appmap</code> bundle to explore your app as a living map — every screen, every link, every agent flow. Or drop an <code>.appmapdiff</code> to review what a PR changed.</p>
        <label className="drop-zone">
          <input
            type="file"
            accept=".appmap,.appmapdiff,.zip"
            onChange={async (e) => {
              const f = e.target.files?.[0]
              if (f) open(await f.arrayBuffer())
            }}
          />
          <span>{dragging ? 'drop it!' : 'drag a bundle here · or click to browse'}</span>
        </label>
        {demoAvailable && (
          <button
            className="demo-btn"
            disabled={busy}
            onClick={async () => {
              const res = await fetch('demo.appmap')
              open(await res.arrayBuffer())
            }}
          >
            {busy ? 'loading…' : 'load the demo bundle'}
          </button>
        )}
        {error && <p className="error">{error}</p>}
      </div>
    </div>
  )
}
