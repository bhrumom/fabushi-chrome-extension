# ChatGPT host resilience

Objective: keep Fabushi ChatGPT automation running while the display is locked, make host recovery lease state control Chrome system keep-awake, and ship a browser release that bundles the corresponding userscript recovery version.

Current stage: implementation. Acceptance: active recovery lease => chrome.power.requestKeepAwake("system"); no active lease => releaseKeepAwake; MV3 restart/alarm re-synchronizes state; browser package bundles the released userscript and CI/release evidence is recorded.

Source of truth: SOURCE_OF_TRUTH.md. Task: FCE-HR-001. Evidence: evidence/FCE-HR-001/README.md.
