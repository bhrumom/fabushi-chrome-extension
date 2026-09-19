# ADR-0001 — Lease-aware system keep-awake

Status: Accepted
Date: 2026-09-19
Owner: Fabushi browser engineering

Context: page JS cannot run after OS sleep. Decision: use Chrome power permission and requestKeepAwake("system") whenever a non-expired active recovery lease exists; release otherwise; reconcile on startup and watchdog. Alternatives: userscript timers (cannot prevent sleep), display keep-awake (unnecessarily prevents screen-off). Consequence: host can keep automation alive through lock while respecting paused/terminal lease removal.
