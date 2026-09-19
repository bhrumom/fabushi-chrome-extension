# FCE-HR-005 — Bundle userscript v2.9.45

Status: in-progress
Started: 2026-09-19
Updated: 2026-09-19

Objective: bundle canonical userscript v2.9.45 and publish Fabushi Chrome v0.6.19 while preserving host keep-awake behavior.

Acceptance:
- H21: extension version advances 0.6.18 -> 0.6.19.
- H22: bundled userscript blob equals canonical v2.9.45 blob `99bc98dbc6e367d5dbc68e44f90015dd01e15221`.
- H23: power/system keep-awake contract remains unchanged.
- H24: host-resilience contract validates v2.9.45 loading-recovery self-heal markers (`NAVIGATION_COMMIT_WATCHDOG_MS`, `armNavigationCommitWatchdog`, same-route recovery reload, loading-aware recovery reset).
- H25: exact-head PR CI, squash merge/main CI and v0.6.19 tag/package/Release succeed; package digest is recorded.

Branch: `chore/bundle-userscript-2.9.45-0.6.19-20260919`
PR/CI/Release/evidence: pending.
