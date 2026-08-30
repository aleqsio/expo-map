#!/usr/bin/env node
// Static route + link extractor.
//
// This file is only the driver: it picks a route provider, runs it, and turns
// the fragment it returns into graph.json. The framework-specific knowledge
// lives in routes/providers/*.mjs — see docs/route-providers.md for the
// contract and how to add one.
//
// Usage:
//   node parse-routes.mjs [projectRoot] [--out <path>]
//                         [--provider <id>] [--detect] [--list-providers]
//
// Output: JSON graph (default <projectRoot>/.screenmap/out/graph.json)

import fs from 'node:fs'
import path from 'node:path'
import { createProjectCtx } from './routes/lib/project.mjs'
import { normalize, validate } from './routes/lib/graph.mjs'
import { PROVIDERS, select, detectAll, formatDetections } from './routes/registry.mjs'

const args = process.argv.slice(2)
let projectRoot = '.'
let outPath = null
let providerId = null
let detectOnly = false
for (let i = 0; i < args.length; i++) {
  const a = args[i]
  if (a === '--out') outPath = args[++i]
  else if (a === '--provider') providerId = args[++i]
  else if (a === '--detect') detectOnly = true
  else if (a === '--list-providers') {
    for (const p of PROVIDERS) console.log(`${p.meta.id.padEnd(18)} ${p.meta.title} (reach: ${p.meta.reach})`)
    process.exit(0)
  } else if (a === '--routes') {
    // legacy flag from the single-file react-navigation mode; the provider now
    // finds its own entry points
    i++
  } else projectRoot = a
}
projectRoot = path.resolve(projectRoot)
outPath = outPath ?? path.join(projectRoot, '.screenmap', 'out', 'graph.json')

const ctx = createProjectCtx(projectRoot)

// .screenmap/config.json → routes: { provider, command }. Read directly rather
// than through the CI config loader so the skill script stays dependency-free.
let routesConfig = {}
try {
  routesConfig = JSON.parse(
    fs.readFileSync(path.join(projectRoot, '.screenmap', 'config.json'), 'utf8')
  ).routes ?? {}
} catch {}

if (detectOnly) {
  console.log(formatDetections(detectAll(ctx)))
  process.exit(0)
}

let provider, detections, reason
try {
  ({ provider, detections, reason } = select(ctx, { provider: providerId, config: routesConfig }))
} catch (e) {
  console.error(`error: ${e.message}`)
  process.exit(1)
}

ctx.opts = { ...routesConfig }
ctx.config = routesConfig

let fragment
try {
  fragment = provider.parse(ctx)
} catch (e) {
  console.error(`error: ${provider.meta.id}: ${e.message}`)
  process.exit(1)
}

const { graph, orphans } = normalize(fragment, ctx, { provider })

const errs = validate(graph)
if (errs.length) {
  console.error(`error: ${provider.meta.id} produced an invalid graph:`)
  for (const e of errs) console.error(`  - ${e}`)
  process.exit(1)
}

fs.mkdirSync(path.dirname(outPath), { recursive: true })
fs.writeFileSync(outPath, JSON.stringify(graph, null, 2))
console.log(`wrote ${outPath}`)
console.log(JSON.stringify(graph.summary))

console.error(`provider: ${provider.meta.id} — ${reason}`)
if (detections.length > 1 && !providerId)
  console.error(formatDetections(detections.filter((d) => d.score > 0)))

// Screens with no URL are expected in navigator-driven frameworks; say how many
// so a map that is mostly tap-reachable does not look like a parse failure.
const navOnly = graph.routes.filter((r) => !r.urlPath)
if (navOnly.length)
  console.error(
    `note: ${navOnly.length} of ${graph.routes.length} route(s) have no deep link and must be reached by in-app navigation: ${navOnly.map((r) => r.id).join(', ')}`
  )

// A screen nothing links to is usually the parser missing the link, not the app
// missing the route — `href={item.href}` and other computed targets cannot be
// resolved statically. Say so, so a sparse map reads as a known limitation
// rather than as the truth about the app.
if (orphans.length)
  console.error(
    `note: ${orphans.length} route(s) have no incoming link and may just be links this parser cannot read (e.g. computed href): ${orphans.map((r) => r.urlPath ?? r.id).join(', ')}`
  )
