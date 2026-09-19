# FCE-HR-003 — Bundle userscript v2.9.43

Status: in-progress
Started: 2026-09-19
Updated: 2026-09-19

Objective: bundle canonical userscript v2.9.43 into the Fabushi Chrome host and publish v0.6.17 while preserving existing host keep-awake behavior.

Acceptance:
- H11: extension version advances 0.6.16 -> 0.6.17.
- H12: bundled userscript content SHA equals canonical v2.9.43 blob `7792ae5d0432ae0b3bc3f8504d7c70ecdc94e6ec`.
- H13: `power` permission/system keep-awake contract remains unchanged.
- H14: release tests validate userscript v2.9.43 plus interruption assistant-turn detection, 10-second interruption cooldown, and persistent counter markers.
- H15: exact-head PR CI, squash merge/main CI and v0.6.17 tag/package/Release succeed; package digest is recorded.

Branch: `chore/bundle-userscript-2.9.43-0.6.17-20260919`
PR/CI/Release/evidence: pending.
