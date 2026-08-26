# expo-map

A Claude Code skill that produces a **visual navigation map of an Expo / React Native app**: every screen as a card with a real screenshot, runtime state variants (bottom sheets, dialogs, drawers), the navigation edges between screens, and **replayable [argent](https://argent.swmansion.com) flows** recording how to reach each screen (headless replay: `argent flow run`) — packed into a portable `.scrmap` bundle and explored in an interactive visualiser.

**Visualiser (hosted):** https://app.screenmap.dev — drop a `.scrmap` (the **Map**) and/or a `.diff.scrmap` (the **Changes** overlay for a PR); everything parses client-side, nothing uploads. Opening it bare gives you the drop screen. Deep links: `?map=<url>&changes=<url>` load bundles from any CORS-readable URL (e.g. a raw GitHub URL) and open on Changes; `?template=bluesky` loads the bundled demo map and diff and opens on the Map, with Changes behind the toggle; `/diffs` loads the same pair and opens on Changes.

## How it works

```
┌─────────────────┐     ┌───────────────────────┐     ┌────────────────┐     ┌──────────────┐
│ 1. static parse │ ──▶ │ 2. agent exploration  │ ──▶ │ 3. pack        │ ──▶ │ 4. visualise │
│ parse-routes.mjs│     │ (simulator + flows)   │     │ pack-map.mjs   │     │ (web app)    │
└─────────────────┘     └───────────────────────┘     └────────────────┘     └──────────────┘
  routes, edges,          screenshots per screen        <app>.scrmap zip       graph map with
  state hints             + state variants              (manifest, map.json,   flow playback,
                          + nav/interaction flows        screens/*.png)        tap overlays
```

1. **Static parse** (zero deps): expo-router file conventions *and* react-navigation route maps (à la Bluesky's `src/routes.ts`) → full route list, navigation edges from `Link`/`navigate()` calls, and **state hints** (which screens use bottom-sheet/dialog systems).
2. **Agent exploration** in the iOS simulator: deep-link sweep capturing every screen, capture classification (real / empty-state / not-found / error-boundary / auth-wall), **navigation flows** in argent's YAML format (the real tap path to each screen — headlessly replayable via `argent flow run`, with a cartography sidecar carrying route ids, per-tap `screen` hops, and capture links), transient-state captures (open drawers, sheets, dialogs), and recovery from sticky error boundaries.
3. **Pack**: everything merges into a producer-agnostic `.scrmap` zip — see [docs/scrmap-format.md](docs/scrmap-format.md).
4. **Visualise**: top-down graph (root screen top-center) with phone-framed screenshots, solid code-declared edges + dashed agent-observed edges, flow playback with a follow camera and tap/swipe markers on the exact screen state they happened on, per-screen state pickers, one-action **neighbours** mode, minimap click-to-jump, and copy-paste replay commands for every flow. Switch to **Changes** with a `.diff.scrmap` loaded: added/changed/removed screens and edges light up over the dimmed map, changed screens flip base⇄head in place, and hovering renders a region-aware visual diff (changed islands boxed, moved islands arrowed). See [docs/diff-scrmap-format.md](docs/diff-scrmap-format.md) and the `pr` mode in the skill.

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
/expo-map pr <number>          # PR diff: which screens/states/edges changed → .diff.scrmap
```

Outputs land in `<project>/.expo-map/` (git-ignore it).

## Run the visualiser locally

```bash
cd apps/visualiser
npm install
npm run dev
```

Drop a `.scrmap` bundle on the landing page. A demo bundle (a full Bluesky map: 70 screens, 126 flows) ships in `public/demo.scrmap` — the hosted instance loads it via the "load the demo bundle" button.

## Run it in CI (GitHub Action)

`aleqsio/expo-map@main` reviews every PR's screens without re-mapping the app — and without
owning a build pipeline: the dev client comes from **EAS Build** (reused by fingerprint when only
JS changed) or a prebuilt `app_path` you supply. Committed flows in `.screenmap/flows/` replay
headlessly, the baseline map of `main` (cached on an
`screenmaps` branch) supplies the base side, the agent — Claude Code by default, or Codex / Gemini /
OpenCode / any custom CLI via `agent_provider` — explores only screens with no flow (budgeted),
and a sticky PR comment links the hosted visualiser preloaded with `?map=…&changes=…`. After merge,
the baseline job opens a flows PR for what the agent recorded. Setup, what each run does, and how to
run the same pipeline locally: [docs/ci.md](docs/ci.md); workflow templates in [`action/templates/`](action/templates/).

## Repo layout

- `skills/expo-map/SKILL.md` — the agent orchestration (phases, safety rails, flow-recording contract)
- `skills/expo-map/scripts/` — `parse-routes.mjs`, `pack-map.mjs`, `diff-map.mjs` (PR diff: suspects + pack), `render-map.mjs` (static HTML fallback) — plain Node, no dependencies
- `apps/visualiser/` — the Map / Changes viewer (Vite + React + Tailwind v4 + shadcn/ui + React Flow + elkjs; pixelmatch + OpenCV.js for the visual diff)
- `docs/scrmap-format.md` — bundle format contract, versioned
- `docs/diff-scrmap-format.md` — the PR diff bundle (Changes) format
- `docs/ci.md` — the GitHub Action: design, install, local runs
- `action.yml` — the composite GitHub Action (metadata at the root so the repo is Marketplace-publishable); its `screenmap-ci` CLI lives in `action/cli`, workflow / `.scrmap` templates in `action/templates`
- `fixtures/demo-app/` — minimal expo-router app exercising the parser

## Known limits

- Edge extraction is regex-based; dynamic hrefs resolve to their route pattern.
- Screens registered without URLs (no route-map entry) aren't discovered statically — they surface through agent exploration instead.
- The interactive phases need a macOS host with the iOS simulator; a web fallback exists for capture but not for tap recording.

MIT © Aleksander Mikucki
