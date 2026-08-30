// Graph assembly: turns a provider's fragment into the graph.json contract.
//
// Providers return only what is specific to their framework — routes, edges,
// layouts. Everything common (defaults, orphan detection, the summary block,
// validation) happens here, so every provider gets identical treatment and a
// new one cannot quietly emit a graph the rest of the pipeline mishandles.

export function normalize(fragment, ctx, { provider }) {
  const routes = fragment.routes.map((r) => ({
    id: r.id,
    file: r.file ?? null,
    urlPath: r.urlPath ?? null,
    // Identity and reachability are separate concerns. A screen registered on a
    // navigator but absent from the linking config has no URL at all, which is
    // ordinary in react-navigation and impossible in expo-router — so `title`
    // is what every consumer labels a node with, and `reach` is what the
    // capture stage branches on.
    title: r.title ?? r.urlPath ?? r.id,
    reach: r.reach ?? (r.urlPath ? 'deep-link' : 'navigation-only'),
    slug: r.slug,
    params: r.params ?? [],
    navigator: r.navigator ?? null,
    layoutDir: r.layoutDir ?? null,
    presentation: r.presentation ?? null,
    stateHints: r.stateHints ?? [],
    ...(r.aliases ? { aliases: r.aliases } : {}),
  }))

  const edges = fragment.edges ?? []
  const layouts = fragment.layouts ?? []
  const { name: appName, scheme } = ctx.appConfig()

  const graph = {
    generatedAt: new Date().toISOString(),
    projectRoot: ctx.projectRoot,
    // The app's own name, not the directory it happens to sit in — checkouts
    // and git worktrees are routinely named after a branch or a ticket.
    appName,
    scheme,
    deepLinkTemplates: {
      devBuild: scheme ? `${scheme}://<urlPath minus leading slash>` : null,
      expoGo: 'exp://127.0.0.1:8081/--<urlPath>',
    },
    mode: provider.meta.id,
    ...providerExtras(fragment),
    layouts,
    routes,
    edges,
  }

  const orphans = findOrphans(routes, edges)
  graph.summary = {
    mode: provider.meta.id,
    routes: routes.length,
    layouts: layouts.length,
    edges: edges.length,
    unresolvedEdges: edges.filter((e) => e.to == null).length,
    routesWithStateHints: routes.filter((r) => r.stateHints.length > 0).length,
    routesNeedingParams: routes.filter((r) => r.params.length > 0).length,
    navigationOnlyRoutes: routes.filter((r) => r.reach === 'navigation-only').length,
    orphanRoutes: orphans.length,
  }
  return { graph, orphans }
}

// Provider-specific top-level keys (appDir, routesFile, navigationFile, …) ride
// along untouched; they are diagnostics, not contract.
function providerExtras(fragment) {
  const { routes, edges, layouts, ...rest } = fragment
  return rest
}

// Routes nothing links to. The root is every app's entry point, so it never
// counts; neither does a tab or drawer child, which the navigator reaches by
// structure rather than by a link. (Stack children do not get that pass — a
// pushed screen needs something to push it.)
export function findOrphans(routes, edges) {
  const linkedTo = new Set(edges.map((e) => e.to).filter(Boolean))
  const structural = (r) =>
    /tab|drawer/i.test(r.navigator ?? '') ||
    /\([^)]*(?:tabs?|drawer)[^)]*\)/i.test(`${r.id}/${r.layoutDir ?? ''}`) ||
    // expo-router specials (+not-found, +html, _sitemap) are reached by the
    // router itself, never by a link
    r.id.split('/').some((s) => s.startsWith('+') || s.startsWith('_'))
  return routes.filter((r) => r.urlPath !== '/' && !linkedTo.has(r.id) && !structural(r))
}

// Contract violations a provider can plausibly ship: duplicate ids silently
// collapse nodes in the viewer, duplicate slugs make two routes fight over one
// screenshot file. Both are worth failing on rather than debugging downstream.
export function validate(graph) {
  const errs = []
  const seenId = new Set()
  const seenSlug = new Set()
  for (const r of graph.routes) {
    if (!r.id) errs.push(`route with no id: ${JSON.stringify(r)}`)
    if (!r.slug) errs.push(`route "${r.id}" has no slug`)
    if (seenId.has(r.id)) errs.push(`duplicate route id "${r.id}"`)
    if (r.slug && seenSlug.has(r.slug)) errs.push(`duplicate slug "${r.slug}" (screenshots would collide)`)
    // Screenshots are <slug>.png and state variants are <slug>--<state>.png,
    // so a slug may not contain a path separator or the state separator.
    if (r.slug && !/^[A-Za-z0-9_.+-]+$/.test(r.slug))
      errs.push(`slug "${r.slug}" on route "${r.id}" is not filename-safe`)
    if (r.slug && r.slug.includes('--'))
      errs.push(`slug "${r.slug}" on route "${r.id}" contains "--", which names state variants`)
    seenId.add(r.id)
    if (r.slug) seenSlug.add(r.slug)
  }
  const ids = new Set(graph.routes.map((r) => r.id))
  for (const e of graph.edges) {
    if (!ids.has(e.from)) errs.push(`edge from unknown route "${e.from}"`)
    if (e.to != null && !ids.has(e.to)) errs.push(`edge to unknown route "${e.to}"`)
  }
  return errs
}
