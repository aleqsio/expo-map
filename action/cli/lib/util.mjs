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
//   deterministic  no agent, no tokens: committed flows replay and everything
//             else is deep-linked. Chosen automatically when no agent key is
//             set, so a keyless run is a mode rather than a degraded one.
//   fast      the agent sees just the screens no committed flow can reach, and
//             suspects stop one import hop out. Cheapest agent lane; a screen
//             that starts needing a param quietly captures its own not-found.
//   balanced  (default) also re-checks routes whose deep link is a guess built
//             from config.params, which is where silent bad captures come from.
//   thorough  every screen in the run goes through the agent, suspects reach
//             three hops. Most accurate, most tokens, slowest.
export const EFFORTS = {
  deterministic: { agent: { enabled: false, scan: 'unflowed', maxScreens: 0 }, suspects: { depth: 2 } },
  fast: { agent: { scan: 'unflowed', maxScreens: 6 }, suspects: { depth: 1 } },
  balanced: { agent: { scan: 'params', maxScreens: 8 }, suspects: { depth: 2 } },
  thorough: { agent: { scan: 'all', maxScreens: 24 }, suspects: { depth: 3 } },
}

// The env var each provider reads. Lives here rather than in agent.mjs so
// effort resolution can tell whether a key exists without importing the agent
// lane; PROVIDERS builds its keyEnv from this. opencode authenticates through
// whichever provider it was configured for, so there is nothing to look for.
export const PROVIDER_KEY_ENVS = {
  claude: 'ANTHROPIC_API_KEY', codex: 'OPENAI_API_KEY', gemini: 'GEMINI_API_KEY', opencode: null,
}

// Is there a key for the provider this run would use? A custom agent.command
// brings its own auth, and opencode has no fixed variable, so both count as
// available and the user stays in charge of the effort they asked for.
function agentKeyPresent(user) {
  if (user.agent?.command) return true
  const name = process.env.AGENT_PROVIDER || user.agent?.provider || 'claude'
  const keyEnv = user.agent?.keyEnv ?? PROVIDER_KEY_ENVS[name]
  if (keyEnv === null || keyEnv === undefined) return true
  return !!(process.env[keyEnv] || process.env.AGENT_API_KEY)
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
  // An explicit effort is always honoured, even one that cannot run: asking for
  // balanced with no key should still say the agent sat out. Only the unstated
  // case falls back to the mode a keyless runner can actually deliver.
  const effort = process.env.SCREENMAP_EFFORT || user.effort || (agentKeyPresent(user) ? 'balanced' : 'deterministic')
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
