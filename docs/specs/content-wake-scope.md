# Content bridge wake scope
Status: active
Owner: Chrome extension
Date: 2026-10-10

Installed content bridge wraps initialization in an idempotent guard, but its added wake listener is outside that guard and references a block-scoped RESPONSE_SOURCE. Hidden alarm delivery therefore throws instead of posting a page wake. Canonical content bridge must guard all initialization including wake listeners. Repeat injection must install exactly one listener; alarm delivery posts fabushi-extension/background-wake without activating tabs. Paired standalone handles clocks and wake events, with pause/ownership safeguards. Test scoped real content bridge in VM, repeated injection and event forwarding; preserve current recovery adapter. Native installed readback and hidden task progress remain separate evidence.

Compliance: implemented and covered by exact-head Actions 38033711251 on e6d6fb7dc1ea8c83da6a1166fca309905f31eef2. Validation and packaged recovery E2E passed. Installed content bridge and background wake adapter updated and extension reloaded. Native project task recorded 539 host clock responses while still queued: clock delivery and navigation progress are separate evidence. Repeated content injection and absent-receiver reinjection retain the original tab. A naturally prolonged hidden renderer hang is not claimed as accepted.
