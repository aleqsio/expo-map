// Screen text via Apple Vision (see native/ocr.swift). Compiled once into a
// cache dir; ~0.5s per capture afterwards. Used to decide whether a replayed
// flow landed on the screen it claims, and to spot system alerts.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { log } from './util.mjs'

const SRC = new URL('./native/ocr.swift', import.meta.url).pathname
let binPath = null
export function ocrAvailable() {
  if (binPath) return true
  if (process.platform !== 'darwin') return false
  const dir = path.join(os.homedir(), '.cache', 'appmap-ci')
  fs.mkdirSync(dir, { recursive: true })
  const bin = path.join(dir, `ocr-${fs.statSync(SRC).size}`)
  if (!fs.existsSync(bin)) {
    log('compiling Vision OCR helper (one-time)…')
    const r = spawnSync('swiftc', ['-O', '-o', bin, SRC], { encoding: 'utf8' })
    if (r.status !== 0) { log('swiftc failed:', (r.stderr || '').slice(-300)); return false }
  }
  binPath = bin
  return true
}

export function ocr(pngPath) {
  if (!ocrAvailable()) return []
  try {
    return execFileSync(binPath, [pngPath], { encoding: 'utf8' }).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return null } }).filter(Boolean)
  } catch { return [] }
}

const STOP = new Set(['the', 'and', 'for', 'with', 'you', 'your', 'this', 'that', 'from', 'are', 'was', 'not', 'all', 'any', 'more', 'ago', 'min', 'now', 'new', 'see', 'via'])
export function words(items) {
  const out = new Set()
  for (const it of items) for (const w of it.text.toLowerCase().split(/[^a-z0-9@#']+/)) {
    if (w.length < 3 || /^\d+$/.test(w) || STOP.has(w)) continue
    out.add(w)
  }
  return out
}
export const jaccard = (a, b) => { if (!a.size && !b.size) return 1; let i = 0; for (const w of a) if (b.has(w)) i++; return i / (a.size + b.size - i) }
export const containment = (needles, hay) => { if (!needles.size) return null; let i = 0; for (const w of needles) if (hay.has(w)) i++; return i / needles.size }

const ALERT_HINTS = [/would like/i, /don['’]t allow/i, /^allow$/i, /allow while using/i, /allow once/i, /^not now$/i, /turn on/i, /^ok$/i]
// a system permission/alert is up if several of its tell-tale strings are visible
export function alertButtons(items) {
  const texts = items.map((i) => i.text.trim())
  const hits = texts.filter((t) => ALERT_HINTS.some((re) => re.test(t)))
  if (hits.length < 2) return []
  const order = [/don['’]t allow/i, /^not now$/i, /^ok$/i, /allow once/i, /allow while using/i, /^allow$/i, /limit access/i]
  return items.filter((i) => order.some((re) => re.test(i.text.trim()))).sort((a, b) => order.findIndex((re) => re.test(a.text)) - order.findIndex((re) => re.test(b.text)))
}
