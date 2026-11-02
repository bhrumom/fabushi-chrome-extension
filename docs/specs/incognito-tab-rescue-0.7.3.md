# Incognito same-tab rescue — Specification

Status: active
Owner: Fabushi Chrome extension
Last updated: 2026-11-02

## Problem and goal
A real incognito task stopped at chrome-extension://dhkifbnclknmafelblbhikfecdieoea/tab-rescue.html with ERR_BLOCKED_BY_CLIENT. Chrome spanning extensions cannot open packaged extension pages as incognito top-level documents. Preserve the original tab and task checkpoint while recovering without a blocked transit page.

## Requirements and architecture
- R1: Keep spanning mode, permissions, normal-window extension transit and recovery owner unchanged. For incognito tabs use a unique browser-owned about:blank#fabushi-rescue=<nonce> transit, persisted before navigation. Never use a remote transit site.
- R2: Restore only the exact persisted tab and transit URL. A background tabs.onUpdated complete listener restores the original recovery URL; the existing watchdog handles worker eviction. Existing extension transit records remain restorable, including an already-blocked old incognito transit.
- R3: Preserve original route, checkpoint hash, task identity, tab slot/group and focus. No new tabs or Send, no task storage reset. Keep health, loading grace, settle deadline, attempt/discard budgets and replacement-ID migration.
- R4: Foreign current or pending navigation cancels restoration; an unrelated blank tab must never be adopted. Concurrent restoration events must not duplicate navigation or clear a newer rescue record.
- R5: Release 0.7.3 through canonical CI/package; verify published package and update existing installation without resetting storage. Live restoration must be distinguished from deterministic regression evidence.

## Failure cases
Refused discard retains bounded attempts; terminate debugger failure preserves current fallback; worker restart consumes persisted transit; legacy blocked transit can be restored using its recorded URL; a lost record must never guess the destination.

## Verification and acceptance
AC1: Incognito active/inactive transit and background completion, worker restart, legacy blocked record, foreign navigation, no-record blank page, concurrent completion, and existing normal/recovery tests pass.
AC2: Exact-head CI and packaged browser tests pass; release source/provenance match installed bytes.
AC3: Restore the reported tab using retained destination if available; record real installed version and task status without claiming a new natural-hang endurance test.

## Delivery and rollback
Back up installed files and preserve extension ID/storage. Update the existing unpacked extension and reload that extension only. Roll back changed files if necessary. No split-mode migration or new permissions.

## Compliance
Pending implementation and verification; final per-requirement evidence is required before completion.

## References
Existing automatic-hung-tab-recovery.md and bounded-loading-discard-recovery.md.
Chrome manifest incognito: https://developer.chrome.com/docs/extensions/reference/manifest/incognito
