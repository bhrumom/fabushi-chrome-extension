# Navigation from ChatGPT project conversations
Status: active
Date: 2026-10-10

Observed installed 2.10.43 task queued at 14:17 on /g/g-p-.../c/...; host pulses and clock responses continued through 15:01. Source navigation validation accepts only /c/... or /. A project document therefore gets invalid-request on every root dispatch request.

R1: Treat strict same-host HTTPS /g/g-p-ID[-slug]/c/CONVERSATION as a valid sender document. Keep target URL validation unchanged: only existing root/c routes, with existing recovery hash policy.
R2: Retain plugin/workspace identity, no new permissions, no guard bypass or forced-navigation fallback. Reject arbitrary project paths, unrelated hosts, malformed routes, and unsupported target routes.
R3: Behavioral VM test must invoke the real guard listener with a project sender and obtain a normal root-navigation lease; ordinary sender regressions and invalid source/target rejection remain covered.
R4: Verify exact-head Actions and installed same-tab task dispatch separately. Preserve original task identity and phase/round.
R5: Packaged E2E must await the intended app URL, complete document and Fabushi title together before checking runtime identity. A complete initial blank document is not app readiness. Run 38034676933 passed validation but exposed this navigation race in package; runtime source was unchanged. Preserve the bounded wait and runtime identity failure check.
Compliance: implemented in e6d6fb7dc1ea8c83da6a1166fca309905f31eef2. Exact-head Actions 38033711251 passed validation and packaged recovery E2E. The real-listener VM regression accepts project conversation senders and rejects unsupported sources/targets without relaxing target policy. Installed extension reloaded with this guard. Native task 6558f830-6eb9-431e-a275-630a33a1012d retained identity: Work final recognized at 15:22, review reply at 15:25, next Work dispatch at 15:26. Its initial departure at 15:07 preceded this guard installation, so that departure alone is not attributed to the patch. A new project-source attempt is covered by CI; prolonged inactive renderer recovery remains a separate acceptance gate.
