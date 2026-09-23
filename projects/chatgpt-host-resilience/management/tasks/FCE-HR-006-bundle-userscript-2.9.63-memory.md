# FCE-HR-006 — Bundle userscript v2.9.63 and align memory discard policy

Status: active
Started: 2026-09-23
Spec: `projects/chatgpt-host-resilience/source/2026-09-23-userscript-memory-discard-2.9.63.md`

Objective: Publish userscript v2.9.63 and Fabushi Chrome v0.6.20 with the elevated-memory host request contract, then install and verify the Chrome extension locally.

Acceptance:
- H26: Userscript v2.9.63 is released after exact-head PR and main checks pass.
- H27: Host allows automatic elevated-pressure discard only at >= 1 GiB and preserves high/manual semantics and active/unsafe/cooldown guards.
- H28: Extension v0.6.20 bundles the exact userscript v2.9.63 bytes and retains all prior host-resilience behavior.
- H29: Extension PR, main CI, package/tag workflow and GitHub Release v0.6.20 succeed; record asset SHA-256.
- H30: Local Chrome profile runs extension v0.6.20 with bundled userscript v2.9.63 enabled.

Verification:
- Userscript `npm test`, syntax, and `git diff --check`.
- Extension syntax checks and all `chatgpt-vps-control/tests` tests.
- Compare bundled script SHA-256 with canonical release source.
- Read GitHub PR/workflow/release evidence through GitHub connector.
- Inspect local Chrome extension details and Fabushi installed-script list.
