#!/usr/bin/env node
// Static route + link extractor. Two modes, one graph format:
//   expo-router      — walks app/ implementing file-based routing conventions
//   react-navigation — parses a route-map file (screen name → URL path, as in
//                      Bluesky's src/routes.ts) plus Navigation.tsx screen bindings
//
// Usage: node parse-routes.mjs [projectRoot] [--out <path>] [--routes <file>]
// Output: JSON graph (default <projectRoot>/.screenmap/out/graph.json)

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let projectRoot = '.'
let outPath = null
let routesFileArg = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i]
  else if (args[i] === '--routes') routesFileArg = args[++i]
  else projectRoot = args[i]
}
projectRoot = path.resolve(projectRoot)
outPath = outPath ?? path.join(projectRoot, '.screenmap', 'out', 'graph.json')

// ---------- shared helpers ----------

function walk(dir) {
  const out = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(p))
    else out.push(p)
  }
  return out
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function rel(p) {
  return path.relative(projectRoot, p).split(path.sep).join('/')
}

function readFileOrNull(p) {
  try { return fs.readFileSync(p, 'utf8') } catch { return null }
}

// tsconfig.json is JSONC in the wild. The stripper must be string-aware: a
// plain /*…*/ sweep eats a stock Expo `paths` block, because "@/*" opens a
// comment and the "**/*.ts" in `include` closes it.
function stripJsonc(src) {
  let out = '', inStr = false, esc = false, line = false, block = false
  for (let i = 0; i < src.length; i++) {
    const c = src[i], n = src[i + 1]
    if (line) { if (c === '\n') { line = false; out += c } continue }
    if (block) { if (c === '*' && n === '/') { block = false; i++ } continue }
    if (inStr) {
      out += c
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') { inStr = true; out += c; continue }
    if (c === '/' && n === '/') { line = true; i++; continue }
    if (c === '/' && n === '*') { block = true; i++; continue }
    out += c
  }
  return out.replace(/,(\s*[}\]])/g, '$1')
}

