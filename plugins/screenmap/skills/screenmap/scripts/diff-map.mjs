#!/usr/bin/env node
// Computes and packs a navigation-map diff between two revisions of an app.
// See docs/appmapdiff-format.md for the format contract.
//
//   node diff-map.mjs suspects <diffDir> --project <headCheckout> [--depth 2] [--broad-cap 8]
//       reads  <diffDir>/base/graph.json, head/graph.json, changed-files.txt
//       writes <diffDir>/suspects.json   (the capture work-list)
//
//   node diff-map.mjs pack <diffDir> [--out <file.appmapdiff>]
//       reads  the above + pr.json (optional) + base|head/screens + base|head/capture-status.json (optional)
//       writes <diffDir>/diff.json and the .appmapdiff zip

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const [cmd, dirArg, ...rest] = process.argv.slice(2)
const opts = {}
for (let i = 0; i < rest.length; i++) {
  if (rest[i].startsWith('--')) opts[rest[i].slice(2)] = rest[i + 1] && !rest[i + 1].startsWith('--') ? rest[++i] : true
}
if (!cmd || !dirArg || !['suspects', 'pack'].includes(cmd)) {
  console.error('usage: diff-map.mjs suspects|pack <diffDir> [options]')
  process.exit(1)
}
const diffDir = path.resolve(dirArg)
const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    if (fallback !== undefined) return fallback
    console.error(`cannot read ${p}: ${e.message}`)
    process.exit(1)
  }
}
const baseGraph = readJson(path.join(diffDir, 'base', 'graph.json'))
const headGraph = readJson(path.join(diffDir, 'head', 'graph.json'))
const changedFiles = fs
  .readFileSync(path.join(diffDir, 'changed-files.txt'), 'utf8')
  .split('\n').map((l) => l.trim()).filter(Boolean)

const byId = (g) => new Map(g.routes.map((r) => [r.id, r]))
const baseById = byId(baseGraph)
const headById = byId(headGraph)

