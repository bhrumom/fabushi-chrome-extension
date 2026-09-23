import { createExtensionPlatformRuntime } from "./extension-runtime.js";
import { projectRunPhase } from "./agent-protocol.js";

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const MAX_ATTACHMENTS = 4;
const PLUGIN_AUTH_AGENT_PURPOSE = "plugin-auth";
const PLUGIN_AUTH_AGENT_NAME = "Plugin Setup";
const PLUGIN_AUTH_PROMPT = [
  "Some installed plugins cannot be fetched because your runtime does not yet have access to their private source repositories.",
  "Set up the required git authentication on the computer you control, not inside the Chrome renderer.",
  "When you need a device code, password, 2FA, OAuth approval, or any secret, ask me through the normal waiting-user flow instead of printing or guessing it.",
  "After setup, verify access with a read-only repository check and tell me which plugins are now available.",
].join(" ");
const ATTACHMENT_MIME_BY_EXTENSION = Object.freeze({
  ".csv": "text/csv",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".rtf": "application/rtf",
  ".txt": "text/plain",
  ".webp": "image/webp",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
});

function attachmentMime(file) {
  if (file.type) return file.type.toLowerCase();
  const name = file.name.toLowerCase();
  const extension = Object.keys(ATTACHMENT_MIME_BY_EXTENSION).find((candidate) => name.endsWith(candidate));
  return extension ? ATTACHMENT_MIME_BY_EXTENSION[extension] : "application/octet-stream";
}

