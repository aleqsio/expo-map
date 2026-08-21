// Committed flows → deterministic captures via `argent flow run`, with a
// landing check. A flow's .meta.json sidecar says which step produces which
// screenshot; argent can't snapshot mid-run for us, so a flow with N capture
// points is split into N+1 fragments run back-to-back against the live
// device, with a screenshot taken between fragments.
//
// Coordinate-tap flows drift silently (a tap "succeeds" wherever it lands), so
// every replay is verified: OCR the end screen, dismiss any system alert, and
// check the flow's landmarks (words the recorder said identify the arrival
// screen). Without landmarks, fall back to comparing OCR text with a fresh
// deep-link capture of the same route.
import fs from 'node:fs'
import path from 'node:path'
import YAML from 'yaml'
import { screenshot } from './sim.mjs'
import { argentFlow, argentRun } from './argent.mjs'
import { ocr, words, jaccard, containment, alertButtons } from './ocr.mjs'
import { readJson, ensureDir, log, sleep } from './util.mjs'

export function loadFlows(projectDir, dirs) {
  const byRoute = new Map() // routeId → { nav, visit, others[] }
  for (const d of dirs) {
    const abs = path.resolve(projectDir, d)
    if (!fs.existsSync(abs)) continue
    for (const f of fs.readdirSync(abs)) {
      if (!f.endsWith('.meta.json')) continue
      const meta = readJson(path.join(abs, f), null)
      if (!meta?.route) continue
      const yaml = path.join(abs, f.replace(/\.meta\.json$/, '.yaml'))
      if (!fs.existsSync(yaml)) continue
      const entry = byRoute.get(meta.route) ?? { nav: null, visit: null, others: [] }
      const rec = { name: meta.name, meta, yaml }
      if (meta.name.startsWith('nav-')) entry.nav ??= rec
      else if (meta.name.startsWith('visit-')) entry.visit ??= rec
      else entry.others.push(rec)
      byRoute.set(meta.route, entry)
    }
  }
  return byRoute
}

function runFragment(steps, name, tmpDir, udid) {
  const file = path.join(tmpDir, `${name}.yaml`)
  fs.writeFileSync(file, YAML.stringify({ steps }))
  const r = argentFlow(file, udid)
  if (!r.ok) log(`argent fragment ${name} failed:`, r.raw.trim().slice(-400))
  return r.ok
}

// Replays one flow and writes its captures into outDir.
export async function replayFlow(rec, { udid, outDir, tmpDir }) {
  const doc = YAML.parse(fs.readFileSync(rec.yaml, 'utf8'))
  const steps = doc?.steps ?? []
  const captures = Object.entries(rec.meta.steps ?? {}).filter(([, s]) => s.capture).map(([i, s]) => ({ after: Number(i), file: s.capture })).sort((a, b) => a.after - b.after)
  ensureDir(outDir); ensureDir(tmpDir)
  const written = []
  let cursor = 0, seg = 0
  for (const cap of captures) {
    const frag = steps.slice(cursor, cap.after + 1)
    if (frag.length && !runFragment(frag, `${rec.name}-${seg++}`, tmpDir, udid)) return { ok: false, written }
    await sleep(400)
    screenshot(udid, path.join(outDir, cap.file))
    written.push(cap.file)
    cursor = cap.after + 1
  }
  if (cursor < steps.length && !runFragment(steps.slice(cursor), `${rec.name}-${seg++}`, tmpDir, udid)) return { ok: false, written }
  return { ok: true, written }
}

// If a system alert is on screen, tap its most conservative button (Don't
// Allow / Not Now / OK) and return true.
export function dismissAlert(udid, shotPath) {
  const items = ocr(shotPath)
  const buttons = alertButtons(items)
  if (!buttons.length) return false
  const b = buttons[0]
  // Vision boxes: normalized, origin bottom-left → argent taps: origin top-left
  const x = b.x + b.w / 2, y = 1 - (b.y + b.h / 2)
  const r = argentRun('gesture-tap', { udid, x: x.toFixed(4), y: y.toFixed(4) })
  log(`dismissed system alert via "${b.text}" (${r.ok ? 'ok' : 'tap failed'})`)
  return r.ok
}

const GENERIC = new Set(['arrived', 'screen', 'captured', 'navigate', 'visit', 'open', 'opened', 'tap', 'tapped', 'shows', 'showing', 'with', 'from', 'into', 'then', 'after', 'before', 'via', 'the', 'and', 'for', 'this', 'that', 'page', 'list', 'row', 'rows', 'button', 'top', 'bottom', 'left', 'right', 'below', 'above', 'fold', 'dev', 'settings', 'home'])
export function landmarksOf(meta) {
  if (Array.isArray(meta.landmarks) && meta.landmarks.length) return new Set(meta.landmarks.map((w) => String(w).toLowerCase()))
  // derive from the recorder's result sentence: distinctive words ≥4 chars
  const src = `${meta.result ?? ''}`
  const out = new Set()
  for (const w of src.toLowerCase().split(/[^a-z0-9']+/)) if (w.length >= 4 && !GENERIC.has(w) && !/^\d+$/.test(w)) out.add(w)
  return out
}

// Decide whether a replay landed on its screen. Returns { ok, method, score }.
export async function verifyLanding({ shot, rec, udid, probe }) {
  // probe(): async () => path of a fresh deep-link capture of the same route (only used as fallback)
  let items = ocr(shot)
  if (alertButtons(items).length && dismissAlert(udid, shot)) { await sleep(600); screenshot(udid, shot); items = ocr(shot) }
  const seen = words(items)
  const marks = landmarksOf(rec.meta)
  if (marks.size >= 2) {
    const c = containment(marks, seen)
    const hits = Math.round(c * marks.size)
    // explicit landmarks are chosen to be visible → demand a real share of them;
    // words mined from the recorder's prose are noisy → a wrong screen shares
    // ~none of them (calibrated: drift scored 0.00, correct screens 0.23–0.93)
    const explicit = Array.isArray(rec.meta.landmarks) && rec.meta.landmarks.length > 0
    const ok = explicit ? c >= (marks.size <= 3 ? 1 / marks.size : 0.34) - 1e-9 : c >= 0.15 && hits >= (marks.size <= 5 ? 1 : 2)
    return { ok, method: explicit ? 'landmarks' : 'result-words', score: Number(c.toFixed(2)), landmarks: [...marks] }
  }
  if (!probe) return { ok: true, method: 'unverified', score: null }
  const p = await probe()
  if (!p) return { ok: true, method: 'unverified', score: null }
  const j = jaccard(seen, words(ocr(p)))
  return { ok: j >= 0.35, method: 'deeplink-text', score: Number(j.toFixed(2)) }
}
