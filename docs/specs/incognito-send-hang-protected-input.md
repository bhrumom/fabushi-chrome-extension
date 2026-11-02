# Incognito send hang and protected input recovery

Status: active
Owner: Fabushi Chrome extension
Date: 2026-11-03

## Incident

In an incognito ChatGPT conversation, sending a message can leave the renderer near one CPU core and the tab visually stuck. Pausing the Fabushi task does not unload the userscript. A manual userscript shutdown was followed by an extension reinjection, so that first comparison did not isolate the script. Two pauses of the busy renderer landed in ChatGPT's own Markdown tokenizer `write` chain in `617936.75de056fef.js:73`; these samples establish the active stack, but do not establish what initiated that work. A second comparison is pending with reinjection blocked in the current document.

The 0.7.4 watchdog reports `healthy/content-visible` and zero recoveries. Its page probe returns `protected:true` for a draft, and the watchdog treats that result as healthy without checking the rendered frame. Thus a black frame during a draft cannot enter the suspect record. A failed page probe after a previously protected observation also loses knowledge that a draft may still exist.

## Goal

Record a persistent black frame even when a draft is present, while keeping the draft and attachments protected from automatic unload. Do not claim this detector repairs ChatGPT's Markdown tokenizer or proves userscript causation. Preserve existing same-tab recovery for unprotected failures.

## Requirements

- R1: For a foreground managed tab, a black visual sample can mark the page suspect even when the DOM probe reports protected input. A protected observation must never trigger automatic unload.
- R2: Retain the last confirmed protected-input state across inconclusive or timed-out page probes. Only a fresh successful probe that confirms unprotected input can clear it. Tabs that have never reported protected input retain the existing timeout recovery path.
- R3: Healthy rendered content clears suspect timing. The existing continuous 90-second threshold, final recheck, navigation, lease, cooldown and attempt budget still apply.
- R4: Diagnostics distinguish black frame with protected input from ordinary healthy content. No page content or screenshot is persisted.
- R5: Add tests for protected black frame, later unprotected recovery, probe timeout after protected input, and ordinary dark content. Run exact-head Actions and verify the installed build separately.

## Architecture

The extension worker samples the viewport as before. Its watchdog stores only a boolean `lastProtectedInput` in session diagnostics and a reason string. A protected observation blocks destructive recovery until a fresh page probe confirms unprotected input. Existing timeout recovery for tabs without a protected observation and existing rescue ownership remain unchanged.

## Release boundary

Version 0.7.5 may package this detection and draft-safety repair after exact-head validation. Its notes must state that the ChatGPT Markdown rendering hang is still under investigation. Do not install or claim a live fix while the same-document isolation comparison is pending. Updating the installed unpacked extension must preserve its ID, script storage and task state, and must happen after the live comparison because reloading the extension invalidates that comparison.

## Acceptance and compliance

| Item | Status | Evidence |
| --- | --- | --- |
| R1-R4 | passed in source | `userscript-watchdog.js` distinguishes `black-frame-protected-input`, retains `lastProtectedInput` across inconclusive probes, blocks automatic unload while protected, and keeps the existing same-tab rescue path. |
| R5 tests and Actions | passed for candidate | PR #33 head `0e3eace` passed validate and package in Actions 41500017776 attempt 2. The first package attempt failed before browser assertions because Chrome CDP was not ready; rerun passed. Protected black frame, timeout after draft, later unprotected recovery, and ordinary dark content are covered by `tab-rescue.test.mjs`. |
| Installed natural hang | pending | The second same-document isolation comparison and natural recovery are pending. |
