# Visible black frame recovery — Specification

Status: active
Owner: Fabushi Chrome extension
Last updated: 2026-11-03
Related incident: ChatGPT conversation 6ae8bb44-a120-83e8-a29e-688efaf4346d

## Context and goal

The reported Chrome tab showed an entirely black viewport while its accessibility tree still contained the conversation. The renderer used about one CPU core. The existing watchdog regards DOM text or controls as healthy, so that signal alone can miss this visual failure. A paused debugger stack pointed into ChatGPT's Statsig timer chain; it does not prove that Fabushi caused the loop. Recover a persistently black managed tab through the existing same-tab, task-preserving host path.

## Requirements

- R1: For a focused, active managed web tab whose DOM probe is healthy, independently inspect the rendered viewport. A nearly uniform black frame is suspect; ordinary dark-mode content is healthy.
- R2: Require 90 seconds of continuous suspect observations and a second black frame immediately before unload. Protect drafts, attachments, fresh canonical task heartbeats, loading/settling, navigation, background/frozen tabs, and the existing recovery budget.
- R3: Screenshot bytes remain in memory only. Do not persist, transmit, or log page pixels. Capture failures and unfocused windows are inconclusive, not proof of failure.
- R4: Keep the existing same-tab transit, checkpoint, and task ownership rules. No extra extension permission, tab, automatic Send, or storage reset.
- R5: Avoid reading the full conversation text just to test DOM health. Keep health probes bounded on long chats.

## Architecture

The background watchdog owns visual detection. It samples a low-quality viewport image through the existing tabs API, decodes it on an OffscreenCanvas, and counts dark pixels in a small grid. The page probe still protects drafts and attachments. The final destructive recheck uses a fresh DOM and visual observation. Only the existing rescue owner unloads and restores.

## Verification and acceptance

- AC1: Tests cover a DOM-healthy black viewport over the continuous threshold, a healthy dark-mode frame, inconclusive capture, protected input, and a recovered frame at final recheck.
- AC2: Existing extension and packaged Chrome tests, exact-head Actions, package provenance and release 0.7.4 pass.
- AC3: Installed extension version and a real natural black-frame recovery are observed separately. Until reproduced, record this gate as blocked rather than claiming success.

## Release and rollback

Publish through the existing tagged release workflow. Update the installed unpacked extension in place only after package verification; preserve its ID and storage. Roll back files to 0.7.3 if visual recovery incorrectly unloads a healthy tab.

## Evidence and compliance

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1-R2 / AC1 | passed | `userscript-watchdog.js` requires a continuously black visual sample for 90 seconds and a fresh final sample; `tab-rescue.test.mjs` verifies recovery, reset on a healthy final frame, protected input and inconclusive capture. |
| R3 | passed | `probeBlackFrame` reads a capture only in worker memory, reduces it to 16×16 pixels, returns only a boolean, and bounds a probe to five seconds. Capture failure is inconclusive. |
| R4 | passed | Existing `rescueSameTab` and checkpoint adapter are reused. Manifest permissions are unchanged; packaged browser recovery and bootstrap integration passed on PR #31 head `474a28f`. |
| R5 | passed | DOM health no longer reads `body.innerText`; it inspects limited candidate elements. |
| AC2 | passed | PR #31 merged at `caca3695f0299ed28d4fa8dd49f8f569e06b631a`; main Actions 41491068609 and tag Actions 41491115406 passed. Published v0.7.4 ZIP SHA256 `7b2367b72d386118b9bbdd932eb17f98f4e53e84ea9dd6f50879587bbd45c6ce`, all 36 package files verified, provenance and tag point to the merge commit. Existing unpacked installation was backed up and updated in place; Chrome extension details showed v0.7.4, the same ID `dhkifbfnclknmafelblbhikfecdieoea`, enabled state, and a running Service Worker after reload. |
| AC3 | blocked | The earlier incident is no longer black. Packaged E2E preserved same tab and task checkpoint, but a new natural long-chat black-frame recovery has not been observed. |
