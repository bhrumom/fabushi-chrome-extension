# Chrome 0.7.1 paired release — Specification

Status: active
Owner: Fabushi Chrome extension
Last updated: 2026-10-11
Related PR: #24; userscript #160

## Context and goal
The user explicitly authorized merging the paired recovery PRs, publishing both,
and installing their latest official versions in Chrome. PR #24 is merged at
8870738fe415a0fcc341a1704b51a3f07a85f042 but still reports 0.7.0, whose published
artifact predates these fixes. Publish a new immutable 0.7.1 release.

## Scope and requirements
- R1: Bump the Chrome manifest and current version assertions to 0.7.1; retain all runtime behavior and permissions.
- R2: Update the release CI version gate and current README release identity. Preserve all regression and packaged E2E checks.
- R3: Publish v0.7.1 from tested canonical main through the existing tag workflow; preserve v0.7.0.
- R4: Install the checksum-verified published artifact in the existing unpacked directory and reload the same extension ID without resetting Chrome storage.
- R5: Update the canonical managed ChatGPT userscript to the officially published 2.10.45 and verify one enabled canonical record.
- R6: Report prolonged natural renderer-freeze acceptance as unresolved. Publishing on the user's authorization does not make that criterion pass.

## Architecture, plan and constraints
The extension release workflow owns packaging, provenance and E2E. The standalone
userscript repository owns its post-Test release. No Web Store submission or new
permissions are requested. Update only version assertions and release identity,
merge a small release PR after CI, tag its tested main commit, download published
assets, verify checksums, and reload in place. Back up the installed files first.

## Failure, verification and rollback
Failed CI prevents merge/tag. Failed digest or source identity prevents installation.
Verify PR/main/tag workflows, release asset version/provenance, Chrome enabled
version and canonical userscript version. Restore backed-up files and reload to
roll back the installation; never replace an existing release asset.

## Acceptance and evidence
AC1: Version and all existing CI checks pass.
AC2: Immutable GitHub releases v0.7.1 and v2.10.45 exist with verified assets.
AC3: Chrome shows enabled 0.7.1 and a single enabled canonical 2.10.45 script.

## Spec compliance record
| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R1–R5, AC1–AC3 | pending | Delivery verification will record workflow, release and installation evidence. |
| R6 | blocked | Real prolonged natural renderer-freeze acceptance remains open in the source specs and paired PRs. |
