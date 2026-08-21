# appmap in CI

The GitHub Action reviews every pull request's screens without re-mapping the
whole app. Three ideas carry it:

1. **Committed flows are the source of truth.** `.appmap/flows/*.yaml` (+ `.meta.json`)
   live in the app repo and are reviewed like code. A screen with a committed flow is
   captured by headless `argent flow run` — deterministic, no LLM, seconds.
2. **The baseline map is a cache.** The full `.appmap` of `main` is built once and
   refreshed incrementally on every push; a PR run captures only the *head side of its
   suspect screens* — base-side screenshots come from the baseline.
3. **The agent fills gaps, then retires.** Claude Code runs only for screens with no
   flow, guided by the repo's `.appmap/SKILL.md`, under a per-run budget. On PRs its
   output is ephemeral (captures in the bundle, flows in the artifact). After the
   feature merges, the baseline job records flows for the new screens and opens a
   **flows PR against `main`**; once merged, those screens replay for free.

```
PR opened ──▶ restore baseline (appmaps branch) ──▶ static parse + suspects ──▶ per suspect:
                                                                               committed flow? ──yes──▶ argent replay (teal)
                                                                                               ──no───▶ Claude explores (violet, budgeted)
             base-side screenshots reused ──────────────────────────────────▶ head captures + notes ──▶ pack .appmapdiff
                                                                                                     ──▶ publish (appmaps branch + artifact)
                                                                                                     ──▶ sticky PR comment → ?map=…&changes=…
```

## Install

1. Add the two workflows from [`action/templates/`](../action/templates/) to
   `.github/workflows/` (`appmap-pr.yml`, `appmap-baseline.yml`).
2. Optionally add `ANTHROPIC_API_KEY` as a repo secret — without it the Action runs
   deterministic-only (deep links + committed flows, no exploration, no notes).
3. Commit `.appmap/config.json` (scheme, device, waits — see the template) and, if
   you want the agent to behave, `.appmap/SKILL.md` (auth, real params, forbidden
   controls, timing). Both are optional.
4. Run the baseline workflow once (`workflow_dispatch`) so PRs have something to
   diff against. It publishes `main/<sha>.appmap` + `main/latest.appmap` to an
   orphan `appmaps` branch.

Requirements: a macOS runner (`macos-15`), an Expo project whose dev client builds
with `expo run:ios` (a prebuilt `ios/` works), and deep-linkable routes. JS-only
PRs hit the dev-client cache; native changes rebuild (~15–25 min).

## What a PR run does

| Step | Lane | Notes |
| --- | --- | --- |
| Restore baseline for the PR base SHA (or `latest`) | — | from the `appmaps` branch |
| `parse-routes` on head, `diff-map suspects` vs baseline graph | deterministic | same suspect logic as `/expo-map pr` |
| Copy base-side screenshots of suspects from the baseline | deterministic | nothing is captured twice |
| Replay committed flows for suspects (`argent flow run`, fragments around capture points) | deterministic | **self-checked**: the replay's end screen must resemble the route's deep-link capture (pixelmatch ≥ 0.45); otherwise the flow is marked *drifted*, the deep-link capture is used, the app is relaunched, and the flow is queued for re-recording |
| Deep-link the rest | deterministic | `xcrun simctl openurl` + screenshot |
| Explore screens with no flow | agent (budgeted) | writes captures, flows, `notes.json` (per-screen "what changed", `unaffected` verdicts) |
| `diff-map pack` → `.appmapdiff` | deterministic | per-state statuses, dismissed suspects |
| Publish + sticky comment | — | `?map=<baseline-url>&changes=<diff-url>` opens the hosted visualiser preloaded |

Private repos: raw GitHub URLs aren't anonymously readable, so set `publish: "false"`
and the comment links the workflow artifact (download, drop into the visualiser).

## Running it locally

The Action is a thin wrapper around `action/cli/appmap-ci.mjs`, which runs against
your own simulator:

```bash
cd action/cli && npm install
# full baseline of the current checkout (agent if ANTHROPIC_API_KEY is set)
node appmap-ci.mjs baseline --project ~/app --out /tmp/main.appmap
# a PR diff: checkout the head, point at the baseline, name the base commit
node appmap-ci.mjs pr --project ~/app --baseline /tmp/main.appmap --base <sha> --pr 42 --title "…" --out /tmp/pr42.appmapdiff
# preview the comment
node appmap-ci.mjs comment --summary ~/app/.expo-map/ci/pr/summary.json --map-url … --changes-url …
```

`--only id,id`, `--limit N`, `--no-agent`, `--no-sim` (static only) help while iterating.

## Files it reads and writes

| Path | Who | What |
| --- | --- | --- |
| `.appmap/SKILL.md` | agent | app-specific guidance (template in `action/templates/APPMAP_SKILL.md`) |
| `.appmap/config.json` | deterministic | scheme, device, waits, suspect depth, agent budget, sample params |
| `.appmap/flows/` | both | committed argent flows; the flows PR adds to it |
| `appmaps` branch | Action | `main/<sha>.appmap`, `main/latest.appmap`, `pr-<n>/<sha>.appmapdiff` — SHA-pinned raw URLs |
| Actions cache | Action | `ios/build/Build/Products` keyed by native inputs + Xcode version |
| workflow artifact | Action | bundle + `summary.json` (90 days) |

## Decisions baked in

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
