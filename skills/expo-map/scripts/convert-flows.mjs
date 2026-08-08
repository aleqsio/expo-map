#!/usr/bin/env node
// Converts legacy v1 JSON flows into argent flow YAML (+ .meta.json sidecar).
// Argent (argent.swmansion.com) is the canonical replay format: flows become
// runnable via `argent flow run` with no LLM in the loop. The sidecar carries
// what argent doesn't model — route ids, per-step screen hops, capture files,
// and human target labels — which the visualiser needs for cartography.
//
// Usage: node convert-flows.mjs <project> [--point-size 402x874] [--delete-v1]

import fs from 'node:fs'
import path from 'node:path'

const args = process.argv.slice(2)
let projectRoot = '.'
let pointSize = [402, 874]
let deleteV1 = false
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--point-size') pointSize = args[++i].split('x').map(Number)
  else if (args[i] === '--delete-v1') deleteV1 = true
  else projectRoot = args[i]
}
const flowsDir = path.join(path.resolve(projectRoot), '.expo-map', 'flows')

const yq = (s) => `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const norm = (v, axis) => Math.round((v / pointSize[axis]) * 10000) / 10000

let converted = 0
for (const file of fs.readdirSync(flowsDir).filter((f) => f.endsWith('.json') && !f.endsWith('.meta.json'))) {
  const v1 = JSON.parse(fs.readFileSync(path.join(flowsDir, file), 'utf8'))
  const pt = v1.pointSize ?? pointSize
  const lines = [`# ${v1.title ?? v1.name}`, 'steps:']
  const meta = {
    formatVersion: 2,
    name: v1.name,
    title: v1.title ?? v1.name,
    route: v1.route ?? null,
    device: v1.device ?? null,
    recordedAt: v1.recordedAt ?? null,
    steps: {},
  }
  let yi = -1 // index of the last emitted YAML step
  const metaFor = (i) => (meta.steps[i] ??= {})

  for (const st of v1.steps ?? []) {
    if (st.action === 'open_url') {
      lines.push(`  - tool: open-url`, `    args:`, `      url: ${yq(st.url)}`)
      yi++
    } else if (st.action === 'wait') {
      lines.push(`  - wait: ${Math.round((st.seconds ?? 1) * 1000)}`)
      yi++
    } else if (st.action === 'tap') {
      if (st.target) lines.push(`  # ${st.target}`)
      const [x, y] = st.coordinate ?? [0, 0]
      lines.push(`  - tap: { x: ${Math.round((x / pt[0]) * 10000) / 10000}, y: ${Math.round((y / pt[1]) * 10000) / 10000} }`)
      yi++
      const m = metaFor(yi)
      if (st.target) m.target = st.target
      if (st.screen) m.screen = st.screen
      if (st.note) m.note = st.note
    } else if (st.action === 'swipe') {
      if (st.note) lines.push(`  # ${st.note}`)
      const [fx, fy] = st.from ?? [0, 0]
      const [tx, ty] = st.to ?? [0, 0]
      lines.push(
        `  - tool: gesture-swipe`,
        `    args: { fromX: ${Math.round((fx / pt[0]) * 10000) / 10000}, fromY: ${Math.round((fy / pt[1]) * 10000) / 10000}, toX: ${Math.round((tx / pt[0]) * 10000) / 10000}, toY: ${Math.round((ty / pt[1]) * 10000) / 10000} }`
      )
      yi++
      const m = metaFor(yi)
      if (st.screen) m.screen = st.screen
      if (st.note) m.note = st.note
    } else if (st.action === 'screenshot') {
      // captures are a mapping concern, not a replay step — sidecar only
      if (yi >= 0 && st.file) metaFor(yi).capture = st.file
      else if (st.file) (meta.captures ??= []).push(st.file)
    } else if (st.action === 'type') {
      lines.push(`  - type: { into: ${yq(st.target ?? '')}, text: ${yq(st.text ?? '')} }`)
      yi++
    }
  }
  if (v1.result) meta.result = v1.result

  const base = v1.name ?? file.replace(/\.json$/, '')
  fs.writeFileSync(path.join(flowsDir, `${base}.yaml`), lines.join('\n') + '\n')
  fs.writeFileSync(path.join(flowsDir, `${base}.meta.json`), JSON.stringify(meta, null, 2))
  if (deleteV1) fs.rmSync(path.join(flowsDir, file))
  converted++
}
console.log(`converted ${converted} flows to argent YAML + sidecars in ${flowsDir}`)
