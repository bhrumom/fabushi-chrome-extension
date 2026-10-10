# Automatic recovery of hung managed-script tabs

Status: active
Owner: Fabushi Chrome extension
Last updated: 2026-10-09
Related task: user's black-screen Recovery acceptance conversation

## 1. Context / problem
Chrome currently loads a local same-tab recovery patch. Both its lease monitor and
script supervisor expire silent pages after five minutes and use tabs.update with
the same URL, which does not reliably unload a hung renderer. Upstream main also
creates a replacement tab. The requested conversation is already blank.
## 2. Goal
Automatically detect and unload an unresponsive managed-script document and
restore its URL and persistent script checkpoint in the original tab.
## 3. Non-goals
Recover arbitrary JS stacks, unsaved data in a dead renderer, or fix website memory
leaks. Do not kill Chrome or a shared renderer process or create replacement tabs.
## 4. Requirements
- R1: Background health probes discover existing tabs matching enabled Fabushi scripts, including tabs already hung at extension upgrade; no fresh page heartbeat required.
- R2: Probe timeout/unavailable or empty visible content must persist at least 90 seconds before recovery. Healthy pages, drafts, frozen/discarded background pages and user navigation/close must not trigger recovery.
- R3: Persist attempt and destination before unloading. For every hung tab terminate execution with the existing debugger permission and navigate through an extension document, retaining the original tab-strip position, group and focus. Do not initiate discard: live Chrome changed the internal tab ID on that path. Retain onReplaced migration defensively for browser-originated replacement.
- R4: Restore the same URL AND automatically resume its previously running task, owner, phase, round, dispatch token and attachments. Native userscript registration and pageReady restore scripts. The extension's canonical-script adapter creates a fresh explicit same-route recovery ticket from persisted origin state before standalone script bootstrap, including when the prior heartbeat/recovery ticket expired. Never adopt an ambiguous owner or resume an explicitly paused/done/cancelled task. Fresh volatile JS stacks cannot be recovered.
- R5: Maximum two attempts per document in ten minutes, cooldown two minutes, independent probes bounded at five seconds; diagnostics and pending restoration survive MV3 eviction and browser sleep. No new permissions.
- R6: Preserve local installed script-import behavior and heartbeat compatibility when updating the existing extension.
- R7: Diagnostics offers an explicit repair action for a healthy page whose persisted running task is unclaimed after an earlier incomplete recovery. Validate enabled canonical script, exact route, readable unambiguous task and absence of draft/attachment; run the same background same-tab rescue with a fresh host ticket. Reject paused, already claimed, navigated or unreadable tasks. Record explicit repair separately from automatic hang recovery.
- R8 (2026-10-10): Restored documents must not enter another terminate/transit cycle while Chrome reports loading. Persist a two-minute post-restoration settling deadline before returning to the destination, including across worker eviction; during that interval reset failure evidence and leave script scheduling/loading checks in control. After settling and loading complete, require a fresh 90-second continuous failure before another bounded rescue. Final destructive recheck must also reject loading. A persisted restoring-stage record whose destination is already open must be consumed, never replayed as a prepared rescue. No new tab, owner reset or duplicate send. Tests cover slow restoration, final-check loading race and worker restart at destination; installed/runtime evidence remains separate.
## 5. Current state
Canonical repository main 300134c; installed extension ID dhkifbfnclknmafelblbhikfecdieoea in Downloads/fabushi-chrome-extension-fix-same-tab-memory-recovery. Local installed changes are backed up before update.
## 6. Target state
One background watchdog owns failed-page recovery. Recovery leases continue to provide persistent task context and keep-awake behavior.
## 7. Architecture / ownership
userscript-recovery owns task leases; userscript-watchdog owns bounded monitoring;
userscript-tab-rescue and tab-rescue page own renderer release and restoration.
## 8. Contracts / flow
Only enabled script match URLs are monitored. Session storage keeps observations,
budgets and pending destinations. Recovery lease remains in existing local storage.
Transit page is extension-owned and authenticated by sender tab ID and exact URL.
## 9. Constraints
No new permission, new tab, focus switch, broad process kill, or sending page content.
## 10. Failure cases
Debugger occupied -> still try cross-origin navigation; discard refused -> transit;
user navigated -> stop; slow network with a visible shell -> do not treat as crash;
repeated failed load -> stop after two attempts; frozen page -> defer; transit
interrupted by MV3 eviction -> next watchdog restores stored destination.
## 11. Strategy
Implement small health probe and background discovery; replace legacy crash scan
with watchdog delegation; use execution termination plus cross-origin transit for both active and inactive tabs.
## 12. Verification
Behavior tests for discovery, timeout/blank detection, same-tab release, draft and
navigation protection, crash-loop budgets, lease restoration, worker restart.
Run existing extension tests and inspect the installed extension and target UI. Add tab-rescue and task-recovery-adapter behavior tests to the existing release workflow regression step.
## 13. Acceptance
- AC1: Behavior and regression tests pass.
- AC2: Update actual installed directory and reload extension without resetting storage.
- AC3: Watchdog automatically recovers the named real Chrome tab; conversation and Fabushi script UI visible in the original tab-strip slot, and its original task automatically resumes without clicking Start/Restore. Verify migrated extension ID separately from tab-strip identity.
## 14. Release / rollback
Back up installed extension files; update only changed extension files in place.
Deliver patch and source package; roll back files and reload extension if needed.
## 15. Evidence
Tests, watchdog session diagnostic record, and Chrome screenshot of restored page.
## 16. References
User request and screenshot; Chrome tabs/debugger API docs; repository AGENTS.md;
local automatic-same-tab-memory-recovery.md superseded for this task (live Chrome
acceptance is explicitly required by the latest user instruction).
Latest user clarification: no manual target-tab action; initial discard restored
the page but lost the running workspace. Source inspection shows standalone
v2.10.38 disables automatic stale-workspace/host-lease recovery to respect tab
closure. Preserve that policy: only a host-issued explicit same-tab reload token
may resume the exact-route persisted owner; do not re-enable global stale stealing.
Chromium ExtensionTabsDiscardTest.DiscardEvent covers discard-triggered onReplaced
with a changed tab ID when kWebContentsDiscard is disabled.
## 17. Compliance
| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1, R2, R5 | passed | Discovery, continuous failure threshold, protective recheck, cooldown/budget and worker restart behavior tests. |
| R3 | passed | Active/inactive tests use terminate + extension transit with no discard/create/activation; installed Chrome explicit repair retained numeric ID. |
| R4, R7 | passed | Adapter refuses paused/ambiguous owners; real installed original task moved from unclaimed approval to claimed generating in its original workspace and round. |
| R6, AC2 | passed | Updated actual installed directory in place, retained its pre-existing import/bridge differences, reloaded existing extension without changing permissions or script storage. |
| AC1 | passed | All 59 Node .test.mjs checks pass, zero skipped; git diff --check passes. |
| AC3 | blocked | Earlier real watchdog trigger recovered the page via discard but lost the workspace. This continuation verified explicit plugin repair plus automatic script resumption in the original numeric tab. Final terminate/transit path has not yet been exercised against a new naturally hung long-duration renderer; do not claim that endurance criterion passed. |

