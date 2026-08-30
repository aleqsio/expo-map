#!/usr/bin/env node
// Snapshot tests for the route providers.
//
//   node fixtures/run-tests.mjs           # check every fixture against its snapshot
//   node fixtures/run-tests.mjs --update  # rewrite the snapshots after an intended change
//
// Each fixture pins both the provider that detection picks and the whole graph,
// so a change that silently re-routes a project to a different provider — or
// quietly drops a route — fails here rather than in someone's capture run.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PARSER = path.join(HERE, '..', 'plugins', 'screenmap', 'skills', 'screenmap', 'scripts', 'parse-routes.mjs')
const UPDATE = process.argv.includes('--update')

const FIXTURES = [
  { dir: 'demo-app', provider: 'expo-router' },
  { dir: 'rn-demo-app', provider: 'react-navigation' },
]

// generatedAt and projectRoot are machine- and clock-specific.
function stable(graph) {
  const { generatedAt, projectRoot, ...rest } = graph
  return rest
}

let failed = 0
for (const { dir, provider } of FIXTURES) {
  const root = path.join(HERE, dir)
  const out = path.join(root, '.screenmap', 'out', 'graph.json')
  let stderr = ''
  try {
    execFileSync('node', [PARSER, root, '--out', out], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    console.error(`FAIL ${dir}: parser exited ${e.status}\n${e.stderr ?? ''}`)
    failed++
    continue
  }
  const graph = stable(JSON.parse(fs.readFileSync(out, 'utf8')))
  fs.rmSync(path.join(root, '.screenmap'), { recursive: true, force: true })

  if (graph.mode !== provider) {
    console.error(`FAIL ${dir}: expected provider "${provider}", detection chose "${graph.mode}"`)
    failed++
    continue
  }

  const snapPath = path.join(HERE, dir, 'expected-graph.json')
  const actual = JSON.stringify(graph, null, 2) + '\n'
  if (UPDATE || !fs.existsSync(snapPath)) {
    fs.writeFileSync(snapPath, actual)
    console.log(`${UPDATE ? 'updated' : 'created'} ${dir}/expected-graph.json`)
    continue
  }
  if (fs.readFileSync(snapPath, 'utf8') !== actual) {
    console.error(`FAIL ${dir}: graph differs from expected-graph.json (re-run with --update if intended)`)
    const a = fs.readFileSync(snapPath, 'utf8').split('\n')
    const b = actual.split('\n')
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}:\n    expected: ${a[i] ?? '<eof>'}\n    actual:   ${b[i] ?? '<eof>'}`)
        break
      }
    }
    failed++
    continue
  }
  console.log(`ok   ${dir} — ${provider}, ${graph.routes.length} routes, ${graph.edges.length} edges`)
}

if (failed) {
  console.error(`\n${failed} fixture(s) failed`)
  process.exit(1)
}
console.log(`\nall ${FIXTURES.length} fixtures passed`)
