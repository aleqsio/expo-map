// The provider registry: which route producers exist, which one fits a
// project, and how a caller overrides that choice.
//
// Adding a framework means adding a module to providers/ and one line here.
// Nothing else in the pipeline needs to know it exists.

import * as expoRouter from './providers/expo-router.mjs'
import * as reactNavigation from './providers/react-navigation.mjs'
import * as custom from './providers/custom.mjs'

export const PROVIDERS = [expoRouter, reactNavigation, custom]

export const byId = (id) => PROVIDERS.find((p) => p.meta.id === id) ?? null

// Below this, a provider is guessing rather than recognising.
const MIN_SCORE = 0.4
// Two providers this close cannot be told apart from the filesystem alone.
const AMBIGUOUS_DELTA = 0.15

export function detectAll(ctx) {
  return PROVIDERS
    .map((p) => {
      let r
      try { r = p.detect(ctx) } catch (e) { r = { score: 0, evidence: [`detect failed: ${e.message}`] } }
      return { provider: p, id: p.meta.id, score: r.score ?? 0, evidence: r.evidence ?? [] }
    })
    .sort((a, b) => b.score - a.score)
}

// Returns { provider, detections, reason }. Throws with an actionable message
// when nothing fits or two providers tie — a run that silently picks the wrong
// producer costs a whole capture pass to discover.
export function select(ctx, { provider: explicit = null, config = {} } = {}) {
  const detections = detectAll(ctx)

  const forced = explicit ?? (config.provider && config.provider !== 'auto' ? config.provider : null)
  if (forced) {
    const p = byId(forced)
    if (!p) {
      throw new Error(
        `unknown route provider "${forced}" — expected ${PROVIDERS.map((x) => x.meta.id).join(' | ')}`
      )
    }
    return { provider: p, detections, reason: explicit ? 'requested with --provider' : 'set in .screenmap/config.json' }
  }

  const [top, second] = detections
  if (!top || top.score < MIN_SCORE) {
    throw new Error(
      `no route provider recognised this project.\n` +
      formatDetections(detections) +
      `\nSet routes.provider in .screenmap/config.json, or pass --provider <id>. ` +
      `To use your own parser: {"routes":{"provider":"custom","command":"node tools/my-parser.mjs"}}`
    )
  }
  if (second && top.score - second.score < AMBIGUOUS_DELTA) {
    throw new Error(
      `two route providers fit this project equally well.\n` +
      formatDetections(detections) +
      `\nPick one with --provider <id>, or set routes.provider in .screenmap/config.json.`
    )
  }
  return { provider: top.provider, detections, reason: `detected (score ${top.score.toFixed(2)})` }
}

export function formatDetections(detections) {
  return detections
    .map((d) => `  ${d.score.toFixed(2)}  ${d.id.padEnd(18)} ${d.evidence.join('; ') || '—'}`)
    .join('\n')
}
