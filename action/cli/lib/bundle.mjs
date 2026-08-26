// .scrmap / .diff.scrmap helpers: read a baseline bundle, turn its map back
// into a parse-routes-shaped graph, pack a new baseline (reusing screenshots
// for unchanged screens), and call the skill's diff-map.mjs to pack a diff.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { readJson, writeJson, ensureDir, log } from './util.mjs'

export const SKILL_SCRIPTS = path.resolve(new URL('../../../skills/expo-map/scripts', import.meta.url).pathname)

export function unzipTo(bundlePath, dir) {
  ensureDir(dir)
  execFileSync('unzip', ['-q', '-o', bundlePath, '-d', dir])
  return dir
}

export function readBaseline(bundlePath, workDir) {
  const dir = unzipTo(bundlePath, workDir)
  const manifest = readJson(path.join(dir, 'manifest.json'))
  const map = readJson(path.join(dir, 'map.json'))
  const graph = fs.existsSync(path.join(dir, 'graph.json')) ? readJson(path.join(dir, 'graph.json')) : graphFromMap(manifest, map)
  return { dir, manifest, map, graph, screensDir: path.join(dir, 'screens'), flowsDir: path.join(dir, 'flows') }
}

// map.json (viewer shape) → graph.json (producer shape) so older baselines
// packed without graph.json still diff
export function graphFromMap(manifest, map) {
  return {
    generatedAt: manifest.generatedAt, projectRoot: null, scheme: manifest.app?.scheme ?? null, mode: manifest.app?.mode ?? null,
    routes: map.nodes.map((n) => ({
      id: n.id, file: n.file, urlPath: n.urlPath, slug: n.slug, params: n.params ?? [], navigator: n.navigator,
      layoutDir: n.group ?? '', presentation: n.presentation ?? null, stateHints: n.stateHints ?? [],
    })),
    edges: map.edges ?? [],
  }
}

export function parseRoutes(projectDir, outPath) {
  execFileSync('node', [path.join(SKILL_SCRIPTS, 'parse-routes.mjs'), projectDir, '--out', outPath], { stdio: ['ignore', 'ignore', 'inherit'] })
  return readJson(outPath)
}

// suspects between two graphs given the changed-file list; reuses diff-map.mjs
export function computeSuspects({ diffDir, baseGraph, headGraph, changedFiles, projectDir, depth, broadCap }) {
  ensureDir(path.join(diffDir, 'base')); ensureDir(path.join(diffDir, 'head'))
  writeJson(path.join(diffDir, 'base', 'graph.json'), baseGraph)
  writeJson(path.join(diffDir, 'head', 'graph.json'), headGraph)
  fs.writeFileSync(path.join(diffDir, 'changed-files.txt'), changedFiles.join('\n') + '\n')
  execFileSync('node', [path.join(SKILL_SCRIPTS, 'diff-map.mjs'), 'suspects', diffDir, '--project', projectDir, '--depth', String(depth), '--broad-cap', String(broadCap)], { stdio: ['ignore', process.stderr, 'inherit'] })
  return readJson(path.join(diffDir, 'suspects.json'))
}

export function packDiff({ diffDir, device, out }) {
  const args = [path.join(SKILL_SCRIPTS, 'diff-map.mjs'), 'pack', diffDir]
  if (device) args.push('--device', device)
  if (out) args.push('--out', out)
  execFileSync('node', args, { stdio: ['ignore', process.stderr, 'inherit'] })
  return out ?? fs.readdirSync(diffDir).filter((f) => f.endsWith('.diff.scrmap')).map((f) => path.join(diffDir, f))[0]
}

// Pack a baseline .scrmap from loose parts. Mirrors pack-map.mjs but takes
// explicit dirs and adds graph.json + commit metadata (producer extensions;
// viewers ignore unknown files/fields).
export function packBaseline({ graph, screensDir, flowsDir, captureStatus = {}, appName, device, commit, ref, out }) {
  const shotFiles = fs.existsSync(screensDir) ? fs.readdirSync(screensDir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)) : []
  const flowFiles = flowsDir && fs.existsSync(flowsDir) ? fs.readdirSync(flowsDir).filter((f) => f.endsWith('.yaml') || f.endsWith('.meta.json')) : []
  const nodes = graph.routes.map((r) => {
    const cs = captureStatus[r.id] ?? {}
    const baseShot = shotFiles.find((f) => f.replace(/\.\w+$/, '') === r.slug)
    const states = shotFiles.filter((f) => f.startsWith(r.slug + '--')).map((f) => ({ name: f.replace(/\.\w+$/, '').slice(r.slug.length + 2), screenshot: 'screens/' + f })).sort((a, b) => a.name.localeCompare(b.name))
    return {
      id: r.id, urlPath: r.urlPath, file: r.file ?? null, slug: r.slug, group: r.layoutDir ?? '', navigator: r.navigator ?? null,
      params: r.params ?? [], presentation: r.presentation ?? null, stateHints: r.stateHints ?? [],
      capture: { status: cs.status ?? (baseShot ? 'ok' : 'missing'), note: cs.note ?? null, needsNavigation: cs.needsNavigation ?? false, screenshot: baseShot ? 'screens/' + baseShot : null, states },
    }
  })
  const map = { nodes, edges: graph.edges ?? [], flows: [] }
  const manifest = {
    formatVersion: 2, flowFormat: 'argent', generator: 'screenmap-ci/0.1',
    app: { name: appName, scheme: graph.scheme ?? null, platform: 'ios-simulator', device: device ?? null, mode: graph.mode ?? null },
    source: { commit: commit ?? null, ref: ref ?? null },
    generatedAt: new Date().toISOString(),
  }
  const stage = fs.mkdtempSync(path.join(path.dirname(out), '.pack-'))
  try {
    writeJson(path.join(stage, 'manifest.json'), manifest)
    writeJson(path.join(stage, 'map.json'), map)
    writeJson(path.join(stage, 'graph.json'), graph)
    writeJson(path.join(stage, 'capture-status.json'), captureStatus)
    ensureDir(path.join(stage, 'screens')); ensureDir(path.join(stage, 'flows'))
    for (const f of shotFiles) fs.copyFileSync(path.join(screensDir, f), path.join(stage, 'screens', f))
    for (const f of flowFiles) fs.copyFileSync(path.join(flowsDir, f), path.join(stage, 'flows', f))
    fs.rmSync(out, { force: true })
    execFileSync('zip', ['-r', '-q', out, 'manifest.json', 'map.json', 'graph.json', 'capture-status.json', 'screens', 'flows'], { cwd: stage })
  } finally { fs.rmSync(stage, { recursive: true, force: true }) }
  log(`packed ${out}: ${nodes.length} nodes, ${shotFiles.length} shots, ${flowFiles.length / 2 | 0} flows`)
  return { manifest, map }
}

export function downscaleAll(dir) {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) if (/\.png$/i.test(f)) { try { execFileSync('sips', ['-Z', '800', path.join(dir, f)], { stdio: 'ignore' }) } catch {} }
}
