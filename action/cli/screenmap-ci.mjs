#!/usr/bin/env node
// screenmap-ci — the deterministic core of the screenmap GitHub Action.
//
//   screenmap-ci baseline --project <dir> [--previous <file.scrmap>] [--full] [--out <file>]
//                      [--only id,id] [--limit N] [--no-agent] [--no-sim]
//   screenmap-ci pr       --project <dir> --baseline <file.scrmap> [--base <sha>] [--head <sha>]
//                      [--pr <n> --title <t> --url <u>] [--out <file>] [--no-agent]
//   screenmap-ci comment  --summary <pr-summary.json> [--map-url U] [--changes-url U] [--artifact-url U] [--shots-base U]
//                      [--post --repo owner/name --pr <n>]
//   screenmap-ci publish  --repo owner/name [--branch screenmaps] --files src=dest[,src=dest…] --message "…"
//   screenmap-ci flows-pr --repo owner/name --flows <dir> [--base main] --title "…" [--body "…"]
//   screenmap-ci resolve-app --project <dir> [--profile development-simulator]   (EAS: reuse-by-fingerprint or build)
//
// Runs locally too: the same commands the Action runs, against your own
// simulator. See docs/ci.md.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs, loadConfig, readJson, writeJson, ensureDir, exists, log, sh, deepLinkFor } from './lib/util.mjs'
import { openSession } from './lib/sim.mjs'
import { readBaseline, parseRoutes, computeSuspects, packBaseline, packDiff, downscaleAll } from './lib/bundle.mjs'
import { loadFlows, replayFlow, verifyLanding } from './lib/replay.mjs'
import { argentAvailable, argentVersion } from './lib/argent.mjs'
import { runAgent, agentInfo } from './lib/agent.mjs'
import { upsertStickyComment, publishToBranch, openFlowsPR, repoSlug } from './lib/github.mjs'

const { opts, positional } = parseArgs(process.argv.slice(2))
const cmd = positional[0]

const git = (args, cwd) => { try { return sh('git', args, { cwd }) } catch { return null } }
const copyShots = (fromDir, toDir, slug) => {
  if (!exists(fromDir)) return 0
  ensureDir(toDir)
  let n = 0
  for (const f of fs.readdirSync(fromDir)) {
    const base = f.replace(/\.\w+$/, '')
    if (base === slug || base.startsWith(slug + '--')) { fs.copyFileSync(path.join(fromDir, f), path.join(toDir, f)); n++ }
  }
  return n
}

