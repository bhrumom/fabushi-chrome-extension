# Grok Bot 0.18 → Fabushi Chrome Extension Architecture, Product & UI Parity — Specification

Status: active  
Owner: Fabushi Chrome Extension / Browser Platform  
Last updated: 2026-09-23  
Related issue/task/PR: user-requested Grok Bot 0.18 Chrome-extension parity  
Target repository: `bhrumom/fabushi-chrome-extension`  
Target baseline: `9a5238642fb4e5fff7d87e5f193b9cbf0864cda7`  
Reference repository: `b-nnett/grok-bot-0.18-reconstructed`  
Reference baseline: `a9f633e09d49a85829b8236331b9e21f7e612634`

## 1. Context / problem

`bhrumom/fabushi-chrome-extension` is the canonical repository for Fabushi Chrome-extension and browser-control integration. `bhrumom/fabushi` is migration/source-history material only and is not an alternate implementation location.

At the target baseline, Fabushi Chrome is MV3 version `0.6.22`. The active extension already provides substantial Chrome-native behavior, including:

- the Fabushi extension application shell;
- Chats;
- Mini Apps;
- Marketplace;
- Browser Control;
- Settings;
- Chrome Debugger/CDP behavior;
- tab and navigation lifecycle handling;
- downloads;
- Native Messaging;
- Fabushi browser account integration;
- same-account browser/MCP behavior;
- userscript install/update/enable/disable/runtime behavior;
- remote userscript updates via stable `@updateURL` / `@downloadURL`;
- ChatGPT automation/recovery behavior;
- Service Worker recovery/watchdog logic;
- bounded system keep-awake while an active recovery lease exists;
- existing browser-control and extension contract tests.

Those are retained product capabilities.

The current extension, however, is not yet the Chrome-extension edition of Grok Bot 0.18. The current `app.html/app.js` shell is a Fabushi-specific Chats/Mini Apps/Marketplace/Browser/Settings application and the manifest still uses `action.default_popup = app.html`. It does not yet provide the complete Grok Agent workspace, lifecycle projection, tool UI, MCP/plugin UI, Coordinator-shaped client protocol, same-run recovery semantics, or full Grok visual/interaction model.

The target is therefore:

> **Implement Grok Bot 0.18's Agent functions, UI, interaction model, lifecycle semantics, and architecture boundaries as a Chrome-extension product under Fabushi identity, while preserving all existing Fabushi Chrome functionality.**

## 2. Goal

Build Fabushi Chrome as the Chrome-extension edition of Grok Bot 0.18.

The final product must:

1. reproduce the Grok Bot Agent workspace and core UI in a full extension application surface;
2. reproduce Grok conversation, transcript, composer, streaming, thinking, tool, MCP/plugin, settings, context/computer, recovery, and Agent lifecycle behavior;
3. preserve Grok's Renderer -> Coordinator -> Host -> Runner responsibility model even though Chrome uses different platform primitives;
4. keep the MV3 Service Worker as a thin transport/capability broker rather than a second Agent runtime;
5. preserve all current Fabushi Chrome capabilities and security boundaries;
6. support both local/native and remote Agent runtime transport without creating two different chat state machines;
7. select the most appropriate language/runtime for each responsibility;
8. account for every pinned Grok `source/**` + `frontend/**` file in a strict parity ledger;
9. use product behavior and UI effect as the final parity criterion, not target file count.

The final user experience should be that Fabushi Chrome is the **Chrome extension form of the same Grok Bot product**, plus Fabushi's browser-native extensions.

## 3. Canonical migration rule

The migration rule is:

> **per-source-file audit/disposition + per-product-responsibility Chrome implementation + zero regression of existing Fabushi extension capabilities.**

The pinned Grok baseline contains:

- `source/**`: 1,724 files;
- `frontend/**`: 322 files;
- total source/frontend audit scope: **2,046 files**.

All 2,046 items must be represented exactly once in the parity ledger.

This does **not** mean Fabushi Chrome must contain 2,046 target files.

Allowed mappings include:

