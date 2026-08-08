# .appmap bundle format (v1)

A `.appmap` file is a plain **zip** containing everything needed to render an application's
navigation map: the graph, screenshots, capture verdicts, and replayable agent flows.
It is the *interchange* format — the expo-map skill's working directory
(`.expo-map/` with `graph.json`, `capture-status.json`, `flows/`, `screens/`) is the
append-friendly *working* format, and `pack-map.mjs` merges it into a bundle.

The format is producer-agnostic: nothing in it is expo-specific. Any tool that can
enumerate screens, capture them, and describe transitions can emit a bundle.

```
myapp-2026-08-06.appmap        (zip)
├── manifest.json
├── map.json
└── screens/*.png              # slug-named; state variants as <slug>--<state>.png
```

## manifest.json

```jsonc
{
  "formatVersion": 1,
  "generator": "expo-map/1.0",
  "app": {
    "name": "bluesky",            // display name
    "scheme": "bluesky",          // deep-link scheme, null if unknown
    "platform": "ios-simulator",
    "device": "iPhone 17 Pro",    // device captures were taken on
    "mode": "react-navigation"    // or "expo-router" — how routes were discovered
  },
  "generatedAt": "2026-08-06T14:00:00.000Z"
}
```

## map.json

```jsonc
{
  "nodes": [{
    "id": "Profile",                    // unique; route id from the producer
    "urlPath": "/profile/:name",        // deep-link path pattern
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
  "flows": [{                          // replayable agent flows (see SKILL.md schema)
    "name": "profile-open-menu",
    "title": "Open the profile … menu bottom sheet",
    "route": "Profile",                // node id the flow targets
    "device": "iPhone 17 Pro",
    "pointSize": [402, 874],           // device point dimensions for tap/swipe coordinates
                                       // (viewers default to [402, 874] when absent)
    "recordedAt": "2026-08-06T13:00:00.000Z",
    "steps": [
      { "action": "open_url", "url": "bluesky://profile/bsky.app" },
      { "action": "wait", "seconds": 2 },
      { "action": "tap", "target": "… button in profile header", "coordinate": [370, 178] },
      { "action": "screenshot", "file": "Profile--menu.png" }
    ],
    // any step may carry "screen": "<node id>" — the screen the app is on AFTER
    // the step runs. Required on taps/swipes that NAVIGATE to another screen,
    // so viewers can trace interactive flows across multiple nodes.
    "result": "Bottom sheet with Share/Mute/Block/Report options"
  }]
}
```

## Semantics

- **Node ↔ flow tie**: a node's canonical flow is the one with `route == node.id`
  (producers should emit at least a trivial deep-link flow per reachable node).
  Flows whose steps contain only `open_url` / `wait` / `screenshot` are **deterministic** —
  replayable as a plain shell script. Flows containing `tap` / `swipe` / `type` are
  **interactive** — coordinates are advisory (recorded-device points); `target` labels
  are the durable identifiers for an agent to re-find.
- **State variants** attach extra captures to a node; `screens/<slug>--<state>.png`.
- **needsNavigation** nodes cannot be reached by bare deep link; their flow or note
  explains the in-app path.
- Viewers must ignore unknown fields and reject `formatVersion` they don't support.
