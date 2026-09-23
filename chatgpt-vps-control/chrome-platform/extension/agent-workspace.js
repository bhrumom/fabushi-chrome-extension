import { createExtensionPlatformRuntime } from "./extension-runtime.js";
import { projectRunPhase } from "./agent-protocol.js";

function textValue(value) {
  return typeof value === "string" ? value : "";
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  for (const key of ["agents", "items", "results", "tools", "entries"]) {
    if (Array.isArray(value?.[key])) return value[key];
  }
  return [];
}

function projectAgent(value) {
  if (!value || typeof value !== "object") return null;
  const id = textValue(value.id || value.agentId || value.conversationId);
  if (!id) return null;
  return {
    id,
    name: textValue(value.name || value.title) || "New chat",
    description: textValue(value.description),
    updatedAt: Number(value.updatedAt || value.updated_at || 0),
    isRunning: value.isRunning === true,
    waitingReason: textValue(value.waitingReason || value.awaitingUserResponse?.reason),
    raw: value,
  };
}

function entryText(entry) {
  if (!entry || typeof entry !== "object") return "";
  const message = entry.message && typeof entry.message === "object" ? entry.message : {};
  return textValue(entry.text || entry.content || entry.delta || message.text || message.content || entry.notice || entry.error);
}

function entryRole(entry) {
  if (!entry || typeof entry !== "object") return "assistant";
  const message = entry.message && typeof entry.message === "object" ? entry.message : {};
  const role = textValue(entry.role || message.role || entry.author);
  if (role === "user" || entry.kind === "user-message" || entry.kind === "user-attachment") return "user";
  if (role === "system") return "system";
  return "assistant";
}

function entryKind(entry) {
  const raw = textValue(entry?.kind || entry?.type || entry?.message?.type).toLowerCase();
  if (raw.includes("tool") || raw.includes("permission")) return "tool";
  if (raw.includes("think")) return "thinking";
  if (raw.includes("notice") || raw.includes("event")) return "notice";
  return "message";
}

function safeId(entry, index) {
  return textValue(entry?.id) || `entry-${index}`;
}