- one Grok file -> one Chrome module;
- one Grok file -> multiple Chrome/runtime modules;
- multiple Grok files -> one Chrome module where architectural ownership and behavior are not collapsed;
- existing Fabushi implementation -> evidenced equivalent;
- desktop-only source mechanism -> reviewed Chrome-adapted replacement;
- genuinely inapplicable implementation mechanism -> reviewed `not-applicable`, only when no required product effect is lost.

Creating empty files, no-op APIs, fake compatibility layers, or placeholder modules solely to match source-file counts is prohibited.

## 4. Non-goals / out of scope

- Do not put this implementation back into `bhrumom/fabushi`.
- Do not embed Electron inside Chrome.
- Do not make the toolbar popup the complete Grok Agent application.
- Do not remove current Browser Control, Marketplace, Mini Apps, userscripts, remote userscript updates, account/MCP, recovery, keep-awake, or extension security behavior merely because Grok has no identical Chrome module.
- Do not make the MV3 Service Worker the canonical owner of turns, transcript, retry policy, provider state, Agent identity, or Host state.
- Do not create a second parallel Grok UI while leaving the current Fabushi shell as a permanent alternative primary application.
- Do not require one target file per Grok source file.
- Do not copy proprietary/binary-derived Grok assets without rights clearance.
- Do not weaken Chrome extension security or current fail-closed browser-control behavior for parity.
- Do not claim parity from screenshots, mocks, manifest rows, or file presence alone.

## 5. Existing Fabushi extension capabilities that must be preserved

### R-EXIST-001 — Current Browser Control contract

Preserve the current browser-control command/action/event contract and all production behavior currently covered by the extension tests and Chrome integration, including:

- tab discovery/selection;
- generation-aware ownership/claims;
- title/URL identity checks where currently required;
- Chrome Debugger/CDP lifecycle;
- cross-frame/OOPIF handling where supported;
- download behavior;
- navigation lifecycle;
- retain/release and tab ownership semantics;
- current failure and safety behavior.

### R-EXIST-002 — Userscript platform

Preserve:

- userscript installation;
- enable/disable;
- update;
- remote stable update URL behavior;
- last-known-good fallback on network failure;
- userscript identity/version behavior;
- content-script/runtime bridge;
- navigation guards;
- recovery/watchdog behavior;
- current ChatGPT automation integration;
- current task-queue userscript behavior where present.

### R-EXIST-003 — Host resilience

Preserve current recovery and power behavior, including:

- active recovery lease handling;
- Service Worker reconciliation;
- bounded `chrome.power.requestKeepAwake("system")`;
- release of keep-awake when no active lease remains;
- existing stall/recovery safety behavior.

### R-EXIST-004 — Mini Apps and Marketplace

Preserve existing Mini Apps and Marketplace functionality, install/update projection, provenance/version checks, and UI journeys.

### R-EXIST-005 — Fabushi account / same-account browser integration

Preserve the existing browser account and same-account browser/MCP behavior, including session expiry/reconnect and cross-account isolation where implemented.

### R-EXIST-006 — Native Messaging

Preserve Native Messaging as a local/native capability transport. It may be refactored behind the Grok-shaped platform runtime but must not silently disappear.

## 6. Grok product and UI parity

### R-UI-001 — Full application surface

The primary Grok-shaped Agent application must run as a full extension page/tab/window.

The toolbar action must open that full application surface.

The final manifest must not use `action.default_popup = app.html` as the canonical Agent workspace.

A compact popup may exist only as an auxiliary launcher/status/quick-action surface.

### R-UI-002 — Grok Agent workspace

The extension must implement the Grok-equivalent UI and interaction model for, at minimum:

- Agent/bot roster;
- Agent identity/avatar;
- create/edit/delete Agent flows where present in the reference;
- conversation list;
- active conversation;
- transcript;
- composer;
- send/stop;
- rich input/attachments where Chrome permits;
- thinking;
- preparing;
- tool-running;
- streaming;
- waiting-user;
- completed;
- failed;
- recovered/recovering;
- tool cards/status;
- reactions where applicable;
- search/command actions;
- MCP/plugins/connectors;
- account/session;
- settings;
- context/computer/browser surface;
- error/retry states;
- reconnect state;
- help/about/feedback where present in the accepted reference.

