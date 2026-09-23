# Remote userscript updates — Specification

Status: implemented
Owner: Fabushi Chrome extension
Last updated: 2026-09-23
Related issue/task/PR: user correction to extension packaging model

## 1. Context / problem

The extension package previously included `userscript/chatgpt-auto-confirm.user.js` and seeded a `chatgpt-auto-confirm` record from that local file. The user clarifies that the extension must not embed the ChatGPT userscript: it must use the userscript's stable `@updateURL`/`@downloadURL`, compare its `@version`, and update the installed record automatically.

## 2. Goal

Remove the userscript payload from extension releases and load/update the installed script through its stable remote update link and declared version.

## 3. Non-goals / out of scope

- Do not remove the extension's general userscript host/runtime or Marketplace updater.
- Do not change the ChatGPT userscript update URL or metadata semantics.
- Do not claim offline first-install support without a previously stored script record.

## 4. Requirements

- R1: Extension archives contain no ChatGPT auto-confirm userscript source payload.
- R2: Initial extension-managed install fetches the canonical stable `@updateURL` with no-store semantics and validates the script metadata.
- R3: Existing installed records compare their stored version to the remote `@version`; newer remote versions replace source while preserving stable record ID, installation time, enablement and applicable user settings.
- R4: If an update fetch fails but an existing record is available, retain the last known good record and keep it running.
- R5: Update UI/Marketplace links refer to the stable script URL and do not point into a packaged script path or an obsolete pinned copy.
- R6: Version changes alone trigger updates; equal/older versions do not downgrade.
- R7: Keep extension host memory/recovery behavior unchanged; publish v0.6.22 after exact-head and main CI.

## 5. Current state

`userscript-runner.js` now reads the stable raw GitHub update link, checks at a bounded interval, and compares remote metadata `@version` to the stored script. The packaged ChatGPT script payload has been removed; the separate task-queue userscript remains.

## 6. Target state

No ChatGPT auto-confirm script bytes ship in the extension archive. The extension fetches the stable raw GitHub update URL, parses `@version`, stores/registers a newer source, and keeps the previous stored source if a check fails.

## 7. Architecture and ownership boundaries

The canonical userscript repository owns source, release and version. The extension owns the runtime loader, persisted installed record, version comparison, and update UI. `@updateURL`/`@downloadURL` remain canonical metadata. Marketplace catalog may display the script but cannot override its trusted update link.

## 8. Interfaces / contracts / schemas / data flow

Use HTTPS raw.githubusercontent.com stable `main/.../chatgpt-auto-confirm.user.js`; append a cache-busting query for checks. `normalizeUserScript()` validates and extracts metadata. Existing extension storage schema remains compatible.

## 9. Constraints and non-functional requirements

Do not silently replace a usable stored script on network/parse failure. Do not fetch from arbitrary metadata origins. Compare versions using existing semantic comparator. Keep request size bounded.

## 10. Failure modes and edge cases

- First run offline: show a clear unavailable state; no bundled fallback exists.
- Existing record offline: continue using the stored last-known-good script.
- Remote metadata unchanged: do not rewrite/re-register the record.
- Remote version newer: update source while preserving the user's enablement and identity.
- Remote version older/equal: no downgrade.

## 11. Implementation strategy

1. Make extension remote stable update URL the script source of truth in userscript-runner.
2. Remove ChatGPT script payload from extension tree/package and stale `entry`/bundle references.
3. Update Marketplace fallback metadata and UI to present the stable update link.
4. Add tests for no embedded payload, remote metadata version upgrade, offline last-good retention, and no downgrade.
5. Bump extension to v0.6.22 and keep host resilience policy unchanged.

## 12. Verification / test strategy

Run extension syntax and host resilience tests, remote update contract tests with mocked fetch/storage, assert the package contains no userscript payload, compare remote URL and script `@version`, then exact-head CI, main CI, and tag release.

## 13. Acceptance criteria / Definition of Done

- AC-1: Extension archive contains no ChatGPT auto-confirm script source.
- AC-2: Newer `@version` from stable remote link automatically replaces/registers the stored script.
- AC-3: Network failure retains existing installed source; first install failure is visible.
- AC-4: Equal/older remote versions never downgrade the installed script.
- AC-5: v0.6.22 release and all CI checks pass.
- AC-6: Chrome runtime verification records installed script version from Marketplace/extension UI; local browser UI access may remain blocked.

## 14. Release / migration / rollback

No destructive storage migration. Existing records remain valid and are upgraded on successful remote comparison. Keep v0.6.21 available for rollback.

## 15. Observability / evidence

Pending implementation and release evidence.

## 16. References / provenance

- `AGENTS.md`
- `docs/specs/spec-first-ai-development.md`
- `chatgpt-vps-control/chrome-platform/extension/userscript-runner.js`
- `chatgpt-vps-control/chrome-platform/extension/marketplace-update-check.js`
- User correction on 2026-09-23: extension must use userscript update URL/version and must not embed its source.

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1 | implemented | Deleted `userscript/chatgpt-auto-confirm.user.js`; package test asserts the file is absent. |
| R2-R3, R6 | implemented | `readRecords()` fetches the stable URL, compares `@version`, persists only a newer version and preserves id, installedAt, enabled, and commands; mock test covers upgrade and equal-version behavior. |
| R4 | implemented | Mock test confirms a fetch failure retains the stored last-good source. |
| R5 | implemented | Marketplace fallback now uses the stable update link; packaged source path is gone. |
| R7 | unchanged | Memory-pressure discard and recovery policy are unchanged. |
| AC-1-AC-5 | implemented locally | Syntax checks and official host-resilience test pass; exact-head CI/release remain pending. |
| AC-6 | pending | Browser runtime test requires the user to reload the unpacked extension in Chrome. |
