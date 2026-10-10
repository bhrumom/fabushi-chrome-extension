# Content bridge wake scope
Status: active
Owner: Chrome extension
Date: 2026-10-10

Installed content bridge wraps initialization in an idempotent guard, but its added wake listener is outside that guard and references a block-scoped RESPONSE_SOURCE. Hidden alarm delivery therefore throws instead of posting a page wake. Canonical content bridge must guard all initialization including wake listeners. Repeat injection must install exactly one listener; alarm delivery posts fabushi-extension/background-wake without activating tabs. Paired standalone handles clocks and wake events, with pause/ownership safeguards. Test scoped real content bridge in VM, repeated injection and event forwarding; preserve current recovery adapter. Native installed readback and hidden task progress remain separate evidence.

Compliance: pending implementation and CI.
