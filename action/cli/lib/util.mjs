import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.error('[screenmap-ci]', ...a)
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

// .screenmap/config.json — the purely mechanical knobs the deterministic lane
// needs without an LLM. Everything is optional; these are the defaults.
// One knob for the cost/accuracy trade, so nobody has to reason about
// `scan` x `depth` x `maxScreens` to get a sensible run. Each preset only
// supplies defaults: anything set explicitly in config.json still wins.
//
//   fast      deterministic lane only. The agent sees just the screens no
//             committed flow can reach, and suspects stop one import hop out.
//             Cheapest and quickest; a screen that starts needing a param will
//             quietly capture its own not-found state.
//   balanced  (default) also re-checks routes whose deep link is a guess built
//             from config.params, which is where silent bad captures come from.
//   thorough  every screen in the run goes through the agent, suspects reach
//             three hops. Most accurate, most tokens, slowest.
export const EFFORTS = {
  fast: { agent: { scan: 'unflowed', maxScreens: 6 }, suspects: { depth: 1 } },
  balanced: { agent: { scan: 'params', maxScreens: 8 }, suspects: { depth: 2 } },
  thorough: { agent: { scan: 'all', maxScreens: 24 }, suspects: { depth: 3 } },
}

export function loadConfig(projectDir) {
  const base = {
    scheme: null, bundleId: null, appPath: null, device: 'iPhone 16 Pro', metroPort: 8081,
    waits: { transition: 2500, network: 6000, boot: 15000 },
    suspects: { broadCap: 8 },
    agent: { enabled: true, model: null, provider: null, command: null, keyEnv: null },
    flowsDir: '.screenmap/flows', skillFile: '.screenmap/SKILL.md',
    params: {},
  }
  const user = readJson(path.join(projectDir, '.screenmap', 'config.json'), {})
  const effort = process.env.SCREENMAP_EFFORT || user.effort || 'balanced'
  const preset = EFFORTS[effort]
  if (!preset) throw new Error(`unknown effort "${effort}" — expected ${Object.keys(EFFORTS).join(' | ')}`)
  const defaults = {
    ...base, effort,
    suspects: { ...base.suspects, ...preset.suspects },
    agent: { ...base.agent, ...preset.agent },
  }
  const merged = {
    ...defaults, ...user, effort,
    waits: { ...defaults.waits, ...(user.waits ?? {}) },
    suspects: { ...defaults.suspects, ...(user.suspects ?? {}) },
    agent: { ...defaults.agent, ...(user.agent ?? {}) },
  }
  if (process.env.AGENT_MAX_SCREENS) merged.agent.maxScreens = Number(process.env.AGENT_MAX_SCREENS) || merged.agent.maxScreens
  if (process.env.SCREENMAP_APP_PATH) merged.appPath = process.env.SCREENMAP_APP_PATH // a prebuilt client (e.g. from EAS) beats ios/build discovery
  return merged
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
