# screenmap in CI

The GitHub Action reviews every pull request's screens without re-mapping the
whole app. Three ideas carry it:

1. **Committed flows are the source of truth.** `.screenmap/flows/*.yaml` (+ `.meta.json`)
   live in the app repo and are reviewed like code. A screen with a committed flow is
   captured by headless `argent flow run` — deterministic, no LLM, seconds.
2. **The baseline map is a cache.** The full `.scrmap` of `main` is built once and
   refreshed incrementally on every push; a PR run captures only the *head side of its
   suspect screens* — base-side screenshots come from the baseline.
3. **The agent fills gaps, then retires.** A headless coding agent (Claude Code by
   default — see [AI providers](#ai-providers)) runs only for screens with no
   flow, guided by the repo's `.screenmap/SKILL.md`, under a per-run budget. On PRs its
   output is ephemeral (captures in the bundle, flows in the artifact). After the
   feature merges, the baseline job records flows for the new screens and opens a
   **flows PR against `main`**; once merged, those screens replay for free.

```
PR opened ──▶ restore baseline (screenmaps branch) ──▶ static parse + suspects ──▶ per suspect:
                                                                               committed flow? ──yes──▶ argent replay (teal)
                                                                                               ──no───▶ agent explores (violet, budgeted)
             base-side screenshots reused ──────────────────────────────────▶ head captures + notes ──▶ pack .diff.scrmap
                                                                                                     ──▶ publish (screenmaps branch + artifact)
                                                                                                     ──▶ sticky PR comment → ?map=…&changes=…
```

## Install

1. Add the two workflows from [`action/templates/`](../action/templates/) to
   `.github/workflows/` (`screenmap-pr.yml`, `screenmap-baseline.yml`).
2. Wire up the dev client. **The Action owns no build pipeline.** Either:
   - **EAS (default):** link the project (`npx eas init`), add an `eas.json` profile
     like `"development-simulator": { "developmentClient": true, "distribution":
     "internal", "ios": { "simulator": true } }`, and pass an `EXPO_TOKEN` secret as
     `expo_token`. The Action reuses the newest finished EAS build whose
     **fingerprint** matches the checkout — JS-only PRs never build — and otherwise
     runs `eas build` on Expo's infrastructure and waits.
   - **Bring your own:** pass `app_path` pointing at a simulator `.app` you built in
     an earlier step (your own pipeline, a shared artifact, whatever) — EAS is not
     touched.
3. Optionally add an API key secret and pass it as `agent_api_key` — without it the
   Action runs deterministic-only (deep links + committed flows, no exploration, no
   notes). Claude Code is the default agent; see [AI providers](#ai-providers).
4. Commit `.screenmap/config.json` (scheme, device, waits — see the template) and, if
   you want the agent to behave, `.screenmap/SKILL.md` (auth, real params, forbidden
   controls, timing). Both are optional.
5. Run the baseline workflow once (`workflow_dispatch`) so PRs have something to
   diff against. It publishes `main/<sha>.scrmap` + `main/latest.scrmap` to an
   orphan `screenmaps` branch.

Requirements: a macOS runner (`macos-26` recommended — the app only *runs* there, so
the runner needs simulators, not a blessed Xcode toolchain), `expo-dev-client` in the
app, and deep-linkable routes. JS-only PRs reuse the EAS build; native changes wait
on one EAS build (queue + build time).

## What a PR run does

| Step | Lane | Notes |
| --- | --- | --- |
| Restore baseline for the PR base SHA (or `latest`) | — | from the `screenmaps` branch |
| `parse-routes` on head, `diff-map suspects` vs baseline graph | deterministic | same suspect logic as `/expo-map pr` |
| Copy base-side screenshots of suspects from the baseline | deterministic | nothing is captured twice |
| Replay committed flows for suspects (`argent flow run`, fragments around capture points) | deterministic | **self-checked**: the replay's end screen must resemble the route's deep-link capture (pixelmatch ≥ 0.45); otherwise the flow is marked *drifted*, the deep-link capture is used, the app is relaunched, and the flow is queued for re-recording |
| Deep-link the rest | deterministic | `xcrun simctl openurl` + screenshot |
| Explore screens with no flow | agent (budgeted) | writes captures, flows, `notes.json` (per-screen "what changed", `unaffected` verdicts) |
| `diff-map pack` → `.diff.scrmap` | deterministic | per-state statuses, dismissed suspects |
| Publish + sticky comment | — | `?map=<baseline-url>&changes=<diff-url>` opens the hosted visualiser preloaded |

Private repos: raw GitHub URLs aren't anonymously readable, so set `publish: "false"`
and the comment links the workflow artifact (download, drop into the visualiser).

## Running it locally

The Action is a thin wrapper around `action/cli/screenmap-ci.mjs`, which runs against
your own simulator:

```bash
cd action/cli && npm install
# full baseline of the current checkout (agent if its provider's key is set)
node screenmap-ci.mjs baseline --project ~/app --out /tmp/main.scrmap
# a PR diff: checkout the head, point at the baseline, name the base commit
node screenmap-ci.mjs pr --project ~/app --baseline /tmp/main.scrmap --base <sha> --pr 42 --title "…" --out /tmp/pr42.diff.scrmap
# preview the comment
node screenmap-ci.mjs comment --summary ~/app/.expo-map/ci/pr/summary.json --map-url … --changes-url …
```

`--only id,id`, `--limit N`, `--no-agent`, `--no-sim` (static only) help while iterating.

## AI providers

The agent lane is provider-agnostic: its contract is file-based (the agent is told
which screens to handle and exactly where to write captures, flows, `notes.json`
and `summary.json`; the CLI validates the files afterwards), so any headless
agentic CLI that can run shell commands fills the slot.

| `agent_provider` | CLI invoked | key env var |
| --- | --- | --- |
| `claude` (default) | `claude -p … --dangerously-skip-permissions` | `ANTHROPIC_API_KEY` |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox` | `OPENAI_API_KEY` |
| `gemini` | `gemini --yolo -p …` | `GEMINI_API_KEY` |
| `opencode` | `opencode run …` | bring your own (per its configured provider) |

Pass the key as the `agent_api_key` input — the CLI maps it onto whichever env var
the provider expects (an explicitly-set env var wins). The Action installs the
chosen CLI on demand. Locally, `AGENT_PROVIDER` + the provider's own env var work
the same way. For anything else, set in `.screenmap/config.json`:

```json
"agent": { "command": "myagent --prompt-file {promptFile}", "keyEnv": "MYAGENT_API_KEY" }
```

`{promptFile}` (also `$SCREENMAP_PROMPT_FILE`) is a markdown file with the full task;
the command runs via bash in the project directory and must be preinstalled by your
workflow. `agent.provider` in the same file sets the preset without touching the
workflow yaml. The prompt itself is identical across providers — quality varies
with the model driving it, and only Claude Code has been dogfooded end to end.

## Files it reads and writes

| Path | Who | What |
| --- | --- | --- |
| `.screenmap/SKILL.md` | agent | app-specific guidance (template in `action/templates/SCREENMAP_SKILL.md`) |
| `.screenmap/config.json` | deterministic | scheme, device, waits, suspect depth, agent budget, sample params |
| `.screenmap/flows/` | both | committed argent flows; the flows PR adds to it |
| `screenmaps` branch | Action | `main/<sha>.scrmap`, `main/latest.scrmap`, `pr-<n>/<sha>.diff.scrmap` — SHA-pinned raw URLs |
| `eas.json` | EAS lane | the simulator dev-client profile (`eas_profile`, default `development-simulator`) |
| EAS build history | EAS lane | acts as the dev-client cache, keyed by `@expo/fingerprint` — no actions/cache |
| workflow artifact | Action | bundle + `summary.json` (90 days) |

## Decisions baked in

- The Action never builds the app on the runner. EAS (or your `app_path`) supplies the
  dev client; an afternoon of CI archaeology (CocoaPods sync, Swift-tools minimums,
  clang strictness per Xcode point release) is Expo's problem now, not this Action's.
- Flows PRs target `main` from the baseline job after merge — feature branches stay
  untouched, and the flows PR is reviewable on its own.
- Baseline refreshes on every push to `main` (incremental: only suspect screens and
  screens without a usable previous capture are re-captured) plus a weekday cron.
- Agent budget defaults to 8 screens per run; the comment says what was skipped.
- Status bar is frozen (`simctl status_bar override`, 9:41) before every screenshot so
  base/head pixels only differ where the app differs; simulator privacy is pre-granted
  (`simctl privacy grant all`) so a mis-tap can't raise a system dialog over later captures.
- Coordinate-tap flows drift silently (argent reports success when the UI moved under a
  tap); the replay self-check turns that into a visible "drifted" signal in the comment and
  a re-record in the next baseline run.
