import { isInteractive } from './loadBundle'

// Best flow to reach a node: the recorded tap path (nav-*) when one exists —
// deep links are the shorthand, reachable via the playhead toggle. Otherwise
// prefer an interactive flow for needs-navigation nodes, then the visit flow.
export function flowForNode(map, nodeId) {
  const candidates = (map.flows ?? []).filter((f) => f.route === nodeId)
  if (!candidates.length) return null
  const nav = candidates.find((f) => f.name.startsWith('nav-'))
  if (nav) return nav
  const node = map.nodes.find((n) => n.id === nodeId)
  const interactive = candidates.filter(isInteractive)
  if (node?.capture?.needsNavigation && interactive.length) return interactive[0]
  return candidates.find((f) => !isInteractive(f)) ?? candidates[0]
}

// Renders a flow as a copy-pasteable shell script. Deterministic steps become
// real commands; interactive steps become annotated comments plus an agent
// command that can replay the whole thing.
export function replayCommand(flow, appName) {
  const lines = [`# ${appName} · replay flow "${flow.name}" — ${flow.title ?? ''}`.trimEnd()]
  let interactive = false
  for (const [i, st] of (flow.steps ?? []).entries()) {
    if (st.action === 'open_url') lines.push(`xcrun simctl openurl booted "${st.url}"`)
    else if (st.action === 'wait') lines.push(`sleep ${st.seconds ?? 1}`)
    else if (st.action === 'screenshot')
      lines.push(`xcrun simctl io booted screenshot "${st.file ?? `step-${i}.png`}"`)
    else {
      interactive = true
      const where = st.coordinate ? ` at (${st.coordinate.join(', ')})pt` : ''
      const fromTo = st.from && st.to ? ` from (${st.from.join(', ')}) to (${st.to.join(', ')})` : ''
      lines.push(`# step ${i + 1}: ${st.action} ${st.target ?? ''}${where}${fromTo} — needs simulator control`.trimEnd())
    }
  }
  if (interactive) {
    lines.push('#')
    lines.push(`# interactive steps need an agent driving the simulator:`)
    lines.push(`claude "/expo-map replay ${flow.name}"`)
  }
  return lines.join('\n')
}
