# Automatic same-tab memory recovery

Fabushi monitors active ChatGPT userscript leases and recycles the original tab when page JavaScript heap stays at or above 2 GiB for 30 seconds. Before recycling it requests a resumable checkpoint. It then unloads/reloads the same tab and resumes the same task. It never creates, activates, focuses, or switches to another tab.

GitHub Actions must verify low-memory and short-duration no-op behavior, sustained threshold checkpoint/recycle/resume, unsafe-checkpoint deferral, same-tab identity, and bounded crash recovery. No local Chrome stress test is part of acceptance.
