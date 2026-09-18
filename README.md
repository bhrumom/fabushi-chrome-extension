# Fabushi — Chrome and browser extension control bridge

Status: repository bootstrap; source migration is pending.

This public repository is the independent home for **Chrome and browser extension control bridge** in the Fabushi platform repository separation project.

- Project: `FAB-P0013` / `PRS`
- Source baseline: `bhrumom/fabushi@cbe65975f3c4c077fa64af4171ebe3d2900185ad`
- Planned source roots: `chatgpt-vps-control/extension; chatgpt-vps-control/chrome-platform; browser bridge/tests`
- Migration policy: do not copy secrets, cookies, signing material, `.env` files, test-account state, or build caches.
- The repository becomes an active delivery repository only after its boundary, CI, package/E2E checks, and Release evidence are accepted.

Until migration is accepted, the original repository remains the rollback source of truth.
