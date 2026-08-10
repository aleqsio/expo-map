// Region-aware visual diff for the hover comparator on changed screens.
//
// pixelmatch produces the perceptual change mask (anti-aliasing ignored);
// OpenCV.js (lazy-loaded WASM) clusters the mask into islands via connected
// components, then template-matches each island's BASE content inside a HEAD
// search window to tell apart:
//   moved   — same pixels, new place  → cyan box at the new spot, dashed box
//             where it came from, arrow between them
//   changed — content actually differs → red box, changed pixels tinted red
// Falls back to a plain red per-pixel render if OpenCV fails to load.
import pixelmatch from 'pixelmatch'

const cache = new Map()
let cvPromise = null
const loadCv = () => (cvPromise ??= import('@techstark/opencv-js').then((m) => m.default))

const MIN_ISLAND_AREA = 60 // mask px after dilation — below this it's noise
const SEARCH_PAD = 90 // how far a region is allowed to have moved (px)
const MATCH_SCORE = 0.88 // TM_CCOEFF_NORMED acceptance
const MATCH_MARGIN = 0.12 // must beat the stay-in-place correlation by this much
const MIN_SHIFT = 4 // px — smaller offsets count as changed-in-place
const MIN_TEXTURE = 12 // grayscale stddev — flat/small patches match anywhere

function loadImage(url) {
  return new Promise((res, rej) => {
    const i = new Image()
    i.onload = () => res(i)
    i.onerror = rej
    i.src = url
  })
}

// { url, moved, changed } — url is a rendered dataURL overlay
export function visualDiff(headUrl, baseUrl) {
  const key = `${headUrl}|${baseUrl}`
  if (cache.has(key)) return cache.get(key)
  const p = compute(headUrl, baseUrl).catch((e) => {
    console.warn('visualDiff falling back to per-pixel render:', e)
    return fallback(headUrl, baseUrl)
  })
  cache.set(key, p)
  return p
}

