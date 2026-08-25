// argent CLI access. Prefer a global `argent` (the Action installs it);
// otherwise npx — always from a neutral cwd, never inside the project, because
// a repo's devEngines node pin can make npx refuse to run there.
import { spawnSync } from 'node:child_process'
import os from 'node:os'

let cached = null
export function argentCommand() {
  if (cached !== null) return cached
  const ok = (r) => /argent v\d|Usage: argent/.test((r.stdout || '') + (r.stderr || ''))
  const g = spawnSync('argent', ['--help'], { encoding: 'utf8', cwd: os.tmpdir() })
  if (ok(g)) return (cached = ['argent', []])
  const n = spawnSync('npx', ['-y', '@swmansion/argent@0.21.0', '--help'], { encoding: 'utf8', cwd: os.tmpdir() })
  if (ok(n)) return (cached = ['npx', ['-y', '@swmansion/argent@0.21.0']])
  return (cached = false)
}
export const argentAvailable = () => !!argentCommand()

let ver
export function argentVersion() {
  if (ver !== undefined) return ver
  const cmd = argentCommand()
  if (!cmd) return (ver = null)
  const r = spawnSync(cmd[0], [...cmd[1], '--help'], { encoding: 'utf8', cwd: os.tmpdir() })
  return (ver = ((r.stdout || '') + (r.stderr || '')).match(/argent v?(\d+\.\d+\.\d+)/)?.[1] ?? null)
}

// run a tool: argent run <tool> --flag value … ; returns { ok, json|null, raw }
export function argentRun(tool, flags = {}) {
  const cmd = argentCommand()
  if (!cmd) return { ok: false, json: null, raw: 'argent unavailable' }
  const [bin, base] = cmd
  const args = [...base, 'run', tool, '--json']
  for (const [k, v] of Object.entries(flags)) if (v !== undefined && v !== null) args.push(`--${k}`, String(v))
  const r = spawnSync(bin, args, { encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 16 * 1024 * 1024 })
  let json = null
  try { json = JSON.parse(r.stdout) } catch {}
  return { ok: r.status === 0, json, raw: (r.stdout || '') + (r.stderr || '') }
}

export function argentFlow(yamlPath, udid) {
  const cmd = argentCommand()
  if (!cmd) return { ok: false, raw: 'argent unavailable' }
  const [bin, base] = cmd
  const r = spawnSync(bin, [...base, 'flow', 'run', yamlPath, '--device', udid], { encoding: 'utf8', cwd: os.tmpdir(), maxBuffer: 16 * 1024 * 1024 })
  return { ok: r.status === 0, raw: (r.stdout || '') + (r.stderr || '') }
}

// pre-authorize the permissions a mis-tap could otherwise prompt for
export function grantPermissions(udid, bundleId) {
  const granted = []
  for (const p of ['photos', 'camera', 'microphone', 'contacts', 'calendar', 'media-library', 'motion', 'reminders', 'location']) {
    const r = argentRun('settings-permissions', { udid, action: 'grant', permission: p, bundleId })
    if (r.ok) granted.push(p)
  }
  return granted
}
