---
name: expo-map
description: Generate a visual navigation map of an Expo app. Statically parses expo-router routes and links for full coverage, then deep-links through every screen in the iOS simulator capturing screenshots — including runtime states like bottom sheet snap points and modals — and renders a self-contained HTML map. Also diffs two revisions into a PR preview (.appmapdiff) showing which screens/edges were added, removed, or changed. Use when the user asks to map an Expo/React Native app's navigation, screens, or routes, wants a visual sitemap of their app, or wants to preview/review what a PR changes on-screen.
---

# expo-map

Produce a visual map of an Expo app's navigation: every expo-router route as a card with a screenshot, runtime state variants (bottom sheets at each snap point, modals), and navigation edges between screens.

**Arguments:** optional path to the Expo project (default: current working directory). `--static` = skip the simulator phases and render a screenshot-less map. `pr <number>` or `diff <base>..<head>` = PR diff mode (see bottom).

**Working directory contract:** all outputs go to `<project>/.expo-map/` — `graph.json`, `screens/*.png`, `flows/*.yaml` + `flows/*.meta.json`, `map.html`. Suggest adding `.expo-map/` to the project's `.gitignore` at the end.

## Flow recording (do this throughout Phases 4–5)

Every interaction sequence you perform is recorded as a **replayable flow**, written at the moment you perform it — not reconstructed afterwards. Flows use the **argent flow format** (argent.swmansion.com — Software Mansion's agentic mobile toolkit): a `<name>.yaml` argent flow plus a `<name>.meta.json` cartography sidecar, both in `<project>/.expo-map/flows/`. Anyone replays a flow headlessly, no LLM in the loop: `npx @swmansion/argent flow run .expo-map/flows/<name>.yaml`. Full pair schema: `docs/appmap-format.md` in the skill repo.

```yaml
# Open item details and expand the sheet to 50%
steps:
  - tool: open-url
    args:
      url: "myapp://details/42"
  - wait: 1500
  # Open sheet button
  - tap: { x: 0.4975, y: 0.4691 }
  - tool: gesture-swipe
    args: { fromX: 0.4975, fromY: 0.8009, toX: 0.4975, toY: 0.4828 }
```

```json
{ "formatVersion": 2, "name": "details-sheet-50", "route": "details/[id]",
  "title": "Open item details and expand the sheet to 50%", "device": "iPhone 17 Pro",
  "steps": { "2": { "target": "Open sheet button" },
             "3": { "capture": "details_id--sheet-50.png", "note": "sheet at 50% snap" } } }
```

Rules:
- **If the argent MCP is connected, record through it** (`flow-start-recording` / `flow-add-step`): every step executes live, only successful steps are recorded, and taps get durable **selectors** instead of coordinates. Write the sidecar yourself alongside. Without argent, write the YAML directly using normalized 0–1 coordinates (device points ÷ device point-size).
- Sidecar `steps` is keyed by 0-based YAML step index. Every coordinate tap/swipe needs a `target` label (visible text or accessibility description). When a tap/swipe NAVIGATES to a different screen, set `"screen": "<route id it landed on>"` — this is how multi-screen flows stay traceable and observed edges get pinned. Screenshots are sidecar `capture` entries on the step they follow — never YAML steps.
- Add top-level `"landmarks": ["Explore", "Trending"]` — 2–5 words that are visible on the arrival screen and identify it (a title, a section header, a fixed button label; not live content). Headless replays in CI OCR the end screen and check these words to detect flow drift — without landmarks a drifted flow can only be caught heuristically.
- Simple deep-link visits from the sweep are flows too (generate them mechanically). Record dead ends you resolved with a `note`.
- Never record credentials; argent supports `{{secret:NAME}}` placeholders if input is unavoidable.

## Phase 1 — static parse

```bash
node <this skill's dir>/scripts/parse-routes.mjs <project>
```

Read the produced `<project>/.expo-map/graph.json` and report the summary to the user: route count, layouts (with navigator types), edges (flag unresolved ones), routes with state hints, routes needing params. If the parser finds no `app/` directory, this is not an expo-router project — say so and stop (bare react-navigation apps are not supported yet).

If `--static` was requested, jump to Phase 6.

## Phase 2 — plan params and auth

- For each route with `params`, pick a sample value: prefer concrete values found in resolved edges' `raw` hrefs (e.g. `/details/42` → `id=42`), then seed/fixture data in the repo, else `1`. Record the substitution you'll use in deep links.
- Skim the graph for routes that are likely auth-gated (segments like `(auth)`, `login`, `sign-in`, or a root layout with a redirect). Expect those to redirect during the sweep; that's fine — capture what actually renders and mark it in your report.

## Phase 3 — boot the app

1. `xcrun simctl list devices booted` — check for a booted simulator.
2. Call the iOS simulator MCP `attach` action FIRST so the user can watch (harmless error if nothing is booted yet — boot/build, then retry attach).
3. Get the app running, preferring what already exists:
   - If Metro is already running and the app is open in the simulator, use it as-is.
   - Else start Metro in the background (`npx expo start` via background Bash from the project dir).
   - If a dev build of the app is installed on the simulator, launch it. If only Expo Go is available, open the project in it. If neither, `npx expo run:ios` (warn the user this builds and takes minutes), or fall back to web (see bottom).
4. **Verify deep linking before sweeping.** Open the root route with the scheme from `graph.json`:
   - dev build: `xcrun simctl openurl booted "<scheme>://"`
   - Expo Go: `xcrun simctl openurl booted "exp://127.0.0.1:8081/--/"`
   Take an MCP `screenshot` to confirm the app rendered (not a crash/error screen). Use whichever URL form worked for the rest of the run.

## Phase 4 — route sweep

For each route in `graph.json` (substituting params from Phase 2; for `+not-found`, deep-link a garbage path like `/definitely-not-a-route`):

1. `open_url` (or `xcrun simctl openurl booted "<url>"`) with the route's deep link.
2. Wait ~1–1.5s for the transition (MCP `wait`). Content screens that fetch over the network need 3–4s — a capture showing a spinner or loading skeleton means the wait was too short, not that the route is broken; the Phase 4b review catches these, and you re-capture with a longer wait.
3. Capture to disk: `xcrun simctl io booted screenshot <project>/.expo-map/screens/<slug>.png` — use the exact `slug` from `graph.json`; the renderer depends on this naming. (MCP `screenshot` is for your own eyes only; it doesn't save a file.)
4. Every few routes, sanity-check via MCP `screenshot` that you're capturing real screens. If a route shows a red error screen, an error boundary, or redirected somewhere else, still keep the capture but note it for the final report.

### Phase 4b — review and recover (do not skip)

Error boundaries **stick**: once a bad deep link crashes a screen, subsequent deep links may render into the same error boundary, silently poisoning every capture after it. So before delivering:

1. Render a draft map (Phase 6 commands) and *look at it* — it doubles as a contact sheet of all captures.
2. Classify every capture that isn't clearly the real screen, and write the verdicts to `<project>/.expo-map/capture-status.json` (the renderer badges them on the map):

   ```json
   { "<routeId>": { "status": "not-found", "needsNavigation": true, "note": "why + what a future agent should do instead" } }
   ```

   Statuses: `ok` · `empty-state` · `not-found` · `error-boundary` · `loading` · `auth-wall`. Decide per capture:
   - **Loading spinner/skeleton** — wait was too short OR the param is synthetic. Re-capture with 3–4s; if still loading, the data doesn't exist → treat as not-found.
   - **Not-found / empty "Oops" screen** — your sample param doesn't resolve to real data. First try to find *real* params (public APIs, seed data, values seen in other captures — e.g. a real starter-pack rkey from the account's public profile). Only if no real value is obtainable, keep the capture, set `needsNavigation: true`, and say in the note how the screen is actually reached (opened from a shared link, requires user-owned data, etc.).
   - **Genuine empty state** — the screen rendered correctly but the account has no content (e.g. "Nothing saved yet"). That IS the screen; status `empty-state`, no `needsNavigation`. Don't confuse this with not-found.
   - **Error boundary** — the route can't render from a bare deep link at all (missing runtime params). Keep as finding, `needsNavigation: true`. Beware the **poisoned tail**: error boundaries stick, so captures taken *after* a crash may show the same stuck error — relaunch the app (`xcrun simctl terminate booted <bundleId>`, relaunch, wait for the bundle) and re-capture those.
3. Re-render after recovery.

## Phase 5 — runtime states (the part static analysis can't see)

For each route whose `stateHints` is non-empty, deep-link to it again and:

**bottom-sheet** — Read the route's source file (`file` in graph.json) to find what opens the sheet (a button whose `onPress` calls `ref.expand()` / `present()`; some sheets are open by default — check the `index` prop). Take an MCP screenshot, locate the trigger, `tap` it. Then for each snap point in the hint (e.g. `25%`, `50%`, `90%`):
- drag the sheet to that height: `swipe` from the sheet handle's current position to `y ≈ screen_height × (1 − snap)`. Start the swipe well inside the screen — a start point within 4pt of an edge triggers an OS edge gesture instead.
- capture `screens/<slug>--sheet-<value>.png` (e.g. `details_id--sheet-50.png` — strip the `%`).

**rn-modal** — find and `tap` the trigger, capture `screens/<slug>--modal.png`, then dismiss (close button, tap outside, or just deep-link away).

**router-modal** — already captured as its own route in Phase 4; nothing extra needed.

Rules for this phase:
- Re-deep-link between routes to reset state; don't let one screen's leftover state bleed into the next capture.
- Never tap destructive or irreversible controls: delete, remove, sign out, purchase, send, submit. If a sheet can only be opened via such a control, skip it and note why.
- If you type into inputs to reach a state, use obviously fake data.
- A hint is advisory — if you can't find the trigger in 2–3 attempts, skip it and note it. Also: sheets defined in shared components aren't in the hints; if you *see* an obvious sheet/modal trigger while on a screen, capture it as a bonus state.
- **The hint list is a work queue, not a suggestion box.** Phase 5 is not done until every hinted route is either captured or explicitly skipped with a reason. End the phase with a coverage line — `state hints: N routes · captured M · skipped K (list + why)` — and carry it into the Phase 6 delivery report. A state pass that quietly processes 3 of 17 hints looks complete on the map and isn't; that silence has bitten before.

## Phase 5b — navigation flows (the tap path to every screen)

Deep links are shorthands; the map's primary flow for each screen is the path a human takes. For every reachable route, record `flows/nav-<slug>.yaml` + sidecar (name `nav-<slug>`, title "Navigate to <urlPath>") that reaches it from app launch using real taps:

- Step 1 is always `open_url` to the app root (`scheme://`) — that's the app entry, not a shortcut. Everything after is taps/swipes.
- **Every navigating tap records three things**: `coordinate` (device points), `target` (durable label), and `screen` (the route id it landed on). Verify the landing with an MCP screenshot BEFORE writing the step — a wrong `screen` poisons the graph.
- Walk the app as a tree, depth-first, reusing prefixes: e.g. record the drawer → Settings hop once, then each settings row extends it. Each flow file is still self-contained (repeats its prefix steps).
- **Transient states get captures too.** When a tap changes the UI without changing route (opens a drawer, menu, sheet), capture that state ONCE as a state variant of the source screen (`<sourceSlug>--<state>.png`, e.g. `Home--drawer.png`) and insert a screenshot step referencing it right after the opening tap in every flow that passes through it. Viewers then render the ripple for the next tap on the drawer capture instead of the closed-drawer base screen.
- End each flow with a screenshot step of the target (`<slug>.png`).
- Screens with no discoverable in-app path (deep-link-only, or requiring data the account lacks) — record that in capture-status notes instead of forcing it.

These flows are what make edges *pinnable*: a nav flow tapping through a transition tells the visualiser exactly where the trigger sits on the source screen.

## Phase 6 — pack, render, deliver

```bash
for f in <project>/.expo-map/screens/*.png; do sips -Z 800 "$f" >/dev/null; done   # downscale
node <this skill's dir>/scripts/pack-map.mjs <project>        # → .expo-map/<app>-<date>.appmap bundle
node <this skill's dir>/scripts/render-map.mjs <project>/.expo-map/graph.json   # static HTML fallback
```

The `.appmap` bundle (zip: manifest.json + map.json + screens/) is the primary deliverable — see `docs/appmap-format.md` in the skill repo. Open it in the **visualiser** (`apps/visualiser` in the skill repo, `npm run dev`, drag the bundle in): interactive graph, flow playback, click-to-copy replay commands. Send the bundle with SendUserFile; send `map.html` too as the no-tooling fallback (display: render). Report: routes captured / total, state variants captured, anything skipped (error screens, auth redirects, un-triggerable sheets), unresolved edges. Offer to publish as an Artifact (if so, load the artifact-design skill first and rebuild the page body-only per Artifact rules — don't publish the full-document HTML as-is). Suggest adding `.expo-map/` to `.gitignore`.

## Replay mode — `/expo-map replay <flow-name>`

Flows are argent YAML, so the primary replay is **headless**:

```bash
npx @swmansion/argent flow run <project>/.expo-map/flows/<flow-name>.yaml
```

Run that first (it needs no LLM and reports pass/fail per step). Fall back to manual replay only when argent isn't installed and can't be (`npx` unavailable) or when the flow fails and the user wants a diagnosis: execute the YAML steps yourself — `open-url`/`wait` via `xcrun simctl`, taps/swipes via the simulator MCP using the sidecar's `target` labels as the source of truth (recorded coordinates are hints that may have drifted). Verify each step with an MCP screenshot; if a target can't be found in 3 attempts, stop and report which step failed and what the screen showed instead. Same safety rules as Phase 5: never trigger destructive or submitting controls.

## PR diff mode — `/expo-map pr <number>` or `/expo-map diff <base>..<head>`

Preview what a change does to the app's navigation surface: which screens were **added,
removed, or changed**, which edges appeared or vanished, with before/after screenshots.
The deliverable is an `.appmapdiff` bundle (format: `docs/appmapdiff-format.md` in the
skill repo) — the visualiser renders it with green/amber/red highlights, a Changes
panel, and base-vs-head comparison per screen.

Working directory: `<project>/.expo-map/diff/<slug>/` where slug is `pr-<number>` or
`<base>..<head>`. Verdicts are **static-only** (a screen is "changed" iff the change
set touches its file or import closure); screenshots are evidence for the reviewer,
not input to the classification.

### D1 — resolve the two revisions

- PR form: `gh pr view <n> --json number,title,url,baseRefName,headRefName,mergeCommit,files`.
  For a *merged* PR, head = the merge commit, base = its first parent (`<merge>^`).
  For an open PR, `gh pr view --json headRefOid,baseRefOid`. Write `pr.json`
  (`{number,title,url,baseSha,headSha,baseRef,headRef}`) and `changed-files.txt`
  (`gh pr diff <n> --name-only`, or `git diff --name-only <base> <head>`).
- Ref form: resolve both refs with `git rev-parse`; same files, no `number`.
- Shallow clones: `git fetch --depth 1 origin <sha>` for any SHA the repo doesn't have.
- **Native guard:** if changed files touch `ios/`, `android/`, `patches/`, or change
  native deps in `package.json`, warn the user that the installed dev build may not
  match both sides — JS-only diffs are the supported case. Proceed only if they accept.
- The project must have a clean tree (or the user agrees to `git stash`). Remember the
  original ref; **restore it at the end, always** — even after failures.

### D2 — parse both sides, pick suspects

```bash
git -C <project> checkout --detach <baseSha>
node <skill>/scripts/parse-routes.mjs <project>   # writes .expo-map/graph.json
cp <project>/.expo-map/graph.json <diffDir>/base/graph.json
git -C <project> checkout --detach <headSha>
node <skill>/scripts/parse-routes.mjs <project>
cp <project>/.expo-map/graph.json <diffDir>/head/graph.json
node <skill>/scripts/diff-map.mjs suspects <diffDir> --project <project>
```

Read `suspects.json` and report the work-list to the user before capturing: N added,
N removed, N modified (with reasons and via-files), plus any broad files excluded from
expansion. That report alone is already a useful static preview — if the user asked
for `--static`, skip to D4.

Then read the PR's actual diff for each suspect's via-files and write
`<diffDir>/notes.json` — `{ "<nodeId>": "what visibly changes on this screen" }`, one
plain sentence per suspect (e.g. "Trending topic pills become full-width ranked rows").
Viewers show this note on the screen's diff card; without it the card only says
"file-touched", which tells a reviewer nothing.

If reading the diff convinces you a statically-flagged suspect has **no visible
change** (shared import only, pure refactor, code path that doesn't render there),
use `{ "note": "why it's unaffected", "verdict": "unaffected" }` instead — pack drops
it from the changed list into `diff.json`'s `dismissed` section (omitted from the
viewer's Changes list, kept in the bundle for audit). You can also skip capturing that
screen. Dismiss only on positive evidence from the diff, not on a hunch — when unsure,
keep it and let the captures decide.

Status is tracked **per capture state**, not just per screen. When a screen's change
lives in one state (below the fold, inside a sheet), say so with per-state notes —
`""` is the bare screen, other keys are variant names:

```json
"Settings": { "note": "A 'Beta features' row is added between Languages and Help.",
  "states": {
    "": { "note": "Top of the list is identical — the row is below the fold.", "verdict": "unaffected" },
    "bottom": "New 'Beta features' row appears between Languages and Help." } }
```

The viewer marks each state in the node's dropdown (`± bottom` etc.), so capture the
state variants that make the change visible (Phase 5 style) — a diff whose change is
below the fold and has no scrolled state variant shows two identical screenshots.

### D3 — targeted capture, base then head

Boot the app (Phase 3), then freeze the status bar so both sides capture identically
(clock noise otherwise pollutes every pixel comparison):

```bash
xcrun simctl status_bar booted override --time "9:41" --dataNetwork wifi --wifiMode active --wifiBars 3 --cellularMode active --cellularBars 4 --batteryState charged --batteryLevel 100
```

Then for each side in order **base → head**:

1. `git checkout --detach <sha>`, restart Metro (kill the background process, start
   again), and relaunch the app; verify a deep link renders the right revision.
2. Capture only the suspect list for that side (`side: both|base` for base,
   `both|head` for head), Phase 4 style, into `<diffDir>/<side>/screens/<slug>.png`.
   Same waits, same 4b review discipline; verdicts go to
   `<diffDir>/<side>/capture-status.json`.
3. For suspects with `stateHints` — and any state the diff added (`states` with
   reason `hint`) — do a scoped Phase 5 pass so state variants land as
   `<slug>--<state>.png` on the right side.

Keep both sides comparable: same device, same account, same waits.

### D4 — pack and deliver

```bash
for f in <diffDir>/{base,head}/screens/*.png; do sips -Z 800 "$f" >/dev/null; done
node <skill>/scripts/diff-map.mjs pack <diffDir> --device "<device name>"
```

Restore the original ref. Send the `.appmapdiff` with SendUserFile; report the diff
table (added/modified/removed screens, edge changes, state changes, broad-file blind
spots, anything uncapturable). The bundle opens in the same visualiser as `.appmap`
files (drag it in). If a full `.appmap` of the app exists, tell the user to load both —
the visualiser overlays the diff on the full map, so unchanged screens keep their real
screenshots (dimmed) and changed screens flip base⇄head in place (hover for a red
changed-pixels render).

## Web fallback (no macOS simulator available, or user asks for web)

- Start `npx expo start --web`, confirm `http://localhost:8081/_sitemap` lists the same routes as the parse (good cross-check).
- Capture each route with `npx playwright screenshot --viewport-size=390,844 "http://localhost:8081<urlPath>" <project>/.expo-map/screens/<slug>.png` (needs `npx playwright install chromium` once; ask before installing).
- State pass on web: drive the browser pane manually (tap triggers), but note playwright captures are the ones saved to disk — for sheet states, prefer `npx playwright screenshot --full-page` after using its `--wait-for-timeout` or skip and note the limitation.
