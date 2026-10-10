# Navigation from ChatGPT project conversations
Status: active
Date: 2026-10-10

Observed installed 2.10.43 task queued at 14:17 on /g/g-p-.../c/...; host pulses and clock responses continued through 15:01. Source navigation validation accepts only /c/... or /. A project document therefore gets invalid-request on every root dispatch request.

R1: Treat strict same-host HTTPS /g/g-p-ID[-slug]/c/CONVERSATION as a valid sender document. Keep target URL validation unchanged: only existing root/c routes, with existing recovery hash policy.
R2: Retain plugin/workspace identity, no new permissions, no guard bypass or forced-navigation fallback. Reject arbitrary project paths, unrelated hosts, malformed routes, and unsupported target routes.
R3: Behavioral VM test must invoke the real guard listener with a project sender and obtain a normal root-navigation lease; ordinary sender regressions and invalid source/target rejection remain covered.
R4: Verify exact-head Actions and installed same-tab task dispatch separately. Preserve original task identity and phase/round.
Compliance: pending implementation and exact-head validation.
