# Fabushi browser

This repository is the independent browser boundary extracted from
bhrumom/fabushi@7851b689d2fe3fc3893cd9f4363899cc4a03e83b by the FAB-P0013 platform repository export workflow.

Source roots: chatgpt-vps-control/extension;chatgpt-vps-control/chrome-platform;chatgpt-vps-control/lib/browser-extension-bridge.js;chatgpt-vps-control/lib/browser-extension-install.js;chatgpt-vps-control/lib/browser-extension-paths.js;chatgpt-vps-control/tests/browser-extension.test.js;chatgpt-vps-control/tests/chrome-platform.test.js

Product builds, CI, Releases, and dependency boundaries are maintained here independently
after the migration acceptance gates pass. Do not add credentials or source paths owned by
another platform repository.

Current browser release: `0.6.13`. The bundled ChatGPT userscript is `2.9.38` and declares
stable Tampermonkey-style `@updateURL` / `@downloadURL` metadata. Marketplace remains the
first-install/discovery surface; subsequent userscript releases are checked from that URL.
