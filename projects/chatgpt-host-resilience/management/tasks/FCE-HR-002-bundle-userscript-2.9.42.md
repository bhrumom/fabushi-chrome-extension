# FCE-HR-002 — Bundle userscript v2.9.42

Status: complete
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
Delivery:
- PR #5 final head `5ee9937c3532b697a5ea7c474fac774be262e19a`.
- Exact-head workflow `35420190719`: validation + host-resilience contract SUCCESS.
- Squash merge/release source `d8bb2b06adb01003acf1f785b59e24499e07a97b`.
- Post-merge main workflow `35420218386`: SUCCESS.
- Tag/package/release workflow `35420234619`: validate + package + Publish GitHub Release SUCCESS.
- Release `v0.6.16`; asset `fabushi-chrome-0.6.16.zip`, 134486 bytes, sha256 `26d43533ab24594e8d84748c932af54d9d003da250d92fa9c79a5271ab41a8da`.
- Bundled userscript blob equals canonical v2.9.42 blob `7257e92d69d8b09474e8e6fabd87100b8e838c9c`.
