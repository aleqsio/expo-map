# expo-map

A Claude Code skill that produces a **visual navigation map of an Expo / React Native app**: every screen as a card with a real screenshot, runtime state variants (bottom sheets, dialogs, drawers), the navigation edges between screens, and **replayable [argent](https://argent.swmansion.com) flows** recording how to reach each screen (headless replay: `argent flow run`) — packed into a portable `.appmap` bundle and explored in an interactive visualiser.

**Visualiser (hosted):** https://appmap-visualiser.vercel.app — drop an `.appmap` (the **Map**) and/or an `.appmapdiff` (the **Changes** overlay for a PR); everything parses client-side, nothing uploads. Deep links: `?map=<url>&changes=<url>` load bundles from any CORS-readable URL (e.g. a raw GitHub URL); `/diffs` opens the bundled demo diff.

## How it works

```
┌─────────────────┐     ┌───────────────────────┐     ┌────────────────┐     ┌──────────────┐
│ 1. static parse │ ──▶ │ 2. agent exploration  │ ──▶ │ 3. pack        │ ──▶ │ 4. visualise │
│ parse-routes.mjs│     │ (simulator + flows)   │     │ pack-map.mjs   │     │ (web app)    │
└─────────────────┘     └───────────────────────┘     └────────────────┘     └──────────────┘
  routes, edges,          screenshots per screen        <app>.appmap zip       graph map with
  state hints             + state variants              (manifest, map.json,   flow playback,
                          + nav/interaction flows        screens/*.png)        tap overlays
```

1. **Static parse** (zero deps): expo-router file conventions *and* react-navigation route maps (à la Bluesky's `src/routes.ts`) → full route list, navigation edges from `Link`/`navigate()` calls, and **state hints** (which screens use bottom-sheet/dialog systems).
2. **Agent exploration** in the iOS simulator: deep-link sweep capturing every screen, capture classification (real / empty-state / not-found / error-boundary / auth-wall), **navigation flows** in argent's YAML format (the real tap path to each screen — headlessly replayable via `argent flow run`, with a cartography sidecar carrying route ids, per-tap `screen` hops, and capture links), transient-state captures (open drawers, sheets, dialogs), and recovery from sticky error boundaries.
3. **Pack**: everything merges into a producer-agnostic `.appmap` zip — see [docs/appmap-format.md](docs/appmap-format.md).
4. **Visualise**: top-down graph (root screen top-center) with phone-framed screenshots, solid code-declared edges + dashed agent-observed edges, flow playback with a follow camera and tap/swipe markers on the exact screen state they happened on, per-screen state pickers, one-action **neighbours** mode, minimap click-to-jump, and copy-paste replay commands for every flow. Switch to **Changes** with an `.appmapdiff` loaded: added/changed/removed screens and edges light up over the dimmed map, changed screens flip base⇄head in place, and hovering renders a region-aware visual diff (changed islands boxed, moved islands arrowed). See [docs/appmapdiff-format.md](docs/appmapdiff-format.md) and the `pr` mode in the skill.

## Install the skill

```bash
git clone https://github.com/aleqsio/expo-map
ln -s "$(pwd)/expo-map/skills/expo-map" ~/.claude/skills/expo-map
```

Then in any Expo/RN project, in Claude Code:

```
/expo-map            # full run: parse + simulator exploration + pack
/expo-map --static   # parse + render only, no simulator
/expo-map replay <flow-name>   # replay a recorded flow on the simulator
/expo-map pr <number>          # PR diff: which screens/states/edges changed → .appmapdiff
```

Outputs land in `<project>/.expo-map/` (git-ignore it).

## Run the visualiser locally

```bash
cd apps/visualiser
npm install
npm run dev
```

Drop a `.appmap` bundle on the landing page. A demo bundle (a full Bluesky map: 70 screens, 126 flows) ships in `public/demo.appmap` — the hosted instance loads it via the "load the demo bundle" button.

## Repo layout

- `skills/expo-map/SKILL.md` — the agent orchestration (phases, safety rails, flow-recording contract)
- `skills/expo-map/scripts/` — `parse-routes.mjs`, `pack-map.mjs`, `diff-map.mjs` (PR diff: suspects + pack), `render-map.mjs` (static HTML fallback) — plain Node, no dependencies
- `apps/visualiser/` — the Map / Changes viewer (Vite + React + Tailwind v4 + shadcn/ui + React Flow + elkjs; pixelmatch + OpenCV.js for the visual diff)
- `docs/appmap-format.md` — bundle format contract, versioned
- `docs/appmapdiff-format.md` — the PR diff bundle (Changes) format
- `fixtures/demo-app/` — minimal expo-router app exercising the parser

## Known limits

- Edge extraction is regex-based; dynamic hrefs resolve to their route pattern.
- Screens registered without URLs (no route-map entry) aren't discovered statically — they surface through agent exploration instead.
- The interactive phases need a macOS host with the iOS simulator; a web fallback exists for capture but not for tap recording.

MIT © Aleksander Mikucki
