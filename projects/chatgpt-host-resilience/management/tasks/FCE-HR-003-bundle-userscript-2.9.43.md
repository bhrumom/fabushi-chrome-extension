# FCE-HR-003 — Bundle userscript v2.9.43

Status: complete
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
Delivery:
- PR #7 final head `63b704f6900ad7af6aa31a8bc4f4f3a6dbc9139c`.
- Exact-head workflow `35427488503`: validation + host-resilience contract SUCCESS.
- Squash merge/release source `0624c0a523dfc34f6d81c89a1aedc979e21a5152`.
- Post-merge main workflow `35427506936`: SUCCESS.
- Tag/package/release workflow `35427522662`: validate + package + Publish GitHub Release SUCCESS.
- Release `v0.6.17`; asset `fabushi-chrome-0.6.17.zip`, 134778 bytes, sha256 `e2f67044894f00996b2c4267d2d5e1f7c55726918372f8e8dafb87a355148b14`.
- Bundled userscript blob equals canonical v2.9.43 blob `7792ae5d0432ae0b3bc3f8504d7c70ecdc94e6ec`.