async function compute(headUrl, baseUrl) {
  const [head, base] = await Promise.all([loadImage(headUrl), loadImage(baseUrl)])
  const w = Math.min(head.naturalWidth, base.naturalWidth)
  const h = Math.min(head.naturalHeight, base.naturalHeight)
  const ctxOf = (img) => {
    const c = document.createElement('canvas')
    c.width = w
    c.height = h
    const ctx = c.getContext('2d', { willReadFrequently: true })
    ctx.drawImage(img, 0, 0, w, h)
    return ctx
  }
  const headCtx = ctxOf(head)
  const baseCtx = ctxOf(base)
  const headData = headCtx.getImageData(0, 0, w, h)
  const baseData = baseCtx.getImageData(0, 0, w, h)

  const maskData = new ImageData(w, h)
  pixelmatch(baseData.data, headData.data, maskData.data, w, h, {
    threshold: 0.12,
    includeAA: false,
    diffMask: true, // only diff pixels are drawn → alpha channel IS the mask
  })

  const cv = await loadCv()
  const islands = []
  // cluster the mask into islands
  const maskMat = cv.matFromImageData(maskData)
  const gray = new cv.Mat()
  cv.cvtColor(maskMat, gray, cv.COLOR_RGBA2GRAY)
  cv.threshold(gray, gray, 1, 255, cv.THRESH_BINARY)
  const kernel = cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9))
  const fused = new cv.Mat()
  cv.dilate(gray, fused, kernel)
  const labels = new cv.Mat()
  const stats = new cv.Mat()
  const centroids = new cv.Mat()
  const n = cv.connectedComponentsWithStats(fused, labels, stats, centroids)
  const changedFraction = cv.countNonZero(gray) / (w * h)
  const headGray = cv.matFromImageData(headData)
  const baseGray = cv.matFromImageData(baseData)
  cv.cvtColor(headGray, headGray, cv.COLOR_RGBA2GRAY)
  cv.cvtColor(baseGray, baseGray, cv.COLOR_RGBA2GRAY)

  for (let i = 1; i < n; i++) {
    const s = stats.data32S.subarray(i * 5, i * 5 + 5)
    const [x, y, bw, bh, area] = s
    if (area < MIN_ISLAND_AREA) continue
    const island = { x, y, w: bw, h: bh, kind: 'changed', dx: 0, dy: 0 }
    // motion analysis is pointless when most of the screen changed, and
    // template matching on huge islands is slow — treat those as changed
    const feasible = changedFraction < 0.5 && bw * bh < w * h * 0.35 && bw > 16 && bh > 10
    if (feasible) {
      const sx = Math.max(0, x - SEARCH_PAD)
      const sy = Math.max(0, y - SEARCH_PAD)
      const sw = Math.min(w, x + bw + SEARCH_PAD) - sx
      const sh = Math.min(h, y + bh + SEARCH_PAD) - sy
      const templ = baseGray.roi(new cv.Rect(x, y, bw, bh))
      const mean = new cv.Mat()
      const stddev = new cv.Mat()
      cv.meanStdDev(templ, mean, stddev)
      const texture = stddev.data64F[0]
      mean.delete(); stddev.delete()
      if (texture >= MIN_TEXTURE) {
        const search = headGray.roi(new cv.Rect(sx, sy, sw, sh))
        const result = new cv.Mat()
        cv.matchTemplate(search, templ, result, cv.TM_CCOEFF_NORMED)
        const mm = cv.minMaxLoc(result)
        const dx = sx + mm.maxLoc.x - x
        const dy = sy + mm.maxLoc.y - y
        // "moved" needs a confident match that clearly BEATS staying put —
        // otherwise textured-but-generic patches (avatar rows) match anywhere
        const stayScore = result.data32F[(y - sy) * result.cols + (x - sx)] ?? -1
        if (
          mm.maxVal >= MATCH_SCORE &&
          mm.maxVal - stayScore >= MATCH_MARGIN &&
          Math.abs(dx) + Math.abs(dy) >= MIN_SHIFT
        ) {
          island.kind = 'moved'
          island.dx = dx
          island.dy = dy
        }
        search.delete(); result.delete()
      }
      templ.delete()
    }
    islands.push(island)
  }
  for (const m of [maskMat, gray, kernel, fused, labels, stats, centroids, headGray, baseGray]) m.delete()

  // merge overlapping/touching same-kind boxes so fragmented regions read as one
  const overlaps = (a, b, pad) =>
    a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad
  let merged = true
  while (merged) {
    merged = false
    outer: for (let i = 0; i < islands.length; i++) {
      for (let j = i + 1; j < islands.length; j++) {
        const a = islands[i]
        const b = islands[j]
        if (a.kind !== b.kind || !overlaps(a, b, 8)) continue
        if (a.kind === 'moved' && (Math.abs(a.dx - b.dx) > 6 || Math.abs(a.dy - b.dy) > 6)) continue
        const x2 = Math.max(a.x + a.w, b.x + b.w)
        const y2 = Math.max(a.y + a.h, b.y + b.h)
        a.x = Math.min(a.x, b.x)
        a.y = Math.min(a.y, b.y)
        a.w = x2 - a.x
        a.h = y2 - a.y
        islands.splice(j, 1)
        merged = true
        break outer
      }
    }
  }

  // a moved island's destination box already marks its landing spot — drop
  // changed islands whose center sits inside one (they're the same event)
  const movedDests = islands.filter((r) => r.kind === 'moved').map((r) => ({ x: r.x + r.dx, y: r.y + r.dy, w: r.w, h: r.h }))
  const covered = (r) => {
    const cx = r.x + r.w / 2
    const cy = r.y + r.h / 2
    return movedDests.some((d) => cx >= d.x && cx <= d.x + d.w && cy >= d.y && cy <= d.y + d.h)
  }
  for (let i = islands.length - 1; i >= 0; i--) {
    if (islands[i].kind === 'changed' && covered(islands[i])) islands.splice(i, 1)
  }

  // ---- render: dimmed grayscale head + island annotations ----
  const out = document.createElement('canvas')
  out.width = w
  out.height = h
  const ctx = out.getContext('2d')
  ctx.filter = 'grayscale(1) brightness(0.5)'
  ctx.drawImage(head, 0, 0, w, h)
  ctx.filter = 'none'

  // red tint for genuinely-changed pixels — only inside changed islands, so
  // the annotation layer stays quiet everywhere else
  const tint = new ImageData(w, h)
  const changedRects = islands.filter((r) => r.kind === 'changed')
  const inChanged = (px, py) =>
    changedRects.some((r) => px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h)
  for (let i = 0; i < maskData.data.length; i += 4) {
    if (maskData.data[i + 3] === 0) continue
    const px = (i / 4) % w
    const py = Math.floor(i / 4 / w)
    if (!inChanged(px, py)) continue
    tint.data[i] = 248; tint.data[i + 1] = 56; tint.data[i + 2] = 56; tint.data[i + 3] = 230
  }
  const tintCanvas = document.createElement('canvas')
  tintCanvas.width = w
  tintCanvas.height = h
  tintCanvas.getContext('2d').putImageData(tint, 0, 0)
  ctx.drawImage(tintCanvas, 0, 0)

  const L = Math.max(1.5, w / 260) // line weight scales with capture size
  let moved = 0
  let changed = 0
  for (const r of islands) {
    if (r.kind === 'moved') {
      moved++
      // dashed box where it was, solid box where it is now, arrow between
      const nx = r.x + r.dx
      const ny = r.y + r.dy
      ctx.strokeStyle = 'rgba(103,232,249,0.55)'
      ctx.lineWidth = L
      ctx.setLineDash([5, 4])
      ctx.strokeRect(r.x, r.y, r.w, r.h)
      ctx.setLineDash([])
      ctx.strokeStyle = '#67e8f9'
      ctx.strokeRect(nx, ny, r.w, r.h)
      const cx1 = r.x + r.w / 2
      const cy1 = r.y + r.h / 2
      const cx2 = nx + r.w / 2
      const cy2 = ny + r.h / 2
      const ang = Math.atan2(cy2 - cy1, cx2 - cx1)
      const headLen = 5 * L
      ctx.beginPath()
      ctx.moveTo(cx1, cy1)
      ctx.lineTo(cx2, cy2)
      ctx.stroke()
      ctx.beginPath()
      ctx.moveTo(cx2, cy2)
      ctx.lineTo(cx2 - headLen * Math.cos(ang - 0.4), cy2 - headLen * Math.sin(ang - 0.4))
      ctx.lineTo(cx2 - headLen * Math.cos(ang + 0.4), cy2 - headLen * Math.sin(ang + 0.4))
      ctx.closePath()
      ctx.fillStyle = '#67e8f9'
      ctx.fill()
    } else {
      changed++
      ctx.strokeStyle = 'rgba(248,113,113,0.9)'
      ctx.lineWidth = L
      ctx.strokeRect(r.x, r.y, r.w, r.h)
    }
  }
  return { url: out.toDataURL(), moved, changed }
}

