# 2026-09-19 — Bundle userscript v2.9.44

Paired userscript release: v2.9.44, release target `b35124fe1a8f3279f412c67164f5daaeb142c575`, source blob `b608025f11e8007ee965013d314222ce30fb5522`.

Requirement: update the Fabushi Chrome fallback bundle to exactly this source so the host package includes durable interruption pending-continuation behavior: after 3/3, Stop is clicked if necessary and `继续完成所有` is retried until a real Send click occurs. Existing keep-awake runtime is unchanged.
