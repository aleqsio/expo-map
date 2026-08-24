// EAS dev-client resolution: the Action owns no build pipeline. A simulator
// dev client comes from EAS — reuse the newest finished build whose
// fingerprint matches the checkout (JS-only changes never rebuild), otherwise
// trigger `eas build` on Expo's infrastructure and wait. Requires EXPO_TOKEN
// and an EAS-linked project (extra.eas.projectId) with a simulator profile in
// eas.json, e.g.:
//   "development-simulator": { "developmentClient": true, "distribution": "internal", "ios": { "simulator": true } }
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ensureDir, log } from './util.mjs'

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024, ...opts })
}

function easCommand() {
  if (run('eas', ['--version']).status === 0) return ['eas']
  // npx from outside the project — a repo's devEngines pin can break npx inside it
  return ['npx', '--yes', 'eas-cli']
}

// `eas … --json` still writes spinners/notices around the payload; take the
// outermost JSON value.
function parseJson(text, what) {
  const start = Math.min(...['[', '{'].map((c) => { const i = text.indexOf(c); return i === -1 ? Infinity : i }))
  if (!Number.isFinite(start)) throw new Error(`no JSON in eas output (${what}): ${text.slice(0, 300)}`)
  return JSON.parse(text.slice(start, Math.max(text.lastIndexOf(']'), text.lastIndexOf('}')) + 1))
}

export function fingerprintOf(projectDir) {
  // run from tmp so a devEngines pin inside the project can't break npx
  const r = run('npx', ['--yes', '@expo/fingerprint', path.resolve(projectDir)], { cwd: os.tmpdir() })
  if (r.status !== 0) { log('fingerprint failed (will build fresh):', (r.stderr || '').slice(-300)); return null }
  try { return parseJson(r.stdout, 'fingerprint').hash ?? null } catch { return null }
}

function artifactUrl(build) {
  return build?.artifacts?.applicationArchiveUrl ?? build?.artifacts?.buildUrl ?? null
}

function download(url, dest) {
  const r = run('curl', ['-fsSL', url, '-o', dest])
  if (r.status !== 0) throw new Error(`download failed: ${(r.stderr || '').slice(-300)}`)
}

function extractApp(archive, destDir) {
  ensureDir(destDir)
  if (/\.(tar\.gz|tgz)$/.test(archive)) {
    const r = run('tar', ['-xzf', archive, '-C', destDir])
    if (r.status !== 0) throw new Error(`extract failed: ${(r.stderr || '').slice(-300)}`)
  } else {
    fs.cpSync(archive, path.join(destDir, path.basename(archive)), { recursive: true })
  }
  const app = fs.readdirSync(destDir).find((f) => f.endsWith('.app'))
  if (!app) throw new Error(`no .app in EAS artifact (${fs.readdirSync(destDir).join(', ')})`)
  return path.join(destDir, app)
}

// Returns { appPath, reused, fingerprint, buildId }. Reuse is best-effort:
// any step of the fingerprint match failing falls through to a fresh build.
export function resolveApp({ projectDir, profile, workDir }) {
  if (!process.env.EXPO_TOKEN) throw new Error('EXPO_TOKEN not set — pass expo_token (or provide app_path / a prebuilt client)')
  const eas = easCommand()
  const cwdOpts = { cwd: projectDir, env: process.env }
  const dest = ensureDir(workDir)

  const fingerprint = fingerprintOf(projectDir)
  if (fingerprint) {
    const r = run(eas[0], [...eas.slice(1), 'build:list', '--platform', 'ios', '--status', 'finished',
      '--build-profile', profile, '--fingerprint-hash', fingerprint, '--limit', '1', '--json', '--non-interactive'], cwdOpts)
    if (r.status === 0) {
      try {
        const hit = parseJson(r.stdout, 'build:list')[0]
        const url = artifactUrl(hit)
        if (url) {
          log(`EAS: reusing build ${hit.id} (fingerprint ${fingerprint.slice(0, 12)})`)
          const archive = path.join(dest, 'client.tar.gz')
          download(url, archive)
          return { appPath: extractApp(archive, path.join(dest, 'client')), reused: true, fingerprint, buildId: hit.id }
        }
      } catch (e) { log('EAS reuse lookup failed (will build fresh):', e.message) }
    } else log('EAS build:list failed (will build fresh):', (r.stderr || r.stdout || '').slice(-300))
  }

  log(`EAS: no reusable build — building profile "${profile}" (this runs on EAS, not this runner)`)
  const b = run(eas[0], [...eas.slice(1), 'build', '--platform', 'ios', '--profile', profile,
    '--non-interactive', '--json', '--wait'], cwdOpts)
  if (b.status !== 0) throw new Error(`eas build failed: ${(b.stderr || b.stdout || '').slice(-800)}`)
  const build = [].concat(parseJson(b.stdout, 'build'))[0]
  const url = artifactUrl(build)
  if (!url) throw new Error(`eas build finished without an artifact URL (status ${build?.status})`)
  const archive = path.join(dest, 'client.tar.gz')
  download(url, archive)
  return { appPath: extractApp(archive, path.join(dest, 'client')), reused: false, fingerprint, buildId: build.id }
}
