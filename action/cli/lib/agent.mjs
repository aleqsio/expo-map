// The agent lane: a headless coding agent for screens no committed flow can
// reach. Provider-agnostic — the contract is file-based (the agent writes
// captures, flows, notes.json and summary.json to the paths we hand it), so
// any agentic CLI that can run shell commands fills the slot. Layered
// guidance: the generic screenmap skill + the repo's own .screenmap/SKILL.md.
// Budgeted, side-effect-free (writes only into the given out dirs), and it
// reports what it recorded so the baseline job can open a flows PR.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { PROVIDER_KEY_ENVS, ensureDir, log, readJson } from './util.mjs'

export const SKILL_DIR = path.resolve(new URL('../../../plugins/screenmap/skills/screenmap', import.meta.url).pathname)

// Each preset knows how to invoke its CLI headlessly with full permissions
// (the runner is disposable) and which env var carries its key. `pkg` is the
// npm package the Action installs on demand.
export const PROVIDERS = {
  claude: {
    bin: 'claude', pkg: '@anthropic-ai/claude-code', keyEnv: PROVIDER_KEY_ENVS.claude,
    args: ({ prompt, model, projectDir }) => {
      const a = ['-p', prompt, '--dangerously-skip-permissions', '--output-format', 'text', '--add-dir', projectDir, '--add-dir', SKILL_DIR]
      if (model) a.push('--model', model)
      return a
    },
  },
  codex: {
    bin: 'codex', pkg: '@openai/codex', keyEnv: PROVIDER_KEY_ENVS.codex,
    args: ({ prompt, model }) => {
      const a = ['exec', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']
      if (model) a.push('-m', model)
      a.push(prompt)
      return a
    },
  },
  gemini: {
    bin: 'gemini', pkg: '@google/gemini-cli', keyEnv: PROVIDER_KEY_ENVS.gemini,
    args: ({ prompt, model }) => {
      const a = ['--yolo', '-p', prompt]
      if (model) a.unshift('-m', model)
      return a
    },
  },
  opencode: {
    bin: 'opencode', pkg: 'opencode-ai', keyEnv: PROVIDER_KEY_ENVS.opencode, // auth is per configured provider — bring your own env
    args: ({ prompt, model }) => {
      const a = ['run']
      if (model) a.push('--model', model)
      a.push(prompt)
      return a
    },
  },
}

// AGENT_PROVIDER env (set by the Action input) beats config.agent.provider;
// a config.agent.command template turns the lane into "run whatever you want".
export function resolveProvider(config) {
  if (config.agent.command) {
    return { name: 'custom', custom: config.agent.command, keyEnv: config.agent.keyEnv ?? null }
  }
  const name = process.env.AGENT_PROVIDER || config.agent.provider || 'claude'
  const preset = PROVIDERS[name]
  if (!preset) return { name, error: `unknown agent provider "${name}" (${Object.keys(PROVIDERS).join(' | ')} or agent.command in .screenmap/config.json)` }
  return { name, ...preset, keyEnv: config.agent.keyEnv ?? preset.keyEnv }
}

export function providerAvailable(p) {
  if (p.custom) return true // arbitrary shell — trust the config
  const r = spawnSync(p.bin, ['--version'], { encoding: 'utf8' })
  return r.status === 0 || !!(r.stdout || '').trim()
}

// Map the generic AGENT_API_KEY secret onto whatever env var the chosen
// provider reads, without clobbering an explicitly-set one.
function providerEnv(p) {
  const env = { ...process.env }
  if (p.keyEnv && !env[p.keyEnv] && env.AGENT_API_KEY) env[p.keyEnv] = env.AGENT_API_KEY
  return env
}

// provider + key presence for reporting (comment footer), without running
export function agentInfo(config) {
  const p = resolveProvider(config)
  if (p.error) return { provider: p.name ?? null, keyEnv: null, hasKey: false }
  const env = providerEnv(p)
  return { provider: p.custom ? 'custom command' : p.name, keyEnv: p.keyEnv ?? null, hasKey: p.keyEnv ? !!env[p.keyEnv] : null }
}

export function runAgent({ projectDir, config, screens, scheme, udid, bundleId, outScreensDir, outFlowsDir, notesPath, summaryPath, mode, prContext }) {
  const info = agentInfo(config)
  if (!screens.length) return { ran: false, reason: 'nothing to explore', ...info }
  if (!config.agent.enabled) return { ran: false, reason: config.effort === 'deterministic' ? 'effort=deterministic — flows replay, nothing is re-checked' : 'agent disabled in .screenmap/config.json', ...info }
  const provider = resolveProvider(config)
  if (provider.error) return { ran: false, reason: provider.error, ...info }
  const env = providerEnv(provider)
  if (provider.keyEnv && !env[provider.keyEnv]) return { ran: false, reason: `${provider.keyEnv} (or AGENT_API_KEY) not set`, ...info }
  if (!providerAvailable(provider)) return { ran: false, reason: `${provider.bin} CLI not installed`, ...info }
  ensureDir(outScreensDir); ensureDir(outFlowsDir)
  const budgeted = screens.slice(0, config.agent.maxScreens)
  const skipped = screens.slice(config.agent.maxScreens)
  const repoSkill = path.join(projectDir, config.skillFile)
  const repoSkillText = fs.existsSync(repoSkill) ? fs.readFileSync(repoSkill, 'utf8') : null

  const prompt = `You are running the screenmap skill's capture phases headlessly in CI (no simulator MCP — use \`xcrun simctl\` for deep links/screenshots and the \`argent\` CLI for taps/swipes: \`argent run <tool> …\` (\`argent tools\` lists them; if \`argent\` is not on PATH, run \`npx -y @swmansion/argent@0.21.0\` from a directory OUTSIDE the project, e.g. /tmp, because this repo's devEngines pin breaks npx inside it)). The app is already running on simulator ${udid} (bundle ${bundleId}, scheme ${scheme}://), Metro is up. Do not rebuild, reinstall, or checkout anything.

Read the skill at ${SKILL_DIR}/SKILL.md for conventions (capture naming, flow recording format, safety rules: never tap destructive/purchase/sign-out controls, never record credentials). The project lives at ${projectDir}. All output paths below are absolute — write to them exactly.
${repoSkillText ? `\nProject-specific guidance (.screenmap/SKILL.md) — follow it:\n---\n${repoSkillText}\n---\n` : ''}
Task (${mode}): for EACH of these screens, capture the screen and record a replayable navigation flow.
${budgeted.map((s) => `- ${s.id}  urlPath=${s.urlPath}  slug=${s.slug}  deepLink=${s.deepLink}  file=${s.file ?? '?'}${s.reason ? `  why=${s.reason}` : ''}`).join('\n')}

Rules:
1. Screenshots go to ${outScreensDir}/<slug>.png (state variants: <slug>--<state>.png). Use exactly these slugs.
2. Flows go to ${outFlowsDir}/ as argent YAML + .meta.json sidecars (formatVersion 2) — nav-<slug> for the tap path from app launch (\`${scheme}://\`), visit-<slug> for the bare deep link, plus one flow per state variant you capture. Coordinates normalized 0–1 for a ${config.device}. Every sidecar MUST include \`"landmarks": [2–5 words visible on the arrival screen that identify it — titles/section headers/fixed labels, never live content]\`; CI verifies replays by OCR-ing for them.
3. Prefer the deep link first; if it shows an error/not-found, find real params (public API, other screens) and note what you used.
4. Write ${notesPath}: JSON { "<routeId>": "one sentence describing what this screen shows${mode === 'pr' ? ' / what visibly changed in this PR' : ''}" } for each screen you handled${mode === 'pr' ? ', or { "note": "...", "verdict": "unaffected" } if the PR diff shows no visible change there' : ''}.
5. Write ${summaryPath}: JSON { "captured": [routeIds], "skipped": [{ "id", "why" }], "flows": [flow names] } when done.
6. Budget: these ${budgeted.length} screens only. Be economical — no broad exploration.${prContext ? `\n\nPR context: ${prContext}` : ''}`

  log(`agent (${provider.name}): exploring ${budgeted.length} screen(s)${skipped.length ? `, ${skipped.length} over budget` : ''}`)
  let r
  if (provider.custom) {
    // custom command template: {promptFile} is substituted; the prompt is also
    // exposed as $SCREENMAP_PROMPT_FILE for templates that prefer the env var
    const promptFile = path.join(path.dirname(summaryPath), 'prompt.md')
    fs.writeFileSync(promptFile, prompt)
    const cmd = provider.custom.replaceAll('{promptFile}', promptFile)
    r = spawnSync('bash', ['-c', cmd], { cwd: projectDir, encoding: 'utf8', env: { ...env, SCREENMAP_PROMPT_FILE: promptFile }, maxBuffer: 64 * 1024 * 1024 })
  } else {
    const args = provider.args({ prompt, model: config.agent.model, projectDir })
    r = spawnSync(provider.bin, args, { cwd: projectDir, encoding: 'utf8', env, maxBuffer: 64 * 1024 * 1024 })
  }
  const summary = readJson(summaryPath, { captured: [], skipped: [], flows: [] })
  if (r.status !== 0) log('agent exited non-zero:', (r.stderr || '').slice(-500))
  return { ran: true, ...info, exit: r.status, summary, overBudget: skipped.map((s) => s.id), transcript: (r.stdout || '').slice(-4000) }
}
