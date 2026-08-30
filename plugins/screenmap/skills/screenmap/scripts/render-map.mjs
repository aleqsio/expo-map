#!/usr/bin/env node
// Renders graph.json + captured screenshots into a self-contained HTML map.
//
// Usage: node render-map.mjs [graphPath] [--shots <dir>] [--out <path>] [--no-embed]
//   graphPath  default: ./.screenmap/out/graph.json
//   --shots    default: <graph dir>/screens
//   --out      default: <graph dir>/map.html
//
// Screenshot naming contract:
//   <slug>.png            base screenshot of the route
//   <slug>--<state>.png   runtime state variant (e.g. details_id--sheet-50.png)

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let graphPath = null
let shotsDir = null
let outPath = null
let embed = true
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--shots') shotsDir = args[++i]
  else if (args[i] === '--out') outPath = args[++i]
  else if (args[i] === '--no-embed') embed = false
  else graphPath = args[i]
}
graphPath = path.resolve(graphPath ?? path.join('.screenmap', 'out', 'graph.json'))
const baseDir = path.dirname(graphPath)
shotsDir = path.resolve(shotsDir ?? path.join(baseDir, 'screens'))
outPath = path.resolve(outPath ?? path.join(baseDir, 'map.html'))

const graph = JSON.parse(fs.readFileSync(graphPath, 'utf8'))
const appName = graph.appName ?? path.basename(graph.projectRoot)

// Every node needs a label, and not every framework gives every screen a URL:
// react-navigation screens missing from the linking config have none at all.
const label = (r) => r?.title ?? r?.urlPath ?? r?.id ?? '?'

