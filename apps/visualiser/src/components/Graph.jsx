import { useCallback, useEffect, useMemo, useState } from 'react'
import { Background, BackgroundVariant, Controls, MarkerType, MiniMap, ReactFlow, useReactFlow } from '@xyflow/react'
import { toast } from 'sonner'
import ScreenNode from './ScreenNode'
import TopBar from './TopBar'
import SidePanel from './SidePanel'
import { Playhead, TransitionCard, ChangeCard, CommandSheet } from './Dock'
import { flowResolution, isInteractive } from '../lib/loadBundle'
import { layoutGraph, NODE_H, NODE_W } from '../lib/layout'
import { flowForNode, replayCommand } from '../lib/replay'

const nodeTypes = { screen: ScreenNode }

// ?shot — headless-screenshot mode: no chrome, no comparator flip (head side
// frozen), viewport fitted to the changed nodes; window.__screenmapShotReady
// flips when the frame is worth capturing. Used by screenmap-ci to render the
// PR-comment image.
const SHOT = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('shot')

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

const HIDDEN_STEPS = ['wait', 'screenshot']

export default function Graph({ bundle, mode, setMode, hasChanges, overlaid, onOpenBuffer, onCloseChanges }) {
  const { manifest, map, images, diff } = bundle
  const diffMode = mode === 'changes' && !!diff
  const [positions, setPositions] = useState(null)
  const [selectedFlow, setSelectedFlow] = useState(null)
  const [step, setStep] = useState(0)
  const [selectedNode, setSelectedNode] = useState(null)
  const [selectedEdge, setSelectedEdge] = useState(null) // { key, from, to, raws }
  const [neighboursMode, setNeighboursMode] = useState(false)
  const [panelOpen, setPanelOpen] = useState(() => window.innerWidth > 900)
  const [commandSheet, setCommandSheet] = useState(null)
  const { fitView, setCenter, getZoom, flowToScreenPosition } = useReactFlow()

  // nodeId → chosen state name. In Changes mode, screens whose bare capture is
  // unaffected but carry a changed state open ON that state.
  const [chosenStates, setChosenStates] = useState(() => {
    if (!diffMode) return {}
    const init = {}
    const changed = (s) => ['A', 'M', 'D'].includes(s?.status)
    for (const n of map.nodes) {
      if (!n.stateDiff || changed(n.stateDiff[''])) continue
      const first = Object.entries(n.stateDiff).find(([name, sd]) => name !== '' && changed(sd))
      if (first) init[n.id] = first[0]
    }
    return init
  })

  // shared clock for the in-place base⇄head comparator on changed screens
  const [flip, setFlip] = useState(false)
  useEffect(() => {
    if (!diffMode || SHOT) return
    const t = setInterval(() => setFlip((f) => !f), 1000)
    return () => clearInterval(t)
  }, [diffMode])

  const { paths, nodeAtStep } = useMemo(() => flowResolution(map), [map])
  const routeById = useMemo(() => Object.fromEntries(map.nodes.map((n) => [n.id, n])), [map])
  const flow = selectedFlow ? map.flows.find((f) => f.name === selectedFlow) : null
  const path = flow ? paths[flow.name] ?? [] : []
  // Where the flow lands. Its state stays the viewer's to pick even mid-replay;
  // the screens the path merely passes through don't get a say — their state is
  // whatever playback put there.
  const flowTarget = flow ? flow.route ?? path[path.length - 1] ?? null : null

  // transitions observed in flow recordings but absent from static analysis
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

  // The subject screen + everything one action away. Computed whether or not
  // the lens is on, because the control that turns it on has to name the count
  // before you commit to it.
  const subjectId = selectedNode ?? flow?.route ?? null
  const neighbourSet = useMemo(() => {
    if (!subjectId) return null
    const nodes = new Set([subjectId])
    const edgeKeys = new Set()
    for (const e of [...map.edges, ...observedEdges]) {
      if (!e.to || e.from !== subjectId || e.to === subjectId) continue
      nodes.add(e.to)
      edgeKeys.add(`${e.from}→${e.to}`)
    }
    return { nodes, edgeKeys }
  }, [subjectId, map, observedEdges])
  // The lens. Null unless the mode is on, so everything downstream keeps
  // reading `neighbourhood ? ...` as "am I in neighbours mode".
  const neighbourhood = neighboursMode ? neighbourSet : null
  const neighbourCount = (neighbourSet?.nodes.size ?? 1) - 1

  useEffect(() => {
    if (!neighbourhood) return
    fitView({ nodes: [...neighbourhood.nodes].map((id) => ({ id })), padding: 0.3, duration: 500 })
  }, [neighbourhood, fitView])

  // Frame the two ends of a picked transition. This has to wait for the
  // selection to render: a fit from inside the click handler is undone by React
  // Flow's own re-fit when the fresh node list lands.
  useEffect(() => {
    if (!selectedEdge) return
    fitView({ nodes: [{ id: selectedEdge.from }, { id: selectedEdge.to }], padding: 0.45, duration: 500, maxZoom: 1.1 })
  }, [selectedEdge, fitView])

  // playhead → current node, state overrides, and the gesture on that screen
  const { currentNodeId, stateOverrides, gesture } = useMemo(() => {
    if (!flow) return { currentNodeId: null, stateOverrides: {}, gesture: null }
    const overrides = {}
    for (let i = 0; i <= step && i < flow.steps.length; i++) {
      const st = flow.steps[i]
      if (st.action === 'screenshot' && st.file) {
        const owner = map.nodes.find((n) => n.capture.states.some((s) => s.screenshot === 'screens/' + st.file))
        if (owner) overrides[owner.id] = owner.capture.states.find((s) => s.screenshot === 'screens/' + st.file)
      }
    }
    let ni = step + 1
    while (ni < flow.steps.length && HIDDEN_STEPS.includes(flow.steps[ni]?.action)) ni++
    const st = flow.steps[ni]
    const pt = flow.pointSize ?? [402, 874]
    let g = null
    if (st?.action === 'tap' && st.coordinate) g = { type: 'tap', x: st.coordinate[0] / pt[0], y: st.coordinate[1] / pt[1], label: st.target }
    else if (st?.action === 'swipe' && st.from && st.to) g = { type: 'swipe', x1: st.from[0] / pt[0], y1: st.from[1] / pt[1], x2: st.to[0] / pt[0], y2: st.to[1] / pt[1] }
    const cur = nodeAtStep[flow.name]?.[step] ?? flow.route ?? path[0] ?? null
    return { currentNodeId: cur, stateOverrides: overrides, gesture: g }
  }, [flow, step, path, map, nodeAtStep])

  // does any recorded flow tap through the selected transition? then we know
  // WHERE on the source screen the trigger sits
  const edgeGesture = useMemo(() => {
    if (!selectedEdge) return null
    for (const f of map.flows) {
      const steps = f.steps ?? []
      const at = nodeAtStep[f.name] ?? []
      for (let i = 0; i < steps.length; i++) {
        const st = steps[i]
        if (st.action === 'tap' && st.coordinate && st.screen === selectedEdge.to && (at[i - 1] ?? f.route) === selectedEdge.from) {
          const pt = f.pointSize ?? [402, 874]
          return { type: 'tap', x: st.coordinate[0] / pt[0], y: st.coordinate[1] / pt[1], label: st.target }
        }
      }
    }
    return null
  }, [selectedEdge, map, nodeAtStep])

  // the playhead scrubs only meaningful steps
  const stepView = useMemo(() => {
    if (!flow) return null
    const visibleIdx = flow.steps.map((_, i) => i).filter((i) => !HIDDEN_STEPS.includes(flow.steps[i].action))
    if (!visibleIdx.length) visibleIdx.push(0)
    const effectiveEnd = (k) => (visibleIdx[k + 1] ?? flow.steps.length) - 1
    const pos = Math.max(0, visibleIdx.filter((i) => i <= step).length - 1)
    return { visibleIdx, effectiveEnd, pos, visStep: flow.steps[visibleIdx[pos]], nextStep: flow.steps[visibleIdx[pos + 1]] ?? null }
  }, [flow, step])

  const copyFlow = useCallback(
    (f) => {
      if (!f) return toast('No flow recorded for this screen')
      const cmd = replayCommand(f, manifest.app.name)
      navigator.clipboard.writeText(cmd).then(
        () => toast.success(`Copied replay · ${f.name}${isInteractive(f) ? ' (interactive)' : ''}`),
        () => setCommandSheet({ flow: f, cmd })
      )
    },
    [manifest]
  )

  const copyDeepLink = useCallback(
    (url) => {
      if (!url) return toast('No deep link recorded for this screen')
      navigator.clipboard.writeText(url).then(
        () => toast.success('Copied deep link'),
        () => setCommandSheet({ flow: { name: 'deep link' }, heading: 'Deep link', cmd: url })
      )
    },
    []
  )

  // focus a node by panning/zooming straight to its layout position
  const focusNode = useCallback(
    (id) => {
      const pos = positions?.[id]
      if (!pos) return
      const zoom = Math.max(getZoom(), Math.min(1.1, (window.innerHeight * 0.6) / NODE_H))
      setCenter(pos.x + NODE_W / 2, pos.y + NODE_H / 2, { zoom, duration: 500 })
    },
    [positions, setCenter, getZoom]
  )

  // Park playback wherever a capture was taken: the flow that shot it, at that
  // step. `name` is '' for the bare screen.
  const jumpToCapture = useCallback(
    (nodeId, name) => {
      const node = map.nodes.find((n) => n.id === nodeId)
      if (!node) return false
      const shot = name ? node.capture.states.find((s) => s.name === name)?.screenshot : node.capture.screenshot
      if (!shot) return false
      for (const f of map.flows) {
        const idx = (f.steps ?? []).findIndex((st) => st.action === 'screenshot' && 'screens/' + st.file === shot)
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

  // Picking a state on the screen that is already the subject keeps that screen
  // active and re-points playback at whichever flow reaches the state — the
  // route under the screen changes, the screen doesn't. On any other node the
  // pick is just a change of what that node displays.
  const selectState = useCallback(
    (nodeId, name) => {
      setChosenStates((prev) => ({ ...prev, [nodeId]: name || undefined }))
      if (nodeId !== subjectId) return
      setSelectedEdge(null)
      setSelectedNode(nodeId)
      if (!jumpToCapture(nodeId, name)) setSelectedFlow(null)
    },
    [subjectId, jumpToCapture]
  )

  // shot mode: once nodes are laid out, frame just the changed screens and
  // signal readiness after images/paint settle
  useEffect(() => {
    if (!SHOT || !positions) return
    const ids = diffMode
      ? map.nodes.filter((n) => ['A', 'M', 'D'].includes(n.diff?.status)).map((n) => ({ id: n.id }))
      : []
    const t = setTimeout(() => {
      fitView({ nodes: ids.length ? ids : undefined, padding: ids.length === 1 ? 0.45 : 0.18, duration: 0, maxZoom: 1.4 })
      setTimeout(() => {
        // screen-space bounds of the framed nodes so the screenshotter can crop
        const subject = (ids.length ? ids : map.nodes.map((n) => ({ id: n.id }))).map(({ id }) => positions[id]).filter(Boolean)
        if (subject.length) {
          const tl = flowToScreenPosition({ x: Math.min(...subject.map((p) => p.x)), y: Math.min(...subject.map((p) => p.y)) })
          const br = flowToScreenPosition({ x: Math.max(...subject.map((p) => p.x)) + NODE_W, y: Math.max(...subject.map((p) => p.y)) + NODE_H })
          window.__screenmapShotBounds = { x: tl.x, y: tl.y, width: br.x - tl.x, height: br.y - tl.y }
        }
        window.__screenmapShotReady = true
        document.title = 'screenmap-shot-ready'
      }, 1200)
    }, 400)
    return () => clearTimeout(t)
  }, [positions, diffMode, map, fitView, flowToScreenPosition])

  const rfNodes = useMemo(() => {
    if (!positions) return []
    // Screens the path merely passes through get no say in their state —
    // playback put them where they are. The flow's destination keeps its say,
    // and so does every screen the flow never touches.
    const midway = new Set(flow ? [...path, ...Object.keys(stateOverrides)].filter((id) => id !== flowTarget) : [])
    return map.nodes.map((n) => {
      const override = stateOverrides[n.id]
      const nodeDiff = diffMode ? n.diff ?? null : null
      const stateList = n.capture.states.map((s) => ({ name: s.name, img: images.get(s.screenshot), diff: diffMode ? n.stateDiff?.[s.name]?.status ?? null : null }))
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
          imgBase: diffMode && n.captureBase?.screenshot ? images.get(n.captureBase.screenshot) : null,
          states: stateList,
          baseStates: diffMode ? (n.captureBase?.states ?? []).map((s) => ({ name: s.name, img: images.get(s.screenshot) })) : [],
          baseDiffStatus: diffMode ? n.stateDiff?.['']?.status ?? null : null,
          flip,
          stateName: override?.name ?? null,
          chosenState: chosenStates[n.id] ?? null,
          onStateSelect: (name) => selectState(n.id, name),
          statePickable: !midway.has(n.id),
          badgeText: statusBadge(n),
          diffMode,
          diff: nodeDiff,
          hue: hueFor(n.group || 'root'),
          dimmed: neighbourhood
            ? !neighbourhood.nodes.has(n.id)
            : (!!flow && !path.includes(n.id)) || (!!selectedEdge && n.id !== selectedEdge.from && n.id !== selectedEdge.to),
          onPath: neighbourhood
            ? neighbourhood.nodes.has(n.id) && n.id !== subjectId
            : (!!flow && path.includes(n.id)) || (!!selectedEdge && (n.id === selectedEdge.from || n.id === selectedEdge.to)),
          isCurrent: neighbourhood ? n.id === subjectId : n.id === currentNodeId,
          gesture: neighbourhood ? null : flow ? (n.id === currentNodeId ? gesture : null) : selectedEdge && n.id === selectedEdge.from ? edgeGesture : null,
        },
      }
    })
  }, [positions, map, images, flow, flowTarget, path, currentNodeId, stateOverrides, gesture, selectedNode, chosenStates, selectState, selectedEdge, edgeGesture, neighbourhood, subjectId, diffMode, flip])

  const rfEdges = useMemo(() => {
    const infos = new Map()
    for (const e of map.edges) {
      if (!e.to || e.from === e.to) continue
      const key = `${e.from}→${e.to}`
      if (!infos.has(key)) infos.set(key, { key, from: e.from, to: e.to, raws: [] })
      const info = infos.get(key)
      if (e.raw && !info.raws.includes(e.raw)) info.raws.push(e.raw)
      if (diffMode && e.diffStatus) info.diffStatus = e.diffStatus
    }
    for (const oe of observedEdges) infos.set(oe.key, oe)
    const anySelection = !!flow || !!selectedEdge || !!neighbourhood
    const out = []
    for (const info of infos.values()) {
      const onPath = neighbourhood ? neighbourhood.edgeKeys.has(info.key) : flow && path.some((id, i) => id === info.from && path[i + 1] === info.to)
      const active = onPath || (!neighbourhood && selectedEdge?.key === info.key)
      out.push({
        id: info.key,
        source: info.from,
        target: info.to,
        animated: !!active,
        className: `${active ? 'edge-on-path' : anySelection ? 'edge-faded' : 'edge-normal'}${info.observed ? ' edge-observed' : ''}${info.diffStatus === 'A' ? ' edge-added' : info.diffStatus === 'D' ? ' edge-removed' : ''}`,
        markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: active ? 'var(--primary)' : anySelection ? 'color-mix(in oklch, var(--foreground) 8%, transparent)' : 'color-mix(in oklch, var(--foreground) 30%, transparent)' },
        data: info,
      })
    }
    if (flow) {
      for (let i = 0; i + 1 < path.length; i++) {
        const key = `${path[i]}→${path[i + 1]}`
        if (!infos.has(key)) {
          out.push({ id: 'syn-' + key, source: path[i], target: path[i + 1], animated: true, className: 'edge-on-path edge-synthetic', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16, color: 'var(--primary)' } })
        }
      }
    }
    return out
  }, [map, flow, path, selectedEdge, observedEdges, neighbourhood, diffMode])

  const selectFlow = useCallback(
    (name) => {
      setSelectedFlow((cur) => (cur === name ? null : name))
      const f = name ? map.flows.find((x) => x.name === name) : null
      setStep(Math.max(0, (f?.steps?.length ?? 1) - 1))
      setSelectedNode(null)
      setSelectedEdge(null)
      setNeighboursMode(false)
    },
    [map]
  )

  // camera follows the playhead
  useEffect(() => {
    if (!flow || !currentNodeId || neighboursMode) return
    fitView({ nodes: [{ id: currentNodeId }], padding: 0.5, duration: 450, maxZoom: 1.15 })
  }, [flow, currentNodeId, fitView, neighboursMode])

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape') {
        setSelectedEdge(null); setSelectedNode(null); setSelectedFlow(null); setNeighboursMode(false)
        return
      }
      if (!flow || !stepView) return
      if (e.key === 'ArrowRight') setStep(stepView.effectiveEnd(Math.min(stepView.pos + 1, stepView.visibleIdx.length - 1)))
      if (e.key === 'ArrowLeft') setStep(stepView.effectiveEnd(Math.max(stepView.pos - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [flow, stepView])

  const interactiveFlows = map.flows.filter(isInteractive)
  const stats = {
    screens: map.nodes.length,
    captured: map.nodes.filter((n) => n.capture.screenshot && (n.capture.status ?? 'ok') === 'ok').length,
    flows: map.flows.length,
  }
  const diffStats = diffMode
    ? { A: diff.nodes.filter((n) => n.status === 'A').length, M: diff.nodes.filter((n) => n.status === 'M').length, D: diff.nodes.filter((n) => n.status === 'D').length, edges: diff.edges.length }
    : null
  const selectedDiffNode = diffMode && selectedNode ? map.nodes.find((n) => n.id === selectedNode) : null

  if (!positions) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">Laying out {map.nodes.length} screens…</div>
  }

  // --- side panel rows -----------------------------------------------------
  const panelItems = diffMode
    ? diff.nodes.map((d) => ({
        key: d.id, kind: d.status, mono: true, active: selectedNode === d.id, title: d.note ?? d.reason,
        label: routeById[d.id]?.urlPath ?? d.id,
        onClick: () => { setSelectedEdge(null); setSelectedNode(d.id); focusNode(d.id) },
      }))
    : interactiveFlows.map((f) => ({
        key: f.name, kind: 'flow', active: selectedFlow === f.name, title: f.title, label: f.title ?? f.name,
        onClick: () => selectFlow(f.name),
      }))
  const panelFooter = diffMode && diff.broadFiles?.length > 0 ? (
    <p className="mx-1 mt-2 rounded-lg border border-changed/25 bg-changed/8 px-2.5 py-2 text-[10.5px] leading-snug text-changed" title={diff.broadFiles.map((b) => b.file).join('\n')}>
      {diff.broadFiles.length} broadly-imported changed file{diff.broadFiles.length === 1 ? '' : 's'} excluded from suspect marking
    </p>
  ) : null

  // --- playhead props ------------------------------------------------------
  const describe = (st) => {
    if (st.action === 'open_url') return `deep link ${st.url}`
    if (st.action === 'tap') return `tap ${st.target ?? st.coordinate?.join(',')}`
    if (st.action === 'swipe') return `swipe ${st.from?.join(',')} → ${st.to?.join(',')}`
    return st.action
  }
  // Every visit-* flow in a bundle is exactly one open_url step, so a deep link
  // was never something to play — it is a URL. Surface it as one.
  const deepLinkUrl = flow ? (() => {
    const visit = map.flows.find((f) => f.route === flow.route && f.name.startsWith('visit-'))
    const from = (f) => (f?.steps ?? []).find((st) => st.action === 'open_url' && st.url)?.url ?? null
    return from(visit) ?? from(flow)
  })() : null

  return (
    <div className="relative h-full">
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
          if (selectedNode === n.id) { setSelectedNode(null); setSelectedFlow(null); return }
          setSelectedNode(n.id)
          const chosen = chosenStates[n.id]
          if (chosen && jumpToCapture(n.id, chosen)) return
          const f = flowForNode(map, n.id)
          if (f) {
            setSelectedFlow(f.name)
            setStep(Math.max(0, (f.steps?.length ?? 1) - 1))
          } else {
            setSelectedFlow(null)
            if (diffMode) focusNode(n.id)
            else fitView({ nodes: [{ id: n.id }], padding: 0.6, duration: 500, maxZoom: 1.1 })
          }
        }}
        onPaneClick={() => { setSelectedNode(null); setSelectedFlow(null); setSelectedEdge(null); setNeighboursMode(false) }}
        onEdgeClick={(_, e) => {
          if (!e.data?.key) return
          const same = selectedEdge?.key === e.data.key
          setSelectedFlow(null); setSelectedNode(null); setNeighboursMode(false)
          setSelectedEdge(same ? null : e.data)
        }}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.4} color="var(--canvas-dot)" />
        {!SHOT && <Controls showInteractive={false} />}
        {!SHOT && <MiniMap
          pannable
          zoomable
          onClick={(_, pos) => setCenter(pos.x, pos.y, { duration: 400, zoom: Math.max(getZoom(), 0.55) })}
          /* Ink, not a rainbow: the minimap is a printed thumbnail of the map,
             so it uses the press's own colours. Group hue stays on the node
             labels, where it can carry the grouping without shouting. The diff
             plate is kept — those three colours mean something. */
          nodeColor={(n) => (n.data?.diff ? `var(--${n.data.diff.status === 'A' ? 'added' : n.data.diff.status === 'D' ? 'removed' : 'changed'})` : 'var(--ink)')}
          maskColor="color-mix(in srgb, var(--paper) 78%, transparent)"
          bgColor="var(--paper-2)"
        />}
      </ReactFlow>

      {!SHOT && <TopBar
        manifest={manifest}
        mode={mode}
        setMode={setMode}
        hasChanges={hasChanges}
        overlaid={overlaid}
        stats={stats}
        diffStats={diffStats}
        onOpenBuffer={onOpenBuffer}
        onCloseChanges={onCloseChanges}
      />}

      {!SHOT && <SidePanel
        title={diffMode ? 'Changes' : 'Agent flows'}
        count={panelItems.length}
        open={panelOpen}
        onToggle={() => setPanelOpen((o) => !o)}
        items={panelItems}
        footer={panelFooter}
      />}

      {flow && stepView && (
        <Playhead
          title={flow.title ?? flow.name}
          subjectPath={routeById[subjectId]?.urlPath ?? subjectId}
          neighbours={neighboursMode}
          neighbourCount={neighbourCount}
          onShowNeighbours={() => setNeighboursMode(true)}
          onExitNeighbours={() => setNeighboursMode(false)}
          deepLinkUrl={deepLinkUrl}
          onCopyDeepLink={() => copyDeepLink(deepLinkUrl)}
          pos={stepView.pos}
          total={stepView.visibleIdx.length}
          onReplay={() => setStep(stepView.effectiveEnd(0))}
          onPrev={() => setStep(stepView.effectiveEnd(Math.max(stepView.pos - 1, 0)))}
          onNext={() => setStep(stepView.effectiveEnd(Math.min(stepView.pos + 1, stepView.visibleIdx.length - 1)))}
          onSeek={(k) => setStep(stepView.effectiveEnd(k))}
          stepDescription={stepView.nextStep ? describe(stepView.nextStep) : `arrived — ${describe(stepView.visStep)}`}
          onCopy={() => copyFlow(flow)}
        />
      )}

      {selectedDiffNode && !selectedEdge && !flow && (
        <ChangeCard
          urlPath={selectedDiffNode.urlPath}
          diff={selectedDiffNode.diff}
          states={(diff.states ?? []).filter((s) => s.node === selectedDiffNode.id && ['A', 'M', 'D'].includes(s.status))}
        />
      )}

      {selectedEdge && !flow && (
        <TransitionCard
          from={routeById[selectedEdge.from]?.urlPath ?? selectedEdge.from}
          to={routeById[selectedEdge.to]?.urlPath ?? selectedEdge.to}
          diffStatus={selectedEdge.diffStatus}
          observed={!!selectedEdge.observed}
          flows={selectedEdge.flows ?? []}
          raws={selectedEdge.raws ?? []}
          file={routeById[selectedEdge.from]?.file}
          gestureKnown={!!edgeGesture}
        />
      )}

      {commandSheet && (
        <CommandSheet
          title={commandSheet.flow.title ?? commandSheet.flow.name}
          heading={commandSheet.heading}
          cmd={commandSheet.cmd}
          onCopy={() => navigator.clipboard.writeText(commandSheet.cmd).then(() => { toast.success('Copied'); setCommandSheet(null) }, () => toast('Select the text and copy manually'))}
          onClose={() => setCommandSheet(null)}
        />
      )}
    </div>
  )
}
