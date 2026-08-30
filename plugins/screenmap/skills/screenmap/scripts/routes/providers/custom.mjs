// custom — delegate route discovery to a command the project owns.
//
// This is the escape hatch that keeps the skill's "write your own parser" story
// first-class, and the way a new framework gets proven before it earns a
// provider module in this directory: prototype it as a command, and upstream it
// once the shape has survived contact with a real app.
//
//   .screenmap/config.json
//   { "routes": { "provider": "custom", "command": "node tools/my-parser.mjs" } }
//
// The command runs with CWD set to the project root and SCREENMAP_PROJECT_ROOT
// in the environment. It must print a JSON fragment on stdout:
//
//   { "routes": [ … ], "edges": [ … ], "layouts": [ … ] }
//
// Routes need at least `id` and `slug`; everything else the driver fills in.
// Anything written to stderr is passed through for debugging.

import { execSync } from 'node:child_process'

export const meta = {
  id: 'custom',
  title: 'Custom command',
  reach: 'unknown',
}

// Never auto-detected — opting in is the whole point.
export function detect() {
  return { score: 0, evidence: ['opt-in only: set routes.provider = "custom"'] }
}

export function parse(ctx) {
  const command = ctx.opts?.command ?? ctx.config?.command
  if (!command) {
    throw new Error(
      'routes.provider is "custom" but no routes.command is set in .screenmap/config.json'
    )
  }

  let stdout
  try {
    stdout = execSync(command, {
      cwd: ctx.projectRoot,
      env: { ...process.env, SCREENMAP_PROJECT_ROOT: ctx.projectRoot },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      maxBuffer: 64 * 1024 * 1024,
    })
  } catch (e) {
    throw new Error(`routes.command failed (${command}): ${e.message}`)
  }

  let fragment
  try {
    fragment = JSON.parse(stdout)
  } catch {
    throw new Error(
      `routes.command did not print JSON on stdout (${command}). ` +
      `Expected { "routes": [...], "edges": [...] }, got: ${stdout.slice(0, 200)}`
    )
  }
  if (!Array.isArray(fragment?.routes)) {
    throw new Error(`routes.command output has no "routes" array (${command})`)
  }
  return {
    command,
    layouts: fragment.layouts ?? [],
    routes: fragment.routes,
    edges: fragment.edges ?? [],
  }
}