// Capture a list of routes on the live session: committed flow replay first,
// deep link otherwise, agent for what's left (budgeted). Shared by both jobs.
async function captureRoutes({ project, config, scheme, session, routes, flows, outDir, work, agentMode, prContext, agentEnabled }) {
  const result = { replay: [], deeplink: [], agent: [], failed: [], unflowed: [], drifted: [] }
  const canReplay = flows.size > 0 && argentAvailable()
  if (flows.size > 0 && !canReplay) log('argent not available — committed flows will not be replayed this run')
  for (const r of routes) {
    const f = flows.get(r.id)
    let done = false
    if (canReplay && f) {
      const recs = [f.nav ?? f.visit, ...f.others].filter(Boolean)
      await session.relaunch() // every replay starts from a clean app
      let wrote = 0, broke = null
      for (const rec of recs) {
        const { ok, written } = await replayFlow(rec, { udid: session.udid, outDir, tmpDir: path.join(work, 'tmp') })
        wrote += written.length
        if (!ok) { broke = rec.name; log(`replay ${rec.name} failed — falling back`); break }
      }
      const shot = path.join(outDir, `${r.slug}.png`)
      if (!broke && wrote > 0 && exists(shot)) {
        const primary = f.nav ?? f.visit ?? recs[0]
        const v = await verifyLanding({
          shot, rec: primary, udid: session.udid,
          probe: async () => { try { await session.relaunch(); const p = path.join(work, 'tmp', `${r.slug}.deeplink.png`); await session.visit(deepLinkFor(scheme, r, config.params), p, r.params?.length ? config.waits.network : config.waits.transition); return p } catch { return null } },
        })
        if (v.ok) { result.replay.push(r.id); done = true; log(`replay ${primary.name} ✓ (${v.method}${v.score != null ? ` ${v.score}` : ''})`) }
        else {
          log(`replay ${primary.name} drifted (${v.method} ${v.score}) — deep-link capture instead; flow queued for re-recording`)
          result.drifted.push({ route: r.id, flows: recs.map((x) => x.name), method: v.method, score: v.score })
          for (const fn of fs.readdirSync(outDir)) if (fn === `${r.slug}.png` || fn.startsWith(r.slug + '--')) fs.rmSync(path.join(outDir, fn), { force: true })
          result.unflowed.push({ ...r, reason: (r.reason ? r.reason + '; ' : '') + 'flow drifted' })
          await session.relaunch()
        }
      } else if (broke) {
        result.drifted.push({ route: r.id, flows: [broke], method: 'replay-error', score: null })
        result.unflowed.push({ ...r, reason: (r.reason ? r.reason + '; ' : '') + 'flow replay failed' })
        await session.relaunch()
      }
    }
    if (!done) {
      try {
        const wait = (r.params?.length ? config.waits.network : config.waits.transition)
        await session.visit(deepLinkFor(scheme, r, config.params), path.join(outDir, `${r.slug}.png`), wait)
        result.deeplink.push(r.id)
        if (!f) result.unflowed.push(r)
      } catch (e) {
        log(`deep link failed for ${r.id}: ${e.message}`)
        result.failed.push(r.id)
        if (!f) result.unflowed.push(r)
      }
    }
  }
  // agent lane: screens without any committed flow, within budget
  if (agentEnabled && result.unflowed.length) {
    const agentDir = ensureDir(path.join(work, 'agent'))
    const screens = result.unflowed.map((r) => ({ id: r.id, urlPath: r.urlPath, slug: r.slug, file: r.file, deepLink: deepLinkFor(scheme, r, config.params), reason: r.reason }))
    const a = runAgent({
      projectDir: project, config, screens, scheme, udid: session.udid, bundleId: session.bundleId,
      outScreensDir: path.join(agentDir, 'screens'), outFlowsDir: path.join(agentDir, 'flows'),
      notesPath: path.join(agentDir, 'notes.json'), summaryPath: path.join(agentDir, 'summary.json'),
      mode: agentMode, prContext,
    })
    result.agentRun = a
    if (a.ran) {
      // agent captures supersede deep-link ones for the screens it handled
      for (const id of a.summary.captured ?? []) {
        const r = routes.find((x) => x.id === id)
        if (r && copyShots(path.join(agentDir, 'screens'), outDir, r.slug) > 0) result.agent.push(id)
      }
      result.recordedFlowsDir = exists(path.join(agentDir, 'flows')) && fs.readdirSync(path.join(agentDir, 'flows')).length ? path.join(agentDir, 'flows') : null
      result.notes = readJson(path.join(agentDir, 'notes.json'), null)
    }
  } else {
    result.agentRun = { ran: false, reason: agentEnabled ? 'no screens without a flow' : 'disabled (--no-agent)', ...agentInfo(config) }
  }
  return result
}