### R-UI-003 — Grok visual effect

The UI should reproduce Grok Bot 0.18's information architecture, hierarchy, spacing, interaction patterns, state transitions, and visual language under Fabushi branding.

Because the reconstructed repository does not contain all original frontend source, approved screenshots/video of the exact reference are normative for observable UI when they conflict with incomplete recovered source.

Do not copy unlicensed proprietary binary assets.

### R-UI-004 — Existing extension features inside Grok UI

Current Fabushi-only extension capabilities must be integrated into the Grok-shaped product instead of living in a competing primary shell.

Browser Control, Mini Apps, Marketplace, Userscripts, browser account status, native/local connection status, and host-resilience controls may appear as Grok-style:

- navigation destinations;
- context panels;
- tools;
- plugin/MCP surfaces;
- settings;
- Agent capabilities.

Their existing behavior must remain intact.

## 7. Target architecture and ownership boundaries

```text
Full-page Chrome Extension Renderer
              |
              v
Typed Extension Platform Runtime
              |
              v
MV3 Service Worker
  transport/capability broker only
              |
       +------+------+
       |             |
       v             v
Local/native      Remote Agent
transport         transport
       |             |
       +------+------+
              v
      Mahayana Coordinator
              |
              v
            Host
              |
       +------+------+
       |             |
       v             v
   MCP/Tools      Runner/Computer
                       |
                 Browser Control
```

### R-ARCH-001 — Renderer

Renderer owns:

- UI;
- ephemeral view state;
- rendering;
- user intent;
- accessibility;
- projection of canonical runtime state.

Renderer does not own:

- provider execution;
- retry policy;
- durable run truth;
- transcript truth;
- Host lifecycle;
- Runner execution.

### R-ARCH-002 — Extension Platform Runtime

Define a typed platform-runtime layer between UI and Chrome transport.

New renderer code must not spread raw `chrome.runtime.sendMessage` calls throughout feature code.

The runtime owns typed methods/events for:

- Coordinator session;
- conversation/Agent operations;
- streaming;
- cancellation;
- attachments;
- MCP/plugins;
- Browser Control;
- account/session;
- settings;
- extension capabilities;
- notifications;
- runtime health;
- local/native availability.

### R-ARCH-003 — MV3 Service Worker

The Service Worker is a thin broker for:

- Chrome privileged APIs;
- transport;
- Native Messaging;
- alarms;
- worker lifecycle/reconnect;
- userscript runtime;
- Browser Control capability access.

It must not become canonical Agent runtime state.

Because MV3 workers may be suspended/restarted, any state required to survive worker restart must live in durable extension storage or, for Agent execution, in Coordinator/Host truth.

### R-ARCH-004 — Coordinator

The Grok Coordinator responsibility remains a distinct durable boundary.

The extension repository owns the client protocol, transport adapters, schemas, recovery behavior, and Chrome-side integration required to interact with that boundary.

A local paired runtime or remote service may provide the durable Coordinator implementation; the Service Worker must not collapse Coordinator into itself.

Coordinator semantics include:

- lifecycle/version negotiation;
- request/reply/event;
- streaming;
- cancel;
- reconnect;
- resync;
- generation/session fencing;
- Host supervision signaling;
- stale-session rejection;
- pending-call settlement;
- multi-client/view attachment.

### R-ARCH-005 — Host

Host remains the owner of:

- Agent turns;
- inference routing;
- transcript mutation;
- retries;
- tool orchestration;
- MCP lifecycle;
- terminal settlement;
- waiting-user state;
- provider behavior.

The extension renderer and Service Worker must not duplicate Host logic.

### R-ARCH-006 — Runner / Browser Control

Existing Browser Control becomes a first-class Chrome Runner/tool capability behind typed Host/Coordinator contracts.

A browser-control task should project as:

```text
ToolStarted
 -> claim/capability acquisition
 -> real Chrome action
 -> progress/result/error
 -> ToolCompleted
 -> Host continues inference
```

The current browser-control security model remains authoritative unless an explicit Spec amendment strengthens it.

## 8. Grok source-area mapping

