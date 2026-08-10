#!/usr/bin/env node
// Static route + link extractor — mode 3: react-navigation apps whose route table
// lives in a React Navigation *linking config* (`linking={{ prefixes, config: { screens } }}`)
// rather than a standalone route-map module.
//
// This is the shape most Expo + react-navigation apps ship with: screen names are
// exported string constants, screens live in `app/screens/<kebab-name>-screen/`
// directories, and navigation happens through `navigation.navigate(SCREEN_CONST)`.
// parse-routes.mjs's mode 2 can't read it (it wants `src/routes.ts` + `src/Navigation.tsx`
// with `component={}` bindings); mode 1 misfires because `app/` here is a source root,
// not an expo-router tree.
//
// Usage: node parse-routes-rn-linking.mjs [projectRoot] [--out <path>]
//                                         [--linking <file>] [--screens-dir <dir>]
// Output: the same graph.json contract as parse-routes.mjs, so pack-map.mjs and
//         render-map.mjs consume it unchanged.

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let projectRoot = '.'
let outPath = null
let linkingArg = null
let screensDirArg = null
let navigatorArg = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i]
  else if (args[i] === '--linking') linkingArg = args[++i]
  else if (args[i] === '--screens-dir') screensDirArg = args[++i]
  else if (args[i] === '--navigator') navigatorArg = args[++i]
  else projectRoot = args[i]
}
projectRoot = path.resolve(projectRoot)
outPath = outPath ?? path.join(projectRoot, '.expo-map', 'graph.json')

const SRC_EXT = /\.(tsx?|jsx?)$/
const SKIP_DIR = /(^|\/)(__tests__|__mocks__|node_modules|\.git)(\/|$)/

function walk(dir) {
  const out = []
  if (!fs.existsSync(dir)) return out
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (SKIP_DIR.test(p.split(path.sep).join('/'))) continue
    if (e.isDirectory()) out.push(...walk(p))
    else if (SRC_EXT.test(e.name)) out.push(p)
  }
  return out
}

const rel = (p) => path.relative(projectRoot, p).split(path.sep).join('/')

function readAppName() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(projectRoot, 'app.json'), 'utf8'))
    const n = cfg.expo?.name ?? cfg.name
    if (n) return n
  } catch {}
  return path.basename(projectRoot)
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

// ---------- state hints (kept byte-identical to parse-routes.mjs) ----------

const SHEET_LIBS = [
  ['@expo/ui/community/bottom-sheet', 'expo-ui-bottom-sheet'],
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
  if (/useDialogControl|Dialog\.Outer/.test(src))
    hints.push({ type: 'bottom-sheet', lib: 'app-dialog', snapPoints: null })
  if (/<Modal[\s>]/.test(src)) hints.push({ type: 'rn-modal' })
  return hints
}

// ---------- 1. locate + parse the linking config ----------