async function baseline() {
  const project = path.resolve(opts.project ?? '.')
  const config = loadConfig(project)
  const work = path.join(project, '.screenmap', 'out', 'ci', 'baseline')
  fs.rmSync(work, { recursive: true, force: true }); ensureDir(work)
  const graph = parseRoutes(project, path.join(work, 'graph.json'))
  const scheme = config.scheme ?? graph.scheme
  if (!scheme) throw new Error('no deep-link scheme: set scheme in .screenmap/config.json')
  const commit = opts.commit ?? git(['rev-parse', 'HEAD'], project)
  const ref = opts.ref ?? git(['rev-parse', '--abbrev-ref', 'HEAD'], project)
  const appName = config.appName ?? path.basename(project)
  const screensDir = ensureDir(path.join(work, 'screens'))
  let captureStatus = {}

  // previous baseline → reuse what didn't change
  let routes = graph.routes
  let reused = 0
  let prev = null
  if (opts.previous && exists(opts.previous) && !opts.full) {
    prev = readBaseline(opts.previous, path.join(work, 'prev'))
    const prevCommit = prev.manifest.source?.commit
    const changed = prevCommit ? git(['diff', '--name-only', prevCommit, 'HEAD'], project) : null
    if (changed === null) {
      log('previous baseline commit not in history — doing a full capture')
    } else {
      const suspects = computeSuspects({ diffDir: path.join(work, 'diff'), baseGraph: prev.graph, headGraph: graph, changedFiles: changed.split('\n').filter(Boolean), projectDir: project, depth: config.suspects.depth, broadCap: config.suspects.broadCap })
      const suspect = new Set(suspects.capture.filter((c) => c.status !== 'D').map((c) => c.id))
      const prevById = new Map(prev.map.nodes.map((n) => [n.id, n]))
      const prevStatus = readJson(path.join(prev.dir, 'capture-status.json'), {})
      routes = []
      for (const r of graph.routes) {
        const p = prevById.get(r.id)
        const stale = suspect.has(r.id) || !p?.capture?.screenshot || ['error-boundary', 'loading', 'missing'].includes(p?.capture?.status)
        if (stale) routes.push({ ...r, reason: suspect.has(r.id) ? 'changed since baseline' : 'no usable previous capture' })
        else { copyShots(prev.screensDir, screensDir, r.slug); reused++; if (prevStatus[r.id]) captureStatus[r.id] = prevStatus[r.id] }
      }
      log(`incremental baseline: ${routes.length} to capture, ${reused} reused from ${prevCommit.slice(0, 7)}`)
    }
  }
  if (opts.only) { const only = new Set(String(opts.only).split(',')); routes = routes.filter((r) => only.has(r.id)) }
  if (opts.limit) routes = routes.slice(0, Number(opts.limit))

  const flowDirs = [config.flowsDir, '.screenmap/out/flows']
  const flows = loadFlows(project, flowDirs)
  const flowsDirForPack = flowDirs.map((d) => path.resolve(project, d)).find((d) => exists(d)) ?? path.resolve(project, config.flowsDir)
  let cap = { replay: [], deeplink: [], agent: [], failed: [], unflowed: [] }
  let deviceName = config.device
  if (routes.length && !opts['no-sim']) {
    const session = await openSession({ projectDir: project, config, scheme })
    deviceName = session.deviceName
    try {
      cap = await captureRoutes({ project, config, scheme, session, routes, flows, outDir: screensDir, work, agentMode: 'baseline', agentEnabled: !opts['no-agent'] })
    } finally { session.close() }
  }
  for (const id of cap.failed) captureStatus[id] = { status: 'missing', note: 'deep link failed in CI' }
  downscaleAll(screensDir)
  const out = path.resolve(opts.out ?? path.join(work, `${appName}-${(commit ?? 'local').slice(0, 7)}.scrmap`))
  packBaseline({ graph, screensDir, flowsDir: flowsDirForPack, captureStatus, appName, device: deviceName, commit, ref, out })
  const summary = {
    kind: 'baseline', app: appName, commit, ref, bundle: out, total: graph.routes.length, reused,
    device: deviceName, argent: argentVersion(),
    captured: { replay: cap.replay.length, deeplink: cap.deeplink.length, agent: cap.agent.length, failed: cap.failed },
    unflowed: cap.unflowed.map((r) => r.id), drifted: cap.drifted ?? [], agent: cap.agentRun ?? { ran: false }, recordedFlowsDir: cap.recordedFlowsDir ?? null,
  }
  writeJson(path.join(work, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

async function pr() {
  const project = path.resolve(opts.project ?? '.')
  const config = loadConfig(project)
  if (!opts.baseline || !exists(opts.baseline)) throw new Error('--baseline <file.scrmap> is required (the base-side map)')
  const work = path.join(project, '.screenmap', 'out', 'ci', 'pr')
  fs.rmSync(work, { recursive: true, force: true }); ensureDir(work)
  const base = readBaseline(opts.baseline, path.join(work, 'base-bundle'))
  const headGraph = parseRoutes(project, path.join(work, 'head-graph.json'))
  const scheme = config.scheme ?? headGraph.scheme ?? base.graph.scheme
  const baseSha = opts.base ?? base.manifest.source?.commit ?? null
  const headSha = opts.head ?? git(['rev-parse', 'HEAD'], project)
  const appName = config.appName ?? base.manifest.app?.name ?? path.basename(project)
  let changed = opts['changed-files'] ? fs.readFileSync(opts['changed-files'], 'utf8').split('\n').filter(Boolean) : null
  if (!changed && baseSha) changed = (git(['diff', '--name-only', `${baseSha}...${headSha}`], project) ?? git(['diff', '--name-only', baseSha, headSha], project) ?? '').split('\n').filter(Boolean)
  if (!changed) throw new Error('cannot determine changed files: pass --changed-files <list> or make sure the base commit is fetched')

  const diffDir = path.join(work, 'diff')
  const suspects = computeSuspects({ diffDir, baseGraph: base.graph, headGraph, changedFiles: changed, projectDir: project, depth: config.suspects.depth, broadCap: config.suspects.broadCap })
  writeJson(path.join(diffDir, 'pr.json'), { number: opts.pr ? Number(opts.pr) : undefined, title: opts.title, url: opts.url, baseSha, headSha, baseRef: opts['base-ref'] ?? base.manifest.source?.ref ?? null, headRef: opts['head-ref'] ?? null })

  // base side comes from the baseline — nothing is captured twice
  const baseStatus = readJson(path.join(base.dir, 'capture-status.json'), {})
  const baseSubset = {}
  for (const c of suspects.capture.filter((c) => c.side !== 'head')) {
    copyShots(base.screensDir, path.join(diffDir, 'base', 'screens'), c.slug)
    if (baseStatus[c.id]) baseSubset[c.id] = baseStatus[c.id]
  }
  writeJson(path.join(diffDir, 'base', 'capture-status.json'), baseSubset)

  // head side: capture suspects on the PR head
  const headRoutes = suspects.capture.filter((c) => c.side !== 'base').map((c) => ({ ...headGraph.routes.find((r) => r.id === c.id), reason: `${c.status}: ${c.reason}${c.via?.length ? ' via ' + c.via.join(', ') : ''}` })).filter((r) => r.id)
  const flows = loadFlows(project, [config.flowsDir, '.screenmap/out/flows'])
  let cap = { replay: [], deeplink: [], agent: [], failed: [], unflowed: [] }
  let deviceName = config.device
  if (headRoutes.length && !opts['no-sim']) {
    const session = await openSession({ projectDir: project, config, scheme })
    deviceName = session.deviceName
    try {
      cap = await captureRoutes({
        project, config, scheme, session, routes: headRoutes, flows, outDir: path.join(diffDir, 'head', 'screens'), work,
        agentMode: 'pr', agentEnabled: !opts['no-agent'],
        prContext: `${opts.title ?? ''} — changed files: ${changed.slice(0, 40).join(', ')}${changed.length > 40 ? ` (+${changed.length - 40})` : ''}`,
      })
    } finally { session.close() }
  }
  if (cap.notes) writeJson(path.join(diffDir, 'notes.json'), cap.notes)
  const headStatus = {}
  for (const id of cap.failed) headStatus[id] = { status: 'missing', note: 'deep link failed in CI' }
  writeJson(path.join(diffDir, 'head', 'capture-status.json'), headStatus)
  downscaleAll(path.join(diffDir, 'head', 'screens'))
  const out = path.resolve(opts.out ?? path.join(work, `${appName}-${opts.pr ? `pr${opts.pr}` : (headSha ?? 'head').slice(0, 7)}.diff.scrmap`))
  packDiff({ diffDir, device: deviceName, out })
  const diff = readJson(path.join(diffDir, 'diff.json'))
  const summary = {
    kind: 'pr', app: appName, pr: opts.pr ? Number(opts.pr) : null, title: opts.title ?? null, baseSha, headSha, bundle: out,
    baselineGeneratedAt: base.manifest.generatedAt, device: deviceName, argent: argentVersion(),
    suspects: { added: suspects.capture.filter((c) => c.status === 'A').length, modified: suspects.capture.filter((c) => c.status === 'M').length, removed: suspects.capture.filter((c) => c.status === 'D').length, broadFiles: suspects.broadFiles },
    captured: { replay: cap.replay.length, deeplink: cap.deeplink.length, agent: cap.agent.length, failed: cap.failed },
    agent: cap.agentRun ?? { ran: false }, recordedFlowsDir: cap.recordedFlowsDir ?? null, drifted: cap.drifted ?? [],
    diff: { nodes: diff.nodes, dismissed: diff.dismissed ?? [], edges: diff.edges, states: (diff.states ?? []).filter((s) => s.reason !== 'hint') },
    routes: Object.fromEntries(headGraph.routes.map((r) => [r.id, r.urlPath])),
    shots: collectShots(diffDir, [...headGraph.routes, ...base.graph.routes], [...diff.nodes.map((d) => d.id), ...(diff.dismissed ?? []).map((d) => d.id)]),
  }
  writeJson(path.join(work, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

// Bundle-relative paths of every capture the comment might want to show:
// per node, the bare screen on each side plus one entry per named state. Only
// files that actually exist are listed, so the renderer can just check.
function collectShots(diffDir, routes, ids) {
  const slugOf = new Map(routes.map((r) => [r.id, r.slug]))
  const out = {}
  for (const id of new Set(ids)) {
    const slug = slugOf.get(id)
    if (!slug) continue
    const entry = { states: {} }
    for (const side of ['head', 'base']) {
      const dir = path.join(diffDir, side, 'screens')
      if (!exists(dir)) continue
      for (const f of fs.readdirSync(dir)) {
        const stem = f.replace(/\.\w+$/, '')
        if (stem === slug) entry[side] = `${side}/screens/${f}`
        else if (stem.startsWith(slug + '--')) {
          const name = stem.slice(slug.length + 2)
          ;(entry.states[name] ??= {})[side] = `${side}/screens/${f}`
        }
      }
    }
    if (entry.head || entry.base || Object.keys(entry.states).length) out[id] = entry
  }
  return out
}

// The PR comment. GitHub gives us tables, <img>, <details> and task lists —
// and strips every style attribute — so the layout is a table and anything that
// wants to look like screenmap has to arrive as a picture.
const MARK = { A: '🟩', M: '🟨', D: '🟥', U: '⬜' }
const TAG = { A: 'new', M: 'changed', D: 'removed' }
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
const STRIP_MAX = 6
const CONTEXT_MAX = 2 // cleared suspects that ride along in the strip for context
const SHOT_W = 190 // px; the strip is the headline, so the screens carry it
// Without an agent in the loop there is no written note, so the raw reason has
// to carry the row. Say it the way a reviewer would.
const REASON = {
  'route-added': 'new route on this branch',
  'route-removed': 'route gone from this branch',
  'file-touched': 'its own source changed',
  'import-touched': 'something it imports changed',
}
const why = (d) => d.note ?? [REASON[d.reason] ?? d.reason, d.via?.length ? `(${d.via.slice(0, 2).map((f) => f.split('/').pop()).join(', ')}${d.via.length > 2 ? ', …' : ''})` : ''].filter(Boolean).join(' ')
const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const say = (n) => WORDS[n] ?? String(n)

// A sentence about this pull request, not a changelog for the tool.
function headline({ A, M, D }) {
  const total = A.length + M.length + D.length
  if (!total) return 'No screen is affected by this pull request'
  const noun = total === 1 ? 'screen' : 'screens'
  if (A.length && !M.length && !D.length) return `${say(A.length)} new ${noun} in this pull request`
  if (D.length && !A.length && !M.length) return `${say(D.length)} ${noun} removed in this pull request`
  return `${say(total)} ${noun} changed in this pull request`
}

function renderComment(s, { mapUrl, changesUrl, artifactUrl, shotUrl, shotsBase, viewer = 'https://app.screenmap.dev' }) {
  const n = s.diff.nodes
  const A = n.filter((x) => x.status === 'A'), M = n.filter((x) => x.status === 'M'), D = n.filter((x) => x.status === 'D')
  const dismissed = s.diff.dismissed ?? []
  const route = (id) => s.routes[id] ?? id
  const states = (id) => (s.diff.states ?? []).filter((x) => x.node === id)
  const bareState = (id) => states(id).find((x) => x.name === '')
  const movedStates = (id) => states(id).filter((x) => x.name !== '' && ['A', 'M', 'D'].includes(x.status))

  const link = mapUrl || changesUrl
    ? `${viewer}/?${[mapUrl && `map=${encodeURIComponent(mapUrl)}`, changesUrl && `changes=${encodeURIComponent(changesUrl)}`].filter(Boolean).join('&')}`
    : null
  const nodeLink = (id) => (link ? `${link}&node=${encodeURIComponent(id)}` : null)
  const url = (rel) => (shotsBase && rel ? shotsBase.replace(/\/$/, '') + '/' + rel : null)

  // Which capture speaks for this screen. A screen whose bare capture is
  // identical but whose bottom sheet moved must show the sheet — otherwise the
  // strip is a row of pictures that all look unchanged.
  const capture = (id, status) => {
    const sh = s.shots?.[id]
    if (!sh) return null
    const side = status === 'D' ? 'base' : 'head'
    if (bareState(id)?.status === 'unchanged') {
      const moved = movedStates(id)[0]
      const rel = moved && sh.states?.[moved.name]?.[side]
      if (rel) return { rel, state: moved.name, note: moved.note ?? null }
    }
    return sh[side] ? { rel: sh[side], state: null, note: null } : null
  }

  const entries = [
    ...[...A, ...M, ...D].map((d) => ({ id: d.id, status: d.status, note: why(d) })),
    ...dismissed.map((d) => ({ id: d.id, status: 'U', note: why(d) })),
  ].map((e) => {
    const cap = capture(e.id, e.status)
    return { ...e, cap, note: cap?.note ?? e.note, tag: cap?.state ? `${cap.state} state` : (TAG[e.status] ?? 'unaffected') }
  })

  const lines = [`### ${headline({ A, M, D })}`, '']

  // the strip: the screens themselves, one cell each, captioned by route
  const withShot = entries.filter((e) => url(e.cap?.rel))
  const changedShots = withShot.filter((e) => e.status !== 'U')
  const shown = [...changedShots, ...withShot.filter((e) => e.status === 'U').slice(0, Math.max(0, Math.min(CONTEXT_MAX, STRIP_MAX - changedShots.length)))].slice(0, STRIP_MAX)
  if (shown.length) {
    const cells = shown.map((e) => {
      const img = `<img src="${url(e.cap.rel)}" width="${SHOT_W}" alt="${esc(route(e.id))}">`
      const href = nodeLink(e.id)
      return `<td align="center" valign="top">${href ? `<a href="${href}">${img}</a>` : img}<br><code>${esc(route(e.id))}</code><br><sub>${MARK[e.status]} ${esc(e.tag)}</sub></td>`
    })
    lines.push('<table><tr>', ...cells, '</tr></table>', '')
    if (entries.length > shown.length) lines.push(`<sub>${entries.length - shown.length} more in the list below.</sub>`, '')
  } else if (shotUrl) {
    lines.push(link ? `[![changed screens](${shotUrl})](${link})` : `![changed screens](${shotUrl})`, '')
  }

  // the ledger: route on the left, what changed on it on the right
  if (entries.length) {
    lines.push('<table>')
    for (const e of entries) {
      const name = `<code>${esc(route(e.id))}</code>${e.cap?.state ? ` <sub>· ${esc(e.cap.state)}</sub>` : ''}`
      const href = nodeLink(e.id)
      lines.push(`<tr><td>${MARK[e.status]} ${href ? `<a href="${href}">${name}</a>` : name}</td><td>${e.note ? esc(e.note) : ''}</td></tr>`)
    }
    lines.push('</table>', '')
  } else {
    lines.push('_Static analysis reaches no screen from the files this pull request touches._', '')
  }

  if (link) lines.push(`**[Open screenmap viewer for this PR →](${link})**`, '')

  const pairs = entries.filter((e) => e.status === 'M' && url(s.shots?.[e.id]?.base) && e.cap && url(e.cap.rel))
    .map((e) => {
      const sh = s.shots[e.id]
      const before = e.cap.state ? sh.states?.[e.cap.state]?.base : sh.base
      return before ? { ...e, before } : null
    }).filter(Boolean)
  if (pairs.length) {
    lines.push('<details><summary>Before and after</summary>', '', '<table>', '<tr><td></td><td align="center"><sub>before</sub></td><td align="center"><sub>after</sub></td></tr>')
    for (const e of pairs) {
      lines.push(`<tr><td valign="middle"><code>${esc(route(e.id))}</code>${e.cap.state ? `<br><sub>· ${esc(e.cap.state)}</sub>` : ''}</td><td><img src="${url(e.before)}" width="${SHOT_W}" alt="${esc(route(e.id))} before"></td><td><img src="${url(e.cap.rel)}" width="${SHOT_W}" alt="${esc(route(e.id))} after"></td></tr>`)
    }
    lines.push('</table>', '', '</details>')
  }

  const eA = s.diff.edges.filter((e) => e.status === 'A'), eD = s.diff.edges.filter((e) => e.status === 'D')
  if (eA.length || eD.length) {
    lines.push('<details><summary>' + [eA.length && `${eA.length} new route${eA.length === 1 ? '' : 's'}`, eD.length && `${eD.length} route${eD.length === 1 ? '' : 's'} gone`].filter(Boolean).join(' · ') + '</summary>', '')
    for (const e of [...eA, ...eD]) lines.push(`- ${MARK[e.status]} \`${route(e.from)}\` → \`${route(e.to)}\`${e.raw && e.raw !== route(e.to) ? ` — \`${e.raw}\`` : ''}`)
    lines.push('', '</details>')
  }

  // things that went wrong get to be seen, not buried in the footnote
  const warn = []
  if (s.captured.failed?.length) warn.push(`${s.captured.failed.length} screen${s.captured.failed.length === 1 ? '' : 's'} could not be captured — deep link failed in CI.`)
  if (s.agent?.ran && s.agent.overBudget?.length) warn.push(`${s.agent.overBudget.length} screen${s.agent.overBudget.length === 1 ? '' : 's'} hit the agent budget before reaching a stable state.`)
  if (s.drifted?.length) warn.push(`${s.drifted.length} committed flow${s.drifted.length === 1 ? '' : 's'} drifted (${s.drifted.map((d) => d.flows[0]).join(', ')}) — captured by deep link instead, and queued to be re-recorded.`)
  if (warn.length) lines.push('', '> [!WARNING]', ...warn.map((w) => `> ${w}`))

  if (s.recordedFlowsDir) lines.push('', '> [!NOTE]', '> New flows were recorded for screens that had none. A flows PR will follow after merge.')

  // provenance: worth keeping, not worth reading first
  const a = s.agent ?? {}
  let agentDesc = 'off'
  if (a.provider) {
    agentDesc = a.provider
    if (a.keyEnv) agentDesc += a.hasKey ? ` · ${a.keyEnv}` : ` · ${a.keyEnv} not set`
    else if (a.keyEnv === null && a.hasKey === null) agentDesc += ' · no LLM key configured'
  }
  const foot = [
    `Captured on ${s.device ?? 'simulator'}: ${s.captured.replay} by flow replay${s.argent ? ` (argent ${s.argent})` : ''}, ${s.captured.deeplink} by deep link, ${s.captured.agent} by agent (${agentDesc}).`,
    s.baselineGeneratedAt ? `Compared against baseline \`${(s.baseSha ?? '').slice(0, 7)}\` from ${new Date(s.baselineGeneratedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC.` : null,
    `${A.length} added · ${M.length} changed · ${D.length} removed · ${dismissed.length} suspect${dismissed.length === 1 ? '' : 's'} cleared by looking.`,
    s.suspects.broadFiles?.length ? `${s.suspects.broadFiles.length} broadly-imported changed file${s.suspects.broadFiles.length === 1 ? '' : 's'} excluded from suspect marking.` : null,
    artifactUrl ? `[Download the bundle](${artifactUrl}).` : null,
  ].filter(Boolean)
  lines.push('', '<details><summary>How these were captured</summary>', '', ...foot.map((f) => `- ${f}`), '', '</details>')

  return lines.join('\n')
}

async function comment() {
  const s = readJson(opts.summary)
  const body = renderComment(s, { mapUrl: opts['map-url'], changesUrl: opts['changes-url'], artifactUrl: opts['artifact-url'], shotUrl: opts['shot-url'], shotsBase: opts['shots-base'], viewer: opts.viewer })
  if (opts.post) {
    const repo = opts.repo ?? repoSlug()
    const number = Number(opts.pr ?? s.pr)
    const how = upsertStickyComment({ repo, number, body })
    log(`comment ${how} on ${repo}#${number}`)
  } else console.log(body)
}

async function publish() {
  const repo = opts.repo ?? repoSlug()
  // a src that is a directory publishes every file under it, keeping the tree
  const files = String(opts.files).split(',').flatMap((pair) => {
    const [src, dest] = pair.split('=')
    if (!exists(src) || !fs.statSync(src).isDirectory()) return [{ src, dest }]
    const walk = (dir, rel = '') => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [{ src: path.join(dir, e.name), dest: `${dest}/${rel}${e.name}` }])
    return walk(src)
  })
  const res = publishToBranch({ repo, branch: opts.branch ?? 'screenmaps', files, message: opts.message ?? 'screenmap-ci: publish bundles', cwd: path.resolve(opts.cwd ?? '.') })
  console.log(JSON.stringify(res, null, 2))
}

async function flowsPr() {
  const repo = opts.repo ?? repoSlug()
  const url = openFlowsPR({ repo, base: opts.base ?? 'main', flowsSrcDir: opts.flows, flowsDestDir: opts.dest ?? '.screenmap/flows', title: opts.title ?? 'screenmap: record flows for new screens', body: opts.body ?? 'Flows recorded by the screenmap agent for screens that had no committed flow. Review the taps, then merge so future runs replay them deterministically.', cwd: path.resolve(opts.cwd ?? '.') })
  console.log(JSON.stringify({ url }))
}

async function shot() {
  const { takeShot } = await import('./lib/shot.mjs')
  const out = path.resolve(opts.out ?? 'screenmap-shot.png')
  await takeShot({ mapFile: path.resolve(opts.map), changesFile: opts.changes ? path.resolve(opts.changes) : null, out, viewer: opts.viewer || undefined })
  console.log(JSON.stringify({ shot: out }))
}

async function resolveAppCmd() {
  const { resolveApp } = await import('./lib/eas.mjs')
  const project = path.resolve(opts.project ?? '.')
  const res = resolveApp({ projectDir: project, profile: opts.profile ?? 'development-simulator', workDir: path.resolve(opts.work ?? path.join(project, '.screenmap', 'out', 'ci', 'eas')) })
  console.log(JSON.stringify(res, null, 2))
}

const commands = { baseline, pr, comment, publish, 'flows-pr': flowsPr, 'resolve-app': resolveAppCmd, shot }
if (!commands[cmd]) { console.error('usage: screenmap-ci <baseline|pr|comment|publish|flows-pr|resolve-app|shot> [options]'); process.exit(1) }
commands[cmd]().catch((e) => { console.error('[screenmap-ci] failed:', e.message); process.exit(1) })