Default ownership mapping:

| Grok Bot 0.18 | Fabushi Chrome target responsibility |
| --- | --- |
| `frontend/**` | full-page extension renderer, preferably React + TypeScript |
| `source/electron-preload/**` | typed Extension Platform Runtime / renderer bridge |
| `source/electron-main/**` | Chrome platform adapters, Service Worker capabilities, auth/settings/attachments/plugin/browser integrations |
| `source/node-agent-coordinator/**` | Coordinator client/protocol/transport locally; durable Coordinator supplied through explicit local/remote runtime boundary |
| `source/host/**` | Host contract/effect mapping; Host remains outside renderer/worker and may execute in paired/remote runtime |
| `source/local-exec-daemon/**` | local/native capabilities or reviewed Chrome adapter |
| `source/box-exec-daemon/**` | remote Runner/box capabilities |
| `source/shared/**` | shared wire schemas/contracts |
| `source/packages/**` | extension/runtime packages by responsibility |
| `source/internal/**` | internal support or reviewed disposition |

This table is an ownership map, not a filename-copy mandate.

## 9. File-level parity ledger

Create:

`docs/architecture/grok-bot-0.18-chrome-extension-parity-ledger.json`

Optional generated readable view:

`docs/architecture/grok-bot-0.18-chrome-extension-parity-ledger.md`

Every pinned Grok `source/**` and `frontend/**` file must have exactly one ledger record.

Minimum fields:

- `reference_path`
- `reference_blob_sha`
- `reference_area`
- `reference_responsibility`
- `reference_ui_effect`
- `chrome_effect`
- `platform_delta`
- `target_paths`
- `target_language`
- `runtime_owner`
- `transport_boundary`
- `parity_class`
- `status`
- `replacement_behavior`
- `tests`
- `production_evidence`
- `preserves_existing_extension_capability`
- `notes`

Allowed migration statuses may include `mapped`, `implementing`, `implemented`, `verified`, `blocked`, `not-applicable`.

Final acceptance permits only `verified` or reviewed `not-applicable`.

`not-applicable` means the **source implementation mechanism** is genuinely unsuitable for Chrome. It may not silently eliminate a still-required Grok product effect. When the user-facing effect remains relevant, `replacement_behavior` is mandatory.

## 10. Turn lifecycle and protocol

### R-RUN-001 — Canonical lifecycle

The extension must project the canonical run lifecycle, including where applicable:

- accepted;
- queued;
- preparing;
- thinking;
- tool-running;
- streaming;
- waiting-user;
- completed;
- failed;
- cancelled;
- recovering.

### R-RUN-002 — Typed protocol

Preserve typed:

- lifecycle;
- request;
- reply;
- event;
- streaming;
- cancellation;
- reconnect;
- resync.

Every active operation must have stable IDs sufficient to prevent duplicate execution and stale event application.

### R-RUN-003 — Service Worker restart

Restart/suspension of the MV3 Service Worker during an active durable run must not lose or duplicate the run.

After worker return:

- transport reinitializes;
- authentication/session is re-established;
- Coordinator resync occurs;
- current run/tool/stream state is restored;
- stale pending worker-local promises are settled deterministically;
- no duplicate send/tool action occurs.

### R-RUN-004 — App reload/reopen

Reloading, closing, or reopening the full extension application during a durable run must resync to the same run when it still exists.

### R-RUN-005 — Multi-view behavior

If multiple extension app pages exist, ownership/event fanout must be explicit. Multiple views may observe the same run but must not accidentally submit duplicate commands.

### R-RUN-006 — Local/remote transport equivalence

Local/native and remote Coordinator transports must expose the same logical Agent protocol.

The UI must not contain two unrelated chat engines.

### R-RUN-007 — Desktop/native optionality

The existing Native Messaging path may enhance local capabilities.

Loss of the local/native host must not turn the full Grok Agent UI into a dead/static shell when an authenticated remote Agent runtime is available.

## 11. MCP / plugins / connectors

Implement Grok-equivalent product behavior for:

