# FCE-HR-001 — Host keep-awake release

Status: complete
Started: 2026-09-19
Updated: 2026-09-19

Objective: bind Chrome system keep-awake to active userscript recovery leases, survive MV3 restarts, sync the paired userscript, and publish v0.6.15.

Acceptance: HR-1..HR-5 from docs/02-需求与成功指标.md. Verification: exact-head CI, main CI, release asset. Delivery:
- PR #3 exact-head `a8f3478d89b9ddc4a1ced41a4f631eb0758450ef`.
- Exact-head CI: run `35411419352` — manifest/JS validation + host-resilience contract SUCCESS.
- Squash merge / release source commit: `9a209c41bcd06b58994ad257bb306a06daa81c43`.
- Post-merge main CI: run `35411458833` — SUCCESS.
- Release tag workflow: run `35411515019` — validate + package + Publish GitHub Release SUCCESS.
- Release: `v0.6.15`; asset `fabushi-chrome-0.6.15.zip`, sha256 `c07e83d1e3eec537ec088b606ef967f931ce90fd522eaaa09b2d4908d368be1e`.
- Bundled userscript source blob: `6a8e9530f6e7e45cfa135856e4f6b5cd0e7f75f4` (v2.9.41).
