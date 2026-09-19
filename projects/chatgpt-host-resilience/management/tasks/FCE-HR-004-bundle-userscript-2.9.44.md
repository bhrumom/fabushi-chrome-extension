# FCE-HR-004 — Bundle userscript v2.9.44

Status: in-progress
Started: 2026-09-19
Updated: 2026-09-19

Objective: bundle canonical userscript v2.9.44 and publish Fabushi Chrome v0.6.18 while preserving host keep-awake behavior.

Acceptance:
- H16: extension version advances 0.6.17 -> 0.6.18.
- H17: bundled userscript blob equals canonical v2.9.44 blob `b608025f11e8007ee965013d314222ce30fb5522`.
- H18: power/system keep-awake contract remains unchanged.
- H19: host-resilience test validates v2.9.44 pending-continuation markers (`queuePendingContinuation`, `attemptPendingContinuation`, Stop click guard, `ignoreCooldown:true`).
- H20: exact-head PR CI, squash merge/main CI and v0.6.18 tag/package/Release succeed; package digest is recorded.

Branch: `chore/bundle-userscript-2.9.44-0.6.18-20260919`
PR/CI/Release/evidence: pending.
