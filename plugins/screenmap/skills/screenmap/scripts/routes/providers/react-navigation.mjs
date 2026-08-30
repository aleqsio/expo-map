// react-navigation — screens are registered on navigators in code, not derived
// from the filesystem, so discovery works the other way round from expo-router:
// find every <X.Screen name=… component=…>, then overlay the linking config to
// learn which of them have a URL.
//
// The overlay is the point. A react-navigation app's linking config is optional
// and usually partial, so a screen having no URL is normal, not an error — it
// is simply reachable by tapping rather than by deep link. Those screens still
// belong on the map; they carry urlPath: null and the driver marks them
// navigation-only so the capture stage navigates instead of deep-linking.

import path from 'node:path'
import { extractHints } from '../lib/hints.mjs'

export const meta = {
  id: 'react-navigation',
  title: 'React Navigation',
  reach: 'mixed',
}

const SRC_EXT = /\.(tsx?|jsx?)$/
const SRC_DIRS = ['src', 'app', 'screens', 'navigation', '.']

const NAVIGATOR_TYPES = {
  createNativeStackNavigator: 'Stack',
  createStackNavigator: 'Stack',
  createBottomTabNavigator: 'Tabs',
  createMaterialBottomTabNavigator: 'Tabs',
  createMaterialTopTabNavigator: 'TopTabs',
  createDrawerNavigator: 'Drawer',
}

// ---------- source discovery ----------

function sourceFiles(ctx) {
  const seen = new Set()
  const out = []
  for (const d of SRC_DIRS) {
    const abs = d === '.' ? ctx.projectRoot : path.join(ctx.projectRoot, d)
    if (!ctx.exists(d === '.' ? '.' : d)) continue
    for (const f of ctx.walk(abs)) {
      if (!SRC_EXT.test(f) || seen.has(f)) continue
      // `.` is a last resort for flat projects; it must not re-walk src/
      seen.add(f)
      out.push(f)
    }
    // A real src/ tree means the root sweep would only add config files.
    if (d !== '.' && out.length) break
  }
  return out
}

// Read a JSX tag starting at `<`, tracking string and brace nesting so that
// options={({ route }) => ({ … })} does not end the tag at its first '>'.
function readTag(src, start) {
  let depth = 0, i = start, quote = null
  for (; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}') depth--
    else if (c === '>' && depth === 0) return src.slice(start, i + 1)
  }
  return src.slice(start, i)
}

// ---------- constants: name={SCREENS.HOME} / name={HOME_SCREEN} ----------

