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

// Renders a flow's replay command. Flows are argent YAML
// (argent.swmansion.com) — replayable headlessly, no LLM in the loop.
export function replayCommand(flow, appName) {
  const lines = [
    `# ${appName} · replay flow "${flow.name}" — ${flow.title ?? ''}`.trimEnd(),
    `# run from the app's project root (flows live in .screenmap/out/flows/)`,
    `npx @swmansion/argent flow run .screenmap/out/flows/${flow.name}.yaml`,
  ]
  if (!isInteractive(flow)) {
    const links = (flow.steps ?? []).filter((st) => st.action === 'open_url' && st.url)
    if (links.length) {
      lines.push('#', '# no-tooling fallback (plain deep link):')
      for (const st of links) lines.push(`# xcrun simctl openurl booted "${st.url}"`)
    }
  }
  return lines.join('\n')
}
