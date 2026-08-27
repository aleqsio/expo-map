# screenmap

screenmap shows you every screen in an Expo / React Native app, and shows your reviewers exactly which screens a pull request changed, without anyone writing a test.

Web pull requests get a preview URL. Mobile pull requests get a QR code, a build to install, and a screen to find on your own, so most reviewers skip the visual half of the change. screenmap closes that gap: it runs the app in CI, screenshots the screens your diff can reach, and posts them into the review.

It is MIT licensed, runs in your own GitHub Actions, and keeps every screenshot on a branch in your own repository.

## Three ways people use it

| Use | What you run | Section |
| --- | --- | --- |
| Review what a pull request changes on screen | the `aleqsio/screenmap@v1` GitHub Action | [Review pull requests in CI](#review-pull-requests-in-ci) |
| Learn an app you have never seen, or map yours locally | the `/screenmap` Claude Code plugin | [Map an app on your machine](#map-an-app-on-your-machine) |
| Look at a map, replay a flow, share it with a designer | the map viewer at [app.screenmap.dev](https://app.screenmap.dev) | [The map viewer](#the-map-viewer) |

All three read and write the same `.scrmap` bundle, so a map recorded locally works in CI and the other way round. If you want the pipeline behind them before the setup steps, jump to [How it works under the hood](#how-it-works-under-the-hood).

**Want to see it first?** Open [app.screenmap.dev/?template=bluesky](https://app.screenmap.dev/?template=bluesky) for a full map of the Bluesky client: 70 screens, 126 recorded flows, captured in one run.

## Words used in these docs

- **Map** (`.scrmap`) is one bundle holding every screen of the app: screenshots, routes, the edges between screens, and the recorded flows. It is a zip, and the viewer opens it.
- **Changes** (`.diff.scrmap`) is a second, smaller bundle describing what one pull request changed against a map. It is meaningless on its own and is always loaded on top of a map.
- **Flow** is a recorded tap path to a screen, written as [argent](https://argent.swmansion.com) YAML with a `.meta.json` sidecar. Committed to your repo, it replays headlessly with `argent flow run`, no LLM involved.
- **Baseline** is the map of your default branch, cached on a `screenmaps` branch in your own repo. Pull request runs diff against it instead of re-mapping the app.
- **Suspects** are the screens a pull request's diff can reach, worked out from the router and the changed files. Only suspects get re-captured.
- **Deterministic lane** covers everything that runs without a model: deep links, committed flow replays, diffing, packing. The **agent lane** is the headless coding agent, and it only handles screens with no flow yet.

## Review pull requests in CI

The `aleqsio/screenmap@v1` Action reviews the screens a pull request touches without re-mapping the whole app. When a PR opens, it works out which routes the diff can reach, captures them on a simulator, and posts a sticky comment with the changed region of each affected screen and a link into the viewer for the rest.

It reports, it does not gate. There is no pass/fail check by default, the agent can mark a suspected change as unaffected, and a reviewer looking at two images decides for themselves.

### What the comment gives a reviewer

- **Before and after, in place.** Changed screens flip between the base and head revision, so a moved button reads instantly instead of forcing a thumbnail comparison.
- **The changed region, boxed.** Hovering a screen renders a region-aware visual diff: changed areas get a box, moved areas get an arrow from where they used to be, and the rest of the screen stays quiet.
- **A note per screen.** The agent writes a short line on each changed screen describing what visibly moved, and can mark a suspect screen as unaffected so it drops out of the way.
- **The whole map behind it.** The link opens the viewer preloaded with the baseline map plus the changes overlay, so a reviewer can also see where the changed screen sits in the app.

### Three ideas the design rests on

1. **Committed flows are the source of truth.** The flows in `.screenmap/flows/*.yaml` (plus their `.meta.json` sidecars) live in the app repo and get reviewed like code. A screen with a committed flow is captured by a headless `argent flow run`, which is deterministic, needs no LLM, and takes seconds.
2. **The baseline map is a cache.** The full `.scrmap` of `main` is built once and refreshed incrementally on every push. A PR run captures only the head side of its suspect screens, because the base-side screenshots already exist in the baseline.
3. **The agent fills gaps, then retires.** A headless coding agent (Claude Code by default, see [AI providers](#ai-providers)) runs only for screens that have no flow, guided by the repo's `.screenmap/SKILL.md` and capped by a per-run budget. On a PR its output is ephemeral: captures go into the bundle, flows go into the artifact. After the feature merges, the baseline job records flows for the new screens and opens a flows PR against `main`. Once that PR is merged, those screens replay for free.

```
PR opened ──▶ restore baseline (screenmaps branch) ──▶ static parse + suspects ──▶ per suspect:
                                                                               committed flow? ──yes──▶ argent replay (teal)
                                                                                               ──no───▶ agent explores (violet, budgeted)
             base-side screenshots reused ──────────────────────────────────▶ head captures + notes ──▶ pack .diff.scrmap
                                                                                                     ──▶ publish (screenmaps branch + artifact)
                                                                                                     ──▶ sticky PR comment → ?map=…&changes=…
```

### Before you start

You need all four of these:

- An Expo or React Native app using expo-router or a react-navigation route map, with `expo-dev-client` installed and deep-linkable routes.
- An EAS build profile that produces a simulator build, or a simulator build of your own.
- A GitHub repo you can add secrets to.
- macOS runner minutes. screenmap runs on macOS only, which bills at ten times the Linux rate. A JavaScript-only pull request takes about 12 minutes end to end.

### Install

1. **Copy the two workflow files** from [`action/templates/`](action/templates/) into your app repo's `.github/workflows/`:

   - [`screenmap-pr.yml`](action/templates/screenmap-pr.yml) runs on every pull request and posts the comment.
   - [`screenmap-baseline.yml`](action/templates/screenmap-baseline.yml) keeps the map of `main` fresh, and opens the flows PR after a merge.

2. **Decide where the dev client comes from.** The Action owns no build pipeline, so pick one:

   - **EAS (the default).** Link the project with `npx eas init`, add a simulator profile to `eas.json`, and pass an `EXPO_TOKEN` secret as the `expo_token` input. The profile looks like this:

     ```json
     "development-simulator": {
       "developmentClient": true,
       "distribution": "internal",
       "ios": { "simulator": true }
     }
     ```

     The Action reuses the newest finished EAS build whose [`@expo/fingerprint`](https://docs.expo.dev/versions/latest/sdk/fingerprint/) matches the checkout, so a JS-only PR never waits on a rebuild. When nothing matches, it runs `eas build` on Expo's infrastructure and waits.

     Get your `EXPO_TOKEN` from expo.dev under Account settings → Access tokens, and add it in your repo under Settings → Secrets and variables → Actions.

   - **Bring your own build.** Pass `app_path` pointing at a simulator `.app` an earlier step produced, from your own pipeline, a shared artifact, or anywhere else. EAS is skipped entirely, and no `EXPO_TOKEN` is needed.

3. **Optionally add an agent key** and pass it as `agent_api_key`. Without a key the Action stays deterministic: deep links and committed flows only, with no exploration and no per-screen notes. Claude Code is the default, and the alternatives are under [AI providers](#ai-providers).

   The key is also what makes a bad capture recoverable. Nothing verifies that a deep link landed on the screen you meant, so a route that starts needing a param will quietly capture its own not-found state; the agent is told to check the link arrived and to find real params when it did not. How many screens it re-checks is the `effort` input:

   | `effort` | The agent sees | Cost |
   | --- | --- | --- |
   | `fast` | only screens no committed flow can reach | cheapest, quickest |
   | `balanced` (default) | also routes whose deep link guesses a param | a few screens more |
   | `thorough` | every screen in the run | most accurate, most tokens |

   `effort` also sets how far suspect marking follows imports (1, 2 and 3 hops). Anything set explicitly in `.screenmap/config.json` — `agent.scan`, `agent.maxScreens`, `suspects.depth` — overrides the preset.

4. **Optionally commit two files** in the app repo.

   **`.screenmap/config.json`** holds the mechanical knobs. Every key is optional; start from [`action/templates/config.json`](action/templates/config.json).

   ```json
   {
     "effort": "balanced",
     "scheme": "myapp",
     "device": "iPhone 17 Pro",
     "params": { "id": "v60" },
     "suspects": { "depth": 2, "broadCap": 8 },
     "waits": { "transition": 2500, "network": 6000, "boot": 15000 },
     "agent": { "enabled": true, "provider": "claude", "scan": "params", "maxScreens": 8 }
   }
   ```

   | Key | Default | What it sets |
   | --- | --- | --- |
   | `effort` | `balanced` | The preset from step 3. The `effort` input and `SCREENMAP_EFFORT` set the same thing |
   | `scheme` | from the parsed app config | URL scheme the deep links use |
   | `device` | `iPhone 16 Pro` | Simulator to boot. In the Action, the `simulator` input boots the device |
   | `appName` | the project directory name | Name recorded in the bundle |
   | `bundleId` | read from the `.app` | Override when discovery picks the wrong one |
   | `appPath` | discovered under `ios/build` | A prebuilt simulator `.app`. The `app_path` input wins over it |
   | `metroPort` | `8081` | Port Metro starts on |
   | `params` | `{}` | Real values for route parameters, see below |
   | `suspects.depth` | from `effort` | Import hops followed out from a changed file |
   | `suspects.broadCap` | `8` | Cap on screens marked by a change to a widely imported file |
   | `waits` | `2500` / `6000` / `15000` ms | `transition`, `network` and `boot` settle times |
   | `agent.enabled` | `true` | Set `false` for a deterministic-only run |
   | `agent.provider` | `claude` | A preset CLI, or `agent.command` plus `agent.keyEnv` for any other |
   | `agent.scan` | from `effort` | `unflowed`, `params` or `all` |
   | `agent.maxScreens` | from `effort` | Screen budget for one run |
   | `flowsDir` | `.screenmap/flows` | Where committed flows live |
   | `skillFile` | `.screenmap/SKILL.md` | Where the project guidance lives |

   `effort` only fills in `agent.scan`, `agent.maxScreens` and `suspects.depth`, so any of the three set here wins over the preset.

   **`params` supplies real values for route parameters.** Without it a route takes a made-up one, so `/brew/[id]` opens as `/brew/1`, and if `1` is not a real id the not-found screen is captured and reported as that screen. `"id": "v60"` covers every route with an `id`, and prefixing the route id scopes it to one route: `"brew/[id].id"` under expo-router, `"Profile.name"` for a react-navigation route map. With an agent key, `balanced` and `thorough` also send those routes back to the agent to find values that work.

   **`.screenmap/SKILL.md`** is the app-specific guidance: how to log in, which ids are real, which controls to leave alone, how long screens take to settle. The agent reads it before it explores. Start from [`action/templates/SCREENMAP_SKILL.md`](action/templates/SCREENMAP_SKILL.md).

5. **Run the baseline workflow once** through `workflow_dispatch`, so pull requests have something to diff against. It publishes `main/<sha>.scrmap` and `main/latest.scrmap` to an orphan `screenmaps` branch.

In a monorepo, point the Action at the app with `project: apps/mobile`. On a private repo, set `publish: "false"`, because raw GitHub URLs are not anonymously readable there. The comment then links the workflow artifact, which you download and drop into the viewer yourself.

### What a PR run does, step by step

| Step | Lane | Notes |
| --- | --- | --- |
| Restore the baseline for the PR base SHA (or `latest`) | deterministic | read from the `screenmaps` branch |
| `parse-routes` on head, then `diff-map suspects` against the baseline graph | deterministic | the same suspect logic as `/screenmap pr` |
| Copy base-side screenshots of the suspects out of the baseline | deterministic | nothing is captured twice |
| Replay committed flows for the suspects (`argent flow run`, fragments around capture points) | deterministic | landing-checked, see below |
| Deep-link the remaining screens | deterministic | `xcrun simctl openurl` plus a screenshot |
| Explore screens that have no flow | agent (budgeted) | writes captures, flows and `notes.json` with per-screen "what changed" and `unaffected` verdicts |
| `diff-map pack` into a `.diff.scrmap` | deterministic | per-state statuses and dismissed suspects |
| Publish and post the sticky comment | deterministic | the link is `?map=<baseline-url>&changes=<diff-url>`, which opens the viewer preloaded |

**The landing check.** Coordinate taps drift silently, because argent reports success wherever a tap lands. So every replay is verified: the end screen is OCR'd with Apple Vision, any system alert is dismissed, and the text is checked against the landmarks the recorder saved in the flow's sidecar (two to five words that identify the arrival screen). A flow with no landmarks falls back to comparing OCR text against a fresh deep-link capture of the same route. When the check fails, the flow is marked *drifted*, the deep-link capture is used instead, the app is relaunched, and the flow is queued for re-recording in the next baseline run.

### Action inputs

| Input | Default | What it does |
| --- | --- | --- |
| `mode` | required | `pr` or `baseline` |
| `project` | `.` | Path to the Expo project, relative to the repo root |
| `agent_provider` | `claude` | `claude`, `codex`, `gemini` or `opencode`. See [AI providers](#ai-providers) |
| `agent_api_key` | empty | Key for the chosen provider. Leave empty for deterministic-only runs |
| `effort` | `balanced` | `fast`, `balanced` or `thorough` — tokens and wall-clock against accuracy. See [Install](#install) step 3 |
| `agent_max_screens` | empty | How many screens the agent may explore in one run. Empty uses the `effort` preset (6 / 8 / 24) |
| `screenmaps_branch` | `screenmaps` | Orphan branch holding baseline maps and per-PR change bundles |
| `publish` | `"true"` | Publish bundles to the `screenmaps` branch so the comment can deep-link the viewer. Needs `contents: write` |
| `viewer_url` | `https://app.screenmap.dev` | Viewer origin used in comment links |
| `simulator` | `iPhone 17 Pro` | Device to boot, falling back to any available iPhone |
| `app_path` | empty | A prebuilt simulator `.app`. When set, EAS is skipped |
| `expo_token` | empty | `EXPO_TOKEN` for the EAS lane. Required unless `app_path` is set |
| `eas_profile` | `development-simulator` | The `eas.json` profile used for the dev client |
| `flows_pr` | `"true"` | Baseline runs open a PR with the flows the agent recorded |
| `github_token` | `${{ github.token }}` | Used for comments, `screenmaps` pushes and flows PRs |

Outputs: `bundle` (path of the produced `.scrmap` or `.diff.scrmap`), `summary` (path of the run summary JSON), and `viewer_link` (the preloaded viewer link, when the run published).

### AI providers

The agent lane is provider-agnostic. Its contract is file-based: the agent is told which screens to handle and exactly where to write captures, flows, `notes.json` and `summary.json`, and the CLI validates those files afterwards. Any headless agentic CLI that can run shell commands fits the slot.

| `agent_provider` | CLI invoked | Key env var |
| --- | --- | --- |
| `claude` (default) | `claude -p … --dangerously-skip-permissions` | `ANTHROPIC_API_KEY` |
| `codex` | `codex exec --dangerously-bypass-approvals-and-sandbox` | `OPENAI_API_KEY` |
| `gemini` | `gemini --yolo -p …` | `GEMINI_API_KEY` |
| `opencode` | `opencode run …` | whichever its configured provider needs |

Pass the key as the `agent_api_key` input and the CLI maps it onto the env var the provider expects (an env var you set explicitly wins). The Action installs the chosen CLI on demand. Locally, `AGENT_PROVIDER` plus the provider's own env var work the same way.

For any other CLI, set this in `.screenmap/config.json`:

```json
"agent": { "command": "myagent --prompt-file {promptFile}", "keyEnv": "MYAGENT_API_KEY" }
```

`{promptFile}` (also available as `$SCREENMAP_PROMPT_FILE`) is a markdown file holding the full task. The command runs through bash in the project directory, and your workflow has to install it beforehand. Setting `agent.provider` in the same file picks a preset without touching the workflow YAML.

The prompt is identical across providers, so quality depends on the model driving it. Claude Code is the only one dogfooded end to end.

### Running the CI pipeline locally

The Action is a thin wrapper around `action/cli/screenmap-ci.mjs`, and that CLI runs against your own simulator:

```bash
cd action/cli && npm install
# full baseline of the current checkout (the agent runs if its provider's key is set)
node screenmap-ci.mjs baseline --project ~/app --out /tmp/main.scrmap
# a PR diff: check out the head, point at the baseline, name the base commit
node screenmap-ci.mjs pr --project ~/app --baseline /tmp/main.scrmap --base <sha> --pr 42 --title "…" --out /tmp/pr42.diff.scrmap
# preview the comment
node screenmap-ci.mjs comment --summary ~/app/.screenmap/out/ci/pr/summary.json --map-url … --changes-url …
```

While iterating, `--only id,id`, `--limit N`, `--no-agent` and `--no-sim` (static only) save a lot of waiting.

### Files the Action reads and writes

| Path | Who uses it | What it holds |
| --- | --- | --- |
| `.screenmap/SKILL.md` | agent | App-specific guidance, templated in [`action/templates/SCREENMAP_SKILL.md`](action/templates/SCREENMAP_SKILL.md) |
| `.screenmap/config.json` | deterministic lane | Scheme, device, waits, suspect depth, agent budget, sample params |
| `.screenmap/flows/` | both lanes | Committed argent flows. The flows PR adds to this directory |
| `screenmaps` branch | the Action | `main/<sha>.scrmap`, `main/latest.scrmap`, `pr-<n>/<sha>.diff.scrmap`, all on SHA-pinned raw URLs |
| `eas.json` | EAS lane | The simulator dev-client profile named by `eas_profile` |
| EAS build history | EAS lane | The dev-client cache, keyed by `@expo/fingerprint`, so no `actions/cache` is involved |
| workflow artifact | the Action | The bundle plus `summary.json`, kept for 90 days |

### Decisions baked in

- The Action never builds the app on the runner. EAS, or the `app_path` you pass, supplies the dev client. An afternoon of CI archaeology (CocoaPods sync, Swift-tools minimums, clang strictness per Xcode point release) is Expo's problem now rather than this Action's.
- Flows PRs are opened by the baseline job against `main` after a merge, which leaves feature branches alone and keeps the flows PR reviewable on its own.
- The baseline refreshes on every push to `main` and on a weekday cron. Refreshes are incremental: only suspect screens, and screens with no usable previous capture, get re-captured.
- The agent budget defaults to 8 screens per run, and the comment says what got skipped.
- The status bar is frozen at 9:41 with `simctl status_bar override` before every screenshot, so base and head pixels differ only where the app differs. Simulator privacy is pre-granted with `simctl privacy grant all`, so a mis-tap cannot raise a system dialog over later captures.

## Map an app on your machine

The same pipeline runs as a Claude Code plugin, which is the fastest way to answer "what is even in this app" on your first day in an unfamiliar codebase, and the way to try screenmap before wiring up CI.

```bash
claude plugin marketplace add aleqsio/screenmap
claude plugin install screenmap@screenmap
```

Then, in any Expo or React Native project, run one of these in Claude Code:

```
/screenmap            # full run: parse + simulator exploration + pack
/screenmap --static   # parse + render only, no simulator
/screenmap replay <flow-name>   # replay a recorded flow on the simulator
/screenmap pr <number>          # PR diff locally: which screens, states and edges changed
```

What you get:

- **Real screenshots, not previews.** Every card is the app actually running, with real data, including the empty states and error boundaries you forgot about.
- **Runtime states as first-class screens.** Bottom-sheet snap points, modals and drawers are captured as variants of the screen they belong to.
- **The path to every screen, saved.** Each screen carries the exact tap sequence that reaches it, ready to replay headlessly. Commit those flows and CI replays them instead of paying an agent to rediscover them.

Output lands in `<project>/.screenmap/out/`, so add that to your `.gitignore`. You need a macOS host with the iOS simulator.

## The map viewer

The hosted viewer lives at [app.screenmap.dev](https://app.screenmap.dev). Drop a `.scrmap` file (the **Map**) and, if you have one, a `.diff.scrmap` file (the **Changes** overlay for a pull request). Parsing happens in your browser, so nothing is uploaded. Opening the site with no parameters gives you the drop screen.

In the **Map** view you get code-declared edges as solid lines and agent-observed edges as dashed ones, flow playback with a follow camera and tap/swipe markers drawn on the exact screen state they happened on, per-screen state pickers, a one-action neighbours mode, minimap click-to-jump, and a copy-paste replay command for every flow.

In the **Changes** view, added, changed and removed screens and edges light up over the dimmed map, changed screens flip between base and head in place, and hovering renders the region-aware visual diff. The format behind it is specified in [docs/diff-scrmap-format.md](docs/diff-scrmap-format.md).

URL parameters:

- `?map=<url>&changes=<url>` loads both bundles from any CORS-readable URL (a raw GitHub URL works) and opens on Changes. This is what the PR comment links to.
- `?template=bluesky` loads the bundled demo map and diff, opening on the Map with Changes behind the toggle.
- `/diffs` loads the same demo pair and opens on Changes.

To run the viewer yourself:

```bash
cd apps/visualiser
npm install
npm run dev
```

Drop a `.scrmap` bundle on the landing page. The demo bundle ships in `public/demo.scrmap`, and the hosted instance loads the same file behind the "load the demo bundle" button.

## How it works under the hood

```
┌─────────────────┐     ┌───────────────────────┐     ┌────────────────┐     ┌──────────────┐
│ 1. static parse │ ──▶ │ 2. agent exploration  │ ──▶ │ 3. pack        │ ──▶ │ 4. visualise │
│ parse-routes.mjs│     │ (simulator + flows)   │     │ pack-map.mjs   │     │ (web app)    │
└─────────────────┘     └───────────────────────┘     └────────────────┘     └──────────────┘
  routes, edges,          screenshots per screen        <app>.scrmap zip       graph map with
  state hints             + state variants              (manifest, map.json,   flow playback,
                          + nav/interaction flows        screens/*.png)        tap overlays
```

1. **Static parse** (no dependencies). Reads expo-router file conventions and react-navigation route maps (the kind Bluesky keeps in `src/routes.ts`), so the screen list is complete rather than whatever a crawler happened to find. It produces the route list, navigation edges from `Link` and `navigate()` calls, and state hints saying which screens use a bottom-sheet or dialog system.
2. **Agent exploration** in the iOS simulator. A deep-link sweep captures every screen and classifies each capture (real, empty state, not found, error boundary, auth wall). For the screens a deep link cannot reach, an agent drives the app and records the tap path as an [argent](https://argent.swmansion.com) flow in YAML, replayable later with `argent flow run`. Runtime states get captured too: open drawers, bottom-sheet snap points, dialogs. If a sticky error boundary blocks the app, the agent recovers and carries on.
3. **Pack.** Everything merges into a producer-agnostic `.scrmap` zip. The format contract is in [docs/scrmap-format.md](docs/scrmap-format.md), which is what you need if you want to write your own producer.
4. **Visualise.** The viewer draws a top-down graph with the root screen at the top-center and phone-framed screenshots. Load a second bundle, a `.diff.scrmap`, and it overlays what a pull request changed.

The expensive part is step 2, and you only pay it once. Recorded flows get committed to your repo, and every later run replays them headlessly instead of exploring again. The agent only wakes up for screens that have no flow yet.

## Repo layout

- `plugins/screenmap/skills/screenmap/SKILL.md` is the agent orchestration: phases, safety rails, and the flow-recording contract.
- `plugins/screenmap/skills/screenmap/scripts/` holds `parse-routes.mjs`, `pack-map.mjs`, `diff-map.mjs` (PR diff: suspects and pack) and `render-map.mjs` (static HTML fallback). All plain Node, no dependencies.
- `apps/visualiser/` is the Map / Changes viewer, built with Vite, React, Tailwind v4, shadcn/ui, React Flow and elkjs, plus pixelmatch and OpenCV.js for the visual diff.
- `action.yml` is the composite GitHub Action. The metadata sits at the repo root so the repo is publishable to the Marketplace. Its `screenmap-ci` CLI lives in `action/cli`, and the workflow and `.scrmap` templates live in `action/templates`.
- [`docs/scrmap-format.md`](docs/scrmap-format.md) is the versioned bundle format contract, for writing your own producer.
- [`docs/diff-scrmap-format.md`](docs/diff-scrmap-format.md) is the format of the PR diff bundle behind the Changes view.
- [`docs/ci.md`](docs/ci.md) is a stub pointing at the CI section above, which is where that guide lives now.
- `fixtures/demo-app/` is a minimal expo-router app that exercises the parser.

## Known limits

- **iOS only.** Android is not supported yet. The interactive phases need a macOS host with the iOS simulator, and there is a web fallback for capture but not for tap recording.
- **Your app needs a router screenmap can read.** expo-router file conventions or a react-navigation route map. Screens registered without URLs are invisible to the static parse, and only show up through agent exploration.
- **Edge extraction is regex-based**, so dynamic hrefs resolve to their route pattern.
- **It reports, it does not gate.** There is no pass/fail check, by design. A reviewer decides what the screenshots mean.

MIT © Aleksander Mikucki
