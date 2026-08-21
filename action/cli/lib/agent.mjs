// The agent lane: Claude Code, headless, for screens no committed flow can
// reach. Layered guidance: the generic expo-map skill + the repo's own
// .appmap/SKILL.md. Budgeted, side-effect-free (writes only into the given
// out dirs), and it reports what it recorded so the baseline job can open a
// flows PR.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir, log, readJson } from './util.mjs'

export const SKILL_DIR = path.resolve(new URL('../../../skills/expo-map', import.meta.url).pathname)

export function claudeAvailable() {
  return spawnSync('claude', ['--version'], { encoding: 'utf8' }).status === 0
}

export function runAgent({ projectDir, config, screens, scheme, udid, bundleId, outScreensDir, outFlowsDir, notesPath, summaryPath, mode, prContext }) {
  if (!screens.length) return { ran: false, reason: 'nothing to explore' }
  if (!config.agent.enabled) return { ran: false, reason: 'agent disabled in .appmap/config.json' }
  if (!process.env.ANTHROPIC_API_KEY) return { ran: false, reason: 'ANTHROPIC_API_KEY not set' }
  if (!claudeAvailable()) return { ran: false, reason: 'claude CLI not installed' }
  ensureDir(outScreensDir); ensureDir(outFlowsDir)
  const budgeted = screens.slice(0, config.agent.maxScreens)
  const skipped = screens.slice(config.agent.maxScreens)
  const repoSkill = path.join(projectDir, config.skillFile)
  const repoSkillText = fs.existsSync(repoSkill) ? fs.readFileSync(repoSkill, 'utf8') : null

  const prompt = `You are running the expo-map skill's capture phases headlessly in CI (no simulator MCP — use \`xcrun simctl\` for deep links/screenshots and the \`argent\` CLI for taps/swipes: \`argent run <tool> …\` (\`argent tools\` lists them; if \`argent\` is not on PATH, run \`npx -y @swmansion/argent@0.21.0\` from a directory OUTSIDE the project, e.g. /tmp, because this repo's devEngines pin breaks npx inside it)). The app is already running on simulator ${udid} (bundle ${bundleId}, scheme ${scheme}://), Metro is up. Do not rebuild, reinstall, or checkout anything.

Read the skill at ${SKILL_DIR}/SKILL.md for conventions (capture naming, flow recording format, safety rules: never tap destructive/purchase/sign-out controls, never record credentials).
${repoSkillText ? `\nProject-specific guidance (.appmap/SKILL.md) — follow it:\n---\n${repoSkillText}\n---\n` : ''}
Task (${mode}): for EACH of these screens, capture the screen and record a replayable navigation flow.
${budgeted.map((s) => `- ${s.id}  urlPath=${s.urlPath}  slug=${s.slug}  deepLink=${s.deepLink}  file=${s.file ?? '?'}${s.reason ? `  why=${s.reason}` : ''}`).join('\n')}

Rules:
1. Screenshots go to ${outScreensDir}/<slug>.png (state variants: <slug>--<state>.png). Use exactly these slugs.
2. Flows go to ${outFlowsDir}/ as argent YAML + .meta.json sidecars (formatVersion 2) — nav-<slug> for the tap path from app launch (\`${scheme}://\`), visit-<slug> for the bare deep link, plus one flow per state variant you capture. Coordinates normalized 0–1 for a ${config.device}. Every sidecar MUST include \`"landmarks": [2–5 words visible on the arrival screen that identify it — titles/section headers/fixed labels, never live content]\`; CI verifies replays by OCR-ing for them.
3. Prefer the deep link first; if it shows an error/not-found, find real params (public API, other screens) and note what you used.
4. Write ${notesPath}: JSON { "<routeId>": "one sentence describing what this screen shows${mode === 'pr' ? ' / what visibly changed in this PR' : ''}" } for each screen you handled${mode === 'pr' ? ', or { "note": "...", "verdict": "unaffected" } if the PR diff shows no visible change there' : ''}.
5. Write ${summaryPath}: JSON { "captured": [routeIds], "skipped": [{ "id", "why" }], "flows": [flow names] } when done.
6. Budget: these ${budgeted.length} screens only. Be economical — no broad exploration.${prContext ? `\n\nPR context: ${prContext}` : ''}`

  const args = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text', '--add-dir', projectDir, '--add-dir', SKILL_DIR]
  if (config.agent.model) args.push('--model', config.agent.model)
  log(`agent: exploring ${budgeted.length} screen(s)${skipped.length ? `, ${skipped.length} over budget` : ''}`)
  const r = spawnSync('claude', args, { cwd: projectDir, encoding: 'utf8', env: process.env, maxBuffer: 64 * 1024 * 1024 })
  const summary = readJson(summaryPath, { captured: [], skipped: [], flows: [] })
  if (r.status !== 0) log('agent exited non-zero:', (r.stderr || '').slice(-500))
  return { ran: true, exit: r.status, summary, overBudget: skipped.map((s) => s.id), transcript: (r.stdout || '').slice(-4000) }
}
