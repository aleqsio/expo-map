import { unzipSync } from 'fflate'
import { parse as parseYaml } from 'yaml'

// Parses a .appmap zip (ArrayBuffer) into { manifest, map, images: Map<path, objectURL> }.
// v1 bundles inline JSON flows in map.json; v2 bundles ship argent flow YAML
// (flows/*.yaml, runnable via `argent flow run`) plus .meta.json sidecars —
// both load into the same internal flow shape.
export async function loadBundle(buffer) {
  const files = unzipSync(new Uint8Array(buffer))
  const text = (name) => {
    const f = files[name]
    if (!f) throw new Error(`bundle is missing ${name}`)
    return new TextDecoder().decode(f)
  }
  const manifest = JSON.parse(text('manifest.json'))
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