function findLinkingFile() {
  if (linkingArg) return path.resolve(projectRoot, linkingArg)
  const candidates = ['app/app.tsx', 'App.tsx', 'src/App.tsx', 'app/App.tsx', 'src/app.tsx']
  for (const c of candidates) {
    const p = path.join(projectRoot, c)
    if (fs.existsSync(p) && /screens\s*:\s*\{/.test(fs.readFileSync(p, 'utf8'))) return p
  }
  return null
}

// Pull the `screens: { Name: "path", ... }` block. Nested navigator configs
// (`Name: { screens: {...} }`) are flattened one level, joining path prefixes.
function parseLinkingScreens(src) {
  const start = src.search(/screens\s*:\s*\{/)
  if (start === -1) return []
  const open = src.indexOf('{', start)
  let depth = 0
  let end = open
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') {
      depth--
      if (depth === 0) { end = i; break }
    }
  }
  const block = src.slice(open + 1, end)
  const out = []
  const entryRe = /^\s*([A-Za-z0-9_]+)\s*:\s*["'`]([^"'`\n]*)["'`]/gm
  for (const m of block.matchAll(entryRe)) out.push({ name: m[1], urlPath: m[2] })
  return out
}

// ---------- 2. constant identifier -> screen-name string ----------

// `preferred` is the set of screen names the linking config declares. Codebases
// this size grow shadow constants — Openers exports USER_NICKNAME_SCREEN twice
// with two different casings — so on a collision the value the router actually
// knows about wins, and the collision is reported rather than silently resolved.
function buildConstantMap(files, preferred = new Set()) {
  const map = {}
  const collisions = {}
  const re = /export\s+const\s+([A-Z][A-Z0-9_]*)\s*(?::[^=]*)?=\s*["']([A-Za-z0-9_]+)["']/g
  for (const f of files) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(re)) {
      const [, name, value] = m
      const prev = map[name]
      if (prev !== undefined && prev !== value) {
        collisions[name] = [...new Set([...(collisions[name] ?? [prev]), value])]
        if (preferred.has(prev) && !preferred.has(value)) continue
      }
      map[name] = value
    }
  }
  return { map, collisions }
}

// ---------- 3. screen name -> source directory ----------

const kebab = (s) => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

function resolveScreenSource(name, screensDir) {
  const slug = kebab(name)
  for (const candidate of [`${slug}-screen`, slug]) {
    const p = path.join(screensDir, candidate)
    if (fs.existsSync(p)) return p
  }
  // Screens that live as a single file inside a grouping folder
  // (e.g. screens/companions/apple-watch-doorway.tsx).
  for (const entry of fs.existsSync(screensDir) ? fs.readdirSync(screensDir) : []) {
    const group = path.join(screensDir, entry)
    if (!fs.statSync(group).isDirectory()) continue
    for (const ext of ['.tsx', '.ts', '.jsx', '.js']) {
      const p = path.join(group, slug + ext)
      if (fs.existsSync(p)) return p
    }
  }
  return null
}

// ---------- main ----------

const linkingFile = findLinkingFile()
if (!linkingFile) {
  console.error(
    `error: no react-navigation linking config (a file with \`screens: { ... }\`) found in ${projectRoot}. ` +
      `Pass --linking <file>.`
  )
  process.exit(1)
}

const screensDir = path.resolve(projectRoot, screensDirArg ?? 'app/screens')
const allSources = walk(path.join(projectRoot, 'app')).concat(
  fs.existsSync(path.join(projectRoot, 'src')) ? walk(path.join(projectRoot, 'src')) : []
)
const entries = parseLinkingScreens(fs.readFileSync(linkingFile, 'utf8'))
const { map: constants, collisions: constantCollisions } = buildConstantMap(
  allSources,
  new Set(entries.map((e) => e.name))
)

// Screens registered on the navigator but absent from the linking config exist —
// they're just not deep-linkable. They belong on the map (reached by in-app taps
// only); the sweep has to navigate to them instead of opening a URL.
const navigatorFile =
  navigatorArg
    ? path.resolve(projectRoot, navigatorArg)
    : allSources.find((f) => /<(?:[A-Za-z]+\.)?Screen\s+name=/.test(fs.readFileSync(f, 'utf8')))
if (navigatorFile) {
  const navSrc = fs.readFileSync(navigatorFile, 'utf8')
  const known = new Set(entries.map((e) => e.name))
  const screenRe = /<(?:[A-Za-z]+\.)?Screen\s+name=\{?\s*["']?([A-Za-z0-9_]+)["']?\s*\}?/g
  for (const m of navSrc.matchAll(screenRe)) {
    const name = constants[m[1]] ?? m[1]
    if (known.has(name)) continue
    known.add(name)
    entries.push({ name, urlPath: null })
  }
}

const routes = entries.map(({ name, urlPath }) => {
  const source = resolveScreenSource(name, screensDir)
  const files = source
    ? fs.statSync(source).isDirectory()
      ? walk(source)
      : [source]
    : []
  const src = files.map((f) => fs.readFileSync(f, 'utf8')).join('\n')
  const segments = (urlPath ?? '').split('/').filter(Boolean)
  return {
    id: name,
    file: source ? rel(source) : rel(linkingFile),
    sourceFiles: files.map(rel),
    urlPath: urlPath == null ? null : '/' + urlPath,
    deepLinkable: urlPath != null,
    aliases: [],
    slug: name,
    params: [],
    navigator: 'react-navigation',
    layoutDir: segments.length > 1 ? segments[0] : '',
    presentation: null,
    stateHints: source ? extractHints(src) : [],
    _src: src,
  }
})

const routeIds = new Set(routes.map((r) => r.id))

// ---------- edges: navigation.navigate(CONST | "Name") within each screen's tree ----------

const NAV_CALL_RE = /\b(?:navigate|push|replace)\(\s*(?:["']([A-Za-z0-9_]+)["']|([A-Z][A-Z0-9_]*))/g
const edges = []
for (const r of routes) {
  const seen = new Set()
  for (const m of r._src.matchAll(NAV_CALL_RE)) {
    const raw = m[1] ?? m[2]
    const target = m[1] ?? constants[m[2]]
    if (!target || !routeIds.has(target) || target === r.id || seen.has(target)) continue
    seen.add(target)
    edges.push({
      from: r.id,
      to: target,
      raw: `navigate(${m[1] ? `'${raw}'` : raw})`,
      target: routes.find((x) => x.id === target).urlPath,
    })
  }
}

for (const r of routes) delete r._src

const layouts = [...new Set(routes.map((r) => r.layoutDir))].map((dir) => ({
  file: rel(linkingFile),
  dir,
  navigator: 'react-navigation',
}))

const scheme = readScheme()
const graph = {
  generatedAt: new Date().toISOString(),
  projectRoot,
  appName: readAppName(),
  scheme,
  deepLinkTemplates: {
    devBuild: scheme ? `${scheme}://<urlPath minus leading slash>` : null,
    expoGo: 'exp://127.0.0.1:8081/--<urlPath>',
  },
  mode: 'react-navigation-linking',
  linkingFile: rel(linkingFile),
  navigationFile: navigatorFile ? rel(navigatorFile) : null,
  screensDir: rel(screensDir),
  componentsResolved: routes.filter((r) => r.sourceFiles.length > 0).length,
  layouts,
  routes,
  edges,
  summary: {
    mode: 'react-navigation-linking',
    routes: routes.length,
    layouts: layouts.length,
    edges: edges.length,
    unresolvedEdges: edges.filter((e) => e.to == null).length,
    routesWithStateHints: routes.filter((r) => r.stateHints.length > 0).length,
    routesNeedingParams: routes.filter((r) => r.params.length > 0).length,
    deepLinkable: routes.filter((r) => r.deepLinkable).length,
    navOnly: routes.filter((r) => !r.deepLinkable).map((r) => r.id),
    routesWithoutSource: routes.filter((r) => r.sourceFiles.length === 0).map((r) => r.id),
    constantCollisions,
  },
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(graph, null, 2))
console.log(`wrote ${outPath}`)
console.log(JSON.stringify(graph.summary, null, 2))
