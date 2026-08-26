// Render the PR-comment image: serve the two bundles from a throwaway local
// server (CORS-open; https viewer → http://localhost is allowed by Chrome),
// open the hosted visualiser in headless Chrome with ?shot, wait for the
// viewer's readiness flag, screenshot. No vite build on the runner, and it
// works for private repos too — the bundles never leave the machine.
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { log } from './util.mjs'

function findChrome() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  for (const bin of ['google-chrome', 'chromium', 'chromium-browser']) {
    const r = spawnSync('which', [bin], { encoding: 'utf8' })
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

function serveFiles(files) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const file = files[decodeURIComponent(req.url.slice(1))]
      if (!file) { res.writeHead(404); res.end(); return }
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/zip' })
      fs.createReadStream(file).pipe(res)
    })
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }))
  })
}

export async function takeShot({ mapFile, changesFile, out, viewer = 'https://app.screenmap.dev', width = 1500, height = 940 }) {
  const chrome = findChrome()
  if (!chrome) throw new Error('no Chrome found for the comment image (set CHROME_PATH)')
  const files = { 'base.scrmap': mapFile }
  if (changesFile) files['changes.diff.scrmap'] = changesFile
  for (const f of Object.values(files)) if (!fs.existsSync(f)) throw new Error(`missing bundle: ${f}`)
  const server = await serveFiles(files)
  const { default: puppeteer } = await import('puppeteer-core')
  const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox', '--force-color-profile=srgb'] })
  try {
    const params = new URLSearchParams()
    params.set('map', `http://localhost:${server.port}/base.scrmap`)
    if (changesFile) params.set('changes', `http://localhost:${server.port}/changes.diff.scrmap`)
    params.set('shot', changesFile ? 'changed' : 'all')
    const url = `${viewer}/?${params}`
    const page = await browser.newPage()
    await page.setViewport({ width, height, deviceScaleFactor: 2 })
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 })
    await page.waitForFunction('window.__screenmapShotReady === true', { timeout: 90000 })
    // crop to the framed nodes (plus breathing room), clamped to the viewport
    const b = await page.evaluate('window.__screenmapShotBounds')
    const clip = b
      ? (() => {
          const m = 28
          const x = Math.max(0, b.x - m), y = Math.max(0, b.y - m)
          return { x, y, width: Math.min(width - x, b.width + 2 * m), height: Math.min(height - y, b.height + 2 * m + 24) } // +24 for the route label row
        })()
      : undefined
    await page.screenshot({ path: out, clip })
    log(`comment image rendered → ${out}`)
    return out
  } finally {
    await browser.close().catch(() => {})
    server.close()
  }
}
