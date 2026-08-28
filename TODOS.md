# TODOs

Open work across the three repos, as of 2026-08-27. Everything here came out of
setting up `aleqsio/screenmap-test` from scratch and running it end to end;
the full write-up of what that turned up is in `site/docs/setup-instruction-fixes.md`.

---

## Drifted flows have no repair path without an agent

`effort=deterministic` (now the automatic choice when no agent key is set) makes
this urgent: it is the one mode where nothing can fix a broken flow, and it is
the mode a keyless repo lands in by default.

When `verifyLanding()` fails a replay, `screenmap-ci.mjs` deletes the captures,
falls back to a deep link, records the route in `result.drifted` and pushes it
onto `result.unflowed` with reason `flow drifted`. The PR comment says the flow
was "queued to be re-recorded". Nothing is queued anywhere. `unflowed` has
exactly one consumer, the agent lane, so with no agent the committed flow in
`.screenmap/flows` stays broken, the same warning appears on every subsequent
PR, and the screen quietly degrades to an unverified deep link forever. Newly
added routes have the same shape: flowless by definition, and nothing without a
key ever gives them a flow.

There is a second gap underneath it. The local skill writes flows to
`.screenmap/out/flows/` and tells you to gitignore that directory, while CI
replays from `config.flowsDir`, `.screenmap/flows`. Nothing moves them across.
In CI the baseline job bridges it by calling `flows-pr`; a local run has no
equivalent, so "record locally, replay deterministically in CI" does not
actually work today without a manual copy. That makes it the first thing to fix,
because the site now points people at exactly that workflow.

`screenmap-ci flows-adopt` now bridges `out/flows` to `.screenmap/flows`, and
the drift and over-budget warnings say what to do about it, so the two cheapest
items are done. What is left:

1. Try repairing drift without an LLM before giving up. Every coordinate tap in
   an argent flow carries a `target` label, and Vision OCR is already local and
   free. Re-resolving a step by its label when its coordinates miss would fix
   the common case, a layout shift, with no tokens and no agent. Speculative:
   worth a spike against a real drifted flow before committing to it.
2. Persist the drift list between runs so a scheduled baseline with a key can
   re-record everything that accumulated, with deterministic PR runs in between.
   Today `drifted` lives only in one run's `summary.json`.

## Auto-baseline needs the guards the first live test found

Found by T15 on 2026-08-28, on the run that proved the feature works.

Two hazards, both fixed, both worth remembering because both burn macOS minutes
at ten times the Linux rate before anyone notices:

1. **The re-run signal was the run log.** GitHub echoes every composite step's
   script source into the log, so grepping it for `no baseline map found` matched
   the echoed source on every PR run in the repo, not the runs that actually hit
   that branch. A completed baseline would have re-run all fifteen open PRs. It
   now reads the PR's own sticky comment instead, which only says "no baseline
   map yet" or "building the first map" when it really happened.
2. **Nothing broke the cycle.** If a baseline completes and the PR still finds no
   map, the PR dispatches another baseline, which re-runs the PR, forever. A
   dispatch is now suppressed when a baseline succeeded in the last 90 minutes,
   and the run says why.

Neither is exercised by a repo that works. The first shows up the moment a repo
has more than one open PR; the second whenever a baseline cannot produce what
the PR is looking for.

## The bogus-param probe cannot see through a fallback

Found by running fifteen PRs against screenmap-test on 2026-08-28.

`verifyDeepLink()`'s bogus-param reference proves only that a route renders the
same screen for a real value and an impossible one. That happens in two very
different situations:

- the parameter did not resolve, and both render not-found; or
- the screen quietly falls back to a default.

