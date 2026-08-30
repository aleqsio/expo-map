# .scrmap bundle format (v2)

A `.scrmap` file is a plain **zip** containing everything needed to render an application's
navigation map: the graph, screenshots, capture verdicts, and replayable flows.
It is the *interchange* format — the screenmap skill's working directory
(`.screenmap/out/` with `graph.json`, `capture-status.json`, `flows/`, `screens/`) is the
append-friendly *working* format, and `pack-map.mjs` merges it into a bundle.

The format is producer-agnostic: nothing in it is expo-specific. Any tool that can
enumerate screens, capture them, and describe transitions can emit a bundle.

**Flows are [argent](https://argent.swmansion.com) flow YAML** — Software Mansion's
agentic mobile toolkit — so every flow in a bundle replays headlessly, no LLM in the
loop: `argent flow run .screenmap/out/flows/<name>.yaml`. A `.meta.json` sidecar per flow
carries the cartography argent doesn't model: route ids, per-step screen hops,
capture files, and human target labels.

```
myapp-2026-08-08.scrmap        (zip)
├── manifest.json              # formatVersion: 2, flowFormat: "argent"
├── map.json
├── screens/*.png              # slug-named; state variants as <slug>--<state>.png
└── flows/
    ├── <name>.yaml            # argent flow — runnable via `argent flow run`
    └── <name>.meta.json       # sidecar: route, screen hops, captures, labels
```

(v1 bundles inlined JSON flows in `map.json`; viewers should keep reading them.)

## manifest.json

```jsonc
{
  "formatVersion": 1,
  "generator": "screenmap/1.0",
  "app": {
    "name": "bluesky",            // display name
    "scheme": "bluesky",          // deep-link scheme, null if unknown
    "platform": "ios-simulator",
    "device": "iPhone 17 Pro",    // device captures were taken on
    "mode": "react-navigation"    // the route provider that discovered the screens:
                                  //   expo-router | react-navigation | custom | …
                                  //   (see docs/route-providers.md)
  },
  "generatedAt": "2026-08-06T14:00:00.000Z"
}
```

## map.json

```jsonc
{
  "nodes": [{
    "id": "Profile",                    // unique; route id from the producer
    "title": "Profile",                 // display label — ALWAYS present; use this to
                                        //   label a node, not urlPath
    "urlPath": "/profile/:name",        // deep-link path pattern; NULL when the screen
                                        //   has no URL (normal in react-navigation)
    "reach": "deep-link",               // "deep-link" | "navigation-only" | "unknown"
    "file": "src/view/screens/Profile.tsx",  // source file, if known
    "slug": "Profile",                  // screenshot base name
    "group": "profile",                 // visual grouping (navigator dir / path segment)
    "navigator": "react-navigation",    // Stack | Tabs | Drawer | Slot | react-navigation | null
    "params": ["name"],
    "presentation": null,               // e.g. "modal"
    "stateHints": [{ "type": "bottom-sheet", "lib": "app-dialog", "snapPoints": null }],
    "capture": {
      "status": "ok",                   // ok | empty-state | not-found | error-boundary | loading | auth-wall | missing
      "note": null,                     // present when status != ok
      "needsNavigation": false,         // true → unreachable by bare deep link
      "screenshot": "screens/Profile.png",       // null if missing
      "states": [                       // runtime state variants
        { "name": "menu", "screenshot": "screens/Profile--menu.png" }
      ]
    }
  }],
  "edges": [{
    "from": "Home", "to": "StarterPack",       // node ids; "to" null = unresolved
    "raw": "navigate('StarterPack')",          // source expression
    "target": "/starter-pack/:name/:rkey"
  }],
  "flows": []                          // v2: always empty — flows live in flows/*.yaml
}
```

## Flows: argent YAML + sidecar

Each flow is a pair of files. The **YAML** is a standard [argent flow](https://argent.swmansion.com)
(directives: `launch`, `tap`, `type`, `scroll-to`, `await`, `assert`, `wait`, `snapshot`,
`run`, `when`, `tool`, …). All coordinates are **normalized 0–1**. Deep links use the
`open-url` tool step. Comments carry human labels for coordinate taps.

```yaml
# Open the profile … menu bottom sheet
steps:
  - tool: open-url
    args:
      url: "bluesky://profile/bsky.app"
  - wait: 2000
  # '…' overflow button in profile header
  - tap: { x: 0.9204, y: 0.2037 }
```

Prefer **selector taps** (`tap: Login`, `tap: { id: submit }`) when recorded via argent's
own tools — they survive layout changes. Coordinate taps are the fallback for recordings
made without accessibility-tree access.

The **`.meta.json` sidecar** maps YAML step indexes (0-based, sparse) to cartography:

```jsonc
{
  "formatVersion": 2,
  "name": "profile-open-menu",
  "title": "Open the profile … menu bottom sheet",
  "route": "Profile",                  // node id the flow targets
  "device": "iPhone 17 Pro",
  "recordedAt": "2026-08-06T13:00:00.000Z",
  "steps": {
    "6": { "target": "'…' overflow button in profile header", // durable human label
           "screen": "Profile",        // route id the app is on AFTER this step —
                                       // REQUIRED on navigating taps/swipes
           "capture": "Profile--menu.png" }  // screenshot taken after this step;
                                             // state variants attach to nodes this way
  },
  "landmarks": ["Share", "Mute", "Block", "Report"],  // words visible on the arrival
                                       // screen; CI replays OCR-check them to
                                       // detect drift (optional, recommended)
  "result": "Bottom sheet with Share/Mute/Block/Report options"
}
```

## Semantics

- **Node ↔ flow tie**: a node's canonical flow is the one with `route == node.id`
  (producers should emit at least a trivial deep-link flow per reachable node).
  Flows whose YAML contains only `open-url` / `wait` steps are **deterministic
  deep links**; flows with `tap` / `type` / gesture steps are **interactive** —
  both replay via `argent flow run`, no agent needed.
- **State variants** attach extra captures to a node; `screens/<slug>--<state>.png`.
- **Labelling**: use `title`. It is always present, while `urlPath` is null for any
  screen the producer could not give a URL — a react-navigation screen absent from the
  linking config, for instance. Bundles packed before `title` existed have neither
  field set on some nodes; fall back `title ?? urlPath ?? id`.
- **reach** is the producer's static verdict on how a screen can be opened, decided
  before any capture runs: `navigation-only` means there is no deep link at all, and
  the capture stage must navigate to it rather than visiting a URL. It seeds
  `capture.needsNavigation`, which remains the *observed* verdict and can also be set
  by an agent that found a screen unreachable in practice.
- **needsNavigation** nodes cannot be reached by bare deep link; their flow or note
  explains the in-app path.
- Viewers must ignore unknown fields and reject `formatVersion` they don't support.
