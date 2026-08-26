# .diff.scrmap bundle format (v1)

A `.diff.scrmap` file is a plain **zip** describing how an app's navigation map changed
between two revisions — typically the base and head of a pull request. It follows git
semantics: the artifact *is* the diff, self-contained and shareable, like a `.patch`
with screenshots.

It embeds both sides' graphs plus captures for the **suspect set** only — the screens
static analysis says the change could touch — not a full re-capture of the app.

```
myapp-pr123.diff.scrmap         (zip)
├── manifest.json              # formatVersion: 1, kind: "diff", base/head/pr metadata
├── diff.json                  # the verdict: nodes/edges/states classified A/M/D
├── base/map.json              # full graph of the base revision (map.json schema from screenmap v2)
├── head/map.json              # full graph of the head revision
├── base/screens/*.png         # suspect-set captures at base
└── head/screens/*.png         # suspect-set captures at head
```

Verdicts are **static-only**: a screen is `modified` iff the change set touches its
route file or a file in its (bounded) import closure. Screenshots are evidence for the
human reviewing the diff, not input to the classification.

## manifest.json

```jsonc
{
  "formatVersion": 1,
  "kind": "diff",                  // discriminates from plain .scrmap bundles
  "generator": "screenmap/1.0",
  "app": { "name": "bluesky", "scheme": "bluesky", "platform": "ios-simulator",
           "device": "iPhone 17 Pro", "mode": "react-navigation" },
  "base": { "ref": "main", "commit": "abc1234", "generatedAt": "…" },
  "head": { "ref": "beta-features", "commit": "def5678", "generatedAt": "…" },
  "pr": {                          // optional — present when diffing a PR
    "number": 11123,
    "title": "Add setting for opting in to beta features",
    "url": "https://github.com/bluesky-social/social-app/pull/11123"
  },
  "generatedAt": "…"
}
```

## diff.json

Statuses use git letters: `A` added · `M` modified · `D` removed. Unchanged
nodes/edges are *not* listed — viewers derive them from `head/map.json`.

```jsonc
{
  "changedFiles": ["src/screens/Settings/Settings.tsx", "…"],   // the PR's file list
  "broadFiles": [                  // changed files excluded from suspect expansion
    { "file": "src/state/queries/preferences/index.ts", "importedByRoutes": 41 }
  ],
  "nodes": [
    { "id": "BetaFeaturesSettings", "status": "A",
      "reason": "route-added" },
    { "id": "Settings", "status": "M",
      "reason": "file-touched",              // or "import-touched"
      "via": ["src/screens/Settings/Settings.tsx"],  // which changed files implicate it
      "depth": 0,                            // import distance; 0 = route file itself
      "note": "New 'Beta features' row between Languages and Help" },
                                             // what visibly changes — authored by
                                             // whoever read the PR diff (notes.json
                                             // in the working dir, keyed by node id)
    { "id": "OldScreen", "status": "D", "reason": "route-removed" }
  ],
  "dismissed": [                   // statically-flagged suspects a human/agent
    { "id": "ProfileSearch",       // judged visually unaffected — dropped from
      "reason": "import-touched",  // nodes, kept here so the call is auditable
      "note": "Shares Explore code by import; those modules don't render here." }
  ],
  "edges": [
    { "from": "Settings", "to": "BetaFeaturesSettings", "status": "A",
      "raw": "navigate('BetaFeaturesSettings')" }
  ],
  "states": [
    // Per-capture-state ledger for every (non-dismissed) suspect: the bare
    // screen is name "" and each captured variant is listed by name, so a
    // change that only shows in one state (a scrolled list, an open sheet)
    // points the reviewer at that exact state. Statuses: A | M | D |
    // "unchanged" (agent judged that state visually unaffected via notes.json
    // per-state verdicts). reason "hint" entries are advisory stateHint
    // changes with no capture backing them.
    { "node": "Settings", "name": "", "status": "unchanged", "reason": "capture",
      "note": "Top of the list is identical — the new row is below the fold." },
    { "node": "Settings", "name": "bottom", "status": "M", "reason": "capture",
      "note": "New 'Beta features' row appears between Languages and Help." },
    { "node": "BetaFeaturesSettings", "name": "bottom-sheet:app-dialog",
      "status": "A", "reason": "hint" }
  ]
}
```

Semantics:

- **Node identity** is the route id. A route present only in head is `A`; only in
  base is `D`. A rename (same file, new id) appears as `D`+`A` — producers may note
  the suspected rename in `reason`.
- **Edge identity** is `(from, to, target)` on statically resolved edges. Unresolved
  edges (`to: null`) are ignored by the differ.
- **`M` is a static claim**, not a visual one. Screenshots let the reviewer see
  whether the touched screen actually looks different; the bundle does not judge.
- **broadFiles** records honesty about scope: a changed file imported by more routes
  than the expansion cap is excluded from suspect marking (it would flag the whole
  app) and surfaced here so the reviewer knows the blind spot.
- **Captures**: `base/screens/` and `head/screens/` are slug-named like plain
  bundles. `A` nodes have head captures only, `D` nodes base only, `M` nodes ideally
  both. Missing captures are allowed (e.g. auth-walled) — viewers show a placeholder.
- Viewers must ignore unknown fields and reject `formatVersion` they don't support.
- **Backdrop merge**: viewers MAY overlay a diff on a full `.scrmap` of the same app
  (matched by `app.name`) — unchanged screens then show their real (dimmed)
  screenshots from the full bundle while the diff supplies annotations and
  base/head captures for the suspect set. The reference visualiser does this
  automatically when both bundles are loaded.

## Working directory

The screenmap skill assembles diffs under `<project>/.screenmap/out/diff/<slug>/`
(`pr-<number>` or `<baseRef>..<headRef>`):

```
.screenmap/out/diff/pr-11123/
├── pr.json               # {number,title,url,baseSha,headSha,baseRef,headRef}
├── changed-files.txt     # one path per line (git diff --name-only base...head)
├── base/graph.json       # parse-routes.mjs output at base
├── base/screens/*.png
├── head/graph.json
├── head/screens/*.png
├── suspects.json         # diff-map.mjs suspects → capture work-list
└── diff.json             # diff-map.mjs pack
```