screenmap-test's own timer is the second kind — `brew/[id].tsx` has
`methodById(id) ?? METHODS[0]` — so the probe fires whether `params` is correct
(PR #11) or deliberately broken (PR #3). Both captures are a valid V60 timer.
No false negatives, but no discrimination either, and the warning had to stop
claiming "not-found".

Worth doing, in order:

1. Compare the capture against the baseline capture of the same route. A screen
   whose parameter broke this PR looks different from the same screen last time;
   a fallback looks identical. This distinguishes the two cases with data we
   already have, and costs nothing.
2. Treat a route whose bogus probe matches as *unparameterised in practice* and
   say so once, rather than warning about it on every PR forever.
3. Landmarks remain the only strong signal. The surest fix for a repo is a
   committed flow with a `landmarks` sidecar, which the docs should say plainly.

## Decide `suspects.broadCap`

Now that tsconfig aliases resolve, a change to a shared data file marks every
screen that imports it. Measured on screenmap-test PR #5: a one-word change in
`src/data/methods.ts` marked 8 screens, the whole app bar the one that does not
import it, and `broadFiles` stayed empty because seven importers sit under the
cap of eight. `broadCap` (default 8) is the only thing between
a data-file edit and re-capturing the whole app on every PR.

Either the cap is right and the default is too high, or the honest answer is a
separate rule for data modules. Worth deciding with a second real repo rather
than from first principles.

## Computed link targets are invisible to the parser

`href={item.href}` and anything else built from data cannot be resolved
statically, so those edges are missing from the map. `parse-routes.mjs` now
reports routes with no incoming link rather than drawing them as islands, which
makes the gap visible but does not close it. Closing it means evaluating the
data module, or reading hrefs back off the running app during capture.

## Cache the CI install step

Fixed overhead on every run, from the screenmap-test timings: "Install
screenmap-ci" (npm install plus `@swmansion/argent`) takes 2m41s, and the
one-time Vision OCR helper compile plus session boot another ~90s. That is
roughly a third of a 12-minute job, redone every time.

## Site: note the `workflow` scope

Pushing the two workflow files under a `gh auth login` token fails with
`refusing to allow an OAuth App to create or update workflow ... without
workflow scope`. Anyone following the setup instructions with an agent hits it
at the first push. One line on the page: `gh auth refresh -s workflow`, or push
over SSH.

## Deploy the site with the global Vercel CLI, not `npx`

`npx vercel` fetches CLI 59.7.0, which fails every deploy from this machine with
`Not authorized`. The globally installed 54.6.1 (`~/Library/pnpm/bin/vercel`)
works with no `--scope` and no re-linking. Both `.vercel/project.json` files are
correct: a personal Vercel account is represented internally as a `team_...` id,
so `team_cgCiwy8h4rZHlZiUQyGT4qCb` is right and not stale.

    cd site && vercel --prod

## Rotate `EXPO_TOKEN`

The token for `aleqsio/screenmap-test` was pasted in plaintext into a Claude
Code transcript on 2026-08-27. It is set as a repo secret and works; rotate it
at expo.dev when the demo work is finished.

---

## Done in this pass

Kept for context on what changed, since several of these alter behaviour.

- tsconfig `paths` were destroyed by a non-string-aware JSONC comment stripper,
  emptying the alias map so `import-touched` suspects could never fire. On
  screenmap-test PR #1 that under-reported 8 affected screens as 1.
- Link scanning follows a route's first-party imports one hop, so a `<Link>` in
  a list-item component no longer leaves a screen looking unreachable.
- `effort` (`fast` / `balanced` / `thorough`) replaces reasoning about `scan`,
  `maxScreens` and `suspects.depth` separately. Default is `balanced`, which
  spends a little more than previous behaviour.
- `deterministic` joins the presets: no agent, no tokens, committed flows replay
  and everything else is deep-linked. An unstated `effort` resolves to it when no
  agent key is available, so a keyless run is a named mode rather than a degraded
  one. An effort you state explicitly is still honoured even when it cannot run.
- The PR comment is posted when the run starts and rewritten as it progresses,
  including a no-baseline state that names the workflow_dispatch trigger.
- The viewer's Changes view stopped showing unchanged screens as NO CAPTURE.
- The expo-dev-menu floating gear is muted; it had been in every capture since
  dev-menu 57.
- Deep-link captures are verified, not assumed. `verifyDeepLink()` checks a
  committed flow's landmarks, or — for a parameterised route — opens the same
  route with an impossible value and compares: if the real id and a nonsense one
  render the same screen, the real one resolved no better. Local OCR, no tokens.
  Failures now reach the agent whether or not a flow exists, and the comment
  names them instead of presenting a not-found screen as the screen.
- `flows-adopt` moves locally recorded flows into the directory CI replays from,
  refusing to overwrite a committed flow that differs.