// ---------------------------------------------------------------- suspects ---
if (cmd === 'suspects') {
  const project = path.resolve(opts.project ?? headGraph.projectRoot ?? '.')
  const maxDepth = parseInt(opts.depth ?? '2', 10)
  const broadCap = parseInt(opts['broad-cap'] ?? '8', 10)
  const changedSet = new Set(changedFiles)

  // Import resolution: relative paths, tsconfig `paths` aliases, and package.json
  // `imports` (subpath imports like Bluesky's `#/…`). All resolved to repo-relative
  // paths against the HEAD checkout — good enough for suspect marking; a miss just
  // means a route isn't flagged, and broad-file reporting keeps us honest.
  const EXT = ['.tsx', '.ts', '.jsx', '.js']
  const aliases = [] // [{prefix, targets: [repoRelPrefix]}]
  // tsconfig.json is JSONC in the wild — strip comments and trailing commas
  const readJsonc = (p) => {
    try {
      const src = fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/,(\s*[}\]])/g, '$1')
      return JSON.parse(src)
    } catch { return {} }
  }
  const tsconfig = readJsonc(path.join(project, 'tsconfig.json'))
  for (const [pat, targets] of Object.entries(tsconfig.compilerOptions?.paths ?? {})) {
    aliases.push({ prefix: pat.replace(/\*$/, ''), targets: targets.map((t) => t.replace(/\*$/, '')) })
  }
  const pkg = readJson(path.join(project, 'package.json'), {})
  for (const [pat, target] of Object.entries(pkg.imports ?? {})) {
    const t = typeof target === 'string' ? target : Object.values(target)[0]
    if (typeof t === 'string' && t.startsWith('.'))
      aliases.push({ prefix: pat.replace(/\*$/, ''), targets: [t.replace(/\*$/, '').replace(/^\.\//, '')] })
  }

  const fileExists = (p) => { try { return fs.statSync(p).isFile() } catch { return false } }
  const resolveToRel = (candidate) => {
    // candidate is repo-relative, possibly extensionless or a directory
    for (const suffix of ['', ...EXT, ...EXT.map((e) => '/index' + e)]) {
      const rel = candidate + suffix
      if (fileExists(path.join(project, rel))) return rel
    }
    return null
  }
  const resolveImport = (spec, fromRel) => {
    if (spec.startsWith('.')) return resolveToRel(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)))
    for (const a of aliases) {
      if (spec.startsWith(a.prefix)) {
        for (const t of a.targets) {
          const hit = resolveToRel(path.posix.normalize(t + spec.slice(a.prefix.length)))
          if (hit) return hit
        }
      }
    }
    return null // bare package import — out of scope
  }

  const importCache = new Map() // rel → [rel]
  const importsOf = (rel) => {
    if (importCache.has(rel)) return importCache.get(rel)
    let out = []
    try {
      const src = fs.readFileSync(path.join(project, rel), 'utf8')
      const specs = [...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
                     ...src.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
      out = [...new Set(specs)].map((s) => resolveImport(s, rel)).filter(Boolean)
    } catch {}
    importCache.set(rel, out)
    return out
  }

  // BFS each surviving route's import closure to maxDepth, intersect with the change set
  const survivors = headGraph.routes.filter((r) => baseById.has(r.id) && r.file)
  const hits = new Map() // routeId → Map(changedFile → depth)
  for (const r of survivors) {
    const seen = new Map([[r.file, 0]])
    let frontier = [r.file]
    for (let d = 1; d <= maxDepth && frontier.length; d++) {
      const next = []
      for (const f of frontier)
        for (const imp of importsOf(f))
          if (!seen.has(imp)) { seen.set(imp, d); next.push(imp) }
      frontier = next
    }
    const hit = new Map()
    for (const [f, d] of seen) if (changedSet.has(f)) hit.set(f, d)
    if (hit.size) hits.set(r.id, hit)
  }

  // broad files: changed files implicating (at import distance > 0) more routes
  // than the cap would flag half the app — exclude them and report the blind spot
  const indirectCount = new Map()
  for (const hit of hits.values())
    for (const [f, d] of hit) if (d > 0) indirectCount.set(f, (indirectCount.get(f) ?? 0) + 1)
  const broadFiles = [...indirectCount.entries()]
    .filter(([, n]) => n > broadCap)
    .map(([file, n]) => ({ file, importedByRoutes: n }))
  const broadSet = new Set(broadFiles.map((b) => b.file))

  const capture = []
  for (const r of headGraph.routes.filter((x) => !baseById.has(x.id)))
    capture.push({ id: r.id, slug: r.slug, urlPath: r.urlPath, side: 'head', status: 'A', reason: 'route-added' })
  for (const r of baseGraph.routes.filter((x) => !headById.has(x.id)))
    capture.push({ id: r.id, slug: r.slug, urlPath: r.urlPath, side: 'base', status: 'D', reason: 'route-removed' })
  for (const [id, hit] of hits) {
    const via = [...hit.entries()].filter(([f, d]) => d === 0 || !broadSet.has(f))
    if (!via.length) continue
    const r = headById.get(id)
    const depth = Math.min(...via.map(([, d]) => d))
    capture.push({
      id, slug: r.slug, urlPath: r.urlPath, side: 'both', status: 'M',
      reason: depth === 0 ? 'file-touched' : 'import-touched',
      via: via.map(([f]) => f), depth,
    })
  }
  // meta-only changes (urlPath, presentation, stateHints) static analysis can see
  for (const r of survivors) {
    if (capture.some((c) => c.id === r.id)) continue
    const b = baseById.get(r.id)
    if (r.urlPath !== b.urlPath || r.presentation !== b.presentation ||
        JSON.stringify(r.stateHints) !== JSON.stringify(b.stateHints))
      capture.push({ id: r.id, slug: r.slug, urlPath: r.urlPath, side: 'both', status: 'M', reason: 'route-meta-changed', via: [], depth: null })
  }

  const suspects = {
    generatedAt: new Date().toISOString(),
    depth: maxDepth, broadCap,
    capture: capture.sort((a, b) => a.status.localeCompare(b.status) || a.id.localeCompare(b.id)),
    broadFiles,
  }
  fs.writeFileSync(path.join(diffDir, 'suspects.json'), JSON.stringify(suspects, null, 2))
  const n = (s) => capture.filter((c) => c.status === s).length
  console.log(`suspects: ${n('A')} added, ${n('D')} removed, ${n('M')} modified → capture ${capture.length} screens`)
  if (broadFiles.length)
    console.log(`broad files excluded from expansion: ${broadFiles.map((b) => `${b.file} (${b.importedByRoutes} routes)`).join(', ')}`)
  process.exit(0)
}

// -------------------------------------------------------------------- pack ---
const suspects = readJson(path.join(diffDir, 'suspects.json'))
const pr = readJson(path.join(diffDir, 'pr.json'), null)
// notes.json: optional, authored by whoever read the PR diff. Values are either
//   "what visibly changes on this screen"                       (plain note)
//   { "note": "...", "verdict": "unaffected" }                  (dismiss it)
// A verdict of "unaffected" drops the screen from the changed list — static
// analysis flagged it, a human/agent judged the change invisible there. The
// dismissal is kept in diff.json (with its note) rather than silently erased.
const notes = readJson(path.join(diffDir, 'notes.json'), {})
const noteFor = (id) => {
  const v = notes[id]
  if (typeof v === 'string') return { note: v, dismissed: false }
  if (v && typeof v === 'object') return { note: v.note ?? null, dismissed: v.verdict === 'unaffected' }
  return { note: null, dismissed: false }
}

const edgeKey = (e) => `${e.from} ${e.to} ${e.target ?? ''}`
const resolved = (g) => g.edges.filter((e) => e.to)
const baseEdges = new Map(resolved(baseGraph).map((e) => [edgeKey(e), e]))
const headEdges = new Map(resolved(headGraph).map((e) => [edgeKey(e), e]))
const edges = []
for (const [k, e] of headEdges) if (!baseEdges.has(k)) edges.push({ from: e.from, to: e.to, status: 'A', raw: e.raw ?? null, target: e.target ?? null })
for (const [k, e] of baseEdges) if (!headEdges.has(k)) edges.push({ from: e.from, to: e.to, status: 'D', raw: e.raw ?? null, target: e.target ?? null })

const shots = (side) => {
  const d = path.join(diffDir, side, 'screens')
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : []
}
const baseShots = shots('base')
const headShots = shots('head')

const annotated = suspects.capture.map(({ side, slug, urlPath, ...n }) => ({ ...n, ...noteFor(n.id) }))

// Per-state diff: each suspect screen's capture set — the bare screen (name "")
// plus every captured variant — gets its own status, so a screen whose change
// only shows in one state (a scrolled list, an open sheet) points the reviewer
// at that exact state. notes.json may refine per state:
//   "Settings": { "note": "...", "states": {
//     "": { "note": "top of list identical", "verdict": "unaffected" },
//     "bottom": "New 'Beta features' row appears" } }
const stateNoteFor = (id, name) => {
  const v = notes[id]
  const sv = v && typeof v === 'object' ? v.states?.[name] : undefined
  if (typeof sv === 'string') return { note: sv, unaffected: false }
  if (sv && typeof sv === 'object') return { note: sv.note ?? null, unaffected: sv.verdict === 'unaffected' }
  return { note: null, unaffected: false }
}
const variantsOf = (slug, list) =>
  new Set(list.filter((f) => f.startsWith(slug + '--')).map((f) => f.replace(/\.\w+$/, '').slice(slug.length + 2)))
const states = []
for (const n of annotated) {
  if (n.dismissed) continue
  const route = headById.get(n.id) ?? baseById.get(n.id)
  const bv = variantsOf(route.slug, baseShots)
  const hv = variantsOf(route.slug, headShots)
  const push = (name, status) => {
    const { note, unaffected } = stateNoteFor(n.id, name)
    states.push({ node: n.id, name, status: unaffected ? 'unchanged' : status, reason: 'capture', note })
  }
  if (n.status === 'M') {
    push('', 'M')
    for (const s of new Set([...hv, ...bv])) push(s, hv.has(s) ? (bv.has(s) ? 'M' : 'A') : 'D')
  } else {
    // added/removed screens: every captured state shares the screen's fate
    push('', n.status)
    for (const s of n.status === 'A' ? hv : bv) push(s, n.status)
  }
}
// advisory hint-level changes (stateHints in the graph, no capture backing them)
for (const r of headGraph.routes) {
  const b = baseById.get(r.id)
  const hintKey = (h) => `${h.type}:${h.lib ?? ''}`
  const bh = new Set((b?.stateHints ?? []).map(hintKey))
  const hh = new Set((r.stateHints ?? []).map(hintKey))
  for (const h of hh) if (!bh.has(h)) states.push({ node: r.id, name: h, status: 'A', reason: 'hint' })
  if (b) for (const h of bh) if (!hh.has(h)) states.push({ node: r.id, name: h, status: 'D', reason: 'hint' })
}
const diff = {
  changedFiles,
  broadFiles: suspects.broadFiles ?? [],
  nodes: annotated.filter((n) => !n.dismissed).map(({ dismissed, ...n }) => n),
  dismissed: annotated.filter((n) => n.dismissed).map((n) => ({ id: n.id, reason: n.reason, note: n.note })),
  edges,
  states,
}
fs.writeFileSync(path.join(diffDir, 'diff.json'), JSON.stringify(diff, null, 2))

// per-side map.json, same node mapping as pack-map.mjs
const sideMap = (graph, side, shotFiles) => {
  const captureStatus = readJson(path.join(diffDir, side, 'capture-status.json'), {})
  const nodes = graph.routes.map((r) => {
    const cs = captureStatus[r.id] ?? {}
    const baseShot = shotFiles.find((f) => f.replace(/\.\w+$/, '') === r.slug)
    const stateShots = shotFiles
      .filter((f) => f.startsWith(r.slug + '--'))
      .map((f) => ({ name: f.replace(/\.\w+$/, '').slice(r.slug.length + 2), screenshot: 'screens/' + f }))
      .sort((a, b) => a.name.localeCompare(b.name))
    return {
      id: r.id, urlPath: r.urlPath, file: r.file ?? null, slug: r.slug,
      group: r.layoutDir ?? '', navigator: r.navigator ?? null, params: r.params ?? [],
      presentation: r.presentation ?? null, stateHints: r.stateHints ?? [],
      capture: {
        status: cs.status ?? (baseShot ? 'ok' : 'missing'),
        note: cs.note ?? null,
        needsNavigation: cs.needsNavigation ?? false,
        screenshot: baseShot ? 'screens/' + baseShot : null,
        states: stateShots,
      },
    }
  })
  return { nodes, edges: graph.edges ?? [], flows: [] }
}

const appName = path.basename(headGraph.projectRoot ?? '.')
const sideMeta = (graph, side) => ({
  ref: pr?.[side + 'Ref'] ?? null,
  commit: pr?.[side + 'Sha'] ?? null,
  generatedAt: graph.generatedAt ?? null,
})
const manifest = {
  formatVersion: 1,
  kind: 'diff',
  generator: 'expo-map/2.0',
  app: {
    name: appName,
    scheme: headGraph.scheme ?? null,
    platform: 'ios-simulator',
    device: opts.device ?? null,
    mode: headGraph.mode ?? null,
  },
  base: sideMeta(baseGraph, 'base'),
  head: sideMeta(headGraph, 'head'),
  ...(pr?.number ? { pr: { number: pr.number, title: pr.title ?? null, url: pr.url ?? null } } : {}),
  generatedAt: new Date().toISOString(),
}

const stage = fs.mkdtempSync(path.join(diffDir, '.pack-'))
try {
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(stage, 'diff.json'), JSON.stringify(diff, null, 2))
  for (const [side, graph, files] of [['base', baseGraph, baseShots], ['head', headGraph, headShots]]) {
    fs.mkdirSync(path.join(stage, side, 'screens'), { recursive: true })
    fs.writeFileSync(path.join(stage, side, 'map.json'), JSON.stringify(sideMap(graph, side, files), null, 2))
    for (const f of files) fs.copyFileSync(path.join(diffDir, side, 'screens', f), path.join(stage, side, 'screens', f))
  }
  const slug = pr?.number ? `pr${pr.number}` : `${(pr?.baseSha ?? 'base').slice(0, 7)}..${(pr?.headSha ?? 'head').slice(0, 7)}`
  const outPath = path.resolve(opts.out ?? path.join(diffDir, `${appName}-${slug}.appmapdiff`))
  fs.rmSync(outPath, { force: true })
  execFileSync('zip', ['-r', '-q', outPath, 'manifest.json', 'diff.json', 'base', 'head'], { cwd: stage })
  const kb = Math.round(fs.statSync(outPath).size / 1024)
  const n = (s) => diff.nodes.filter((c) => c.status === s).length
  console.log(`wrote ${outPath} (${kb} KB) — nodes: ${n('A')}A/${n('M')}M/${n('D')}D · edges: ${edges.filter((e) => e.status === 'A').length}A/${edges.filter((e) => e.status === 'D').length}D · states: ${states.length} · shots: ${baseShots.length} base + ${headShots.length} head`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
