# Paired userscript v2.9.63 and elevated-pressure tab discard — Specification

Status: active
Owner: Fabushi browser engineering
Last updated: 2026-09-23
Related task: FCE-HR-006

## 1. Context / problem
The bundled userscript now requests host tab cleanup after two elevated-or-high JavaScript-heap samples at or above 1 GiB. The MV3 host currently accepts automatic discard requests only when pressure is `high`, so the two components disagree and an elevated request is rejected. Chrome's tab discard unloads a non-active tab and restores it when opened; it cannot clear the active tab while keeping it live.

## 2. Goal
Publish the verified userscript as v2.9.63, align the Fabushi extension host policy with its elevated-pressure request contract, bundle the exact published userscript, publish Fabushi Chrome v0.6.20, and install that release into the local Chrome profile.

## 3. Non-goals
- Do not discard an active tab, a tab with unsaved input/files, or a tab with in-flight task/approval/navigation state.
- Do not claim a live active tab can be reset to its initial process memory while remaining loaded.
- Do not add process RSS telemetry or permissions beyond the existing `tabs` API.
- Do not alter keep-awake/recovery lease behavior.

## 4. Requirements
- R1: Release userscript v2.9.63 with same-chat interruption continuation, recovered ended-draft detection, and the sustained elevated/high >=1 GiB host request gate.
- R2: Host accepts automatic `elevated` pressure only when the reported JS heap is at least 1 GiB; `high` remains eligible. Manual requests remain pressure-independent.
- R3: Existing host identity, ChatGPT URL, enabled-script, active-tab, unsafe-state, and cooldown checks remain enforced.
- R4: Add host unit coverage for eligible and under-threshold elevated requests and refusal reasons.
- R5: Package extension v0.6.20 with bundled userscript byte-identical to v2.9.63 source; validate release tag/version and keep-awake contract.
- R6: Publish both releases only after exact-head PR checks and merged-main checks pass; record run IDs, SHAs, asset digests, and source blob identity.
- R7: Install the released extension package in the user's local Chrome profile and verify its installed version and that the paired userscript is enabled.

## 5. Current state
The extension v0.6.19 host already bridges `tab-memory.request` to `chrome.tabs.discard()`, but `userscript-memory-policy.js` accepts only `high` automatic pressure. The userscript candidate v2.9.63 applies the elevated/high gate. Releases v2.9.62 and v0.6.19 are the published baselines.

## 6. Target state
v2.9.63 is the canonical released userscript. Extension v0.6.20 accepts eligible elevated requests, returns explicit active/unsafe/threshold/cooldown outcomes, and bundles the byte-identical v2.9.63 script. Both GitHub releases and the local Chrome installation match these versions.

## 7. Architecture and ownership
Userscript owns detection, safety context and redacted JS heap estimate. Extension content bridge forwards the request. MV3 service worker validates the enabled script, tab, pressure threshold, task safety and cooldown before calling `chrome.tabs.discard()`. Chrome reloads discarded tabs when selected.

## 8. Interfaces and data flow
`tab-memory.request` payload includes capability `tab-memory-discard`, pressure, `usedBytes`, and safety flags. Automatic `elevated` requires `usedBytes >= 1 GiB`; automatic `high` remains eligible. Manual user-initiated requests bypass pressure thresholds only; all host identity, URL, active-tab, unsafe-state, and cooldown checks remain.

## 9. Constraints
No new permissions. No arbitrary tab discard. Preserve active/in-flight safety and existing tab restore semantics.

## 10. Failure modes
Active tab -> `active-tab`; draft/upload/task state -> `unsafe-state`; below threshold -> `pressure-not-elevated`; unavailable host/tab and discard failure return explicit failures; cooldown remains explicit.

## 11. Implementation strategy
Repair this spec, implement host policy and tests, bump extension release validation/version, copy the released userscript into the extension bundle, update project task/evidence tracking, run both repository test suites, publish userscript, then publish extension, install, and verify Chrome.

## 12. Verification
Userscript repository `npm test`; extension syntax checks and `node --test chatgpt-vps-control/tests/*.test.*`; verify userscript bundle SHA matches source; verify extension archive manifest/version/userscript bytes; inspect local Chrome extension version and enabled script.

## 13. Acceptance criteria
- AC-1: Userscript v2.9.63 release exists and all userscript checks pass.
- AC-2: Elevated >= 1 GiB host request can discard only an inactive safe tab; elevated below 1 GiB is rejected.
- AC-3: Host tests preserve active/unsafe/cooldown and keep-awake behavior.
- AC-4: Extension v0.6.20 release bundles the exact userscript v2.9.63 blob and has a verified ZIP asset.
- AC-5: Local Chrome shows extension v0.6.20 enabled with userscript v2.9.63 enabled.

## 14. Release, migration, rollback
Use the repositories' PR and GitHub Actions release workflows. Roll back to userscript v2.9.62 / extension v0.6.19 if active/unsafe protections regress; retain prior installed package until the new version is verified.

## 15. Observability
Keep userscript response reasons visible in the Fabushi panel. Record PR exact-head/main/tag run IDs, merge SHAs, userscript blob SHA, extension release asset SHA-256, and local install version.

## 16. References
- `projects/chatgpt-host-resilience/SOURCE_OF_TRUTH.md`
- `projects/chatgpt-host-resilience/management/tasks/FCE-HR-005-bundle-userscript-2.9.46.md`
- Chrome `tabs.discard`: https://developer.chrome.com/docs/extensions/reference/api/tabs#method-discard
- User request and screenshots, 2026-09-23.

## 17. Spec compliance record
| Requirement / AC | Status | Evidence / reason |
|---|---|---|
| R1-R7 / AC-1-AC-5 | pending | Implementation and release verification pending. |
