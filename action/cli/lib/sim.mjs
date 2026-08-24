// iOS simulator + Metro driver. Everything here is `xcrun simctl` and a
// background Metro process — no MCP, no LLM, works on a macOS runner.
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { sh, shOk, sleep, log } from './util.mjs'
import { argentAvailable, argentRun, grantPermissions } from './argent.mjs'
import { ocr, ocrAvailable } from './ocr.mjs'

// iOS ≥18.3 gates simctl openurl for a custom scheme behind an
// "Open in …?" prompt. Pre-approving the scheme in LaunchServices skips it
// (the Detox/Maestro technique); harmless on versions without the prompt.
function approveScheme(udid, scheme, bundleId) {
  shOk('xcrun', ['simctl', 'spawn', udid, 'defaults', 'write', 'com.apple.launchservices.schemeapproval',
    `com.apple.CoreSimulator.CoreSimulatorBridge-->${scheme}`, '-string', bundleId])
}

// Belt-and-braces for the same prompt: OCR the screen and tap "Open".
function tapOpenPrompt(udid, projectDir) {
  if (!ocrAvailable()) return false
  const shot = path.join(projectDir, '.expo-map', 'ci', 'open-prompt.png')
  fs.mkdirSync(path.dirname(shot), { recursive: true })
  sh('xcrun', ['simctl', 'io', udid, 'screenshot', shot])
  const items = ocr(shot)
  if (!items.some((i) => /^open in/i.test(i.text.trim()))) return false
  const b = items.find((i) => /^open$/i.test(i.text.trim()))
  if (!b) return false
  // Vision boxes: normalized, origin bottom-left → argent taps: origin top-left
  const x = b.x + b.w / 2, y = 1 - (b.y + b.h / 2)
  const r = argentRun('gesture-tap', { udid, x: x.toFixed(4), y: y.toFixed(4) })
  log(`tapped "Open" on the scheme prompt (${r.ok ? 'ok' : 'tap failed'})`)
  return r.ok
}

export function listBooted() {
  const j = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'booted', '-j']))
  return Object.values(j.devices).flat().filter((d) => d.state === 'Booted')
}

export async function ensureBooted(deviceName) {
  const booted = listBooted()
  if (booted.length) { log(`simulator already booted: ${booted[0].name} (${booted[0].udid})`); return booted[0].udid }
  const j = JSON.parse(sh('xcrun', ['simctl', 'list', 'devices', 'available', '-j']))
  const all = Object.values(j.devices).flat()
  const pick = all.find((d) => d.name === deviceName) ?? all.find((d) => /iPhone/.test(d.name))
  if (!pick) throw new Error(`no available simulator (wanted "${deviceName}")`)
  log(`booting ${pick.name} (${pick.udid})`)
  sh('xcrun', ['simctl', 'boot', pick.udid])
  sh('xcrun', ['simctl', 'bootstatus', pick.udid, '-b'])
  return pick.udid
}

// presentation mode: identical clock/battery/signal on every capture, so
// base and head screenshots only differ where the app differs
export function freezeStatusBar(udid) {
  shOk('xcrun', ['simctl', 'status_bar', udid, 'override', '--time', '9:41', '--dataNetwork', 'wifi', '--wifiMode', 'active',
    '--wifiBars', '3', '--cellularMode', 'active', '--cellularBars', '4', '--batteryState', 'charged', '--batteryLevel', '100'])
}

export function findBuiltApp(projectDir) {
  const dirs = [
    path.join(projectDir, 'ios', 'build', 'Build', 'Products', 'Debug-iphonesimulator'),
    path.join(projectDir, 'ios', 'build', 'Build', 'Products', 'Release-iphonesimulator'),
  ]
  for (const d of dirs) {
    if (!fs.existsSync(d)) continue
    const app = fs.readdirSync(d).find((f) => f.endsWith('.app'))
    if (app) return path.join(d, app)
  }
  return null
}

export function bundleIdOf(appPath) {
  return sh('defaults', ['read', path.join(appPath, 'Info'), 'CFBundleIdentifier'])
}

export function installApp(udid, appPath) {
  sh('xcrun', ['simctl', 'install', udid, appPath])
}

export function terminate(udid, bundleId) { shOk('xcrun', ['simctl', 'terminate', udid, bundleId]) }
export function launch(udid, bundleId) { sh('xcrun', ['simctl', 'launch', udid, bundleId]) }
export function openUrl(udid, url) { sh('xcrun', ['simctl', 'openurl', udid, url]) }
export function screenshot(udid, outPath) {
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  freezeStatusBar(udid) // tooling in between (argent) can clear the override
  sh('xcrun', ['simctl', 'io', udid, 'screenshot', outPath])
}

// pre-grant privacy so a mis-tap can never summon a system permission dialog
// that then sits over every later capture (simctl + argent's TCC editor)
export function grantPrivacy(udid, bundleId) {
  shOk('xcrun', ['simctl', 'privacy', udid, 'grant', 'all', bundleId])
  if (argentAvailable()) { const g = grantPermissions(udid, bundleId); if (g.length) log(`pre-granted: ${g.join(', ')}`) }
}

