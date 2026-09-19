# Fabushi browser

This repository is the independent browser boundary extracted from
bhrumom/fabushi@7851b689d2fe3fc3893cd9f4363899cc4a03e83b by the FAB-P0013 platform repository export workflow.

Source roots: chatgpt-vps-control/extension;chatgpt-vps-control/chrome-platform;chatgpt-vps-control/lib/browser-extension-bridge.js;chatgpt-vps-control/lib/browser-extension-install.js;chatgpt-vps-control/lib/browser-extension-paths.js;chatgpt-vps-control/tests/browser-extension.test.js;chatgpt-vps-control/tests/chrome-platform.test.js

Product builds, CI, Releases, and dependency boundaries are maintained here independently
after the migration acceptance gates pass. Do not add credentials or source paths owned by
another platform repository.

Current browser release candidate: `0.6.16`. The bundled ChatGPT userscript is `2.9.42` and declares
stable Tampermonkey-style `@updateURL` / `@downloadURL` metadata. Marketplace remains the
first-install/discovery surface; subsequent userscript releases are checked from that URL.


## 0.6.15 host resilience

While an active ChatGPT automation recovery lease exists, the extension requests `chrome.power.requestKeepAwake("system")`. This keeps Chrome/network execution alive through screen lock/display-off without forcing the display to stay on. When no active lease remains, it calls `releaseKeepAwake()`. The MV3 worker reconciles this state at startup, install, lease changes, tab removal and the 30-second recovery watchdog.

## 0.6.16 bundled conversation-length handoff

The Chrome package now bundles the canonical userscript v2.9.42 source. When ChatGPT reaches a conversation length limit, the userscript carries the latest assistant reply into a fresh chat and continues the same task/phase/round until a true final reply. The existing system keep-awake behavior from 0.6.15 is unchanged.