// per-pixel red render — used when OpenCV can't load
async function fallback(headUrl, baseUrl) {
  const [head, base] = await Promise.all([loadImage(headUrl), loadImage(baseUrl)])
  const w = Math.min(head.naturalWidth, base.naturalWidth)
  const h = Math.min(head.naturalHeight, base.naturalHeight)
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const ctx = c.getContext('2d', { willReadFrequently: true })
  ctx.drawImage(head, 0, 0, w, h)
  const hd = ctx.getImageData(0, 0, w, h)
  ctx.clearRect(0, 0, w, h)
  ctx.drawImage(base, 0, 0, w, h)
  const bd = ctx.getImageData(0, 0, w, h)
  const mask = new ImageData(w, h)
  const count = pixelmatch(bd.data, hd.data, mask.data, w, h, { threshold: 0.12, includeAA: false, diffMask: true })
  ctx.filter = 'grayscale(1) brightness(0.5)'
  ctx.drawImage(head, 0, 0, w, h)
  ctx.filter = 'none'
  const mc = document.createElement('canvas')
  mc.width = w
  mc.height = h
  mc.getContext('2d').putImageData(mask, 0, 0)
  ctx.drawImage(mc, 0, 0)
  return { url: c.toDataURL(), moved: 0, changed: count > 0 ? 1 : 0 }
}