function buildConstantMap(ctx, files) {
  const scalars = {}   // HOME_SCREEN → "Home"
  const objects = {}   // SCREENS → { HOME: "Home" }
  const SCALAR_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*["'`]([^"'`]+)["'`]/g
  const OBJECT_RE = /\bexport\s+const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*\{([^}]*)\}/g
  const MEMBER_RE = /([A-Za-z_$][\w$]*)\s*:\s*["'`]([^"'`]+)["'`]/g
  for (const f of files) {
    const src = ctx.readFileOrNull(f)
    if (!src) continue
    for (const m of src.matchAll(SCALAR_RE)) scalars[m[1]] ??= m[2]
    for (const m of src.matchAll(OBJECT_RE)) {
      const members = {}
      for (const mm of m[2].matchAll(MEMBER_RE)) members[mm[1]] = mm[2]
      if (Object.keys(members).length) objects[m[1]] ??= members
    }
  }
  return { scalars, objects }
}

// A Screen's name attribute, whichever form it takes. Returns null when the
// value is computed in a way static reading cannot follow.
function resolveName(raw, consts) {
  if (raw == null) return null
  const lit = raw.match(/^["'`]([^"'`]+)["'`]$/)
  if (lit) return lit[1]
  const member = raw.match(/^([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)$/)
  if (member) return consts.objects[member[1]]?.[member[2]] ?? null
  const ident = raw.match(/^([A-Za-z_$][\w$]*)$/)
  if (ident) return consts.scalars[ident[1]] ?? null
  return null
}

// ---------- linking config ----------

// Pull the balanced { … } that follows `key` at or after `from`.
function blockAfter(src, key, from = 0) {
  const at = src.indexOf(key, from)
  if (at === -1) return null
  const open = src.indexOf('{', at)
  if (open === -1) return null
  let depth = 0, quote = null
  for (let i = open; i < src.length; i++) {
    const c = src[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; continue }
    if (c === '{') depth++
    else if (c === '}' && --depth === 0) return { body: src.slice(open + 1, i), end: i }
  }
  return null
}

// screens: { Home: 'home', Tabs: { screens: { Feed: 'feed' } }, Profile: { path: 'p/:id' } }
// → { Home: '/home', Feed: '/feed', Profile: '/p/:id' }, plus the parent chain
// so a nested screen's path inherits its navigator's prefix.
function parseScreens(body, prefix = '') {
  const out = {}
  const ENTRY = /([A-Za-z_$][\w$]*)\s*:\s*/g
  let m
  while ((m = ENTRY.exec(body))) {
    const name = m[1]
    const rest = body.slice(ENTRY.lastIndex)
    const strM = rest.match(/^["'`]([^"'`]*)["'`]/)
    if (strM) {
      out[name] = joinPath(prefix, strM[1])
      continue
    }
    if (rest.trimStart().startsWith('{')) {
      const blk = blockAfter(body, '', ENTRY.lastIndex - 1)
      if (!blk) continue
      const inner = blk.body
      const pathM = inner.match(/\bpath\s*:\s*["'`]([^"'`]*)["'`]/)
      const here = pathM ? joinPath(prefix, pathM[1]) : prefix
      if (pathM) out[name] = here
      const nested = blockAfter(inner, 'screens')
      if (nested) Object.assign(out, parseScreens(nested.body, here))
      ENTRY.lastIndex = blk.end + 1
    }
  }
  return out
}

function joinPath(prefix, seg) {
  const a = (prefix || '').replace(/\/$/, '')
  const b = (seg || '').replace(/^\//, '')
  const joined = b ? `${a}/${b}` : a
  return joined.startsWith('/') ? joined : '/' + joined
}

function findLinking(ctx, files) {
  for (const f of files) {
    const src = ctx.readFileOrNull(f)
    if (!src || !/\bscreens\s*:/.test(src)) continue
    // A linking config is a `config: { screens: … }` under a prefixes/linking
    // declaration — not just any object with a screens key.
    if (!/\b(linking|prefixes)\b/.test(src)) continue
    const cfg = blockAfter(src, 'screens')
    if (!cfg) continue
    return { file: ctx.rel(f), paths: parseScreens(cfg.body) }
  }
  return { file: null, paths: {} }
}

// ---------- navigators and screens ----------

// The function that renders a navigator, so a nested navigator can be named
// after the route that mounts it rather than after its variable.
function enclosingFunction(src, index) {
  const before = src.slice(0, index)
  const decls = [
    ...before.matchAll(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/g),
    ...before.matchAll(/\bconst\s+([A-Za-z_$][\w$]*)\s*(?::[^=]*)?=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/g),
  ].sort((a, b) => a.index - b.index)
  return decls.length ? decls[decls.length - 1][1] : null
}

function collectScreens(ctx, files, consts) {
  const navigators = []  // { key, type, file, rendererFn }
  const screens = []     // { name, componentIdent, presentation, navKey, file }

  for (const f of files) {
    const src = ctx.readFileOrNull(f)
    if (!src || !src.includes('.Screen')) continue
    const relFile = ctx.rel(f)

    // const Stack = createNativeStackNavigator<Params>()
    const navTypes = {}
    for (const m of src.matchAll(
      /\bconst\s+([A-Za-z_$][\w$]*)\s*=\s*(create[A-Za-z]*Navigator)\s*(?:<[^>]*>)?\s*\(/g
    )) {
      navTypes[m[1]] = NAVIGATOR_TYPES[m[2]] ?? 'Stack'
    }

    for (const m of src.matchAll(/<([A-Za-z_$][\w$]*)\.Navigator\b/g)) {
      const ident = m[1]
      const key = `${relFile}::${ident}`
      if (navigators.some((n) => n.key === key)) continue
      navigators.push({
        key, ident, file: relFile,
        type: navTypes[ident] ?? 'Stack',
        rendererFn: enclosingFunction(src, m.index),
      })
    }

    for (const m of src.matchAll(/<([A-Za-z_$][\w$]*)\.Screen\b/g)) {
      const tag = readTag(src, m.index)
      const nameRaw = tag.match(/\bname\s*=\s*(?:\{([^}]*)\}|("(?:[^"]*)"|'(?:[^']*)'))/)
      const raw = (nameRaw?.[1] ?? nameRaw?.[2] ?? '').trim()
      const name = resolveName(raw, consts)
      if (!name) continue
      const componentIdent =
        tag.match(/\bcomponent\s*=\s*\{\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1] ??
        tag.match(/\bgetComponent\s*=\s*\{\s*\(\)\s*=>\s*([A-Za-z_$][\w$]*)\s*\}/)?.[1] ??
        null
      screens.push({
        name,
        componentIdent,
        presentation: tag.match(/\bpresentation\s*:\s*["'`]([A-Za-z]+)["'`]/)?.[1] ?? null,
        navKey: `${relFile}::${m[1]}`,
        file: relFile,
        absFile: f,
      })
    }
  }
  return { navigators, screens }
}

// identifier → absolute file, for one module's imports
function importMap(ctx, src, fromFile) {
  const map = {}
  const RE = /import\s+(?:([A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{([^}]*)\})?\s*from\s*["']([^"']+)["']/g
  for (const m of src.matchAll(RE)) {
    const resolved = ctx.resolveImport(m[3], fromFile)
    if (!resolved) continue
    if (m[1]) map[m[1]] = resolved
    for (const part of (m[2] ?? '').split(',')) {
      const pm = part.trim().match(/^(?:type\s+)?([A-Za-z_$][\w$]*)(?:\s+as\s+([A-Za-z_$][\w$]*))?$/)
      if (pm) map[pm[2] ?? pm[1]] = resolved
    }
  }
  return map
}

// ---------- detection ----------

// expo-router layouts also write <Stack.Screen name="about" />, so the mere
// presence of a Screen tag proves nothing. What separates the two is the
// component binding: expo-router resolves screens from the filesystem and never
// names one, while react-navigation must say which component to render.
function bindsComponents(src) {
  for (const m of src.matchAll(/<([A-Za-z_$][\w$]*)\.Screen\b/g)) {
    const tag = readTag(src, m.index)
    if (/\b(?:component|getComponent)\s*=\s*\{/.test(tag)) return true
  }
  return false
}

export function detect(ctx) {
  const evidence = []
  let score = 0
  const deps = ctx.deps()

  const navDeps = Object.keys(deps).filter((d) => d.startsWith('@react-navigation/'))
  if (navDeps.length) {
    score += 0.4
    evidence.push(`${navDeps.length} @react-navigation/* dependencies`)
  }
  // expo-router owns its own app/ tree; if it is present this is its project.
  if (deps['expo-router']) {
    evidence.push('expo-router also present — deferring to it')
    return { score: Math.min(score, 0.3), evidence }
  }

  const files = sourceFiles(ctx).slice(0, 4000)
  const withScreens = files.filter((f) => {
    const src = ctx.readFileOrNull(f)
    return src && src.includes('.Screen') && bindsComponents(src)
  })
  if (withScreens.length) {
    score += 0.45
    evidence.push(`component-bound <X.Screen> in ${withScreens.length} file(s)`)
  }
  const linking = findLinking(ctx, files)
  if (linking.file) {
    score += 0.15
    evidence.push(`linking config in ${linking.file}`)
  }
  if (!withScreens.length) {
    // An expo-router tree drags in @react-navigation transitively; without a
    // single component-bound screen there is nothing here for this provider.
    return { score: 0, evidence: [...evidence, 'no component-bound screen registrations'] }
  }
  return { score: Math.min(score, 1), evidence }
}

// ---------- parse ----------

export function parse(ctx) {
  const files = sourceFiles(ctx)
  const consts = buildConstantMap(ctx, files)
  const { navigators, screens } = collectScreens(ctx, files, consts)
  const linking = findLinking(ctx, files)

  if (!screens.length) {
    throw new Error(
      'react-navigation: no <X.Screen name=… /> registrations found. ' +
      'If screens are registered dynamically, use a custom provider ' +
      '({"routes":{"provider":"custom","command":"…"}}).'
    )
  }

  const navByKey = Object.fromEntries(navigators.map((n) => [n.key, n]))

  // A navigator mounted by a Screen takes that route's name as its group, so a
  // tab navigator reads as "Tabs" rather than as the variable it was assigned
  // to. Everything else falls back to the navigator type.
  const mountName = {}
  const mountedNavKey = {} // container screen name → the navigator it mounts
  for (const s of screens) {
    if (!s.componentIdent) continue
    for (const n of navigators) {
      if (n.file === s.file && n.rendererFn && n.rendererFn === s.componentIdent) {
        mountName[n.key] = s.name
        mountedNavKey[s.name] = n.key
      }
    }
  }

  // A screen whose component *is* another navigator is a mount point, not a
  // screen: it has no content of its own, and deep-linking it lands on whatever
  // child is first. expo-router models the same thing as _layout, and layouts
  // are not routes — so these become layouts here too, and links aimed at them
  // resolve to the child that actually renders.
  const containers = new Set(Object.keys(mountedNavKey))
  const firstChildOf = {}
  for (const name of containers) {
    const child = screens.find((s) => s.navKey === mountedNavKey[name])
    if (child) firstChildOf[name] = child.name
  }

  // Screen names are unique per navigator, not globally; disambiguate the rare
  // collision by prefixing the group rather than dropping a route.
  const nameCount = new Map()
  for (const s of screens) nameCount.set(s.name, (nameCount.get(s.name) ?? 0) + 1)

  const seenIds = new Set()
  const routes = []
  for (const s of screens) {
    if (containers.has(s.name)) continue
    const nav = navByKey[s.navKey]
    const group = mountName[s.navKey] ?? nav?.type ?? ''
    let id = nameCount.get(s.name) > 1 && group ? `${group}/${s.name}` : s.name
    while (seenIds.has(id)) id = `${id}_`
    seenIds.add(id)

    const abs = s.componentIdent
      ? importMap(ctx, ctx.readFileOrNull(s.absFile) ?? '', s.absFile)[s.componentIdent] ?? null
      : null
    const componentSrc = abs ? ctx.readFileOrNull(abs) : null

    const urlPath = linking.paths[s.name] ?? null
    const stateHints = componentSrc ? extractHints(componentSrc) : []
    if (s.presentation && /modal/i.test(s.presentation))
      stateHints.push({ type: 'router-modal', presentation: s.presentation })

    routes.push({
      id,
      file: abs ? ctx.rel(abs) : s.file,
      urlPath,
      // The registered screen name is what the app's own code calls this
      // screen, so it beats a URL that may not exist.
      title: s.name,
      slug: id.replace(/[^A-Za-z0-9_.-]+/g, '_'),
      params: urlPath ? urlPath.split('/').filter((x) => x.startsWith(':')).map((x) => x.slice(1)) : [],
      navigator: nav?.type ?? 'react-navigation',
      layoutDir: group,
      presentation: s.presentation,
      stateHints,
      _abs: abs,
      _screenName: s.name,
    })
  }

  // ---------- edges ----------

  const byScreenName = new Map()
  for (const r of routes) if (!byScreenName.has(r._screenName)) byScreenName.set(r._screenName, r)
  // navigate('Tabs') with no nested screen lands on the container's first child
  for (const [container, child] of Object.entries(firstChildOf)) {
    const target = byScreenName.get(child)
    if (target && !byScreenName.has(container)) byScreenName.set(container, target)
  }
  const withUrl = routes.filter((r) => r.urlPath)
  const matchers = withUrl.map((r) => ({ route: r, re: ctx.routeMatcher(r.urlPath) }))

  // navigate('Profile') · navigate(SCREENS.PROFILE) · navigate('Tabs', { screen: 'Feed' })
  const NAV_RE = /\b(?:navigate|push|replace|jumpTo)\(\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$.]*))\s*(?:,\s*\{\s*screen\s*:\s*(?:["'`]([^"'`]+)["'`]|([A-Za-z_$][\w$.]*)))?/g
  const LINK_RE = /(?:href|to)=\{?\s*["'`](\/[^"'`\s]*)["'`]/g

  // Same one-hop-with-fanout-cap rule as expo-router: links live in list items
  // and cards, not in the screen module itself.
  const IMPORT_FANOUT_CAP = 8
  const importsOf = new Map()
  const fanout = new Map()
  for (const r of routes) {
    if (!r._abs) continue
    const src = ctx.readFileOrNull(r._abs)
    if (!src) continue
    const own = ctx.firstPartyImports(src, r.file)
    importsOf.set(r.id, own)
    for (const f of new Set(own)) fanout.set(f, (fanout.get(f) ?? 0) + 1)
  }

  const edges = []
  for (const r of routes) {
    if (!r._abs) continue
    const own = ctx.readFileOrNull(r._abs)
    if (!own) continue
    const sources = [own]
    for (const f of importsOf.get(r.id) ?? []) {
      if ((fanout.get(f) ?? 0) > IMPORT_FANOUT_CAP) continue
      const s = ctx.readFileOrNull(path.join(ctx.projectRoot, f))
      if (s) sources.push(s)
    }
    const seen = new Set()
    for (const src of sources) {
      for (const m of src.matchAll(NAV_RE)) {
        // A nested target names the child screen; that is the screen that ends
        // up on top, so it is the edge worth drawing.
        const outer = m[1] ?? resolveName(m[2] ?? '', consts)
        const inner = m[3] ?? (m[4] ? resolveName(m[4], consts) : null)
        const targetName = inner ?? outer
        if (!targetName) continue
        const target = byScreenName.get(targetName)
        if (!target || seen.has(target.id)) continue
        seen.add(target.id)
        edges.push({
          from: r.id, to: target.id,
          raw: `navigate('${targetName}')`,
          target: target.urlPath ?? target.id,
        })
      }
      for (const m of src.matchAll(LINK_RE)) {
        const t = m[1].split(/[?#]/)[0].replace(/\$\{[^}]*\}/g, 'X') || '/'
        const hit = matchers.find((x) => x.re.test(t))
        if (!hit || seen.has(hit.route.id)) continue
        seen.add(hit.route.id)
        edges.push({ from: r.id, to: hit.route.id, raw: m[1], target: t })
      }
    }
  }

  for (const r of routes) { delete r._abs; delete r._screenName }

  const layouts = navigators.map((n) => ({
    file: n.file,
    dir: mountName[n.key] ?? n.type,
    navigator: n.type,
  }))

  return {
    linkingFile: linking.file,
    screensResolved: routes.filter((r) => r.file).length,
    layouts, routes, edges,
  }
}
