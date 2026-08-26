# Testing the Action against the live sample repo

There is a standing dogfood repo: **https://github.com/aleqsio/expo-map-sample**
(local checkout: `~/Projects/expo-map-sample`). Use it to test Action changes on
real GitHub infrastructure instead of guessing. Every workflow there consumes
`aleqsio/screenmap@v1`, so **pushing to this repo's `main` is deploying** — the
next sample run picks it up.

## What the sample repo has

- A 6-screen expo-router app (tabs `/` `/explore` `/profile`, `/item/[id]` with a
  param, `/settings` pushed, `/modal` modal) whose parsed graph is known-good:
  6 routes, 4 edges, 1 modal hint.
- Secrets already set: `EXPO_TOKEN` (EAS project `9afaf3b2…`, owner `aleqsio`,
  profile `development-simulator`). `AGENT_API_KEY` is **not** set yet — the agent
  lane is `opencode`, which runs keylessly and produces nothing (expected).
- `.github/workflows/screenmap-baseline.yml` (push to main + weekday cron +
  `workflow_dispatch`) and `screenmap-pr.yml` (pull_request only — **no dispatch**).
- An `screenmaps` branch with published bundles: `main/<sha7>.scrmap`,
  `main/latest.scrmap`, `pr-<n>/<headsha>.diff.scrmap` (raw URLs are CORS-open).
- Demo PR **#1** (`appmap-demo/settings-restyle`): visible changes on `/settings`
  and `/item/[id]`; its sticky screenmap comment + viewer link are the reference for
  the PR lane working.

## How to run a test

```bash
# baseline lane (also runs automatically on every push to sample main — beware)
gh workflow run screenmap-baseline.yml -R aleqsio/expo-map-sample

# PR lane: no dispatch trigger — retrigger with an empty commit on the PR branch
cd ~/Projects/expo-map-sample && git checkout appmap-demo/settings-restyle
git commit --allow-empty -m "retrigger screenmap" && git push

# watch (run it in the background; a JS-only run takes ~12 min)
gh run watch <run-id> -R aleqsio/expo-map-sample --exit-status
```

Costs: public repo → runner minutes are free, but each run occupies a macOS
runner for ~12 min (JS-only, EAS build reused) or ~20 min (+ one EAS build when
the fingerprint changed). EAS builds spend the user's EAS quota — don't churn
native deps casually. Baseline runs queue serially (`concurrency:
screenmap-baseline`, no cancel-in-progress); cancel superseded ones.

## Debugging a failed run

1. `gh run view <id> -R aleqsio/expo-map-sample --log-failed` — the Action logs
   `[screenmap-ci]` lines to stderr; grep those, skip the simulator boot spam.
2. Failure artifacts: `screenmap-diagnostics-<runid>` (connect-timeout screenshot,
   metro.log, listapps, Metro /status probe). Download with
   `gh run download <id> -n <name> -D <dir>`.
3. Success artifact `screenmap-<mode>-<runid>` holds the bundle + `summary.json` —
   check `captured`, `drifted`, `agent.reason` there before reading logs.
4. Reruns (`gh run rerun <id> --failed`) re-resolve `@main`, so a fix pushed to
   this repo applies to a rerun. Succeeded runs cannot be rerun.
5. Reproduce locally without a runner: the CLI is the Action —
   `node action/cli/screenmap-ci.mjs baseline --project ~/Projects/expo-map-sample
   --previous <latest.scrmap> --no-sim --no-agent` exercises parse/suspects/pack;
   drop `--no-sim` to use the local simulator. `EXPO_TOKEN` + logged-in eas-cli
   let you test `resolve-app` locally too.

## Hard-won environment facts (don't rediscover)

- Fingerprints must come from `eas fingerprint:generate` — bare
  `@expo/fingerprint` hashes differently and reuse never matches.
- eas-cli flags are kebab-case: `--build-profile`, `--fingerprint-hash`.
- iOS 26 simulators gate `simctl openurl` custom schemes behind an
  "Open in …?" prompt — the Action pre-approves the scheme
  (`launchservices.schemeapproval` + SpringBoard respring) and OCR-taps "Open"
  as a fallback. Runners: `macos-26` (recent SDKs need Xcode 26.4+; `macos-15`
  tops out at 26.3, whose clang rejects expo-modules-jsi).
- Runners have 3 cores: never do heavy work (swiftc, builds) while Metro is
  bundling — `simctl` calls start timing out (POSIX 60). Treat `openurl`
  failures as retriable.
- Anything the CLI prints to stdout must be pure JSON (the yaml redirects it);
  child-process chatter goes to stderr.

Don't run tests speculatively — the user often prefers to trigger/verify runs
themselves. Ask or wait for an explicit "test it".