export function createAgentWorkspace({ desktopRequest, showBanner, hideBanner }) {
  const runtime = createExtensionPlatformRuntime();
  const state = {
    filter: "",
    agents: [],
    activeAgentId: "",
    entries: [],
    phase: "recovering",
    transport: { kind: "none", connected: false },
    mcp: [],
    browser: { connected: false, tabs: [] },
    inFlightRequestId: "",
    refreshTimer: null,
    started: false,
  };

  const $ = (selector) => document.querySelector(selector);
  const roster = $("#chat-list");
  const count = $("#chat-count");
  const messages = $("#messages");
  const empty = $("#conversation-empty");
  const conversation = $("#conversation");
  const title = $("#conversation-title");
  const runState = $("#agent-run-state");
  const transportState = $("#agent-transport-state");
  const mcpList = $("#agent-mcp-list");
  const browserList = $("#agent-browser-context");
  const agentName = $("#agent-name-input");
  const stopButton = $("#stop-run");
  const composer = $("#composer");
  const input = $("#composer-input");

  function renderPhase() {
    if (runState) {
      runState.textContent = state.phase || "idle";
      runState.dataset.phase = state.phase || "idle";
    }
    if (transportState) {
      const label = state.transport.connected
        ? `${state.transport.kind || "coordinator"} connected`
        : `${state.transport.kind || "coordinator"} unavailable`;
      transportState.textContent = label;
      transportState.classList.toggle("connected", Boolean(state.transport.connected));
    }
    if (stopButton) stopButton.hidden = !state.inFlightRequestId;
  }

  function renderRoster() {
    if (!roster) return;
    roster.replaceChildren();
    const needle = state.filter.trim().toLowerCase();
    const filtered = state.agents
      .filter((agent) => !needle || `${agent.name} ${agent.description}`.toLowerCase().includes(needle))
      .sort((left, right) => right.updatedAt - left.updatedAt);

    if (count) count.textContent = String(filtered.length);

    for (const agent of filtered) {
      const button = document.createElement("button");
      button.type = "button";
      button.classList.toggle("active", agent.id === state.activeAgentId);

      const strong = document.createElement("strong");
      strong.textContent = agent.name;

      const meta = document.createElement("span");
      meta.textContent = agent.waitingReason
        ? `waiting · ${agent.waitingReason}`
        : agent.isRunning ? "running" : "agent";

      button.append(strong, meta);
      button.addEventListener("click", () => void openAgent(agent.id));
      roster.append(button);
    }

    if (!filtered.length) {
      const node = document.createElement("div");
      node.className = "empty compact";
      node.textContent = state.transport.connected
        ? "No agents yet."
        : "Coordinator unavailable. Browser Control, Marketplace and userscripts remain available.";
      roster.append(node);
    }
  }

  function renderEntries() {
    if (!messages) return;
    messages.replaceChildren();

    for (const [index, entry] of state.entries.entries()) {
      const kind = entryKind(entry);
      const node = document.createElement("div");
      node.className = `message ${kind}${entryRole(entry) === "user" ? " me" : ""}`;
      node.dataset.entryId = safeId(entry, index);

      const copy = entryText(entry);
      if (kind === "thinking") {
        node.textContent = copy || "Thinking…";
      } else if (kind === "tool") {
        const label = document.createElement("strong");
        label.textContent = textValue(entry.toolName || entry.name || entry.message?.name) || "Tool";
        const detail = document.createElement("span");
        detail.textContent = copy || textValue(entry.status || entry.phase) || "running";
        node.append(label, detail);
      } else {
        node.textContent = copy || textValue(entry.kind || entry.type);
      }
      messages.append(node);
    }

    messages.scrollTop = messages.scrollHeight;
  }

  function renderContext() {
    if (mcpList) {
      mcpList.replaceChildren();
      const shown = state.mcp.slice(0, 12);
      for (const tool of shown) {
        const row = document.createElement("div");
        row.className = "context-row";
        row.textContent = textValue(tool.title || tool.name || tool.toolName) || "MCP tool";
        mcpList.append(row);
      }
      if (!shown.length) {
        const row = document.createElement("div");
        row.className = "context-muted";
        row.textContent = "No routed MCP tools reported.";
        mcpList.append(row);
      }
    }

    if (browserList) {
      browserList.replaceChildren();

      const summary = document.createElement("div");
      summary.className = "context-muted";
      summary.textContent = `${state.browser.tabs?.length || 0} Chrome tabs · ${state.browser.connected ? "native bridge connected" : "extension-local Browser Control"}`;
      browserList.append(summary);

      for (const tab of (state.browser.tabs || []).slice(0, 5)) {
        const row = document.createElement("div");
        row.className = "context-row";
        row.textContent = tab.title || tab.url || "Chrome tab";
        browserList.append(row);
      }
    }

    const active = state.agents.find((agent) => agent.id === state.activeAgentId);
    if (agentName) agentName.value = active?.name || "";
  }

  function selectAgent(agentId) {
    state.activeAgentId = String(agentId || "");
    const active = state.agents.find((agent) => agent.id === state.activeAgentId);

    if (title) title.textContent = active?.name || "Agent";
    if (empty) empty.hidden = Boolean(state.activeAgentId);
    if (conversation) conversation.hidden = !state.activeAgentId;

    renderRoster();
    renderContext();
    void runtime.setActiveAgent(state.activeAgentId).catch(() => {});
  }

  async function coordinatorCall(method, args = {}, options = {}) {
    const response = await runtime.call(method, args, options);
    state.transport = response.transport || { kind: "coordinator", connected: true };
    renderPhase();
    return response.result;
  }

  async function refreshTranscript() {
    if (!state.activeAgentId || state.activeAgentId === "new") return;

    const result = await coordinatorCall(
      "getAgentTranscriptWindow",
      { id: state.activeAgentId, limit: 160 },
      { timeoutMs: 30_000 }
    );
    state.entries = asArray(result);
    renderEntries();
  }

  async function openAgent(agentId) {
    selectAgent(agentId);
    try {
      await refreshTranscript();
      hideBanner?.();
    } catch (error) {
      if (error?.code !== "coordinator-unavailable") showBanner?.(error.message, "error");
    }
  }

  async function refreshRoster() {
    try {
      const result = await coordinatorCall("listAgents", {}, { timeoutMs: 20_000 });
      state.agents = asArray(result).map(projectAgent).filter(Boolean);
      if (!state.activeAgentId && state.agents[0]) selectAgent(state.agents[0].id);
      renderRoster();
      if (state.activeAgentId) await refreshTranscript();
      hideBanner?.();
    } catch (error) {
      state.transport = { kind: state.transport.kind || "none", connected: false, error: error.message };
      if (state.activeAgentId) state.phase = "recovering";
      renderPhase();
      renderRoster();
    }
  }

  async function refreshMcp() {
    try {
      const result = await coordinatorCall("listRoutedMcpTools", {}, { timeoutMs: 20_000 });
      state.mcp = asArray(result);
    } catch {
      state.mcp = [];
    }
    renderContext();
  }

  async function refreshBrowser() {
    try {
      state.browser = await runtime.browserStatus();
    } catch {
      state.browser = { connected: false, tabs: [] };
    }
    renderContext();
  }

  function scheduleTranscriptRefresh() {
    clearTimeout(state.refreshTimer);
    state.refreshTimer = setTimeout(() => void refreshTranscript().catch(() => {}), 80);
  }

  function applyRuntimeEvent({ family, payload }) {
    if (family === "coordinator-transport-state") {
      const connected = payload?.state === "connected";
      state.transport = {
        ...state.transport,
        connected,
        ...(payload?.transport ? { kind: payload.transport } : {}),
      };
      state.phase = connected && state.phase === "recovering" ? "accepted" : connected ? state.phase : "recovering";
      renderPhase();
      if (connected) void refreshRoster();
      return;
    }

    if (family === "agents" || family === "agent-upserted") {
      void refreshRoster();
      return;
    }

    if (family === "client-side-tool-v2" || String(family).includes("tool")) {
      state.phase = "tool-running";
      renderPhase();
    }

    const phase = projectRunPhase(family, payload);
    if (phase) {
      state.phase = phase;
      if (["completed", "failed", "cancelled"].includes(phase)) state.inFlightRequestId = "";
      renderPhase();
    }

    if (family === "transcript" || String(family).includes("transcript")) scheduleTranscriptRefresh();
  }

  function handleLegacyPlatformEvent(event) {
    if (!event || typeof event !== "object") return false;

    if (event.type === "conversation.listed" && Array.isArray(event.conversations)) {
      state.agents = event.conversations.map(projectAgent).filter(Boolean);
      state.transport = { kind: "legacy-native", connected: true };
      renderRoster();
      renderPhase();
      return true;
    }

    if (event.type === "conversation.opened") {
      if (event.conversationId) selectAgent(event.conversationId);
      state.entries = Array.isArray(event.messages) ? event.messages : [];
      renderEntries();
      return true;
    }

    if (event.type === "chat.message") {
      state.entries.push({ id: crypto.randomUUID(), role: event.role, text: event.text || "" });
      renderEntries();
      return true;
    }

    if (event.type === "chat.delta") {
      state.phase = "streaming";
      const last = state.entries.at(-1);
      if (last?.role === "assistant" && last.streaming) {
        last.text = `${last.text || ""}${event.delta || ""}`;
      } else {
        state.entries.push({
          id: crypto.randomUUID(),
          role: "assistant",
          text: event.delta || "",
          streaming: true,
        });
      }
      renderEntries();
      renderPhase();
      return true;
    }

    if (["operation.completed", "operation.failed", "operation.interrupted"].includes(event.type)) {
      state.phase = event.type === "operation.completed"
        ? "completed"
        : event.type === "operation.failed" ? "failed" : "cancelled";
      if (state.entries.at(-1)?.streaming) state.entries.at(-1).streaming = false;
      state.inFlightRequestId = "";
      renderEntries();
      renderPhase();
      return true;
    }

    return false;
  }

  async function createAgent() {
    try {
      const result = await coordinatorCall("createAgent", {
        name: "New chat",
        description: "",
        origin: "user",
        isKickstartRequested: false,
        clientNonce: crypto.randomUUID(),
      });
      const raw = result?.agent || result;
      const agent = projectAgent(raw);
      await refreshRoster();
      if (agent) await openAgent(agent.id);
      return;
    } catch (error) {
      if (error?.code !== "coordinator-unavailable") {
        showBanner?.(error.message, "error");
        return;
      }
    }

    if (!state.agents.some((agent) => agent.id === "new")) {
      state.agents.unshift({ id: "new", name: "New chat", description: "", updatedAt: Date.now(), raw: {} });
    }
    state.entries = [];
    selectAgent("new");
    renderEntries();
    input?.focus();
  }

  async function sendPrompt(text) {
    if (!state.activeAgentId || !text.trim()) return;

    const prompt = text.trim();
    const nonce = crypto.randomUUID();
    const createdAtMs = Date.now();
    const requestId = `send-${nonce}`;

    state.entries.push({
      id: nonce,
      role: "user",
      text: prompt,
      clientNonce: nonce,
      timestampMs: createdAtMs,
    });
    state.phase = "accepted";
    state.inFlightRequestId = requestId;
    renderEntries();
    renderPhase();

    try {
      await coordinatorCall("sendPrompt", {
        agentId: state.activeAgentId,
        prompt,
        directAddressedAcceptance: true,
        attachmentPaths: [],
        attachmentNames: [],
        clientNonce: nonce,
        enterEpochMs: createdAtMs,
        composedAtMs: createdAtMs,
      }, { requestId, timeoutMs: 60_000 });
      state.phase = "preparing";
      scheduleTranscriptRefresh();
      return;
    } catch (error) {
      if (error?.code !== "coordinator-unavailable" || error?.delivery !== "not-sent") {
        state.phase = "recovering";
        showBanner?.(
          "Coordinator acknowledgement was lost after dispatch. Fabushi will resync this run instead of sending the prompt again.",
          "warning"
        );
        renderPhase();
        return;
      }
    }

    if (typeof desktopRequest !== "function") {
      state.phase = "failed";
      state.inFlightRequestId = "";
      renderPhase();
      return;
    }

    try {
      const conversationId = state.activeAgentId === "new" ? undefined : state.activeAgentId;
      await desktopRequest("feature.execute", {
        command: {
          type: "chat.send",
          requestId,
          text: prompt,
          conversationId,
          agentId: conversationId ? undefined : "mahayana-assistant",
          mode: "agent",
        },
      });
      state.transport = { kind: "legacy-native", connected: true };
      state.phase = "preparing";
    } catch (legacyError) {
      state.phase = "failed";
      state.inFlightRequestId = "";
      showBanner?.(legacyError.message, "error");
    }
    renderPhase();
  }

  async function renameActiveAgent() {
    const active = state.agents.find((agent) => agent.id === state.activeAgentId);
    const name = agentName?.value.trim();
    if (!active || !name || active.id === "new") return;

    try {
      await coordinatorCall("updateAgent", {
        id: active.id,
        profile: { name, description: active.description || "" },
      });
      active.name = name;
      renderRoster();
      renderContext();
      if (title) title.textContent = name;
    } catch (error) {
      showBanner?.(error.message, "error");
    }
  }

  async function deleteActiveAgent() {
    const id = state.activeAgentId;
    if (!id || id === "new") return;

    try {
      await coordinatorCall("deleteAgents", { ids: [id] });
      state.activeAgentId = "";
      state.entries = [];
      await refreshRoster();
      renderEntries();
    } catch (error) {
      showBanner?.(error.message, "error");
    }
  }

  async function cancelActive() {
    if (!state.inFlightRequestId) return;

    try {
      await runtime.cancel(state.inFlightRequestId);
      state.phase = "cancelled";
    } catch (error) {
      showBanner?.(error.message, "error");
    } finally {
      state.inFlightRequestId = "";
      renderPhase();
    }
  }

  function bind() {
    $("#new-chat")?.addEventListener("click", () => void createAgent());

    composer?.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input?.value || "";
      if (input) input.value = "";
      void sendPrompt(value);
    });

    stopButton?.addEventListener("click", () => void cancelActive());
    $("#agent-save-name")?.addEventListener("click", () => void renameActiveAgent());
    $("#agent-delete")?.addEventListener("click", () => void deleteActiveAgent());
    $("#agent-refresh-context")?.addEventListener("click", () => void Promise.allSettled([refreshMcp(), refreshBrowser()]));
  }

  return {
    async start() {
      if (state.started) return;
      state.started = true;
      bind();
      runtime.subscribe(applyRuntimeEvent);

      try {
        const attached = await runtime.attach(state.activeAgentId);
        state.transport = attached.transport || state.transport;
        state.phase = attached.cursor?.runPhase || (state.transport.connected ? "accepted" : "recovering");
        if (attached.cursor?.activeAgentId) state.activeAgentId = attached.cursor.activeAgentId;
      } catch {
        state.phase = "recovering";
      }

      renderPhase();
      await Promise.allSettled([refreshRoster(), refreshMcp(), refreshBrowser()]);
    },

    async refresh() {
      await Promise.allSettled([refreshRoster(), refreshMcp(), refreshBrowser()]);
    },

    setFilter(value) {
      state.filter = String(value || "");
      renderRoster();
    },

    handleLegacyPlatformEvent,

    dispose() {
      clearTimeout(state.refreshTimer);
      runtime.dispose();
    },
  };
}
