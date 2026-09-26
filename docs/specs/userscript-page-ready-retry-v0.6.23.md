# ChatGPT userscript page-ready retry — Specification

Status: completed
Owner: Fabushi Chrome extension
Last updated: 2026-09-26
Related issue/task/PR: [PR #20](https://github.com/bhrumom/fabushi-chrome-extension/pull/20)

## 1. Context / problem

Fabushi's document-start content bridge requests activation of matching userscripts. The host caught per-script registration/execution errors and returned an empty started list, while the page-ready message handler replied `ok: true`. The bridge interpreted that as success and stopped retrying. Its separate tab-update fallback only retried at `status: complete`, which never occurs while ChatGPT remains stuck loading. GitHub's canonical v2.9.87 source already declares `@run-at document-start`; the observed delay was in the host's failed-activation acknowledgment/retry path. Fabushi now normalizes registration to document start to repair any stale persisted run timing.

## 2. Goal

Ensure the ChatGPT workbench is registered to appear at document start, matching enabled userscript activation failures are visible to the page-ready bridge, and failed handshakes retry in the same tab/document with bounded backoff.

## 3. Non-goals / out of scope

- Do not change the canonical userscript repository, its stable update URL, or its source/version.
- Do not open a recovery tab, navigate, or refresh ChatGPT as part of this retry mechanism.
- Do not retry continuously at one-second intervals or overlap activation requests.
- Do not change unrelated recovery leases, memory policy, or userscript permissions.

## 4. Requirements

- R1: For the page-ready handshake, any enabled matching userscript activation error produces `ok: false`; an empty successful result remains valid if there are no matching enabled scripts.
- R2: The Fabushi ChatGPT workbench is registered at `document_start`; it does not wait for ChatGPT's document completion or idle event to appear.
- R3: The content bridge retries a failed/unanswered page-ready handshake in the current document with exponential backoff capped at 30 seconds.
- R4: A URL change bypasses the retry cooldown and triggers a handshake for the new URL, including after an older in-flight request settles.
- R5: At most one page-ready request may be in flight per content-script instance; success stops further retries.
- R6: Startup stays non-blocking and retrying does not create duplicate requests.
- R7: Bump Fabushi extension to v0.6.23 and release only after local validation and GitHub CI succeed.

## 5. Current state

`runMatchingScripts()` logs per-record errors and returns the IDs that started. The `pageReady` handler translated that result to `{ok:true}` even when activation threw. The content bridge retried once a second only until any `{ok:true}` response, and its only lifecycle fallback depended on tab completion. The latest canonical v2.9.87 source declares `@run-at document-start`; older stored registration metadata could still be stale.

## 6. Target state

The Fabushi-hosted ChatGPT script is registered at `document_start`, including when a stored record contains older timing metadata. Activation errors for matching records reject the page-ready call. The bridge retries with delays 1, 2, 4, 8, 16, then 30 seconds, without overlap. URL changes trigger immediately after any older request settles. A successful handshake ends retries.

## 7. Architecture and ownership boundaries

The Fabushi Chrome extension owns the page bridge and host activation handshake. The remote userscript repository owns canonical userscript code and metadata. The Marketplace installed-version indicator is not runtime activation evidence.

## 8. Interfaces / contracts / schemas / data flow

`userscript-content.js` sends `fabushi.userscript.pageReady` with the current URL. The service worker resolves matching enabled records and attempts registration/execution. Its response `ok` indicates all matching activation attempts completed without error; `started` lists scripts started. Empty matches can return `ok: true, started: []`.

## 9. Constraints and non-functional requirements

Retries do not block user interaction, spin the worker at one-second frequency after failure, duplicate requests, change tabs, or navigate. Maximum retry interval is 30 seconds.

## 10. Failure modes and edge cases

- Service worker unavailable or rejected: continue bounded retrying.
- One matching userscript fails among several: report failure and retry; activation deduplication prevents overlapping work.
- No matching enabled userscripts: acknowledge success and stop.
- Same-document SPA route changes during cooldown: immediately request activation for the new route.

## 11. Implementation strategy

1. Register the canonical Fabushi ChatGPT userscript at `document_start` even if a persisted record has stale run timing, while preserving source metadata.
2. Require successful matches for page-ready activation while preserving existing best-effort callers.
3. Add a single-flight page-ready bridge with capped exponential backoff and URL-change handling.
4. Add regression tests for early registration, activation failure followed by success and bridge retry/success behavior.
5. Bump manifest, README and release workflow to 0.6.23.

## 12. Verification / test strategy

Local host resilience contract: 8 passing tests. All extension JavaScript passes `node --check`; `git diff --check` passes. [PR #20](https://github.com/bhrumom/fabushi-chrome-extension/pull/20) validate job and main branch validation pass. Tag workflow [36222082389](https://github.com/bhrumom/fabushi-chrome-extension/actions/runs/36222082389) completed successfully.

## 13. Acceptance criteria / Definition of Done

- AC-1: Matching activation errors never receive a successful page-ready acknowledgment.
- AC-2: The installed ChatGPT script is registered at document start and is not gated on full page completion.
- AC-3: Failed handshakes retry in the same document with bounded exponential backoff, single-flight behavior and route-change retry.
- AC-4: Successful activation stops retries; no-match page remains a valid success.
- AC-5: v0.6.23 passes local and GitHub validation and is published with the Chrome extension archive.

## 14. Release / migration / rollback

No storage migration. Published v0.6.23 through the validated tag workflow; v0.6.22 remains the rollback version. [Release v0.6.23](https://github.com/bhrumom/fabushi-chrome-extension/releases/tag/v0.6.23) contains `fabushi-chrome-0.6.23.zip`.

## 15. Observability / evidence

Page-ready rejection includes the failed script identifier and activation error. Evidence: local tests, [PR #20 checks](https://github.com/bhrumom/fabushi-chrome-extension/actions/runs/36222026993), [main validation](https://github.com/bhrumom/fabushi-chrome-extension/actions/runs/36222050424), and [v0.6.23 tag workflow](https://github.com/bhrumom/fabushi-chrome-extension/actions/runs/36222082389).

## 16. References / provenance

- `AGENTS.md`
- `docs/specs/spec-first-ai-development.md`
- `docs/specs/userscript-remote-update-link-v0.6.22.md`
- `chatgpt-vps-control/chrome-platform/extension/userscript-runner.js`
- `chatgpt-vps-control/chrome-platform/extension/userscript-content.js`
- User report and screenshot dated 2026-09-26 showing the Fabushi-installed userscript during a loading ChatGPT conversation.
- Canonical ChatGPT auto-confirm userscript v2.9.87 metadata from GitHub commit `2675666cbb93e6ab2c4238f622c9c02ec8223974`.

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1, R3-R6 / AC-1, AC-3-AC-4 | passed | `host-resilience.test.mjs` covers activation failure, retry, capped backoff timings, success stop, SPA route changes, and in-flight single-flight behavior; all 8 tests pass. |
| R2 / AC-2 | passed | Regression asserts that a legacy stored `document-idle` run time registers the canonical ChatGPT script as `document_start`. |
| R7 / AC-5 | passed | PR and main validation passed; v0.6.23 tag workflow succeeded and published the Chrome extension archive. |