- plugin/MCP catalog;
- installed state;
- authentication;
- accounts;
- tool discovery;
- tool enable/disable;
- invocation;
- result/error;
- reconnect/re-auth;
- metadata/logo/instructions where present.

Existing Fabushi same-account browser/MCP behavior must be preserved.

Credentials and long-lived secrets must not be exposed to renderer JavaScript.

## 12. Attachments / media

Translate Grok desktop attachment behavior to Chrome-native APIs:

- file chooser;
- drag/drop/paste where supported;
- staged upload;
- type/size validation;
- preview;
- cancellation;
- commit/discard;
- transcript association;
- interrupted upload recovery where practical.

Do not depend on arbitrary local filesystem paths.

## 13. Browser / computer context

Grok's computer/context role must map to Chrome Browser Control and remote/local Runner capabilities.

Required user-visible states include:

- disconnected;
- connecting;
- ready;
- running;
- waiting-user where needed;
- failed/recovering;
- released.

Browser actions must remain capability scoped and generation fenced.

## 14. Language selection

Use the best-fit language/runtime.

| Boundary | Preferred implementation |
| --- | --- |
| Renderer/UI | React + TypeScript |
| Extension platform runtime | TypeScript |
| MV3 Service Worker | TypeScript/JavaScript |
| Chrome APIs/Debugger/tabs/downloads/userScripts | TypeScript/JavaScript |
| Userscripts | JavaScript userscript format |
| Native Messaging client adapters | TypeScript/JavaScript; Rust only if materially better |
| Coordinator durable runtime | Rust preferred in its owning runtime |
| Host durable runtime | Rust preferred; ecosystem-specific adapters may use TypeScript |
| Runner/native execution | Rust preferred |
| Shared wire schemas | language-neutral schemas + generated TS/Rust where practical |
| Browser E2E | TypeScript/Playwright |

Language is not parity evidence by itself.

## 15. Security constraints

Grok parity must not weaken current extension security.

Required controls include:

- MV3 CSP compatibility;
- no unsafe remote executable-code loading outside approved userscript update policy;
- sender/origin validation for extension messages;
- Native Messaging allowlist/authentication;
- short-lived/bounded browser sessions;
- no long-lived provider credentials in renderer;
- same-account isolation;
- logout/revocation;
- generation/tab identity fencing;
- capability-scoped browser actions;
- safe external URL/deep-link handling;
- secrets scrubbed from logs/evidence;
- bounded queues/rate limits;
- no production-only debug bypasses.

## 16. Current state

At `bhrumom/fabushi-chrome-extension@9a5238642fb4e5fff7d87e5f193b9cbf0864cda7`:

- MV3 extension version is `0.6.22`;
- `action.default_popup` points to `app.html`;
- `app.html/app.js` implement a Fabushi-specific five-view shell;
- Chats currently use a desktop/platform request path;
- Browser Control, account integration, userscripts and recovery are separate Service Worker modules;
- remote userscript update behavior is present;
- the complete Grok 2,046-row Chrome parity ledger does not exist;
- full Grok Agent UI/runtime parity is not complete.

Existing extension capability maturity must not be interpreted as Grok parity completion.

## 17. Target repository shape

Target ownership should become approximately:

```text
fabushi-chrome-extension/
├── frontend/
│   └── extension-app/
│       ├── src/
│       └── public/
├── source/
│   ├── extension-preload/
│   ├── extension-main/
│   ├── coordinator-client/
│   ├── browser-runner/
│   ├── userscripts/
│   ├── shared/
│   └── packages/
├── chatgpt-vps-control/
│   └── migration/adapters only until cutover is complete
├── docs/
│   ├── architecture/
│   └── specs/
└── tests/
    ├── contract/
    ├── integration/
    └── e2e/
```

Exact folders may evolve through a Spec amendment. The important requirement is Grok-shaped ownership, not a specific build tool.

Old paths may remain during controlled migration but must not remain a second production truth after cutover.

## 18. Failure modes and edge cases

Required coverage includes:

