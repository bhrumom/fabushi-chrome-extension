# FCE-HR-005 — Bundle userscript v2.9.46

Status: complete
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
Delivery:
- PR #12 final head `0bdde2bd2f60a8409e603c0a3db7de1f0e556963`.
- Exact-head workflow `35442363295`: validate + host-resilience contract SUCCESS.
- Squash merge/release source `4dbd229880786ce717cc7ecfe57cd39d7e34ccd0`.
- Post-merge main workflow `35442384253`: SUCCESS.
- Tag/package/release workflow `35442405134`: validate + package + Publish GitHub Release SUCCESS.
- Release `v0.6.19`; asset `fabushi-chrome-0.6.19.zip`, 136285 bytes, sha256 `8b666d832a200e774646181c3d22b85d8b13b4e90139b5a48100f62da9516f31`.
- Bundled userscript blob equals canonical v2.9.46 blob `a97bb5848eca83508c9fcd03872ecd57af33dd05`.
