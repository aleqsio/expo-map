import ELK from 'elkjs/lib/elk.bundled.js'

const elk = new ELK()

export const NODE_W = 168
export const NODE_H = 396

export async function layoutGraph(nodes, edges) {
  // isolated screens (no resolved links) go in a tidy grid below the graph,
  // grouped by section, instead of elk's long disconnected strip
  const connectedIds = new Set()
  for (const e of edges) {
    if (e.to && e.from !== e.to) {
      connectedIds.add(e.from)
      connectedIds.add(e.to)
    }
  }
  const connected = nodes.filter((n) => connectedIds.has(n.id))
  const isolated = nodes
    .filter((n) => !connectedIds.has(n.id))
    .sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.id.localeCompare(b.id))

  const pos = await layoutConnected(connected, edges)

  // center the root route over the connected graph — it sits alone in the top layer
  const root = connected.find((n) => n.urlPath === '/')
  if (root && pos[root.id]) {
    const others = connected.filter((n) => n.id !== root.id).map((n) => pos[n.id].x)
    if (others.length) pos[root.id].x = (Math.min(...others) + Math.max(...others)) / 2
  }

  const xs = Object.values(pos)
  const maxY = xs.length ? Math.max(...xs.map((p) => p.y)) + NODE_H : 0
  const minX = xs.length ? Math.min(...xs.map((p) => p.x)) : 0
  const cols = Math.max(4, Math.ceil(Math.sqrt(isolated.length * 2.2)))
  isolated.forEach((n, i) => {
    pos[n.id] = {
      x: minX + (i % cols) * (NODE_W + 56),
      y: maxY + 180 + Math.floor(i / cols) * (NODE_H + 90),
    }
  })
  return pos
}

async function layoutConnected(nodes, edges) {
  if (!nodes.length) return {}
  const graph = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.layered.spacing.nodeNodeBetweenLayers': '110',
      'elk.spacing.nodeNode': '56',
      'elk.layered.considerModelOrder.strategy': 'PREFER_NODES',
      'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
      'elk.layered.crossingMinimization.semiInteractive': 'true',
    },
    children: nodes.map((n) => ({
      id: n.id,
      width: NODE_W,
      height: NODE_H,
      // the root route gets its own separate top layer
      ...(n.urlPath === '/' ? { layoutOptions: { 'elk.layered.layering.layerConstraint': 'FIRST_SEPARATE' } } : {}),
    })),
    edges: edges
      .filter((e) => e.to && e.from !== e.to)
      .map((e, i) => ({ id: `e${i}`, sources: [e.from], targets: [e.to] })),
  }
  // dedupe parallel edges — elk doesn't need them
  graph.edges = graph.edges.filter(
    (e, i, a) => a.findIndex((x) => x.sources[0] === e.sources[0] && x.targets[0] === e.targets[0]) === i
  )
  const res = await elk.layout(graph)
  const pos = {}
  for (const c of res.children) pos[c.id] = { x: c.x, y: c.y }
  return pos
}
