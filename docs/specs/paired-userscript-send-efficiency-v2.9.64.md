# Paired userscript send safety and efficiency — Specification

Status: active
Owner: Fabushi Chrome extension
Last updated: 2026-09-23
Related issue/task/PR: paired release follow-up to userscript v2.9.64

## 1. Context / problem

The extension ships a bundled copy of the canonical userscript. Userscript v2.9.64 prevents duplicate dispatch when an exact sent prompt remains in the composer and lowers recurring scan frequency across multiple tabs. Shipping only the standalone script would leave extension users on the previous behavior.

## 2. Goal

Bundle the exact v2.9.64 userscript in the next Chrome extension version and verify the archive contains the canonical script.

## 3. Non-goals / out of scope

- Do not change memory discard policy, permissions, or host bridges.
- Do not claim local Chrome runtime verification without access to extension management UI.

## 4. Requirements

- R1: Bundle byte-identical userscript v2.9.64 from canonical main/release source.
- R2: Bump the extension manifest and release workflow version to 0.6.21.
- R3: Preserve extension host resilience behavior and permissions.
- R4: Verify exact-head CI, main CI, release archive, and script digest.
- R5: Record local Chrome install/runtime verification as blocked until Chrome management can be operated by the user.

## 5. Current state

Published extension v0.6.20 bundles userscript v2.9.63. The canonical userscript candidate v2.9.64 has focused and full local tests passing.

## 6. Target state

Extension v0.6.21 bundles exactly userscript v2.9.64, passes existing host-resilience tests, and publishes a verified archive.

## 7. Architecture and ownership boundaries

Canonical script remains in `bhrumom/fabushi-chatgpt-auto-confirm-userscript`; extension package mirrors its bytes under `chatgpt-vps-control/chrome-platform/extension/userscript/`. Extension host behavior remains owned by this repository.

## 8. Interfaces / contracts / schemas / data flow

No API, permission, or message contract changes. Package version is 0.6.21.

## 9. Constraints and non-functional requirements

Keep extension host policy unchanged. Release only after CI verifies extension contract and package.

## 10. Failure modes and edge cases

- Script digest mismatch: do not publish.
- Extension validation fails: do not tag/release.
- Chrome management unavailable: report install verification as blocked, not passed.

## 11. Implementation strategy

Copy the exact v2.9.64 script into the extension bundle, bump manifest/workflow/README to 0.6.21, update repository evidence, then run CI and publish through the existing workflow.

## 12. Verification / test strategy

Run extension syntax and host resilience contract tests locally. Require exact PR head CI and canonical main/release workflow success. Compare bundled script SHA-256 against canonical v2.9.64.

## 13. Acceptance criteria / Definition of Done

- AC-1: Bundle bytes match canonical userscript v2.9.64.
- AC-2: Extension is tagged/released as v0.6.21 after CI.
- AC-3: Local Chrome install and two-tab CPU/recovery behavior verified, or explicitly blocked with the user operation needed.

## 14. Release / migration / rollback

No migration. Release v0.6.21 through the tag workflow. Roll back by loading v0.6.20 if needed.

## 15. Observability / evidence

Pending bundle digest, PR CI, main CI, and release evidence.

## 16. References / provenance

- `AGENTS.md`
- `docs/specs/spec-first-ai-development.md`
- `projects/chatgpt-host-resilience/source/2026-09-23-userscript-memory-discard-2.9.63.md`
- Canonical userscript v2.9.64 and its regression suite.
- User request 2026-09-23: prevent duplicate dispatch from retained composer content and reduce CPU use across concurrent script tabs.

## 17. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1-R4 | pending | |
| R5 | pending | |
| AC-1-AC-3 | pending | |
