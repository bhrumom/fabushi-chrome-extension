# FCE-HR-004 — Bundle userscript v2.9.44

Status: complete
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
Delivery:
- PR #9 final head `3539dc41e2d84de461bf0b2dc85594a12b97700f`.
- Exact-head workflow `35428950281`: validation + host-resilience contract SUCCESS.
- Squash merge/release source `c412db85e4809859ca326b924d74a93bcc5ff7ab`.
- Post-merge main workflow `35428973694`: SUCCESS.
- Tag/package/release workflow `35428994707`: validate + package + Publish GitHub Release SUCCESS.
- Release `v0.6.18`; asset `fabushi-chrome-0.6.18.zip`, 135746 bytes, sha256 `935db4b71f1a57e87eb67872447fbbe8d7b0d6b48d3cb51d4efa4495be34ee43`.
- Bundled userscript blob equals canonical v2.9.44 blob `b608025f11e8007ee965013d314222ce30fb5522`.
