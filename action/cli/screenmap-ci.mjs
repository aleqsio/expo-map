#!/usr/bin/env node
// screenmap-ci — the deterministic core of the screenmap GitHub Action.
//
//   screenmap-ci baseline --project <dir> [--previous <file.scrmap>] [--full] [--out <file>]
//                      [--only id,id] [--limit N] [--no-agent] [--no-sim]
//   screenmap-ci pr       --project <dir> --baseline <file.scrmap> [--base <sha>] [--head <sha>]
//                      [--pr <n> --title <t> --url <u>] [--out <file>] [--no-agent]
//   screenmap-ci comment  --summary <pr-summary.json> [--map-url U] [--changes-url U] [--artifact-url U]
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
  const work = path.join(project, '.expo-map', 'ci', 'baseline')
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

  const flowDirs = [config.flowsDir, '.expo-map/flows']
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
  const work = path.join(project, '.expo-map', 'ci', 'pr')
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
  const flows = loadFlows(project, [config.flowsDir, '.expo-map/flows'])
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
    diff: { nodes: diff.nodes, dismissed: diff.dismissed ?? [], edges: diff.edges, states: (diff.states ?? []).filter((s) => s.reason !== 'hint' && ['A', 'M', 'D'].includes(s.status) && s.name !== '') },
    routes: Object.fromEntries(headGraph.routes.map((r) => [r.id, r.urlPath])),
  }
  writeJson(path.join(work, 'summary.json'), summary)
  console.log(JSON.stringify(summary, null, 2))
}

function renderComment(s, { mapUrl, changesUrl, artifactUrl, shotUrl, viewer = 'https://app.screenmap.dev' }) {
  const n = s.diff.nodes
  const A = n.filter((x) => x.status === 'A'), M = n.filter((x) => x.status === 'M'), D = n.filter((x) => x.status === 'D')
  const eA = s.diff.edges.filter((e) => e.status === 'A').length, eD = s.diff.edges.filter((e) => e.status === 'D').length
  const route = (id) => s.routes[id] ?? id
  const lines = []
  const parts = [`${A.length} screen${A.length === 1 ? '' : 's'} added`, `${M.length} changed`, `${D.length} removed`]
  if (eA || eD) parts.push(`${eA + eD} edge${eA + eD === 1 ? '' : 's'} ${eA && eD ? 'changed' : eA ? 'added' : 'removed'}`)
  if (s.diff.dismissed.length) parts.push(`${s.diff.dismissed.length} suspect${s.diff.dismissed.length === 1 ? '' : 's'} dismissed`)
  lines.push(`### 🗺 screenmap · ${parts.join(' · ')}`)
  lines.push('')
  if (!n.length) lines.push('_No screen is affected by this change as far as static analysis can tell._')
  const link = mapUrl || changesUrl ? `${viewer}/?${[mapUrl && `map=${encodeURIComponent(mapUrl)}`, changesUrl && `changes=${encodeURIComponent(changesUrl)}`].filter(Boolean).join('&')}` : null
  if (link) lines.push(`**[Open in visualiser →](${link})**`, '')
  // the changed region, rendered by the visualiser in shot mode; clicks through
  if (shotUrl) lines.push(link ? `[![changed screens](${shotUrl})](${link})` : `![changed screens](${shotUrl})`, '')
  const mark = { A: '➕', M: '✏️', D: '➖' }
  for (const d of [...A, ...M, ...D]) {
    const states = s.diff.states.filter((st) => st.node === d.id)
    const stateNote = states.length ? ` — states: ${states.map((st) => `\`${st.name}\` ${st.status === 'A' ? 'added' : st.status === 'D' ? 'removed' : 'changed'}`).join(', ')}` : ''
    lines.push(`- ${mark[d.status]} \`${route(d.id)}\`${d.note ? ` — ${d.note}` : ''}${stateNote}`)
  }
  if (s.diff.dismissed.length) {
    lines.push('', '<details><summary>Dismissed suspects (statically flagged, judged visually unaffected)</summary>', '')
    for (const d of s.diff.dismissed) lines.push(`- \`${route(d.id)}\`${d.note ? ` — ${d.note}` : ''}`)
    lines.push('', '</details>')
  }
  const foot = []
  if (artifactUrl) foot.push(`[artifact](${artifactUrl})`)
  if (s.baselineGeneratedAt) foot.push(`baseline \`${(s.baseSha ?? '').slice(0, 7)}\` (${new Date(s.baselineGeneratedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`)
  // who did the capturing: device, replay runner, and the agent's LLM setup
  const a = s.agent ?? {}
  let agentDesc = 'off'
  if (a.provider) {
    agentDesc = a.provider
    if (a.keyEnv) agentDesc += a.hasKey ? ` · ${a.keyEnv}` : ` · ${a.keyEnv} not set`
    else if (a.keyEnv === null && a.hasKey === null) agentDesc += ' · no LLM key configured'
  }
  foot.push(`captured on ${s.device ?? 'simulator'}: ${s.captured.replay} by flow replay${s.argent ? ` (argent ${s.argent})` : ''}, ${s.captured.deeplink} by deep link (simctl), ${s.captured.agent} by agent (${agentDesc})`)
  if (s.agent?.ran && s.agent.overBudget?.length) foot.push(`${s.agent.overBudget.length} screen(s) over the agent budget`)
  if (s.recordedFlowsDir) foot.push('new flows recorded — a flows PR will follow after merge')
  if (s.drifted?.length) foot.push(`${s.drifted.length} committed flow(s) drifted (${s.drifted.map((d) => d.flows[0]).join(', ')}) — captured by deep link instead; will be re-recorded`)
  if (s.suspects.broadFiles?.length) foot.push(`${s.suspects.broadFiles.length} broadly-imported changed file(s) excluded from suspect marking`)
  lines.push('', `<sub>${foot.join(' · ')}</sub>`)
  return lines.join('\n')
}

async function comment() {
  const s = readJson(opts.summary)
  const body = renderComment(s, { mapUrl: opts['map-url'], changesUrl: opts['changes-url'], artifactUrl: opts['artifact-url'], shotUrl: opts['shot-url'], viewer: opts.viewer })
  if (opts.post) {
    const repo = opts.repo ?? repoSlug()
    const number = Number(opts.pr ?? s.pr)
    const how = upsertStickyComment({ repo, number, body })
    log(`comment ${how} on ${repo}#${number}`)
  } else console.log(body)
}

async function publish() {
  const repo = opts.repo ?? repoSlug()
  const files = String(opts.files).split(',').map((p) => { const [src, dest] = p.split('='); return { src, dest } })
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
  const res = resolveApp({ projectDir: project, profile: opts.profile ?? 'development-simulator', workDir: path.resolve(opts.work ?? path.join(project, '.expo-map', 'ci', 'eas')) })
  console.log(JSON.stringify(res, null, 2))
}

const commands = { baseline, pr, comment, publish, 'flows-pr': flowsPr, 'resolve-app': resolveAppCmd, shot }
if (!commands[cmd]) { console.error('usage: screenmap-ci <baseline|pr|comment|publish|flows-pr|resolve-app|shot> [options]'); process.exit(1) }
commands[cmd]().catch((e) => { console.error('[screenmap-ci] failed:', e.message); process.exit(1) })