function attachmentReference(value) {
  if (typeof value === "string" && value) return value;
  if (!value || typeof value !== "object") return "";
  for (const key of ["reference", "attachmentRef", "token", "path"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  return "";
}

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

export function createAgentWorkspace({ showBanner, hideBanner }) {
  const runtime = createExtensionPlatformRuntime();
  const state = {
    filter: "",
    agents: [],
    activeAgentId: "",
    entries: [],
    phase: "recovering",
    transport: { kind: "none", connected: false },
    mcp: [],
    pluginSync: { status: "loading", authBlocked: [], error: "" },
    channels: { status: "idle", manifests: [], connections: [], error: "" },
    account: { loggedIn: false, loggingIn: false, connected: false, account: null, error: "" },
    browser: { connected: false, tabs: [] },
    attachments: [],
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
  const pluginStatus = $("#agent-plugin-status");
  const channelList = $("#agent-channel-list");
  const accountStatus = $("#agent-account-status");
  const browserList = $("#agent-browser-context");
  const agentName = $("#agent-name-input");
  const stopButton = $("#stop-run");
  const composer = $("#composer");
  const input = $("#composer-input");
  const attachmentTray = $("#attachment-tray");
  const attachmentInput = $("#attachment-input");
  const attachButton = $("#attach-file");

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

  function renderAttachments() {
    if (!attachmentTray) return;
    attachmentTray.replaceChildren();
    attachmentTray.hidden = state.attachments.length === 0;

    for (const attachment of state.attachments) {
      const chip = document.createElement("div");
      chip.className = "attachment-chip";
      chip.dataset.status = attachment.status;

      const name = document.createElement("strong");
      name.textContent = attachment.name;
      name.title = attachment.name;

      const detail = document.createElement("span");
      const size = attachment.size < 1024 * 1024
        ? `${Math.max(1, Math.round(attachment.size / 1024))} KB`
        : `${(attachment.size / (1024 * 1024)).toFixed(1)} MB`;
      detail.textContent = attachment.status === "failed"
        ? attachment.error || "failed"
        : attachment.status === "staging" ? `${size} · staging`
          : attachment.status === "submitted" ? `${size} · submitted`
            : size;

      chip.append(name, detail);

      if (attachment.status !== "submitted") {
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary-button";
        remove.textContent = "×";
        remove.title = "Remove attachment";
        remove.addEventListener("click", () => void removeAttachment(attachment.attachmentId));
        chip.append(remove);
      }

      attachmentTray.append(chip);
    }
  }

  async function removeAttachment(attachmentId) {
    const index = state.attachments.findIndex((item) => item.attachmentId === attachmentId);
    if (index < 0) return;
    const [attachment] = state.attachments.splice(index, 1);
    renderAttachments();

    if (attachment.reference && attachment.status !== "submitted") {
      await runtime.discardAttachment({
        attachmentId: attachment.attachmentId,
        reference: attachment.reference,
      }).catch(() => {});
    }
  }

  async function discardUnsubmittedAttachments() {
    const pending = state.attachments.filter((attachment) => attachment.status !== "submitted");
    state.attachments = state.attachments.filter((attachment) => attachment.status === "submitted");
    renderAttachments();
    await Promise.allSettled(pending
      .filter((attachment) => attachment.reference)
      .map((attachment) => runtime.discardAttachment({
        attachmentId: attachment.attachmentId,
        reference: attachment.reference,
      })));
  }

  async function stageFiles(fileList) {
    const files = [...(fileList || [])];
    if (!files.length) return;

    const available = Math.max(0, MAX_ATTACHMENTS - state.attachments.filter((item) => item.status !== "submitted").length);
    if (available === 0) {
      showBanner?.(`Up to ${MAX_ATTACHMENTS} staged attachments are allowed per prompt.`, "error");
      return;
    }

    for (const file of files.slice(0, available)) {
      const mimeType = attachmentMime(file);
      if (file.size <= 0 || file.size > MAX_ATTACHMENT_BYTES) {
        showBanner?.(`${file.name}: attachments must be between 1 byte and 8 MiB.`, "error");
        continue;
      }
      if (mimeType === "application/octet-stream") {
        showBanner?.(`${file.name}: unsupported attachment type.`, "error");
        continue;
      }

      const local = {
        attachmentId: crypto.randomUUID(),
        name: file.name,
        mimeType,
        size: file.size,
        status: "staging",
        reference: "",
        error: "",
      };
      state.attachments.push(local);
      renderAttachments();

      try {
        const staged = await runtime.stageAttachment(file, { mimeType });
        local.attachmentId = staged.attachmentId || local.attachmentId;
        local.reference = attachmentReference(staged.result);
        if (!local.reference) throw new Error("Coordinator did not return a staged attachment reference.");
        local.status = "ready";
      } catch (error) {
        local.status = "failed";
        local.error = error?.message || String(error);
      }
      renderAttachments();
    }
  }

  function actionButton(label, handler, options = {}) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = options.danger ? "danger-button context-action" : "secondary-button context-action";
    button.textContent = label;
    button.disabled = options.disabled === true;
    button.addEventListener("click", handler);
    return button;
  }

  function renderAccount() {
    if (!accountStatus) return;
    accountStatus.replaceChildren();

    const summary = document.createElement("div");
    summary.className = "context-row";
    const user = state.account.account?.user || state.account.account || null;
    const identity = textValue(user?.nickname || user?.username || user?.email);
    summary.textContent = state.account.loggingIn
      ? "Fabushi sign-in in progress"
      : state.account.loggedIn
        ? `${identity || "Fabushi account"} · ${state.account.connected ? "browser MCP connected" : "session ready"}`
        : "Signed out";
    accountStatus.append(summary);

    if (state.account.error) {
      const error = document.createElement("div");
      error.className = "context-muted context-error";
      error.textContent = state.account.error;
      accountStatus.append(error);
    }

    if (state.account.loggedIn) {
      accountStatus.append(actionButton("Sign out", () => void accountLogout(), { danger: true }));
    } else {
      accountStatus.append(actionButton(
        state.account.loggingIn ? "Signing in…" : "Sign in",
        () => void accountLogin(),
        { disabled: state.account.loggingIn }
      ));
    }
  }

  function renderPlugins() {
    if (!pluginStatus) return;
    pluginStatus.replaceChildren();

    if (state.pluginSync.status === "loading") {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Checking installed plugin sync…";
      pluginStatus.append(row);
      return;
    }

    if (state.pluginSync.status === "failed") {
      const row = document.createElement("div");
      row.className = "context-row context-error";
      row.textContent = state.pluginSync.error || "Plugin sync status unavailable.";
      pluginStatus.append(row);
      pluginStatus.append(actionButton("Retry", () => void refreshPluginStatus()));
      return;
    }

    const blocked = state.pluginSync.authBlocked;
    if (!blocked.length) {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Plugin source authentication is ready.";
      pluginStatus.append(row);
      return;
    }

    const row = document.createElement("div");
    row.className = "context-row";
    const names = blocked.slice(0, 3).map((item) => item.pluginName).filter(Boolean);
    row.textContent = names.length
      ? `${names.join(", ")}${blocked.length > names.length ? ` +${blocked.length - names.length}` : ""} need setup`
      : `${blocked.length} installed plugin${blocked.length === 1 ? "" : "s"} need setup`;
    pluginStatus.append(row);
    pluginStatus.append(actionButton("Fix with Setup Agent", () => void fixPluginAuthentication()));
  }

  function renderChannels() {
    if (!channelList) return;
    channelList.replaceChildren();

    if (!state.activeAgentId) {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Choose an Agent to view connectors.";
      channelList.append(row);
      return;
    }

    if (state.channels.status === "loading") {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Loading connectors…";
      channelList.append(row);
      return;
    }

    if (state.channels.status === "failed") {
      const row = document.createElement("div");
      row.className = "context-row context-error";
      row.textContent = state.channels.error || "Connector status unavailable.";
      channelList.append(row);
      channelList.append(actionButton("Retry", () => void refreshChannels()));
      return;
    }

    const connections = new Map(state.channels.connections.map((item) => [item.platform, item]));
    const manifests = state.channels.manifests;

    if (!manifests.length && !state.channels.connections.length) {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "No Agent connectors reported.";
      channelList.append(row);
      return;
    }

    for (const manifest of manifests) {
      const row = document.createElement("div");
      row.className = "context-row context-row-actions";

      const copy = document.createElement("div");
      const name = document.createElement("strong");
      name.textContent = textValue(manifest.displayName || manifest.platform) || "Connector";
      const detail = document.createElement("div");
      detail.className = "context-muted";
      const connection = connections.get(manifest.platform);
      detail.textContent = manifest.availability === "coming-soon"
        ? "Soon"
        : connection?.status === "connected"
          ? `Connected as ${textValue(connection.label) || "account"}`
          : connection?.status === "error"
            ? textValue(connection.detail) || "Needs attention"
            : textValue(manifest.blurb) || "Available";
      copy.append(name, detail);
      row.append(copy);

      if (manifest.availability !== "coming-soon") {
        if (connection?.status === "connected") {
          row.append(
            actionButton("Refresh", () => void refreshChannel(manifest.platform)),
            actionButton("Disconnect", () => void disconnectChannel(manifest.platform), { danger: true })
          );
        } else {
          row.append(actionButton("Set up with Agent", () => void startChannelSetup(manifest)));
        }
      }
      channelList.append(row);
    }
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
    const nextAgentId = String(agentId || "");
    if (state.activeAgentId && state.activeAgentId !== nextAgentId) void discardUnsubmittedAttachments();
    state.activeAgentId = nextAgentId;
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
      if (agent) {
        await openAgent(agent.id);
        input?.focus();
      }
    } catch (error) {
      state.phase = error?.code === "coordinator-unavailable" ? "recovering" : "failed";
      renderPhase();
      showBanner?.(error.message, "error");
    }
  }

  async function sendPrompt(text) {
    if (!state.activeAgentId || !text.trim()) return;

    if (state.attachments.some((attachment) => attachment.status === "staging")) {
      showBanner?.("Wait for attachments to finish staging before sending.", "warning");
      return;
    }
    const failedAttachment = state.attachments.find((attachment) => attachment.status === "failed");
    if (failedAttachment) {
      showBanner?.(`Remove or retry failed attachment: ${failedAttachment.name}`, "error");
      return;
    }

    const prompt = text.trim();
    const promptAttachments = state.attachments.filter((attachment) => attachment.status === "ready");
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
        attachmentPaths: promptAttachments.map((attachment) => attachment.reference),
        attachmentNames: promptAttachments.map((attachment) => attachment.name),
        clientNonce: nonce,
        enterEpochMs: createdAtMs,
        composedAtMs: createdAtMs,
      }, { requestId, timeoutMs: 60_000 });
      state.phase = "preparing";
      const submittedIds = new Set(promptAttachments.map((attachment) => attachment.attachmentId));
      state.attachments = state.attachments.filter((attachment) => !submittedIds.has(attachment.attachmentId));
      renderAttachments();
      scheduleTranscriptRefresh();
      return;
    } catch (error) {
      if (error?.code !== "coordinator-unavailable" || error?.delivery !== "not-sent") {
        state.phase = "recovering";
        const submittedIds = new Set(promptAttachments.map((attachment) => attachment.attachmentId));
        for (const attachment of state.attachments) {
          if (submittedIds.has(attachment.attachmentId)) attachment.status = "submitted";
        }
        renderAttachments();
        showBanner?.(
          "Coordinator acknowledgement was lost after dispatch. Fabushi will resync this run instead of sending the prompt or its attachments again.",
          "warning"
        );
        renderPhase();
        return;
      }
    }

    state.phase = "recovering";
    state.inFlightRequestId = "";
    showBanner?.(
      "No Coordinator runtime is available. Connect an authenticated remote runtime or a Coordinator-capable native host.",
      "error"
    );
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

    attachButton?.addEventListener("click", () => attachmentInput?.click());
    attachmentInput?.addEventListener("change", () => {
      const files = attachmentInput.files;
      attachmentInput.value = "";
      void stageFiles(files);
    });
    composer?.addEventListener("dragover", (event) => {
      if (!event.dataTransfer?.types?.includes("Files")) return;
      event.preventDefault();
      composer.classList.add("drag-active");
    });
    composer?.addEventListener("dragleave", () => composer.classList.remove("drag-active"));
    composer?.addEventListener("drop", (event) => {
      if (!event.dataTransfer?.files?.length) return;
      event.preventDefault();
      composer.classList.remove("drag-active");
      void stageFiles(event.dataTransfer.files);
    });
    input?.addEventListener("paste", (event) => {
      const files = [...(event.clipboardData?.files || [])];
      if (files.length) void stageFiles(files);
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


    dispose() {
      clearTimeout(state.refreshTimer);
      void discardUnsubmittedAttachments();
      runtime.dispose();
    },
  };
}
