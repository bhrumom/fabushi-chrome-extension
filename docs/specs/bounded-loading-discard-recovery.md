# Bounded loading and discard recovery — Specification

Status: active
Owner: Fabushi Chrome host and standalone task runner
Last updated: 2026-10-18

## Context and evidence
The original ChatGPT conversation 6ad3f44b-3084-83e8-ae9d-b1c03f245fb5 froze at 4.4 GB. Reload left a blank document while Chrome accessibility retained old content. Chrome Discards showed unloaded; urgent discard of that original slot followed by activation restored the conversation, original task supervision and authorization handling, at 1.2 GB. No goal was resent.

## Goal and requirements
R1: Keep the original conversation and tab-strip slot; no new task tab, broad process kill, task reset or duplicate Send.
R2: Loading is protected for two minutes, then continuous failed probes for at least 90 seconds may recover it. Responsive content, drafts, files, fresh task heartbeat, deliberate suspension and foreign pending navigation remain protected. Memory alone never triggers recovery.
R3: Persist a rescue destination and attempt before unload. If terminate/transit remains stuck on the source for 30 seconds, attempt explicit browser discard and restore using the returned tab ID. Do not reset attempt time on each alarm. Handle refused active-tab discard without changing focus or creating a tab; retain pending evidence and retry within a bounded fallback budget.
R4: Preserve two-attempt/ten-minute watchdog budget, post-restore settling, owner, phase, round, dispatch identity and attachments across worker eviction and tab replacement. Recheck exact source and pending navigation before destructive operations.
R5: Standalone same-document fallback must durably prepare the existing recovery ticket before requesting host reload and pass that same token in both grant and commit destination. Failed persistence must stop that reload; do not re-enable closed-tab resurrection or memory-only reload.
R6: Publish additive versions 0.7.2 after focused and required regression checks and exact-head CI. Verify published bytes; install through the existing extension/script entry without resetting storage.

## Architecture and strategy
Existing watchdog owns continuous loading observations; tab-rescue owns terminate/transit plus bounded discard fallback and restoration. Existing standalone ticket helper owns workspace identity. No added permissions or second recovery owner.

## Verification and acceptance
AC1: Regressions exercise indefinitely loading pages, loading race, healthy/draft protection, stalled transit discard, replacement ID, refused discard and foreign navigation.
AC2: Standalone grant/commit use the durable same-route ticket and preserve task identity; denied persistence sends no request.
AC3: Required local checks and exact-head Actions pass; published assets match tested source.
AC4: Original real conversation is restored. New installed automation and future natural freeze acceptance must be recorded separately from manual recovery.

## Release and rollback
Use canonical repositories and existing workflows. Never overwrite prior release assets. Retain installed-directory backup, extension storage and script record. Roll back files and reload only the same extension.

## Compliance
R1 / AC4 manual recovery: passed, original route restored and later tool activity appeared; workbench original task automatically handled authorization.
R2-R5 / AC1-AC2: passed in focused behavioral regressions. Host tests cover loading grace plus continuous failure, stalled transit deadline retention, discard/replacement/protected/foreign navigation/refusal, and exact-lease token commit. Script tests cover durable token in grant and commit, pause/round/draft/denial fences and storage failure. Complete regression and exact-head CI are delivery gates below.
R6 / AC3: blocked pending exact-head CI, publication and installed readback.
New installed automatic natural-freeze acceptance: blocked pending runtime evidence.
