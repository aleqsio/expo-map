---
name: appmap-project
description: Project-specific guidance for the appmap agent when it explores screens of THIS app in CI. Layered on top of the generic expo-map skill.
---

# How to explore this app

<!-- Copy to .appmap/SKILL.md and edit. Everything here is advice the agent
     follows when a screen has no committed flow. Keep it short and concrete. -->

## Signing in
- The test account is signed in on the simulator image; if you land on the login screen, stop and report it — never type credentials. (If input is unavoidable, use `{{secret:APPMAP_TEST_PASSWORD}}` placeholders, never literals.)

## Real params
- `/profile/:name` → use `bsky.app`
- `/post/:id` → IDs under the test account resolve; random IDs show "not found" (don't mark those as broken screens)

## Never touch
- Delete account, deactivate, sign out, purchase/subscribe, send/post/submit, block/report.

## Timing
- Feed and profile screens need ~6s to settle; settings screens ~2.5s.

## Notes vocabulary
- Say what a user would see ("the Trending module gets its own header"), not how the code changed.