- Service Worker suspended/restarted during streaming;
- extension app reload during streaming;
- extension app closed/reopened during tool execution;
- multiple extension app tabs;
- Native Messaging unavailable;
- Native Messaging disconnect/reconnect;
- remote Coordinator disconnect/reconnect;
- auth expiry;
- Host crash/recovery;
- Runner/browser-control error;
- tab closed during tool action;
- CDP detach;
- cross-frame/OOPIF change;
- download failure/cancel;
- userscript update network failure;
- userscript recovery lease during extension restart;
- stale generation;
- duplicate event;
- out-of-order event;
- duplicate reply;
- duplicate send/cancel;
- protocol version mismatch;
- Chrome restart;
- extension update/reload during active run;
- storage quota/corruption;
- MCP auth failure;
- account switch/logout mid-run.

Every case must reach a deterministic terminal or recovery state.

## 19. Implementation strategy

### Phase 0 — inventory / parity ledger

1. pin Grok and Fabushi Chrome baselines;
2. generate all 2,046 Grok source/frontend ledger rows;
3. identify source responsibility/UI effect;
4. assign Chrome target path(s), runtime owner, language, transport and platform delta;
5. identify which existing extension capability each row intersects;
6. add strict inventory validation.

Exit gate: 100% source-file audit/disposition and zero unclassified responsibilities. Equal target/source file counts are not required.

### Phase 1 — full-page Grok renderer

Implement the full Grok-shaped application in React/TypeScript.

Cut toolbar behavior toward opening the full app.

Do not remove current shell until all current capability surfaces are available in the new app.

### Phase 2 — typed Extension Platform Runtime

Move product UI away from raw ad-hoc message calls into typed runtime contracts.

### Phase 3 — Coordinator transport

Implement one Coordinator client abstraction with local/native and remote adapters.

### Phase 4 — conversation/Agent lifecycle

Wire:

- Agent roster;
- conversation;
- transcript;
- composer;
- streaming;
- cancel;
- retry;
- resync;
- waiting-user;
- tool state;
- terminal settlement.

### Phase 5 — MCP/plugins/tools

Implement full Grok plugin/MCP UI/lifecycle and integrate Browser Control as a first-class tool/Runner capability.

### Phase 6 — existing Fabushi capabilities

Integrate and regression-protect:

- Browser Control;
- Mini Apps;
- Marketplace;
- Userscripts;
- remote userscript updates;
- account/same-account browser integration;
- recovery;
- keep-awake;
- Native Messaging.

### Phase 7 — legacy shell cutover

After replacement evidence:

- remove `default_popup = app.html` as the main Agent entry;
- remove the old shell as a parallel primary application;
- remove duplicate chat/runtime ownership;
- retain only explicit migration adapters with removal criteria.

### Phase 8 — strict parity closure

Require:

- zero unclassified ledger rows;
- zero product responsibilities without production implementation/equivalent;
- zero unexplained platform adaptations;
- zero hidden legacy primary shell;
- zero renderer->Host/Runner bypass;
- zero regression in existing extension capabilities.

## 20. Verification / test strategy

### Static / architecture

Fail CI if:

- a Grok source/frontend row is missing/duplicated;
- a required product responsibility lacks implementation/evidence;
- `not-applicable` lacks platform rationale;
- target checker requires equal source/target file counts;
- renderer directly owns Host/Runner behavior;
- Service Worker becomes canonical Agent truth;
- existing required extension feature disappears;
- unsafe secret/runtime code appears in renderer;
- old shell remains a hidden normal production fallback after final cutover.

### Unit / contract

Test:

- protocol schemas;
- lifecycle;
- streaming;
- cancel;
- reconnect/resync;
- stale generation;
- worker restart settlement;
- Browser Control;
- account/session;
- MCP;
- userscript update/recovery;
- Marketplace/Mini Apps;
- power/lease behavior.

### Packaged Chrome E2E

Run a real packaged/unpacked extension in Chrome.

Required flows:

