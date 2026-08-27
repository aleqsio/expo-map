import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadBundle, mergeBundles, sameApp } from './loadBundle'

// A viewer session holds up to two bundles: the Map (a plain .scrmap) and the
// Changes overlay (a .diff.scrmap). When both describe the same app, Changes
// mode renders the overlay on top of the map's real captures.
//
// Sources, in priority order: ?map= / ?changes= URL params (CORS-fetched, for
// PR comment links), ?template= for a named demo, the legacy /diffs route, and
// whatever the user drops or picks. Opening the bare page loads nothing: the
// viewer's job is the bundle you bring, so it starts on the drop screen.

// Named demos, so a link can hand someone a populated viewer without every
// bare visit loading one.
const TEMPLATES = {
  bluesky: { map: '/demo.scrmap', changes: '/demo.diff.scrmap' },
}

async function fetchBundle(url) {
  const res = await fetch(url)
  const type = res.headers.get('content-type') ?? ''
  if (!res.ok || type.includes('text/html')) throw new Error(`Couldn't load ${url} (${res.status})`)
  return loadBundle(await res.arrayBuffer())
}

export function useBundles() {
  const [plain, setPlain] = useState(null)
  const [changes, setChanges] = useState(null)
  const [mode, setMode] = useState('map') // 'map' | 'changes'
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [demoAvailable, setDemoAvailable] = useState(false)
  const [gen, setGen] = useState(0)

  const place = useCallback((loaded) => {
    if (loaded.diff) {
      setChanges(loaded)
      setMode('changes')
    } else {
      setPlain(loaded)
    }
    setGen((g) => g + 1)
  }, [])

  const open = useCallback(
    async (buffer) => {
      setBusy(true)
      try {
        place(await loadBundle(buffer))
        setError(null)
      } catch (e) {
        setError(String(e.message ?? e))
      } finally {
        setBusy(false)
      }
    },
    [place]
  )

  const closeChanges = useCallback(() => {
    setChanges(null)
    setMode('map')
    setGen((g) => g + 1)
  }, [])

  // The same pair and the same landing view as ?template=bluesky, so the button
  // and the link hand you an identical viewer. The diff is optional: if only
  // the map is deployed, you still get the map rather than an error.
  const loadDemo = useCallback(async () => {
    setBusy(true)
    try {
      const [map, diff] = await Promise.all([
        fetchBundle(TEMPLATES.bluesky.map),
        fetchBundle(TEMPLATES.bluesky.changes).catch(() => null),
      ])
      setPlain(map)
      if (diff?.diff) setChanges(diff)
      setMode('map')
      setGen((g) => g + 1)
      setError(null)
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [])

  // initial sources
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const mapUrl = params.get('map') ?? params.get('bundle')
    const changesUrl = params.get('changes') ?? params.get('diff')
    const template = TEMPLATES[params.get('template') ?? ''] ?? null
    // /diffs predates ?template= and is documented, so keep it pointed at the
    // same bundles. It differs only in landing on the overlay, which is what
    // the route name promises.
    const onDiffsRoute = /^\/diffs\/?$/.test(window.location.pathname)
    const named = template ?? (onDiffsRoute ? TEMPLATES.bluesky : null)

    const wantMap = mapUrl ?? named?.map ?? null
    const wantChanges = changesUrl ?? named?.changes ?? null
    // A template opens on the Map with Changes waiting behind the toggle. An
    // explicit ?changes= or /diffs link is asking for the overlay itself.
    const openOnChanges = !template
    ;(async () => {
      // Probe the demo so the landing can offer the button, without loading it.
      try {
        const head = await fetch('/demo.scrmap', { method: 'HEAD' })
        const type = head.headers.get('content-type') ?? ''
        const size = parseInt(head.headers.get('content-length') ?? '0', 10)
        setDemoAvailable(head.ok && !type.includes('text/html') && (size > 10000 || /zip|octet-stream/.test(type)))
      } catch {}

      if (!wantMap && !wantChanges) return // bare page: the drop screen

      setBusy(true)
      try {
        if (wantMap) {
          const b = await fetchBundle(wantMap)
          if (b.diff) setChanges(b)
          else setPlain((cur) => cur ?? b) // never clobber a bundle dropped meanwhile
        }
        if (wantChanges) {
          const b = await fetchBundle(wantChanges)
          if (b.diff) {
            setChanges(b)
            if (openOnChanges) setMode('changes')
          }
        }
      } catch (e) {
        setError(String(e.message ?? e))
      } finally {
        setBusy(false)
      }
    })()
  }, [])

  // drop a bundle anywhere — landing or over an open graph
  useEffect(() => {
    const over = (e) => e.preventDefault()
    const drop = async (e) => {
      if (e.defaultPrevented) return
      e.preventDefault()
      const f = e.dataTransfer?.files?.[0]
      if (f) open(await f.arrayBuffer())
    }
    document.addEventListener('dragover', over)
    document.addEventListener('drop', drop)
    return () => {
      document.removeEventListener('dragover', over)
      document.removeEventListener('drop', drop)
    }
  }, [open])

  // Is there a map to lay the overlay over? Only then does the Changes view get
  // the map's captures behind it; without one it still resolves what it can
  // from the diff's own base side.
  const overlaid = useMemo(() => !!(plain && changes && sameApp(plain, changes)), [plain, changes])
  const merged = useMemo(
    () => (changes ? mergeBundles(overlaid ? plain : null, changes) : null),
    [plain, changes, overlaid]
  )

  // what the graph renders for the current mode
  const bundle = useMemo(() => {
    if (mode === 'changes' && merged) return merged
    if (plain) return plain
    if (merged) {
      // Map view of a lone Changes bundle: the head graph, undecorated
      return { ...merged, diff: null, map: { ...merged.map, nodes: merged.map.nodes.filter((n) => n.diff?.status !== 'D') } }
    }
    return null
  }, [mode, plain, merged])

  return {
    plain, changes, bundle, mode, setMode,
    hasChanges: !!changes, overlaid,
    open, closeChanges, loadDemo, busy, error, demoAvailable, gen,
  }
}
