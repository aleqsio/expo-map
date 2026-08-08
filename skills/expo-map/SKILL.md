---
name: expo-map
description: Generate a visual navigation map of an Expo app. Statically parses expo-router routes and links for full coverage, then deep-links through every screen in the iOS simulator capturing screenshots — including runtime states like bottom sheet snap points and modals — and renders a self-contained HTML map. Use when the user asks to map an Expo/React Native app's navigation, screens, or routes, or wants a visual sitemap of their app.
---

# expo-map

Produce a visual map of an Expo app's navigation: every expo-router route as a card with a screenshot, runtime state variants (bottom sheets at each snap point, modals), and navigation edges between screens.

**Arguments:** optional path to the Expo project (default: current working directory). `--static` = skip the simulator phases and render a screenshot-less map.

**Working directory contract:** all outputs go to `<project>/.expo-map/` — `graph.json`, `screens/*.png`, `flows/*.json`, `map.html`. Suggest adding `.expo-map/` to the project's `.gitignore` at the end.

## Flow recording (do this throughout Phases 4–5)

Every interaction sequence you perform is recorded as a **replayable agent flow** in `<project>/.expo-map/flows/<name>.json`, written at the moment you perform it — not reconstructed afterwards. Flows let a future agent session (or E2E scaffold) reach any screen or state without rediscovering the steps. Schema:

```json
{
  "name": "details-sheet-50",
  "title": "Open item details and expand the sheet to 50%",
  "route": "details/[id]",
  "device": "iPhone 17 Pro",
  "pointSize": [402, 874],
  "recordedAt": "<iso date>",
  "steps": [
    { "action": "open_url", "url": "myapp://details/42", "note": "deep link, params from fixtures" },
    { "action": "wait", "seconds": 1.5 },
    { "action": "tap", "target": "Open sheet button", "coordinate": [200, 410] },
    { "action": "swipe", "from": [200, 700], "to": [200, 422], "note": "drag sheet handle to 50%" },
    { "action": "screenshot", "file": "details_id--sheet-50.png" }
  ],
  "result": "Sheet resting at 50% snap point"
}
```

Rules: `route` is the graph.json route id the flow targets. `coordinate`/`from`/`to` are device points and are REQUIRED on every tap/swipe (the visualiser renders them as gesture markers on the screen); `pointSize` is the device's point dimensions, reported by the simulator MCP attach. When a tap/swipe NAVIGATES to a different screen, add `"screen": "<route id of where it landed>"` to that step — this is how multi-screen interactive flows stay traceable in the visualiser (deep-link steps don't need it; their URL identifies the screen). Coordinates are advisory for replay; `target` is the durable identifier (visible label or accessibility description), so always fill it. Simple deep-link visits from the sweep are flows too (generate them mechanically alongside the sweep). Multi-step interactions from the state pass are recorded individually as you do them, including dead ends you resolved (note the fix). The renderer picks up `flows/*.json` automatically and shows them in an "Agent flows" section of the map.

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

Deep links are shorthands; the map's primary flow for each screen is the path a human takes. For every reachable route, record `flows/nav-<slug>.json` (name `nav-<slug>`, title "Navigate to <urlPath>") that reaches it from app launch using real taps:

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

Replays a recorded flow (the visualiser's "copy replay command" emits `claude "/expo-map replay <name>"` for interactive flows). Locate the flow: `<project>/.expo-map/flows/<name>.json`, or unzip it from a provided `.appmap` bundle. Ensure the app is running (Phase 3 recipe), then execute steps in order:

- `open_url` / `wait` / `screenshot` — via `xcrun simctl` exactly as recorded.
- `tap` / `swipe` — via the simulator MCP. The `target` label is the source of truth: take an MCP screenshot, find the element it describes, and tap what you see; the recorded `coordinate` is a hint that may have drifted (different device, UI changes). Same safety rules as Phase 5: never trigger destructive or submitting controls.

Verify each step's outcome with an MCP screenshot before proceeding; if a step's target can't be found in 3 attempts, stop and report which step failed and what the screen showed instead.

## Web fallback (no macOS simulator available, or user asks for web)

- Start `npx expo start --web`, confirm `http://localhost:8081/_sitemap` lists the same routes as the parse (good cross-check).
- Capture each route with `npx playwright screenshot --viewport-size=390,844 "http://localhost:8081<urlPath>" <project>/.expo-map/screens/<slug>.png` (needs `npx playwright install chromium` once; ask before installing).
- State pass on web: drive the browser pane manually (tap triggers), but note playwright captures are the ones saved to disk — for sheet states, prefer `npx playwright screenshot --full-page` after using its `--wait-for-timeout` or skip and note the limitation.