// Metro in the background. Resolves `ready` when the server listens, and
// exposes `bundled` (first successful bundle) for the caller to await after
// launching the app.
export function startMetro(projectDir, port = 8081) {
  const cli = fs.existsSync(path.join(projectDir, 'node_modules', 'expo', 'bin', 'cli'))
    ? [path.join(projectDir, 'node_modules', 'expo', 'bin', 'cli'), 'start', '--port', String(port)]
    : null
  if (!cli) throw new Error('expo not installed in project (node_modules/expo missing)')
  const proc = spawn('node', cli, { cwd: projectDir, env: { ...process.env, CI: '1', EXPO_NO_TELEMETRY: '1' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = ''
  let readyRes, bundledRes
  const ready = new Promise((r) => (readyRes = r))
  const bundled = new Promise((r) => (bundledRes = r))
  const onData = (d) => {
    const s = d.toString()
    out += s
    if (/Waiting on http:\/\/localhost:\d+/.test(out)) readyRes(true)
    if (/Bundled\s|Bundling complete|\d+% \(\d+\/\d+\)/.test(out) && /Bundled\s|Bundling complete/.test(out)) bundledRes(true)
    if (/(^|\n)\s*(error|Error|ERROR)/.test(s)) log('metro:', s.trim().slice(0, 300))
  }
  proc.stdout.on('data', onData)
  proc.stderr.on('data', onData)
  proc.on('exit', (code) => { log(`metro exited (${code})`); readyRes(false); bundledRes(false) })
  const stop = () => { try { proc.kill('SIGTERM') } catch {} }
  return { proc, ready, bundled, stop, output: () => out }
}

export async function waitFor(promise, ms, label) {
  const t = await Promise.race([promise, sleep(ms).then(() => 'timeout')])
  if (t === 'timeout') throw new Error(`timed out waiting for ${label} (${ms}ms)`)
  return t
}

// Boot the whole stack: simulator, app, Metro, first bundle. Returns a
// session with capture helpers; call session.close() at the end.
export async function openSession({ projectDir, config, scheme }) {
  const udid = await ensureBooted(config.device)
  freezeStatusBar(udid)
  const appPath = config.appPath ?? findBuiltApp(projectDir)
  if (!appPath) throw new Error('no built dev client found under ios/build — build it first (expo run:ios --no-bundler)')
  const bundleId = config.bundleId ?? bundleIdOf(appPath)
  installApp(udid, appPath)
  grantPrivacy(udid, bundleId)
  approveScheme(udid, scheme, bundleId)
  const metro = startMetro(projectDir, config.metroPort)
  await waitFor(metro.ready, 120000, 'Metro to start')
  terminate(udid, bundleId)
  await sleep(800)
  launch(udid, bundleId)
  await sleep(3000)
  // the dev client opens on its launcher; a deep link routes it to Metro.
  // Re-nudge every 15s — a cold simulator sometimes swallows the first one.
  // expo-dev-client's connect URL loads a specific Metro without a tap.
  const connectUrl = `${scheme}://expo-development-client/?url=${encodeURIComponent(`http://localhost:${config.metroPort}`)}`
  const deadline = Date.now() + 300000
  let bundledOk = false
  let nudges = 0
  while (Date.now() < deadline) {
    // after a few foreground nudges, cold-start into the link instead: openurl
    // on a terminated app launches it straight into the deep link, skipping
    // any launcher race
    if (nudges > 0 && nudges % 3 === 0) { try { terminate(udid, bundleId) } catch {}; await sleep(800) }
    openUrl(udid, connectUrl)
    nudges++
    const r = await Promise.race([metro.bundled, sleep(15000).then(() => 'tick')])
    if (r === true) { bundledOk = true; break }
    if (r === false) break
    log('waiting for the first JS bundle…')
    try { tapOpenPrompt(udid, projectDir) } catch {}
  }
  if (!bundledOk) {
    log('metro tail:\n' + metro.output().split('\n').slice(-25).join('\n'))
    try {
      const diagDir = path.join(projectDir, '.expo-map', 'ci', 'diag')
      fs.mkdirSync(diagDir, { recursive: true })
      sh('xcrun', ['simctl', 'io', udid, 'screenshot', path.join(diagDir, 'connect-timeout.png')])
      fs.writeFileSync(path.join(diagDir, 'metro.log'), metro.output())
      fs.writeFileSync(path.join(diagDir, 'listapps.txt'), sh('xcrun', ['simctl', 'listapps', udid]))
      let status = 'curl failed'
      try { status = sh('curl', ['-s', '-m', '5', `http://localhost:${config.metroPort}/status`]) } catch {}
      fs.writeFileSync(path.join(diagDir, 'metro-status.txt'), status)
      log('connect diagnostics written to', diagDir)
    } catch (e) { log('diagnostics failed:', e.message) }
    metro.stop()
    throw new Error('timed out waiting for first JS bundle')
  }
  await sleep(config.waits.boot)
  log(`session ready: ${bundleId} on ${udid}, Metro :${config.metroPort}`)
  const deviceName = listBooted().find((d) => d.udid === udid)?.name ?? config.device
  let firstVisit = true
  return {
    udid, bundleId, scheme, config, deviceName,
    async visit(url, outPath, waitMs) {
      openUrl(udid, url)
      await sleep(waitMs ?? config.waits.transition)
      // dev builds often show a one-off toast right after the bundle loads;
      // give the very first capture extra time to settle
      if (firstVisit) { await sleep(config.waits.settle ?? 6000); firstVisit = false }
      screenshot(udid, outPath)
      return outPath
    },
    async relaunch() {
      terminate(udid, bundleId); await sleep(800); launch(udid, bundleId); await sleep(4000)
      firstVisit = true // dev builds re-show their load-time toast after a relaunch
    },
    close() { metro.stop() },
  }
}
