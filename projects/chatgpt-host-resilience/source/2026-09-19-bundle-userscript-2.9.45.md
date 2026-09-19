# 2026-09-19 — Bundle userscript v2.9.45

Paired userscript release: v2.9.45, release target `eb0b3fc5920b88ba5229d88e49383f6c8c2d5f66`, source blob `99bc98dbc6e367d5dbc68e44f90015dd01e15221`.

Requirement: update the Fabushi Chrome fallback bundle to exactly this source so the host package includes the loading-recovery scheduler self-heal: same-route recovery does a real reload, cancelled navigation re-arms scheduling, committed navigation has a no-unload watchdog, and recovery counters survive until loading really clears. Existing keep-awake runtime is unchanged.
