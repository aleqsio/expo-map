import { unzipSync } from 'fflate'

// Parses a .appmap zip (ArrayBuffer) into { manifest, map, images: Map<path, objectURL> }
export async function loadBundle(buffer) {
  const files = unzipSync(new Uint8Array(buffer))
  const text = (name) => {
    const f = files[name]
    if (!f) throw new Error(`bundle is missing ${name}`)
    return new TextDecoder().decode(f)
  }
  const manifest = JSON.parse(text('manifest.json'))
  if (manifest.formatVersion !== 1) {
    throw new Error(`unsupported formatVersion ${manifest.formatVersion}`)
  }
  const map = JSON.parse(text('map.json'))
  const images = new Map()
  for (const [name, data] of Object.entries(files)) {
    if (/^screens\/.+\.(png|jpe?g|webp)$/i.test(name)) {
      const ext = name.split('.').pop().toLowerCase().replace('jpg', 'jpeg')
      images.set(name, URL.createObjectURL(new Blob([data], { type: `image/${ext}` })))
    }
  }
  return { manifest, map, images }
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
