# Fabushi Chrome platform

This directory contains the Chrome-only host and extension integration. Changes limited to this boundary should use the Chrome package/preflight checks and the shared JavaScript security checks; they do not by themselves change the Rust Host, remote-control Worker, Electron desktop, GBF security, or Global Dharma service contracts.

The CI scope-aware workflows classify this boundary explicitly. Workflow, scope-filter, security-boundary, or shared toolchain changes remain conservative and can select the full matrix.

This line is a scope-regression fixture: a documentation-only change in this directory should still select Chrome validation and Node security while leaving unrelated platform checks skipped.

Main-push verification marker (2026-09-14): this file is intentionally changed without touching any other product boundary.
