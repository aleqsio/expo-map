// expo-router — file-based routing under app/. The directory tree *is* the URL
// space, so every route is deep-linkable and reachability needs no inference.

import fs from 'node:fs'
import path from 'node:path'
import { extractHints } from '../lib/hints.mjs'

export const meta = {
  id: 'expo-router',
  title: 'Expo Router',
  reach: 'deep-link',
}

const APP_DIRS = ['app', 'src/app']

function findAppDir(ctx) {
  return APP_DIRS.map((d) => path.join(ctx.projectRoot, d)).find((d) => fs.existsSync(d)) ?? null
}

// An `app/` directory is not by itself expo-router — plenty of react-navigation
// apps use app/ as a source root. The route tree is what distinguishes them:
// expo-router needs a _layout, and the dependency seals it.
export function detect(ctx) {
  const evidence = []
  let score = 0
  const appDir = findAppDir(ctx)
  if (!appDir) return { score: 0, evidence: ['no app/ or src/app/'] }

  const files = ctx.walk(appDir, { skip: null })
  const hasLayout = files.some((f) => /(^|\/)_layout\.[jt]sx?$/.test(ctx.rel(f)))
  if (hasLayout) {
    score += 0.6
    evidence.push(`${ctx.rel(appDir)}/ contains a _layout route`)
  } else {
    evidence.push(`${ctx.rel(appDir)}/ exists but has no _layout`)
  }

  if (ctx.deps()['expo-router']) {
    score += 0.35
    evidence.push('expo-router in package.json')
  }
  // A bare app/ tree of .tsx files with no _layout and no dependency is more
  // likely a source root than a router tree, so it stays below the threshold.
  if (!hasLayout && !ctx.deps()['expo-router']) score = 0.1

  return { score: Math.min(score, 1), evidence, appDir: ctx.rel(appDir) }
}

export function parse(ctx) {
  const appDir = findAppDir(ctx)
  if (!appDir) throw new Error('expo-router: no app/ or src/app/ directory')

  const rel = ctx.rel
  const EXTS = new Set(['.tsx', '.jsx', '.ts', '.js'])
  const NON_ROUTE_BASES = new Set(['+html', '+native-intent', '+middleware'])

  const entries = ctx.walk(appDir, { skip: null })
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

  const matchers = routes.map((r) => ({ route: r, re: ctx.routeMatcher(r.urlPath) }))
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
    const own = ctx.firstPartyImports(r._src, r.file)
    importsOfRoute.set(r.id, own)
    for (const f of new Set(own)) fanout.set(f, (fanout.get(f) ?? 0) + 1)
  }

  const edges = []
  for (const r of routes) {
    const raws = new Set()
    const sources = [r._src]
    for (const f of importsOfRoute.get(r.id) ?? []) {
      if ((fanout.get(f) ?? 0) > IMPORT_FANOUT_CAP) continue
      const s = ctx.readFileOrNull(path.join(ctx.projectRoot, f))
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
  return { appDir: rel(appDir), layouts, routes, edges }
}
