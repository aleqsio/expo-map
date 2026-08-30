#!/usr/bin/env node
// Packs an .screenmap/out/ working directory into a distributable .scrmap bundle (zip).
// Usage: node pack-map.mjs [projectRoot] [--out <file.scrmap>]
// See docs/scrmap-format.md for the format contract.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let projectRoot = '.'
let outPath = null
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--out') outPath = args[++i]
  else projectRoot = args[i]
}
projectRoot = path.resolve(projectRoot)
const base = path.join(projectRoot, '.screenmap', 'out')

const graph = JSON.parse(fs.readFileSync(path.join(base, 'graph.json'), 'utf8'))
let captureStatus = {}
try {
  captureStatus = JSON.parse(fs.readFileSync(path.join(base, 'capture-status.json'), 'utf8'))
} catch {}

// v2: flows are argent YAML + .meta.json sidecars, shipped verbatim in the
// bundle (the visualiser parses them client-side). Metas are read here only
// for the device field and the flow count.
const flowsDir = path.join(base, 'flows')
const flowFiles = fs.existsSync(flowsDir)
  ? fs.readdirSync(flowsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.meta.json'))
  : []
const flows = flowFiles
  .filter((f) => f.endsWith('.meta.json'))
  .map((f) => {
    try {
      return JSON.parse(fs.readFileSync(path.join(flowsDir, f), 'utf8'))
    } catch {
      return null
    }
  })
  .filter(Boolean)

const shotsDir = path.join(base, 'screens')
const shotFiles = fs.existsSync(shotsDir)
  ? fs.readdirSync(shotsDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f))
  : []

const appName = graph.appName ?? path.basename(graph.projectRoot ?? projectRoot)

const nodes = graph.routes.map((r) => {
  const cs = captureStatus[r.id] ?? {}
  const baseShot = shotFiles.find((f) => f.replace(/\.\w+$/, '') === r.slug)
  const states = shotFiles
    .filter((f) => f.startsWith(r.slug + '--'))
    .map((f) => ({ name: f.replace(/\.\w+$/, '').slice(r.slug.length + 2), screenshot: 'screens/' + f }))
    .sort((a, b) => a.name.localeCompare(b.name))
  return {
    id: r.id,
    urlPath: r.urlPath ?? null,
    title: r.title ?? r.urlPath ?? r.id,
    reach: r.reach ?? (r.urlPath ? 'deep-link' : 'navigation-only'),
    file: r.file ?? null,
    slug: r.slug,
    group: r.layoutDir ?? '',
    navigator: r.navigator ?? null,
    params: r.params ?? [],
    presentation: r.presentation ?? null,
    stateHints: r.stateHints ?? [],
    capture: {
      status: cs.status ?? (baseShot ? 'ok' : 'missing'),
      note: cs.note ?? null,
      needsNavigation: cs.needsNavigation ?? r.reach === 'navigation-only',
      screenshot: baseShot ? 'screens/' + baseShot : null,
      states,
    },
  }
})

const map = { nodes, edges: graph.edges ?? [], flows: [] }
const manifest = {
  formatVersion: 2,
  flowFormat: 'argent', // flows/*.yaml runnable via `argent flow run`
  generator: 'screenmap/2.0',
  app: {
    name: appName,
    scheme: graph.scheme ?? null,
    platform: 'ios-simulator',
    device: flows.find((f) => f.device)?.device ?? null,
    mode: graph.mode ?? null,
  },
  generatedAt: new Date().toISOString(),
}

const stage = fs.mkdtempSync(path.join(base, '.pack-'))
try {
  fs.writeFileSync(path.join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2))
  fs.writeFileSync(path.join(stage, 'map.json'), JSON.stringify(map, null, 2))
  fs.mkdirSync(path.join(stage, 'screens'))
  for (const f of shotFiles) fs.copyFileSync(path.join(shotsDir, f), path.join(stage, 'screens', f))
  fs.mkdirSync(path.join(stage, 'flows'))
  for (const f of flowFiles) fs.copyFileSync(path.join(flowsDir, f), path.join(stage, 'flows', f))

  const date = new Date().toISOString().slice(0, 10)
  outPath = path.resolve(outPath ?? path.join(base, `${appName}-${date}.scrmap`))
  fs.rmSync(outPath, { force: true })
  execFileSync('zip', ['-r', '-q', outPath, 'manifest.json', 'map.json', 'screens', 'flows'], { cwd: stage })
  const kb = Math.round(fs.statSync(outPath).size / 1024)
  console.log(`wrote ${outPath} (${kb} KB, ${nodes.length} nodes, ${map.edges.length} edges, ${flows.length} flows, ${shotFiles.length} screenshots)`)
} finally {
  fs.rmSync(stage, { recursive: true, force: true })
}