## 18. Installed continuation evidence (2026-10-09, Asia/Shanghai)
- Verified loaded extension source in Chrome extension details, existing 0.7.0 permissions unchanged.
- 02:16:40: explicit-task-repair recorded terminate-transit-original-tab and equal before/after numeric tab ID.
- 02:16:57: restored script automatically handled the task's existing authorization card.
- 02:16:59: original round 2 moved to generating, without clicking script Start/Restore or sending a fresh goal.
- 02:19:05: background diagnostic showed healthy, original workspace claimed, same numeric tab ID.
- These are installed-runtime observations, not evidence of a new automatic 90-second hang trigger or long-duration endurance run.
- Published repository code uses the canonical main runner; installed runner retains earlier local registration fallback/bridge/import changes outside this patch. The task-ticket wrapper and rescue/watchdog/diagnostic files are the same.

Legacy .test.js check: marketplace-install passes; browser-extension and chrome-platform fail before assertions because local-install.js and desktop/electron/chrome-platform-server.cjs are absent from canonical HEAD. These migration leftovers are outside this patch; no legacy-suite pass is claimed.

## 19. CI follow-up
Exact-head run 37823767568 passed validate and artifact build/checksum verification. Packaged Chrome E2E cleanup raised ENOTEMPTY in its temporary profile and masked the primary test outcome. Repair fixture shutdown to await process exit after SIGKILL, retry temporary-directory cleanup, and report the primary failure before finally cleanup. Cleanup-only errors must not replace the primary error. No acceptance assertion is removed.

## 20. Restored loading protection compliance (2026-10-10)
R8 implementation: loading defers watchdog probes/recovery; restoration persists a fixed two-minute settling deadline and clears unhealthy evidence before destination navigation; resumed restoring-stage records are consumed without termination. Rescue also refuses a loading tab at both direct checks. Three regressions exercise slow loading and fresh failure accumulation, loading race, and restart after destination commit. Exact-head CI and native installation verification are required before delivery; natural long-duration freeze acceptance AC3 remains blocked as recorded above.
