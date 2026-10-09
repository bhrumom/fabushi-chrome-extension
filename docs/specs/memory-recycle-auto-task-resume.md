# Memory recycle must automatically resume the original task

Status: active
Owner: Fabushi Chrome extension
Updated: 2026-10-10

## Problem and goal
The installed memory-request path discard/reloads a bare conversation URL, unlike the watchdog path. Replacement can erase sessionStorage identity. The workbench then shows zero local tasks while the original task remains in an offline workspace. Recovery must automatically reclaim and supervise the exact original task without Start/Restore or a new task tab.

## Requirements
- R1: Probe durable exact-route task checkpoint before destructive memory recycling. Defer missing, ambiguous, paused or differently owned checkpoints.
- R2: Return with an explicit fabushi-host recovery token; the existing pre-bootstrap adapter reconstructs the owner ticket using durable origin state even with empty sessionStorage.
- R3: Recheck current URL/pending URL after asynchronous probe; defer user navigation or newly active automatic-recovery tabs.
- R4: Retain task id, owner, phase, round, send token, goal and attachments; no duplicate send, no new task tab, no permission change.
- R5: Preserve existing pause and cooldown policy. Discard-returned replacement ID remains authoritative.
- R6: Use the real pinned standalone userscript in an integration check to verify workspace ownership, automatic runner start and supervision, not merely token creation.

## Architecture and dependencies
Consolidates the existing hung-tab recovery adapter/watchdog work from PR #22 and background scheduling/discard-returned-ID work from PR #23. The watchdog remains the single hung-page recovery owner. The memory-request path now uses the same explicit host-ticket contract.

## Acceptance
- AC1: Production memory request returns host-token URL after simulated sessionStorage loss and changed discard ID; original workbench snapshot unchanged.
- AC2: Actual standalone bootstrap reclaims owner, starts supervision and handles the same current turn automatically without manual task commands or a duplicate user prompt.
- AC3: Paused/ambiguous/moved/protected/active automatic-recovery cases stay non-destructive.
- AC4: Required regression and exact-head GitHub Actions validation; source deliverable submitted to canonical extension repository.

## Verification and release
Run extension .test.mjs regressions and Marketplace test. In Actions, check out standalone source at 237f9852cffc955e2fa9aae1ba65a80db3b15233, install its locked jsdom dependency and run real bootstrap integration. This pins the compatibility contract and prevents external latest-source drift. Package/signed release and a naturally prolonged hung/high-memory renderer are separate acceptance gates; no claim that those are completed.

## Evidence and compliance
- R1/R2/R3/R5 and AC1/AC3: passed; six focused production-memory/adapter tests cover discarded ID changes, empty session identity, active tabs, missing/moved/different owner, paused and ambiguous checkpoints.
- R4/R6 and AC2: passed; real standalone 237f985 bootstrap automatically claims original-owner, acquires runner lock, performs a supervisor scan, enters generating at Work round 27, preserves original-send and original-attachment, and makes zero Send clicks. No Start/Restore commands used.
- Regression: passed; 71 Node tests, zero failures/skips, plus real bootstrap integration (one test), 43 syntax checks, parity inventory check and git diff --check.
- AC4: source submission and exact-head Actions pending.
- Natural prolonged high-memory/hung-renderer acceptance: blocked; not triggered in this turn. Local installed patch previously passed six focused adapter/memory-request tests and ordinary installed-extension reload retained one task. That observation is separate from automatic high-memory trigger acceptance.