const IMPORT_EXT = ['.tsx', '.ts', '.jsx', '.js']
let _aliases = null
function pathAliases() {
  if (_aliases) return _aliases
  _aliases = []
  const src = readFileOrNull(path.join(projectRoot, 'tsconfig.json'))
  if (src) {
    let cfg = null
    try { cfg = JSON.parse(stripJsonc(src)) } catch { try { cfg = JSON.parse(src) } catch {} }
    for (const [pat, targets] of Object.entries(cfg?.compilerOptions?.paths ?? {}))
      _aliases.push({ prefix: pat.replace(/\*$/, ''), targets: targets.map((t) => t.replace(/\*$/, '').replace(/^\.\//, '')) })
  }
  return _aliases
}

function resolveToRel(candidate) {
  for (const suffix of ['', ...IMPORT_EXT, ...IMPORT_EXT.map((e) => '/index' + e)]) {
    const c = candidate + suffix
    try { if (fs.statSync(path.join(projectRoot, c)).isFile()) return c } catch {}
  }
  return null
}

// repo-relative targets of a file's first-party imports; bare package imports
// resolve to null and drop out
function firstPartyImports(src, fromRel) {
  const specs = [
    ...src.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"]*?from\s*['"]([^'"]+)['"]/g),
    ...src.matchAll(/(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g),
  ].map((m) => m[1])
  const out = []
  for (const spec of new Set(specs)) {
    let hit = null
    if (spec.startsWith('.')) {
      hit = resolveToRel(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec)))
    } else {
      for (const a of pathAliases()) {
        if (!spec.startsWith(a.prefix)) continue
        for (const t of a.targets) {
          hit = resolveToRel(path.posix.normalize(t + spec.slice(a.prefix.length)))
          if (hit) break
        }
        if (hit) break
      }
    }
    if (hit) out.push(hit)
  }
  return out
}

function readScheme() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'))
    const s = cfg.expo?.scheme ?? cfg.scheme
    const v = (Array.isArray(s) ? s[0] : s) ?? null
    if (v) return v
  } catch {}
  for (const f of ['app.config.js', 'app.config.ts']) {
    try {
      const src = fs.readFileSync(path.join(projectRoot, f), 'utf8')
      const m = src.match(/\bscheme\s*:\s*["']([A-Za-z0-9._+-]+)["']/)
      if (m) return m[1]
    } catch {}
  }
  return null
}

// route pattern → regex; supports [param]/[...param] (expo) and :param (RN)
function routeMatcher(urlPath) {
  const re = urlPath
    .split('/')
    .map((seg) =>
      seg.startsWith('[...') ? '.*'
      : seg.startsWith('[') || seg.startsWith(':') ? '[^/]+'
      : escapeRe(seg)
    )
    .join('/')
  return new RegExp('^' + re + '/?$')
}

const SHEET_LIBS = [
  ['@gorhom/bottom-sheet', 'gorhom-bottom-sheet'],
  ['react-native-actions-sheet', 'actions-sheet'],
  ['@lodev09/react-native-true-sheet', 'true-sheet'],
  ['react-native-raw-bottom-sheet', 'raw-bottom-sheet'],
]

function extractHints(src) {
  const hints = []
  for (const [lib, label] of SHEET_LIBS) {
    if (src.includes(lib)) {
      const snap = src.match(/snapPoints\s*[:=][^[\n]*\[([^\]]+)\]/)
      const snapPoints = snap
        ? snap[1].split(',').map((s) => s.trim().replace(/["'`]/g, '')).filter(Boolean)
        : null
      hints.push({ type: 'bottom-sheet', lib: label, snapPoints })
    }
  }
  // app-level dialog/sheet systems (e.g. Bluesky's Dialog is a native bottom sheet)
  if (/useDialogControl|Dialog\.Outer/.test(src))
    hints.push({ type: 'bottom-sheet', lib: 'app-dialog', snapPoints: null })
  if (/<Modal[\s>]/.test(src)) hints.push({ type: 'rn-modal' })
  return hints
}

// ---------- mode 1: expo-router ----------

function parseExpoRouter(appDir) {
  const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js'])
  const NON_ROUTE_BASES = new Set(['+html', '+native-intent', '+middleware'])

  const entries = walk(appDir)
    .filter((f) => EXTS.has(path.extname(f)))
    .map((f) => {
      const relApp = path.relative(appDir, f).split(path.sep).join('/')
      const noExt = relApp.slice(0, -path.extname(relApp).length)
      const base = path.posix.basename(noExt)
      const dir = path.posix.dirname(noExt)
      return { abs: f, noExt, base, dir: dir === '.' ? '' : dir }
    })
    .filter((e) => !e.base.endsWith('+api') && !NON_ROUTE_BASES.has(e.base))

  const layoutEntries = entries.filter((e) => e.base === '_layout')
  const screenEntries = entries.filter((e) => e.base !== '_layout')

  const layoutsByDir = {}
  for (const l of layoutEntries) {
    const src = fs.readFileSync(l.abs, 'utf8')
    const nav = src.match(/<\s*(NativeTabs|Tabs|Stack|Drawer|Slot)\b/)
    layoutsByDir[l.dir] = { file: rel(l.abs), dir: l.dir, navigator: nav ? nav[1] : null, src }
  }

  function nearestLayout(dir) {
    let d = dir
    while (true) {
      if (layoutsByDir[d]) return layoutsByDir[d]
      if (d === '') return null
      const parent = path.posix.dirname(d)
      d = parent === '.' ? '' : parent
    }
  }

  const presentations = []
  for (const l of Object.values(layoutsByDir)) {
    for (const tag of l.src.match(/<[\w.]*Screen\b[^>]*>/g) ?? []) {
      const name = tag.match(/name\s*=\s*["']([^"']+)["']/)?.[1]
      const presentation = tag.match(/presentation\s*:\s*["']([a-zA-Z]+)["']/)?.[1]
      if (name && presentation)
        presentations.push({ prefix: l.dir ? `${l.dir}/${name}` : name, presentation })
    }
  }

  function toSlug(noExt) {
    let s = noExt === 'index' ? 'index' : noExt.replace(/\/index$/, '')
    s = s.replace(/[()[\]]/g, '').replace(/\.\.\./g, '').replace(/\//g, '_')
    return s || 'index'
  }

  const routes = screenEntries.map((e) => {
    const segments = e.noExt.split('/')
    if (segments[segments.length - 1] === 'index') segments.pop()
    const urlSegments = segments.filter((s) => !(s.startsWith('(') && s.endsWith(')')))
    const urlPath = '/' + urlSegments.join('/')
    const params = segments
      .filter((s) => s.startsWith('[') && s.endsWith(']'))
      .map((s) => s.slice(1, -1).replace(/^\.\.\./, ''))
    const layout = nearestLayout(e.dir)
    const presentation =
      presentations.find((p) => e.noExt === p.prefix || e.noExt.startsWith(p.prefix + '/'))
        ?.presentation ?? null
    const src = fs.readFileSync(e.abs, 'utf8')
    const stateHints = extractHints(src)
    if (presentation && /modal/i.test(presentation))
      stateHints.push({ type: 'router-modal', presentation })
    return {
      id: e.noExt, file: rel(e.abs), urlPath, slug: toSlug(e.noExt), params,
      navigator: layout?.navigator ?? null, layoutDir: layout?.dir ?? null,
      presentation, stateHints, _src: src,
    }
  })

  const matchers = routes.map((r) => ({ route: r, re: routeMatcher(r.urlPath) }))
  const HREF_RE = /href=\{?\s*["'`]([^"'`]+)["'`]/g
  const PATHNAME_RE = /pathname\s*:\s*["'`]([^"'`]+)["'`]/g
  const ROUTER_RE = /(?:router|navigation)\.(?:push|replace|navigate)\(\s*["'`]([^"'`]+)["'`]/g

  // A route's own source is not where its links live in ordinary code: put the
  // <Link> in a list-item component and the screen reads as unreachable. So the
  // scan follows each route's first-party imports one hop.
  //
  // One hop, and not into shared chrome: a header or tab bar imported by most
  // screens would otherwise attribute its links to every one of them and turn
  // the graph into a hairball. Files imported by more than IMPORT_FANOUT_CAP
  // routes are treated as chrome and skipped.
  const IMPORT_FANOUT_CAP = 8
  const importsOfRoute = new Map() // route.id → [repo-rel file]
  const fanout = new Map() // repo-rel file → route count
  for (const r of routes) {
    const own = firstPartyImports(r._src, r.file)
    importsOfRoute.set(r.id, own)
    for (const f of new Set(own)) fanout.set(f, (fanout.get(f) ?? 0) + 1)
  }

  const edges = []
  for (const r of routes) {
    const raws = new Set()
    const sources = [r._src]
    for (const f of importsOfRoute.get(r.id) ?? []) {
      if ((fanout.get(f) ?? 0) > IMPORT_FANOUT_CAP) continue
      const s = readFileOrNull(path.join(projectRoot, f))
      if (s) sources.push(s)
    }
    for (const src of sources)
      for (const re of [HREF_RE, PATHNAME_RE, ROUTER_RE])
        for (const m of src.matchAll(re)) raws.add(m[1])
    for (const raw of raws) {
      let t = raw.split(/[?#]/)[0]
      if (/^(https?|mailto|tel):/.test(t)) continue
      if (!t.startsWith('/')) {
        t = path.posix.normalize(path.posix.join(path.posix.dirname(r.urlPath), t))
        if (!t.startsWith('/')) t = '/' + t
      }
      if (t === '') t = '/'
      // group segments are legal in hrefs but absent from urlPath; template-literal
      // params (`/user/${id}`) become a concrete dummy for matching
      const probe =
        t.split('/')
          .filter((s) => !(s.startsWith('(') && s.endsWith(')')))
          .join('/')
          .replace(/\$\{[^}]*\}/g, 'X') || '/'
      const hit = matchers.find((m) => m.re.test(probe))
      edges.push({ from: r.id, to: hit?.route.id ?? null, raw, target: t })
    }
  }

  for (const r of routes) delete r._src
  const layouts = Object.values(layoutsByDir).map(({ src, ...l }) => l)
  return { mode: 'expo-router', appDir: rel(appDir), layouts, routes, edges }
}

// ---------- mode 2: react-navigation route map ----------

function findRoutesFile() {
  if (routesFileArg) return path.resolve(projectRoot, routesFileArg)
  for (const c of ['src/routes.ts', 'src/routes.tsx', 'src/routes.js', 'routes.ts'])
    if (fs.existsSync(path.join(projectRoot, c))) return path.join(projectRoot, c)
  return null
}

function resolveImport(spec, fromFile) {
  let base
  if (spec.startsWith('#/')) base = path.join(projectRoot, 'src', spec.slice(2))
  else if (spec.startsWith('.')) base = path.resolve(path.dirname(fromFile), spec)
  else return null // package import
  for (const suffix of ['', '.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts']) {
    const p = base + suffix
    if (fs.existsSync(p) && fs.statSync(p).isFile()) return p
  }
  return null
}

function parseRouteMap(routesFile) {
  const src = fs.readFileSync(routesFile, 'utf8')
  const routes = []
  const entryRe = /^\s*([A-Za-z0-9_]+):\s*(\[[^\]]*\]|["'`][^"'`\n]*["'`])/gm
  for (const m of src.matchAll(entryRe)) {
    const name = m[1]
    const paths = [...m[2].matchAll(/["'`]([^"'`]+)["'`]/g)].map((x) => x[1])
    if (!paths.length || !paths[0].startsWith('/')) continue
    const urlPath = paths[0]
    routes.push({
      id: name,
      file: rel(routesFile),
      urlPath,
      aliases: paths.slice(1),
      slug: name,
      params: urlPath.split('/').filter((s) => s.startsWith(':')).map((s) => s.slice(1)),
      navigator: 'react-navigation',
      layoutDir: null, // filled below from path grouping
      presentation: null,
      stateHints: [],
    })
  }

  // group by first path segment when ≥2 routes share it; singletons go to root
  const segCount = new Map()
  for (const r of routes) {
    const seg = r.urlPath.split('/')[1] ?? ''
    segCount.set(seg, (segCount.get(seg) ?? 0) + 1)
  }
  for (const r of routes) {
    const seg = r.urlPath.split('/')[1] ?? ''
    r.layoutDir = segCount.get(seg) >= 2 && seg !== '' ? seg : ''
  }
  const layouts = [...new Set(routes.map((r) => r.layoutDir))].map((dir) => ({
    file: rel(routesFile), dir, navigator: 'react-navigation',
  }))

  // screen name → component file, via Navigation.tsx bindings + its imports
  const navFile = ['src/Navigation.tsx', 'src/Navigation.jsx', 'src/Navigation.ts', 'Navigation.tsx']
    .map((c) => path.join(projectRoot, c))
    .find((p) => fs.existsSync(p))
  const componentFiles = {} // route id → abs file
  if (navFile) {
    const navSrc = fs.readFileSync(navFile, 'utf8')
    const imports = {} // identifier → abs file
    const importRe = /import\s+(?:([A-Za-z0-9_]+)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
    for (const m of navSrc.matchAll(importRe)) {
      const resolved = resolveImport(m[3], navFile)
      if (!resolved) continue
      if (m[1]) imports[m[1]] = resolved
      for (const part of (m[2] ?? '').split(',')) {
        const pm = part.trim().match(/^(?:type\s+)?([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/)
        if (pm) imports[pm[2] ?? pm[1]] = resolved
      }
    }
    const bindRe = /name="([A-Za-z0-9_]+)"[\s\S]{0,160}?(?:getComponent=\{\(\)\s*=>\s*([A-Za-z0-9_]+)\}|component=\{([A-Za-z0-9_]+)\})/g
    for (const m of navSrc.matchAll(bindRe)) {
      const file = imports[m[2] ?? m[3]]
      if (file) componentFiles[m[1]] = file
    }
  }

  // edges + state hints from each screen's component file (shallow: that file only)
  const matchers = routes.map((r) => ({ route: r, re: routeMatcher(r.urlPath) }))
  const routeById = Object.fromEntries(routes.map((r) => [r.id, r]))
  const NAV_CALL_RE = /\b(?:navigate|push|replace)\(\s*["']([A-Za-z0-9_]+)["']/g
  const LINK_RE = /(?:href|to)=\{?\s*["'`](\/[^"'`\s]*)["'`]/g
  const edges = []
  for (const r of routes) {
    const file = componentFiles[r.id]
    if (!file) continue
    r.file = rel(file)
    const src2 = fs.readFileSync(file, 'utf8')
    r.stateHints = extractHints(src2)
    const seen = new Set()
    for (const m of src2.matchAll(NAV_CALL_RE)) {
      const target = routeById[m[1]]
      if (target && !seen.has(target.id)) {
        seen.add(target.id)
        edges.push({ from: r.id, to: target.id, raw: `navigate('${m[1]}')`, target: target.urlPath })
      }
    }
    for (const m of src2.matchAll(LINK_RE)) {
      const t = m[1].split(/[?#]/)[0].replace(/\$\{[^}]*\}/g, 'X') || '/'
      const hit = matchers.find((x) => x.re.test(t))
      if (hit && !seen.has(hit.route.id)) {
        seen.add(hit.route.id)
        edges.push({ from: r.id, to: hit.route.id, raw: m[1], target: t })
      }
    }
  }

  return {
    mode: 'react-navigation',
    routesFile: rel(routesFile),
    navigationFile: navFile ? rel(navFile) : null,
    componentsResolved: Object.keys(componentFiles).length,
    layouts, routes, edges,
  }
}

// ---------- main ----------

const appDir = ['app', 'src/app']
  .map((d) => path.join(projectRoot, d))
  .find((d) => fs.existsSync(d))

let parsed
if (appDir) {
  parsed = parseExpoRouter(appDir)
} else {
  const routesFile = findRoutesFile()
  if (!routesFile) {
    console.error(
      `error: no app/ (expo-router) or src/routes.ts (react-navigation route map) found in ${projectRoot}`
    )
    process.exit(1)
  }
  parsed = parseRouteMap(routesFile)
}

const scheme = readScheme()
// routes nothing links to. The root is every app's entry point, so it never
// counts; neither does a tab or drawer child, which the navigator reaches by
// structure rather than by a link. (Stack children do not get that pass — a
// pushed screen needs something to push it.)
const linkedTo = new Set(parsed.edges.map((e) => e.to).filter(Boolean))
const structural = (r) =>
  /tab|drawer/i.test(r.navigator ?? '') ||
  /\([^)]*(?:tabs?|drawer)[^)]*\)/i.test(`${r.id}/${r.layoutDir ?? ''}`) ||
  // expo-router specials (+not-found, +html, _sitemap) are reached by the
  // router itself, never by a link
  r.id.split('/').some((s) => s.startsWith('+') || s.startsWith('_'))
const orphans = parsed.routes.filter(
  (r) => r.urlPath !== '/' && !linkedTo.has(r.id) && !structural(r)
)
const graph = {
  generatedAt: new Date().toISOString(),
  projectRoot,
  scheme,
  deepLinkTemplates: {
    devBuild: scheme ? `${scheme}://<urlPath minus leading slash>` : null,
    expoGo: 'exp://127.0.0.1:8081/--<urlPath>',
  },
  ...parsed,
  summary: {
    mode: parsed.mode,
    routes: parsed.routes.length,
    layouts: parsed.layouts.length,
    edges: parsed.edges.length,
    unresolvedEdges: parsed.edges.filter((e) => e.to == null).length,
    routesWithStateHints: parsed.routes.filter((r) => r.stateHints.length > 0).length,
    routesNeedingParams: parsed.routes.filter((r) => r.params.length > 0).length,
    orphanRoutes: orphans.length,
  },
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(graph, null, 2))
console.log(`wrote ${outPath}`)
console.log(JSON.stringify(graph.summary))
// A screen nothing links to is usually the parser missing the link, not the app
// missing the route — `href={item.href}` and other computed targets cannot be
// resolved statically. Say so, so a sparse map reads as a known limitation
// rather than as the truth about the app.
if (orphans.length)
  console.error(`note: ${orphans.length} route(s) have no incoming link and may just be links this parser cannot read (e.g. computed href): ${orphans.map((r) => r.urlPath).join(', ')}`)
