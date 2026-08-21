import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.error('[appmap-ci]', ...a)
export const sh = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opts }).trim()
export const shOk = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts }).status === 0
export const readJson = (p, fallback) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch (e) {
    if (fallback !== undefined) return fallback
    throw e
  }
}
export const writeJson = (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(v, null, 2)) }
export const ensureDir = (p) => { fs.mkdirSync(p, { recursive: true }); return p }
export const exists = (p) => fs.existsSync(p)
export const slugOf = (name) => name.replace(/[^A-Za-z0-9_-]+/g, '-')

// parse `--flag value` / `--flag` / positionals
export function parseArgs(argv) {
  const opts = {}, positional = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const k = a.slice(2)
      const next = argv[i + 1]
      if (next !== undefined && !next.startsWith('--')) { opts[k] = next; i++ } else opts[k] = true
    } else positional.push(a)
  }
  return { opts, positional }
}

// .appmap/config.json — the purely mechanical knobs the deterministic lane
// needs without an LLM. Everything is optional; these are the defaults.
export function loadConfig(projectDir) {
  const defaults = {
    scheme: null, bundleId: null, appPath: null, device: 'iPhone 16 Pro', metroPort: 8081,
    waits: { transition: 2500, network: 6000, boot: 15000 },
    suspects: { depth: 2, broadCap: 8 },
    agent: { enabled: true, maxScreens: 8, model: null },
    flowsDir: '.appmap/flows', skillFile: '.appmap/SKILL.md',
    params: {},
  }
  const user = readJson(path.join(projectDir, '.appmap', 'config.json'), {})
  return {
    ...defaults, ...user,
    waits: { ...defaults.waits, ...(user.waits ?? {}) },
    suspects: { ...defaults.suspects, ...(user.suspects ?? {}) },
    agent: { ...defaults.agent, ...(user.agent ?? {}) },
  }
}

// substitute :param placeholders in a urlPath with sample values
export function deepLinkFor(scheme, route, params = {}) {
  let p = route.urlPath ?? '/'
  for (const name of route.params ?? []) {
    const v = params[`${route.id}.${name}`] ?? params[name] ?? '1'
    p = p.replace(new RegExp(`:${name}\\??`, 'g'), encodeURIComponent(String(v))).replace(new RegExp(`\\[${name}\\]`, 'g'), encodeURIComponent(String(v)))
  }
  return `${scheme}://${p.replace(/^\//, '')}`
}