1. toolbar action opens full Grok-shaped application;
2. login/session;
3. Agent roster;
4. create/open Agent;
5. create/open conversation;
6. ordinary chat;
7. streaming;
8. stop/cancel;
9. real Browser Control tool execution;
10. MCP tool execution;
11. ToolStarted/ToolCompleted UI;
12. attachments;
13. settings;
14. Mini Apps;
15. Marketplace;
16. userscript install/update/enable/disable;
17. userscript recovery;
18. Service Worker restart mid-run;
19. app reload/reopen mid-run;
20. same-run resync;
21. Native Messaging disconnect/reconnect;
22. remote runtime path without native host;
23. Chrome restart where durable state applies;
24. account switch/logout;
25. current host-resilience/keep-awake behavior.

## 21. Grok Bot Chrome effect

A mandatory end-to-end acceptance task must show:

```text
User sends task
  -> accepted
  -> preparing/thinking
  -> Host inference
  -> Tool/MCP/Browser Runner requested
  -> ToolStarted visible
  -> real Chrome/browser action executes
  -> ToolCompleted visible
  -> Host continues inference
  -> transcript streams incrementally
  -> completed/failed
```

During that run, force either Service Worker restart or app close/reopen:

```text
worker/app returns
  -> transport reauth/reconnect
  -> Coordinator resync
  -> same run ID/generation restored
  -> current tool/stream state restored
  -> no duplicate send/tool execution
  -> run continues or settles
```

This is the defining product-level acceptance for the plugin edition.

## 22. Acceptance criteria / Definition of Done

- **AC-1**: Grok reference is pinned to `a9f633e09d49a85829b8236331b9e21f7e612634`.
- **AC-2**: All 2,046 pinned Grok `source/**` + `frontend/**` files exist exactly once in the Chrome parity ledger.
- **AC-3**: Every product-relevant Grok responsibility has a real production Chrome implementation or evidenced equivalent; equal target-file count is not required.
- **AC-4**: Reviewed N/A applies only to genuinely inapplicable source mechanisms and does not silently remove a required product effect.
- **AC-5**: Full-page Grok-shaped Agent UI is the canonical plugin application.
- **AC-6**: Toolbar action opens the full app; a popup is absent or auxiliary only.
- **AC-7**: Renderer -> Platform Runtime -> Coordinator -> Host -> Runner ownership is real and tested.
- **AC-8**: MV3 Service Worker is a thin broker, not canonical Agent truth.
- **AC-9**: Service Worker restart mid-run resyncs the same durable run without duplicate send/tool.
- **AC-10**: Extension app reload/close/reopen mid-run resyncs the same durable run.
- **AC-11**: Local/native and remote transports expose one logical Coordinator protocol.
- **AC-12**: Core Grok Agent use works when the Native Messaging host is unavailable but the remote runtime is available.
- **AC-13**: Grok conversation/transcript/composer/streaming/lifecycle UI is implemented.
- **AC-14**: Grok MCP/plugins/connectors UI and lifecycle are implemented.
- **AC-15**: Browser Control is integrated as Grok-shaped tool/Runner capability.
- **AC-16**: Existing Browser Control behavior has zero regression.
- **AC-17**: Existing Mini Apps/Marketplace behavior has zero regression.
- **AC-18**: Existing userscript install/update/enable/disable/recovery behavior has zero regression.
- **AC-19**: Existing remote userscript update and last-known-good fallback behavior has zero regression.
- **AC-20**: Existing account/same-account browser integration has zero regression.
- **AC-21**: Existing host-resilience/recovery/keep-awake behavior has zero regression.
- **AC-22**: Existing Native Messaging functionality remains available behind the new runtime.
- **AC-23**: Current extension security guarantees are not weakened.
- **AC-24**: Old Fabushi primary shell does not remain as a hidden normal-production fallback.
- **AC-25**: Exact-HEAD CI passes strict ledger, unit, contract, architecture, security and packaged Chrome E2E.
- **AC-26**: Package ZIP, version, checksum/content manifest and release evidence bind to exact source SHA.
- **AC-27 — Grok Bot Chrome effect**: exact-HEAD packaged acceptance proves accepted -> thinking -> real Tool/MCP/Browser Runner -> live result -> continued inference -> streaming -> terminal, plus same-run recovery after worker/app restart.
- **AC-28**: Final Spec compliance records every requirement and AC as passed, blocked or not-applicable with evidence; no mandatory blocked item remains for completion.

## 23. Release / migration / rollback

