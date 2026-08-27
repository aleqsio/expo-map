import { unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'

// Parses a .scrmap zip (ArrayBuffer) into { manifest, map, images: Map<path, objectURL> }.
// v1 bundles inline JSON flows in map.json; v2 bundles ship argent flow YAML
// (flows/*.yaml, runnable via `argent flow run`) plus .meta.json sidecars —
// both load into the same internal flow shape.
// .diff.scrmap bundles (manifest.kind === "diff") load into the same shape plus
// a `diff` field; base/head sides are merged into one graph with per-node and
// per-edge diff annotations.
export async function loadBundle(buffer) {
  const files = unzipSync(new Uint8Array(buffer))
  const text = (name) => {
    const f = files[name]
    if (!f) throw new Error(`bundle is missing ${name}`)
    return new TextDecoder().decode(f)
  }
  const manifest = JSON.parse(text('manifest.json'))
  if (manifest.kind === 'diff') return loadDiffBundle(files, manifest, text)
  if (manifest.formatVersion !== 1 && manifest.formatVersion !== 2) {
    throw new Error(`unsupported formatVersion ${manifest.formatVersion}`)
  }
  const map = JSON.parse(text('map.json'))
  if (manifest.formatVersion === 2) {
    map.flows = Object.keys(files)
      .filter((n) => /^flows\/.+\.yaml$/.test(n))
      .map((n) => {
        try {
          const name = n.slice('flows/'.length, -'.yaml'.length)
          const metaRaw = files[`flows/${name}.meta.json`]
          const meta = metaRaw ? JSON.parse(new TextDecoder().decode(metaRaw)) : {}
          return argentFlowToInternal(name, text(n), meta)
        } catch {
          return null
        }
      })
      .filter(Boolean)
  }
  const images = new Map()
  for (const [name, data] of Object.entries(files)) {
    if (/^screens\/.+\.(png|jpe?g|webp)$/i.test(name)) {
      const ext = name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')
      images.set(name, URL.createObjectURL(new Blob([data], { type: `image/${ext}` })))
    }
  }
  return { manifest, map, images }
}

// .diff.scrmap → the internal bundle shape. Head is the primary graph; base-only
// (removed) nodes and edges are merged in so the map shows what disappeared.
// Screenshot paths get side-prefixed keys ("head/screens/…") into `images`.
function loadDiffBundle(files, manifest, text) {
  if (manifest.formatVersion !== 1) {
    throw new Error(`unsupported diff formatVersion ${manifest.formatVersion}`)
  }
  const diff = JSON.parse(text('diff.json'))
  const baseMap = JSON.parse(text('base/map.json'))
  const headMap = JSON.parse(text('head/map.json'))

  const images = new Map()
  for (const [name, data] of Object.entries(files)) {
    if (/^(base|head)\/screens\/.+\.(png|jpe?g|webp)$/i.test(name)) {
      const ext = name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')
      images.set(name, URL.createObjectURL(new Blob([data], { type: `image/${ext}` })))
    }
  }

  const nodeDiff = new Map(diff.nodes.map((n) => [n.id, n]))
  // per-capture-state statuses: node id → { "" | stateName → {status, note} }
  const stateDiff = {}
  for (const s of diff.states ?? []) {
    if (s.reason === 'hint') continue // advisory only — no capture to attach to
    ;(stateDiff[s.node] ??= {})[s.name] = { status: s.status, note: s.note ?? null }
  }
  const sideCapture = (cap, side) => ({
    ...cap,
    screenshot: cap.screenshot ? `${side}/${cap.screenshot}` : null,
    states: (cap.states ?? []).map((s) => ({ ...s, screenshot: `${side}/${s.screenshot}` })),
  })
  const baseById = new Map(baseMap.nodes.map((n) => [n.id, n]))
  const headIds = new Set(headMap.nodes.map((n) => n.id))
  const nodes = headMap.nodes.map((n) => ({
    ...n,
    capture: sideCapture(n.capture, 'head'),
    captureBase: baseById.has(n.id) ? sideCapture(baseById.get(n.id).capture, 'base') : null,
    diff: nodeDiff.get(n.id) ?? null,
    stateDiff: stateDiff[n.id] ?? null,
  }))
  for (const b of baseMap.nodes.filter((n) => !headIds.has(n.id))) {
    nodes.push({
      ...b,
      capture: sideCapture(b.capture, 'base'),
      captureBase: null,
      diff: nodeDiff.get(b.id) ?? { id: b.id, status: 'D', reason: 'route-removed' },
      stateDiff: stateDiff[b.id] ?? null,
    })
  }

  // edge diff at from→to pair granularity (what the graph can draw)
  const pairKey = (e) => `${e.from}→${e.to}`
  const addedPairs = new Set(diff.edges.filter((e) => e.status === 'A').map(pairKey))
  const headPairs = new Set(headMap.edges.filter((e) => e.to).map(pairKey))
  const edges = headMap.edges
    .filter((e) => e.to)
    .map((e) => ({ ...e, diffStatus: addedPairs.has(pairKey(e)) ? 'A' : null }))
  for (const e of baseMap.edges.filter((x) => x.to && !headPairs.has(pairKey(x)))) {
    edges.push({ ...e, diffStatus: 'D' })
  }

  return { manifest, map: { nodes, edges, flows: [] }, images, diff }
}

// Do these two bundles describe the same app? Names alone are too strict a
// test: a .scrmap takes app.name from the app config ("Brew") while a
// .diff.scrmap takes it from the repo ("screenmap-test"), so the identical
// pair a PR comment links to failed to match and Changes lost its backdrop.
// Any one of shared commit provenance, URL scheme, or name is enough.
export function sameApp(plain, diff) {
  const norm = (v) => (typeof v === 'string' && v.trim() ? v.trim().toLowerCase() : null)
  const commit = norm(plain.manifest.source?.commit)
  const sides = [norm(diff.manifest.base?.commit), norm(diff.manifest.head?.commit)]
  if (commit && sides.includes(commit)) return true
  const a = plain.manifest.app ?? {}
  const b = diff.manifest.app ?? {}
  if (norm(a.scheme) && norm(a.scheme) === norm(b.scheme)) return true
  return !!norm(a.name) && norm(a.name) === norm(b.name)
}

// Build the graph the Changes view renders. Every node keeps its diff
// annotation; a node the diff carries no capture for is an unchanged screen
// the PR could not have touched, not a missing one, so it borrows a shot —
// from the map bundle when one is loaded, otherwise from its own base side.
// Only a node that no bundle has a shot for keeps the "no capture" state.
//
// `plain` may be null: a .diff.scrmap opened on its own still gets the
// base-side fallback, it just has no map to borrow from. Image keys don't
// collide — plain uses "screens/…", diff uses "base|head/screens/…".
export function mergeBundles(plain, diff) {
  const plainById = new Map((plain?.map.nodes ?? []).map((n) => [n.id, n]))
  const nodes = diff.map.nodes.map((n) => {
    const p = plainById.get(n.id) ?? null
    if (n.capture.screenshot) {
      if (!p) return n
      // union state variants by name; diff-side (head) wins on collision
      const have = new Set((n.capture.states ?? []).map((s) => s.name))
      const states = [
        ...(n.capture.states ?? []),
        ...(p.capture.states ?? []).filter((s) => !have.has(s.name)),
      ].sort((a, b) => a.name.localeCompare(b.name))
      return { ...n, capture: { ...n.capture, states } }
    }
    const donor = p?.capture?.screenshot ? p.capture : n.captureBase?.screenshot ? n.captureBase : null
    if (!donor) return n
    // A borrowed shot is evidence from one side only, so there is nothing for
    // the base⇄head comparator to alternate between.
    return { ...n, capture: { ...donor, states: donor.states ?? [] }, captureBase: null }
  })
  return {
    manifest: diff.manifest,
    map: { nodes, edges: diff.map.edges, flows: [] },
    images: new Map([...(plain?.images ?? []), ...diff.images]),
    diff: diff.diff,
    backdrop: plain?.manifest ?? null,
  }
}

function selectorLabel(sel) {
  if (typeof sel === 'string') return sel
  if (sel && typeof sel === 'object') {
    if (typeof sel.x === 'number') return null // a point, not a selector
    return sel.text ?? sel.id ?? sel.role ?? JSON.stringify(sel)
  }
  return null
}

// argent YAML step list + sidecar → the internal step shape the visualiser
// renders. Coordinates arrive normalized 0–1, so pointSize is identity.
function argentFlowToInternal(name, yamlText, meta) {
  const doc = parseYaml(yamlText) ?? {}
  const steps = []
  ;(doc.steps ?? []).forEach((raw, i) => {
    const m = meta.steps?.[i] ?? meta.steps?.[String(i)] ?? {}
    const key = typeof raw === 'object' && raw ? Object.keys(raw)[0] : null
    const val = key ? raw[key] : raw
    if (key === 'tool' && raw.tool === 'open-url') {
      steps.push({ action: 'open_url', url: raw.args?.url, note: m.note })
    } else if (key === 'tool' && raw.tool === 'gesture-swipe') {
      const a = raw.args ?? {}
      steps.push({ action: 'swipe', from: [a.fromX, a.fromY], to: [a.toX, a.toY], screen: m.screen, note: m.note })
    } else if (key === 'wait') {
      steps.push({ action: 'wait', seconds: (val ?? 1000) / 1000 })
    } else if (key === 'tap' || key === 'long-press') {
      const point = typeof val === 'object' && typeof val.x === 'number' ? val
        : typeof val?.on === 'object' && typeof val.on.x === 'number' ? val.on : null
      steps.push({
        action: 'tap',
        coordinate: point ? [point.x, point.y] : m.coordinate ?? null,
        target: m.target ?? selectorLabel(val?.on ?? val),
        screen: m.screen,
        note: m.note,
      })
    } else if (key === 'type') {
      steps.push({ action: 'type', text: val?.text, target: selectorLabel(val?.into), screen: m.screen })
    } else if (key === 'launch') {
      steps.push({ action: 'launch', app: typeof val === 'string' ? val : JSON.stringify(val) })
    } else {
      steps.push({ action: key ?? String(raw), note: m.note, screen: m.screen })
    }
    if (m.capture) steps.push({ action: 'screenshot', file: m.capture })
  })
  return {
    name,
    title: meta.title ?? name,
    route: meta.route ?? null,
    device: meta.device ?? null,
    recordedAt: meta.recordedAt ?? null,
    result: meta.result ?? null,
    pointSize: [1, 1], // argent coordinates are already normalized
    steps,
  }
}

// Route pattern matching: ties flow deep-link URLs back to nodes.
function matcherFor(urlPath) {
  const re = urlPath
    .split('/')
    .map((seg) =>
      seg.startsWith('[...') ? '.+'
      : seg.startsWith('[') || seg.startsWith(':') ? '[^/]+'
      : seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    )
    .join('/')
  return new RegExp('^' + re + '/?$')
}

// Resolve each flow to (a) the ordered list of node ids it traverses and
// (b) which node is current at every step index. A step moves the current
// screen when it is an `open_url` (resolved against node URL patterns) or when
// it carries an explicit `screen` field — how interactive flows record that a
// tap/swipe navigated somewhere.
export function flowResolution(map) {
  const matchers = map.nodes.map((n) => ({ id: n.id, re: matcherFor(n.urlPath) }))
  const nodeIds = new Set(map.nodes.map((n) => n.id))
  const resolve = (url) => {
    let p = url.replace(/^[a-z+.-]+:\/\//i, '')
    p = '/' + p.replace(/^\/+/, '')
    p = p.split(/[?#]/)[0]
    const hit = matchers.find((m) => m.re.test(p === '' ? '/' : p))
    return hit?.id ?? null
  }
  const paths = {}
  const nodeAtStep = {}
  for (const flow of map.flows ?? []) {
    const nodes = []
    const perStep = []
    let cur = null
    for (const st of flow.steps ?? []) {
      if (st.action === 'open_url' && st.url) cur = resolve(st.url) ?? cur
      if (st.screen && nodeIds.has(st.screen)) cur = st.screen
      if (cur && nodes[nodes.length - 1] !== cur) nodes.push(cur)
      perStep.push(cur)
    }
    if (flow.route && !nodes.includes(flow.route)) nodes.push(flow.route)
    paths[flow.name] = nodes
    nodeAtStep[flow.name] = perStep.map((id) => id ?? flow.route ?? nodes[0] ?? null)
  }
  return { paths, nodeAtStep }
}

export function isInteractive(flow) {
  return (flow.steps ?? []).some((s) => ['tap', 'swipe', 'type', 'touch_path'].includes(s.action))
}