const shotFiles = fs.existsSync(shotsDir)
  ? fs.readdirSync(shotsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  : []

// agent-written classification of what each capture actually shows
// { "<routeId>": { "status": "ok|empty-state|not-found|error-boundary|loading|auth-wall",
//                  "note": "...", "needsNavigation": true } }
let captureStatus = {}
try {
  captureStatus = JSON.parse(fs.readFileSync(path.join(baseDir, 'capture-status.json'), 'utf8'))
} catch {}

// v2 sidecars (.meta.json) or legacy v1 flow JSON — the fallback renderer only
// needs names/titles/results, which both carry
const flowsDir = path.join(baseDir, 'flows')
const flows = fs.existsSync(flowsDir)
  ? fs
      .readdirSync(flowsDir)
      .filter((f) => f.endsWith('.json'))
      .filter((f, _, all) => f.endsWith('.meta.json') || !all.some((x) => x.endsWith('.meta.json')))
      .map((f) => {
        try {
          return { ...JSON.parse(fs.readFileSync(path.join(flowsDir, f), 'utf8')), _file: f }
        } catch {
          return null
        }
      })
      .filter(Boolean)
  : []

function imgSrc(file) {
  const abs = path.join(shotsDir, file)
  if (!embed) {
    return path.relative(path.dirname(outPath), abs).split(path.sep).join('/')
  }
  const ext = path.extname(file).slice(1).toLowerCase().replace('jpg', 'jpeg')
  return `data:image/${ext};base64,${fs.readFileSync(abs).toString('base64')}`
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function shotsFor(slug) {
  const base = shotFiles.find((f) => f.replace(/\.\w+$/, '') === slug)
  const states = shotFiles
    .filter((f) => f.startsWith(slug + '--'))
    .map((f) => ({ file: f, label: f.replace(/\.\w+$/, '').slice(slug.length + 2) }))
    .sort((a, b) => a.label.localeCompare(b.label))
  return { base, states }
}

// ---- group routes by their nearest layout ----
const groups = new Map()
for (const r of graph.routes) {
  const key = r.layoutDir ?? ''
  if (!groups.has(key)) groups.set(key, [])
  groups.get(key).push(r)
}
const layoutByDir = Object.fromEntries((graph.layouts ?? []).map((l) => [l.dir, l]))

const edgesFrom = new Map()
for (const e of graph.edges) {
  if (!edgesFrom.has(e.from)) edgesFrom.set(e.from, [])
  edgesFrom.get(e.from).push(e)
}
const routeById = Object.fromEntries(graph.routes.map((r) => [r.id, r]))

// ---- mermaid overview ----
const mmNodes = graph.routes
  .map((r) => `  ${JSON.stringify(r.slug).replace(/"/g, '')}["${label(r)}"]`)
  .join('\n')
const mmEdges = graph.edges
  .filter((e) => e.to && e.from !== e.to)
  .map((e) => `  ${routeById[e.from].slug} --> ${routeById[e.to].slug}`)
  .filter((v, i, a) => a.indexOf(v) === i)
  .join('\n')

function stateHintBadges(r) {
  return (r.stateHints ?? [])
    .map((h) => {
      const label =
        h.type === 'bottom-sheet'
          ? `bottom sheet${h.snapPoints ? ` (${h.snapPoints.join(', ')})` : ''}`
          : h.type === 'rn-modal'
            ? 'RN modal'
            : `router ${h.presentation ?? 'modal'}`
      return `<span class="badge hint">${esc(label)}</span>`
    })
    .join('')
}

function routeCard(r) {
  const { base, states } = shotsFor(r.slug)
  const edges = edgesFrom.get(r.id) ?? []
  const shot = base
    ? `<img class="shot" src="${imgSrc(base)}" alt="${esc(label(r))}" loading="lazy">`
    : `<div class="shot placeholder">no screenshot</div>`
  const stateRow = states.length
    ? `<div class="states">${states
        .map(
          (s) =>
            `<figure><img src="${imgSrc(s.file)}" alt="${esc(s.label)}" loading="lazy"><figcaption>${esc(s.label)}</figcaption></figure>`
        )
        .join('')}</div>`
    : ''
  const edgeChips = edges.length
    ? `<div class="edges">${edges
        .map((e) =>
          e.to
            ? `<a class="chip" href="#route-${esc(routeById[e.to].slug)}" title="${esc(e.raw)}">→ ${esc(label(routeById[e.to]))}</a>`
            : `<span class="chip unresolved" title="${esc(e.raw)}">→ ? ${esc(e.target)}</span>`
        )
        .join('')}</div>`
    : ''
  const st = captureStatus[r.id]
  const badges = [
    r.presentation ? `<span class="badge presentation">${esc(r.presentation)}</span>` : '',
    r.params.length ? `<span class="badge param">[${r.params.map(esc).join(', ')}]</span>` : '',
    stateHintBadges(r),
    st && st.status !== 'ok'
      ? `<span class="badge capture-issue" title="${esc(st.note ?? '')}">${esc(st.status)}${st.needsNavigation ? ' · needs navigation' : ''}</span>`
      : '',
  ].join('')
  const statusNote = st && st.status !== 'ok' && st.note
    ? `<div class="file capture-note">⚠ ${esc(st.note)}</div>`
    : ''
  return `
  <div class="card" id="route-${esc(r.slug)}">
    <div class="card-head">
      <span class="url">${esc(label(r))}</span>${badges}
    </div>
    <div class="file">${esc(r.file)}</div>
    ${statusNote}
    ${shot}
    ${stateRow}
    ${edgeChips}
  </div>`
}

const groupSections = [...groups.entries()]
  .sort(([a], [b]) => a.localeCompare(b))
  .map(([dir, routes]) => {
    const layout = layoutByDir[dir]
    const label = `${dir === '' ? '(root)' : dir} — ${layout?.navigator ?? 'unknown navigator'}`
    return `
  <section class="group">
    <h2>${esc(label)} <span class="muted">${esc(layout?.file ?? '')}</span></h2>
    <div class="grid">
      ${routes.map(routeCard).join('\n')}
    </div>
  </section>`
  })
  .join('\n')

function flowStep(st, i) {
  const desc =
    st.action === 'open_url' ? `deep link <code>${esc(st.url ?? '')}</code>`
    : st.action === 'tap' ? `tap ${esc(st.target ?? st.coordinate?.join(',') ?? '')}`
    : st.action === 'swipe' ? `swipe ${esc((st.from ?? []).join(','))} → ${esc((st.to ?? []).join(','))}`
    : st.action === 'type' ? `type ${esc(st.text ?? '')}`
    : st.action === 'wait' ? `wait ${esc(st.seconds ?? '')}s`
    : st.action === 'screenshot' ? `capture <code>${esc(st.file ?? '')}</code>`
    : esc(st.action)
  const thumb =
    st.action === 'screenshot' && st.file && shotFiles.includes(st.file)
      ? `<img class="flow-thumb" src="${imgSrc(st.file)}" alt="${esc(st.file)}" loading="lazy">`
      : ''
  const note = st.note ? ` <span class="muted">— ${esc(st.note)}</span>` : ''
  return `<li>${desc}${note}${thumb}</li>`
}

function flowsSection() {
  if (!flows.length) return ''
  const cards = flows
    .map((f) => {
      const routeRef = f.route && routeById[f.route]
        ? `<a class="chip" href="#route-${esc(routeById[f.route].slug)}">${esc(label(routeById[f.route]))}</a>`
        : ''
      return `
  <div class="card flow" id="flow-${esc(f.name ?? f._file)}">
    <div class="card-head"><span class="url">${esc(f.title ?? f.name ?? f._file)}</span>${routeRef}</div>
    ${f.device ? `<div class="file">recorded on ${esc(f.device)}</div>` : ''}
    <ol class="flow-steps">${(f.steps ?? []).map(flowStep).join('')}</ol>
    ${f.result ? `<div class="muted">⇒ ${esc(f.result)}</div>` : ''}
  </div>`
    })
    .join('\n')
  return `
  <section class="group">
    <h2>Agent flows <span class="muted">${flows.length} recorded — replayable step sequences</span></h2>
    <div class="grid">${cards}</div>
  </section>`
}

const s = graph.summary ?? {}
const missing = graph.routes.filter((r) => !shotsFor(r.slug).base)

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(appName)} — navigation map</title>
<style>
  :root {
    --bg: #fafafa; --fg: #1a1a1a; --card: #fff; --border: #e2e2e2;
    --muted: #737373; --accent: #4630eb; --warn: #b45309;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #111; --fg: #eee; --card: #1c1c1e; --border: #333; --muted: #999; --accent: #8b7dff; --warn: #f59e0b; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px; background: var(--bg); color: var(--fg);
         font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  h2 { font-size: 15px; margin: 28px 0 12px; border-bottom: 1px solid var(--border); padding-bottom: 6px; }
  .muted { color: var(--muted); font-weight: normal; font-size: 12px; }
  .summary { color: var(--muted); margin-bottom: 8px; }
  .warnbox { color: var(--warn); font-size: 13px; margin: 8px 0; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 12px;
          display: flex; flex-direction: column; gap: 8px; scroll-margin-top: 16px; }
  .card:target { outline: 2px solid var(--accent); }
  .card-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
  .url { font-weight: 600; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
  .file { color: var(--muted); font-size: 11px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .badge { font-size: 10px; padding: 1px 7px; border-radius: 99px; border: 1px solid var(--border); color: var(--muted); }
  .badge.presentation { color: var(--accent); border-color: var(--accent); }
  .badge.hint { color: var(--warn); border-color: var(--warn); }
  .badge.capture-issue { color: #fff; background: var(--warn); border-color: var(--warn); }
  .capture-note { color: var(--warn); }
  .shot { width: 100%; border-radius: 8px; border: 1px solid var(--border); }
  .shot.placeholder { aspect-ratio: 9/16; display: flex; align-items: center; justify-content: center;
                      color: var(--muted); font-size: 12px; background: repeating-linear-gradient(45deg,
                      transparent, transparent 8px, var(--border) 8px, var(--border) 9px); }
  .states { display: flex; gap: 8px; overflow-x: auto; }
  .states figure { margin: 0; flex: 0 0 90px; }
  .states img { width: 90px; border-radius: 6px; border: 1px solid var(--border); }
  .states figcaption { font-size: 10px; color: var(--muted); text-align: center; }
  .edges { display: flex; flex-wrap: wrap; gap: 6px; margin-top: auto; }
  .chip { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: transparent;
          border: 1px solid var(--accent); color: var(--accent); text-decoration: none;
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .chip.unresolved { border-color: var(--warn); color: var(--warn); }
  details { margin: 16px 0; }
  details pre { overflow-x: auto; background: var(--card); border: 1px solid var(--border);
                border-radius: 8px; padding: 12px; font-size: 12px; }
  .flow-steps { margin: 0; padding-left: 18px; font-size: 12px; }
  .flow-steps li { margin-bottom: 4px; }
  .flow-steps code { font-size: 11px; background: var(--bg); padding: 1px 4px; border-radius: 4px; }
  .flow-thumb { display: block; width: 90px; margin-top: 4px; border-radius: 6px; border: 1px solid var(--border); }
</style>
</head>
<body>
  <h1>${esc(appName)} — navigation map</h1>
  <div class="summary">${s.routes ?? graph.routes.length} routes · ${s.layouts ?? '?'} layouts · ${s.edges ?? graph.edges.length} links${
    s.unresolvedEdges ? ` (${s.unresolvedEdges} unresolved)` : ''
  } · generated ${esc(graph.generatedAt ?? '')}</div>
  ${missing.length ? `<div class="warnbox">⚠ ${missing.length} route(s) without a screenshot: ${missing.map((r) => esc(label(r))).join(', ')}</div>` : ''}
  ${(() => {
    const nn = graph.routes.filter((r) => captureStatus[r.id]?.needsNavigation || r.reach === 'navigation-only')
    return nn.length
      ? `<div class="warnbox">⚠ ${nn.length} route(s) not reachable by bare deep link (need in-app navigation or real data): ${nn.map((r) => `<a href="#route-${esc(r.slug)}">${esc(label(r))}</a>`).join(', ')}</div>`
      : ''
  })()}
  <details>
    <summary>Route graph (mermaid)</summary>
    <pre class="mermaid">flowchart LR
${mmNodes}
${mmEdges}</pre>
  </details>
  ${groupSections}
  ${flowsSection()}
</body>
</html>
`

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, html)
const kb = Math.round(fs.statSync(outPath).size / 1024)
console.log(`wrote ${outPath} (${kb} KB, ${shotFiles.length} screenshots, embed=${embed})`)
