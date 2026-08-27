# TODOs

Open work across the three repos, as of 2026-08-27. Everything here came out of
setting up `aleqsio/screenmap-test` from scratch and running it end to end;
the full write-up of what that turned up is in `site/docs/setup-instruction-fixes.md`.

---

## Verify that a deep link actually arrived

The highest-value item on this list, and it costs nothing to run.

`session.visit()` resolving counts as a successful capture. Nothing checks that
the app landed on the screen we asked for, so a route that starts requiring a
param captures its own not-found state and reports it as that screen. The run
goes green.

The check already exists: `verifyLanding()` OCRs the capture for the landmarks
in a flow's `.meta.json` sidecar. It runs only on flow replays, never on
deep-link captures. Vision OCR is local, so extending it costs no tokens.

Two parts:

1. Verify deep-link captures the same way replays are verified. A route's own
   landmarks come from its committed flow sidecar when there is one; for routes
   with no flow, the baseline capture's OCR text is a usable reference.
2. Route the failures to the agent. Today only `result.unflowed` reaches the
   agent lane, and that is gated on having no committed flow at all
   (`screenmap-ci.mjs`, the `if (!f)` in the deep-link branch). A route whose
   flow exists but could not replay falls through to a deep link and is never
   re-checked, however wrong the result looks.

With both, `effort` becomes a real cost dial rather than a guess: `fast` still
detects bad captures, and only the screens that failed cost agent tokens.

## Decide `suspects.broadCap`

Now that tsconfig aliases resolve, a change to a shared data file marks every
screen that imports it. On screenmap-test, editing `src/data/methods.ts`
correctly marks 9 of 9 screens. `broadCap` (default 8) is the only thing between
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
- The PR comment is posted when the run starts and rewritten as it progresses,
  including a no-baseline state that names the workflow_dispatch trigger.
- The viewer's Changes view stopped showing unchanged screens as NO CAPTURE.
- The expo-dev-menu floating gear is muted; it had been in every capture since
  dev-menu 57.
