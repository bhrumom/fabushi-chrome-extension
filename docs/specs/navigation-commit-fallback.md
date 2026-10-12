# Same-document navigation commit fallback
Status: active
Owner: Fabushi userscript and Chrome extension
Last updated: 2026-10-11
Related task: original conversation 6acb729c-fb70-83e8-a520-9a124995d980

## 1. Context / problem
Live logs show two reload attempts timing out without document unload, followed by durable exhaustion. Chrome native reload actually unloads the document; frontend assets may still be delayed by network conditions. Installed Marketplace version is 2.10.47.
## 2. Goal
Use one host reload fallback when a recovery navigation fails to unload the original document.
## 3. Non-goals
No new tab, no resend, no account/network settings change, no unlimited retry loop; network availability is external.
## 4. Requirements
- R1: At recovery commit timeout, request one guarded same-URL host reload for the current task generation.
- R2: Recheck running, ownership, phase, round, goal revision, URL, pause/final reply, draft and attachment before requesting and before committing host reload.
- R3: The host requires a live, unconsumed recovery lease matching sender tab, same URL, task/workspace and generation. Reload with chrome.tabs.reload; never update or create a tab.
- R4: Record the fallback attempt before asynchronous work. No repeat within the recovery generation; real progress/reset clears this budget. Legacy exhausted tasks can use the same fallback once.
- R5: Preserve goal/token/attachments/task ID and report failure without claiming recovery succeeded.
## 5. Current state
Watchdog only releases navigating. Persistent loading retry is already present in 2.10.47 but uses page-side reload.
## 6. Target state
A page-side no-op reload can escalate once to Chrome's native reload through the existing content bridge and navigation guard.
## 7. Architecture / ownership
Userscript owns task validity and reply/draft checks. Extension owns lease validation and native tab reload.
## 8. Interface
navigation-guard.request adds hostReload=true to obtain a lease without standalone fallback. navigation-guard.commit forwards capability, leaseId, targetURL, ownerTabId, taskId, phase, round and goalRevision. Response uses existing granted/denied envelope.
## 9. Constraints
Same HTTPS origin and existing allowed route rules; sender frame 0; no new permissions. Existing attempt limits remain intact.
## 10. Failure modes
Missing bridge/denial/stale lease/pause/new generation/final/draft: cancel or log and continue supervision. Actual reload may still load a stalled website; do not call this success.
## 11. Implementation
Add generation-scoped fallback helper and watchdog/exhaustion hook; content bridge commit forwarding; host one-use lease commit handler.
## 12. Verification
Real host listener VM tests: matching lease reloads once; replay, cross-route, foreign workspace, changed generation and non-recovery lease denied. Userscript fixtures: fallback sent once, pause/draft/final/stale generation suppress commit, existing suite passes.
## 13. Acceptance
AC1: Valid host fallback reloads original tab only.
AC2: No duplicate send/new-chat; task identity preserved.
AC3: Live original conversation recovers or external blocker is recorded honestly.
## 14. Release / rollback
Deliver paired draft PRs and installed update if feasible. Revert paired change to restore page-only reload behavior.
## 15. Observability
Log fallback request and failure. Source tests and live site loading are separate evidence.
## 16. References
renderer-shell-hydration-bounded-recovery-v2.10.4.md (userscript); project-conversation-navigation.md (extension); user screenshot and native Chrome observations.
## 17. Spec compliance
Pending verification; final statuses will be recorded after checks.

## Verification record
Passed: deterministic source generation and syntax checks; userscript full suite 419 total, 412 pass, 7 skipped, 0 failures. Host listener suite 15 pass, 0 failures. Review complete/next and rejection cases; same-document one-shot and post-grant pause/round/draft checks passed.
Blocked: installed original conversation acceptance pending live installation/site availability; tests do not prove service/network recovery.
