# FCE-HR-002 — Bundle userscript v2.9.42

Status: in-progress
Started: 2026-09-19
Updated: 2026-09-19

Objective: bundle canonical userscript v2.9.42 into the Fabushi Chrome host and publish v0.6.16 without changing the already-released keep-awake behavior.

Acceptance:
- H6: extension version advances 0.6.15 -> 0.6.16.
- H7: bundled userscript content SHA equals canonical v2.9.42 blob `7257e92d69d8b09474e8e6fabd87100b8e838c9c`.
- H8: existing `power` permission/system keep-awake contract remains present and host-resilience contract tests continue to pass.
- H9: release workflow expects 0.6.16 and validates bundled userscript v2.9.42 conversation-length handoff markers.
- H10: exact-head PR CI, squash merge/main CI and v0.6.16 tag/package/Release succeed; package digest is recorded.

Branch: `chore/bundle-userscript-2.9.42-0.6.16-20260919`
PR/CI/Release/evidence: pending.
