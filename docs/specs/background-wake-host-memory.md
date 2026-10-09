# Background wake and host memory recovery — Specification
Status: active
Owner: canonical standalone userscript
Last updated: 2026-10-09

## Context / goal
The user's hidden ChatGPT tabs process send confirmation and approval only after activation. Main d0d3368 runs 40 chained 250 ms page timers after Send; Chrome intensive background throttling can stretch this to minutes. Memory recovery is explicitly disabled by v2.9.99. The latest user request supersedes that diagnostic-only policy for safe inactive tabs.

## Requirements and acceptance
- R1: All hidden-page runner, heartbeat, popup, global approval and startup timers plus asynchronous waits use an optional Fabushi host clock; local timers remain a compatibility fallback. Cancellation and instance shutdown remove pending callbacks. No concurrent runner or duplicate send.
- R2: Host alarm messages wake supervision and approval without activating the tab. Wake requests preserve manual pause, scoped authorization, cooldowns and exclusive runner ownership.
- R3: Two elevated/high samples of at least 1 GiB request host memory cleanup only for hidden, safe tabs after durable checkpoint succeeds. Preserve URL/token/phase/round/attachment metadata; reject draft, upload, send ambiguity, navigation or failed persistence. Never reload from userscript.
- R4: Host releases and immediately reloads the same inactive tab; no replacement tab or focus change. Five-minute cooldown survives MV3 worker suspension through session storage; legacy crash watchdog must not race memory discard into a replacement tab. Host denials and unavailable host are reported.
- R5: Distinguish JS heap estimate from renderer memory; never claim full-tab memory measurement or guaranteed recovery of a frozen renderer.

## Current / target architecture and contracts
Userscript owns task checkpoint and guards. Optional messages `background-clock.request/response` carry requestId and bounded delayMs (0–20000 ms); `background-wake` is a host pulse. Automatic `tab-memory.request` uses the new `tab-memory-discard-resume` capability plus `resumeAfterDiscard:true`; old hosts reject it safely instead of discarding without resumption. Manual legacy capability stays compatible; content bridge forwards only bounded fields. Extension owns alarm, clock, discard and same-tab reload. Standalone execution remains supported by page timers.

## Constraints / failures / non-goals
No new permissions, forced tab activation, permanent approval, fresh-chat resend, or active-tab discard. Browser sleep/freeze and full renderer memory metrics remain outside this patch. Bridge events are advisory; they do not confer task ownership. Memory requests may be delayed to a safe boundary.

## Plan / verification / release
Add bounded clock with abort cleanup; direct wake through existing runner mutex; restore two-sample pressure policy with durable checkpoint. Add paired host clock/alarm and same-tab reload. Run userscript full regression suite and host-focused regression tests; deliver reviewable paired patches/branches. Installed Chrome long-hidden-tab and real-pressure acceptance must be reported separately and cannot be inferred from simulated tests. Rollback both commits restores page clock and diagnostic-only policy.

## References
User request and screenshot 2026-10-09; AGENTS.md; continuous-task-no-memory-auto-reload-v2.9.99.md (memory-only requirements superseded); resumed-ended-task-and-tab-memory.md; Chrome timer throttling and tabs API documentation.

## Compliance
| Requirement | Status | Evidence |
| --- | --- | --- |
| R1 | passed | Host clock covers hidden runner, heartbeat, popup, approval and startup scheduling; withheld-page-timer test completes an owned task; abort cleanup is tested. |
| R2 | passed | Host alarm only wakes matching enabled inactive ChatGPT tabs; runner mutex and manual pause regression retained. |
| R3 | passed | Two-sample pressure test observes complete URL/token/phase/round checkpoint before request; drafts, ambiguous sends and failed storage are rejected. |
| R4 | passed | Host tests verify ordered discard/reload of the same tab, cooldown, reload-failure response and suppression of racing legacy takeover. Old hosts reject the new automatic resume capability. |
| R5 | passed | UI/README distinguish JS heap estimate and state frozen-renderer limitations. |
| Regression | passed | Userscript 382 passed, 7 existing skips, 0 failures; extension CI test inventory plus new host tests 50 passed; 23 JavaScript syntax checks and parity ledger passed; git diff --check passed. |
| Controlled browser fixture | blocked | Real host clock completed 40 waits with page timers withheld in about 13 seconds; two natural alarm pulses and one fixture approval were observed. Automation kept visibility visible (fixture override required), and the worker/page handle expired during reload verification. This is not prolonged hidden live-account acceptance. |
| Installed acceptance | passed with limits | Native Chrome confirms one enabled canonical script at 2.10.39. Two real hidden task pages continued scanning over 463 seconds (5 to 47 and 43 to 78); 40 host-clock waits of 250 ms completed in 10259 ms with hidden=true. An isolated paused task received synthetic 2 GiB heap pressure; automatic discard/reload retained window 1123698329 and tab-strip index 13, hidden/inactive state, script version, task ID daa490e4-5f65-4dbf-bb93-a45b755078b5, goal, work phase, round 1 and pause. Natural renderer-pressure/freeze acceptance remains separate. |

## Extension ownership correction
Owner: canonical Fabushi Chrome extension. Userscript changes are delivered in its separate canonical repository. Host base: 300134c. Host timer accepts only top-frame ChatGPT senders; alarm wakes only tabs matching an enabled canonical userscript. Reload failure returns an explicit reason; browser tabs are never created for memory recovery.

Canonical local imports with the exact script name and namespace replace the managed record and retain its plugin identity. This prevents duplicate execution and keeps the host wake and memory bridge bound to the installed script. A regression verifies one record after import.

Native Chrome revealed that discard replaces the internal extension tab ID (1123699053 to 1123699056) while retaining the same tab-strip position. Reload must use the ID returned by discard. Transfer cooldown and recovery lease records to that ID; migration failure after destruction must not prevent reload. No tabs.create is used by recovery. Regression covers both stable and changed discard IDs.
