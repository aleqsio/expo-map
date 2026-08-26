import { useCallback, useEffect, useMemo, useState } from 'react'
import { loadBundle, mergeBundles } from './loadBundle'

// A viewer session holds up to two bundles: the Map (a plain .scrmap) and the
// Changes overlay (a .diff.scrmap). When both describe the same app, Changes
// mode renders the overlay on top of the map's real captures.
//
// Sources, in priority order: ?map= / ?changes= URL params (CORS-fetched, for
// PR comment links), the /diffs route (ships the demo diff), the bundled demo
// map, and whatever the user drops or picks.

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

  const loadDemo = useCallback(async () => {
    setBusy(true)
    try {
      place(await fetchBundle('/demo.scrmap'))
    } catch (e) {
      setError(String(e.message ?? e))
    } finally {
      setBusy(false)
    }
  }, [place])

  // initial sources
  useEffect(() => {
    const params = new URLSearchParams(window.location.search)
    const mapUrl = params.get('map') ?? params.get('bundle')
    const changesUrl = params.get('changes') ?? params.get('diff')
    const onDiffsRoute = /^\/diffs\/?$/.test(window.location.pathname)
    ;(async () => {
      try {
        const head = await fetch('/demo.scrmap', { method: 'HEAD' })
        const type = head.headers.get('content-type') ?? ''
        const size = parseInt(head.headers.get('content-length') ?? '0', 10)
        const ok = head.ok && !type.includes('text/html') && (size > 10000 || /zip|octet-stream/.test(type))
        setDemoAvailable(ok)
        if (ok && !mapUrl) {
          const demo = await fetchBundle('/demo.scrmap')
          setPlain((cur) => cur ?? demo) // never clobber a user-opened bundle
        }
      } catch {}
      if (mapUrl) {
        setBusy(true)
        try {
          const b = await fetchBundle(mapUrl)
          if (b.diff) setChanges(b)
          else setPlain(b)
        } catch (e) {
          setError(String(e.message ?? e))
        } finally {
          setBusy(false)
        }
      }
      const diffUrl = changesUrl ?? (onDiffsRoute ? '/demo.diff.scrmap' : null)
      if (diffUrl) {
        try {
          const b = await fetchBundle(diffUrl)
          if (b.diff) {
            setChanges(b)
            setMode('changes')
          }
        } catch (e) {
          setError(String(e.message ?? e))
        }
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

  const merged = useMemo(
    () => (plain && changes && plain.manifest.app.name === changes.manifest.app.name ? mergeBundles(plain, changes) : null),
    [plain, changes]
  )

  // what the graph renders for the current mode
  const bundle = useMemo(() => {
    if (mode === 'changes' && changes) return merged ?? changes
    if (plain) return plain
    if (changes) {
      // Map view of a lone Changes bundle: the head graph, undecorated
      return { ...changes, diff: null, map: { ...changes.map, nodes: changes.map.nodes.filter((n) => n.diff?.status !== 'D') } }
    }
    return null
  }, [mode, plain, changes, merged])

  return {
    plain, changes, bundle, mode, setMode,
    hasChanges: !!changes, overlaid: !!merged,
    open, closeChanges, loadDemo, busy, error, demoAvailable, gen,
  }
}
