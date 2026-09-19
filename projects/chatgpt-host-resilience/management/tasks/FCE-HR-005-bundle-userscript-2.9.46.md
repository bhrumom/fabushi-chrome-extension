# FCE-HR-005 — Bundle userscript v2.9.46

Status: in-progress
Started: 2026-09-19
Updated: 2026-09-19

Objective: bundle canonical userscript v2.9.46 and publish Fabushi Chrome v0.6.19 while preserving host keep-awake behavior.

Acceptance:
- H21: extension version advances 0.6.18 -> 0.6.19.
- H22: bundled userscript blob equals canonical v2.9.46 blob `a97bb5848eca83508c9fcd03872ecd57af33dd05`.
- H23: `power` permission/system keep-awake contract remains unchanged.
- H24: host-resilience test validates v2.9.46 version, loading-recovery watchdog markers, generic stall 15-minute constant, and ambiguous-send 3-minute constant.
- H25: exact-head PR CI, squash merge/main CI and v0.6.19 tag/package/Release succeed; package digest is recorded.

Branch: `chore/bundle-userscript-2.9.46-0.6.19-20260919`
PR/CI/Release/evidence: pending.
