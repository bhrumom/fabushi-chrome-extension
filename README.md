# Fabushi browser

This repository is the independent browser boundary extracted from
bhrumom/fabushi@7851b689d2fe3fc3893cd9f4363899cc4a03e83b by the FAB-P0013 platform repository export workflow.

Source roots: chatgpt-vps-control/extension;chatgpt-vps-control/chrome-platform;chatgpt-vps-control/lib/browser-extension-bridge.js;chatgpt-vps-control/lib/browser-extension-install.js;chatgpt-vps-control/lib/browser-extension-paths.js;chatgpt-vps-control/tests/browser-extension.test.js;chatgpt-vps-control/tests/chrome-platform.test.js

Product builds, CI, Releases, and dependency boundaries are maintained here independently
after the migration acceptance gates pass. Do not add credentials or source paths owned by
another platform repository.

Current browser release candidate: `0.6.22`. It does not bundle the ChatGPT auto-confirm
userscript. The extension fetches the stable `@updateURL` / `@downloadURL`, compares `@version`,
and upgrades the installed script while retaining its enabled state and identity.


## 0.6.15 host resilience

While an active ChatGPT automation recovery lease exists, the extension requests `chrome.power.requestKeepAwake("system")`. This keeps Chrome/network execution alive through screen lock/display-off without forcing the display to stay on. When no active lease remains, it calls `releaseKeepAwake()`. The MV3 worker reconciles this state at startup, install, lease changes, tab removal and the 30-second recovery watchdog.

## 0.6.16 bundled conversation-length handoff

The Chrome package now bundles the canonical userscript v2.9.42 source. When ChatGPT reaches a conversation length limit, the userscript carries the latest assistant reply into a fresh chat and continues the same task/phase/round until a true final reply. The existing system keep-awake behavior from 0.6.15 is unchanged.

## 0.6.17 bundled interruption-count persistence

The Chrome package now bundles canonical userscript v2.9.43. The live assistant `连接已中断。正在等待完整回复。` status advances a persistent three-refresh budget across reload hydration, retries on a dedicated 10-second cadence, and sends `继续完成所有` in the same chat after the third persistent failure. Existing system keep-awake behavior is unchanged.

## 0.6.18 durable interruption continuation

The host now bundles canonical userscript v2.9.44. After connection interruption refresh exhaustion, the userscript persists a pending same-chat continuation. If ChatGPT still shows Stop, it stops the failed generation and keeps retrying until `继续完成所有` is actually sent. Existing system keep-awake behavior is unchanged.

## 0.6.19 loading recovery + 15-minute stall refresh

The host bundles canonical userscript v2.9.46. Same-route loading recovery now performs a real reload, cancelled/failed navigation re-arms the scheduler, and a no-unload watchdog prevents silent supervision stops. Generic unchanged-conversation refresh waits 15 minutes; unbound ambiguous-send recovery remains 3 minutes. Existing system keep-awake behavior is unchanged.

## 0.6.21 same-chat recovery + memory-pressure discard

When ChatGPT reports a connection interruption, the script continues in the same conversation and detects a completed response even when its own `继续完成所有` recovery draft is already present. The host accepts automatic elevated-pressure discard requests only at a JS heap estimate of at least 1 GiB; active tabs, unsafe workspaces, and requests inside the cooldown remain protected. Chrome unloads a discarded background tab and reloads it when selected; this does not clear memory from the active tab.

## 0.6.22 remote ChatGPT userscript updates

The extension no longer packages the ChatGPT auto-confirm userscript. It installs the canonical v2.9.65 release and automatically follows newer versions at the stable update URL. On first install and bounded update checks, it reads the stable raw GitHub update link, validates the script metadata, and updates only when `@version` increases. A network failure keeps the last known good source running. The independent task-queue userscript remains packaged.


## Grok Bot 0.18 Chrome-extension parity

The canonical product/architecture/UI parity specification is:

`docs/specs/grok-bot-0.18-chrome-extension-architecture-product-ui-parity.md`

The target is the Chrome-extension edition of Grok Bot 0.18 under Fabushi identity, while preserving all existing Fabushi Chrome capabilities. Migration uses per-source-file audit/disposition plus per-product-responsibility Chrome implementation; it does not require one-to-one target files.