Migration may be incremental, but final shipping architecture has one canonical Agent UI/runtime client.

Existing data/state must be migrated or preserved as appropriate:

- userscript enabled/installed state;
- Marketplace/Mini App state;
- account/session state within security limits;
- extension preferences;
- safe Browser Control state;
- recovery/lease state where still valid.

Rollback occurs at extension package/version boundary. Do not keep two primary shells/runtimes indefinitely as a rollback strategy.

Release is blocked if:

- existing extension functions regress;
- Grok core is only mocked;
- the Service Worker owns durable Agent truth;
- same-run recovery fails;
- old primary shell remains required;
- exact-HEAD package/E2E evidence is incomplete.

## 24. Observability / evidence

Evidence must include:

- exact source SHA;
- Chrome extension version;
- ZIP SHA-256/content manifest;
- strict parity-ledger report;
- UI screenshots/video;
- one full Agent run trace;
- stable run/request/generation IDs;
- worker restart trace;
- app reload/reopen trace;
- Browser Control tool trace;
- MCP trace;
- userscript regression evidence;
- remote update regression evidence;
- host-resilience/keep-awake evidence;
- Native Messaging local path evidence;
- remote Agent runtime path evidence;
- Chrome version/profile.

## 25. References / provenance

Primary reference:

- `b-nnett/grok-bot-0.18-reconstructed@a9f633e09d49a85829b8236331b9e21f7e612634`

Canonical Fabushi Chrome repository:

- `bhrumom/fabushi-chrome-extension`
- baseline: `9a5238642fb4e5fff7d87e5f193b9cbf0864cda7`

Current key implementation paths:

- `chatgpt-vps-control/chrome-platform/extension/manifest.json`
- `chatgpt-vps-control/chrome-platform/extension/app.html`
- `chatgpt-vps-control/chrome-platform/extension/app.js`
- `chatgpt-vps-control/chrome-platform/extension/service-worker.js`
- `chatgpt-vps-control/chrome-platform/extension/platform-bridge.js`
- `chatgpt-vps-control/chrome-platform/extension/browser-control.js`
- `chatgpt-vps-control/chrome-platform/extension/account-browser-agent.js`
- `chatgpt-vps-control/chrome-platform/extension/userscript-*.js`
- `projects/chatgpt-host-resilience/**`

Legacy migration/source history:

- `bhrumom/fabushi` is reference/migration history only and is not a valid target location for this implementation.

The Grok repository is an unofficial reconstruction. It is used as architecture, protocol, behavior and UI evidence; rights/provenance review remains required for any directly derived redistributed material.

## 26. Spec compliance record

| Requirement / AC | Status | Evidence / reason |
| --- | --- | --- |
| R-EXIST-001..006 | pending | Current baseline implements these capabilities; final Grok architecture must prove zero regression. |
| R-UI-001..004 | pending | Current popup-oriented five-view shell is not full Grok UI parity. |
| R-ARCH-001..006 | pending | Complete Grok-shaped runtime ownership is not yet proven. |
| R-RUN-001..007 | pending | Durable same-run lifecycle/recovery is not yet proven. |
| AC-1 | passed | Exact Grok reference pinned in this Spec. |
| AC-2 | pending | 2,046-row Chrome parity ledger does not yet exist. |
| AC-3..4 | pending | Product-responsibility closure has not been completed. |
| AC-5..6 | pending | Current manifest still uses `action.default_popup = app.html`. |
| AC-7..12 | pending | Coordinator/Host/Runner client boundaries and same-run recovery are incomplete. |
| AC-13..15 | pending | Full Grok Agent/MCP/tool UI parity is incomplete. |
| AC-16..23 | pending | Existing capabilities require final-architecture regression/security evidence. |
| AC-24 | pending | Old shell is still the current production application. |
| AC-25..26 | pending | Final exact-HEAD CI/package evidence does not exist for this architecture. |
| AC-27 | pending | Grok Bot Chrome effect is not yet proven. |
| AC-28 | pending | Final compliance review pending. |

Allowed migration status: `pending`. Allowed final statuses: `passed`, `blocked`, `not-applicable`.
