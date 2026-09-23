# FCE-HR-007 — Pair send-safety and multi-tab efficiency fix

Status: active
Spec: `docs/specs/paired-userscript-send-efficiency-v2.9.64.md`

Objective: bundle canonical userscript v2.9.64 in extension v0.6.21, verify CI/package, and complete Chrome runtime verification when the extension management page is available.

## Acceptance

- H31: userscript v2.9.64 exact-head tests and release checks pass.
- H32: extension v0.6.21 includes byte-identical userscript v2.9.64 and extension resilience tests pass.
- H33: exact-head PR checks, main CI, and v0.6.21 package/release succeed.
- H34: local Chrome installs v0.6.21; verify the two existing tabs and a restored task. If the browser surface blocks extension management, record blocked and request user reload plus observed results.
