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
  for (const key of ["agents", "items", "results", "tools", "entries", "tasks", "workflows", "automations"]) {
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
  const messageType = textValue(entry?.message?.type).toLowerCase();
  if (messageType === "local-tool-permission" || messageType === "auto-review-approval") return "approval";
  if (messageType === "secret-request") return "secret";
  if (messageType === "widget" || messageType === "connector" || messageType === "connectors") return "interactive";
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
    mcpResults: {},
    pluginSync: { status: "loading", authBlocked: [], error: "" },
    channels: { status: "idle", manifests: [], connections: [], error: "" },
    account: { loggedIn: false, loggingIn: false, connected: false, account: null, error: "" },
    browser: { connected: false, tabs: [] },
    asyncTasks: { status: "idle", items: [], error: "" },
    outline: { status: "idle", items: [], error: "" },
    workflows: { status: "idle", items: [], error: "" },
    automations: { status: "idle", items: [], error: "" },
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
  const avatar = $("#agent-avatar");
  const runState = $("#agent-run-state");
  const transportState = $("#agent-transport-state");
  const reconnectButton = $("#agent-reconnect-runtime");
  const mcpList = $("#agent-mcp-list");
  const pluginStatus = $("#agent-plugin-status");
  const channelList = $("#agent-channel-list");
  const accountStatus = $("#agent-account-status");
  const browserList = $("#agent-browser-context");
  const asyncTasksList = $("#agent-async-tasks");
  const outlineList = $("#agent-conversation-outline");
  const workflowsList = $("#agent-workflows");
  const automationsList = $("#agent-automations");
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

  function avatarGlyph(agent) {
    const source = textValue(agent?.name || agent?.id || "F").trim();
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return `${parts[0][0] || ""}${parts[1][0] || ""}`.toUpperCase();
    return source.slice(0, 2).toUpperCase() || "F";
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
      button.className = "agent-roster-item";
      button.classList.toggle("active", agent.id === state.activeAgentId);

      const icon = document.createElement("span");
      icon.className = "agent-avatar";
      icon.textContent = avatarGlyph(agent);

      const copy = document.createElement("span");
      const strong = document.createElement("strong");
      strong.textContent = agent.name;

      const meta = document.createElement("span");
      meta.textContent = agent.waitingReason
        ? `waiting · ${agent.waitingReason}`
        : agent.isRunning ? "running" : "agent";

      copy.append(strong, meta);
      button.append(icon, copy);
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

  function approvalActions(node, actions) {
    const group = document.createElement("div");
    group.className = "transcript-actions";
    for (const action of actions) group.append(actionButton(action.label, action.handler, { danger: action.danger, disabled: action.disabled }));
    node.append(group);
  }

  function renderReactions(node, entry) {
    if (entry?.kind !== "send-message" || !entry?.id || entry?.message?.type === "secret-request") return;
    const reactionRows = Array.isArray(entry.reactions) ? entry.reactions : [];
    const mine = new Set(reactionRows
      .filter((reaction) => reaction?.by === "me" && typeof reaction.emoji === "string")
      .map((reaction) => reaction.emoji));
    const counts = new Map();
    for (const reaction of reactionRows) {
      if (typeof reaction?.emoji !== "string" || !reaction.emoji) continue;
      counts.set(reaction.emoji, (counts.get(reaction.emoji) || 0) + 1);
    }

    const row = document.createElement("div");
    row.className = "reaction-row";
    const choices = ["👍", "👎", "❤️", "🎉"];
    for (const emoji of choices) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "secondary-button reaction-button";
      button.classList.toggle("active", mine.has(emoji));
      const count = counts.get(emoji) || 0;
      button.textContent = count > 0 ? `${emoji} ${count}` : emoji;
      button.title = `React ${emoji}`;
      button.addEventListener("click", () => void reactToMessage(entry, emoji));
      row.append(button);
    }
    node.append(row);
  }

  function renderApprovalEntry(node, entry) {
    const message = entry?.message || {};
    if (message.type === "local-tool-permission") {
      const ask = message.ask || {};
      const title = document.createElement("strong");
      title.textContent = "Allow this Agent to use a local tool?";
      const detail = document.createElement("span");
      detail.textContent = ask.status === "pending"
        ? "This action runs through the Host permission boundary."
        : `Permission request: ${textValue(ask.status) || "settled"}`;
      node.append(title, detail);
      if (ask.status === "pending" && state.activeAgentId && entry.id && ask.requestId) {
        approvalActions(node, [
          {
            label: "Allow once",
            handler: () => void resolveLocalToolPermission(entry, "allow-once"),
          },
          {
            label: "Deny",
            danger: true,
            handler: () => void resolveLocalToolPermission(entry, "deny"),
          },
        ]);
      }
      return;
    }

    const approval = message.approval || {};
    const title = document.createElement("strong");
    title.textContent = approval.surface === "mcp"
      ? "The Agent wants to use a connected service"
      : approval.surface === "host_shell" || approval.surface === "box_shell"
        ? "The Agent wants to run a command"
        : "Approval required";
    const detail = document.createElement("span");
    detail.textContent = textValue(approval.reason || approval.summary) || "Review this action before continuing.";
    node.append(title, detail);
    if (approval.status === "pending" && state.activeAgentId && entry.id && approval.requestId) {
      approvalActions(node, [
        {
          label: "Allow once",
          handler: () => void resolveAutoReviewApproval(entry, "approved"),
        },
        {
          label: "Deny",
          danger: true,
          handler: () => void resolveAutoReviewApproval(entry, "denied"),
        },
      ]);
    }
  }

  function renderSecretEntry(node, entry) {
    const request = entry?.message?.secretRequest || {};
    const title = document.createElement("strong");
    title.textContent = textValue(request.label) || "Secret required";
    const description = document.createElement("span");
    description.textContent = entry.secretProvided === true
      ? "Provided securely to the Agent runtime."
      : textValue(request.description) || "This value is sent directly to the Coordinator and is not stored by the extension UI.";
    node.append(title, description);

    if (entry.secretProvided === true || !state.activeAgentId || !entry.id) return;

    const form = document.createElement("form");
    form.className = "secret-request-form";
    const input = document.createElement("input");
    input.type = "password";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.placeholder = textValue(request.label) || "Secret";
    input.setAttribute("aria-label", textValue(request.label) || "Secret");

    const submit = document.createElement("button");
    submit.type = "submit";
    submit.textContent = "Provide";

    form.append(input, submit);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const value = input.value;
      input.value = "";
      if (!value.trim()) return;
      submit.disabled = true;
      void submitSecret(entry, value).finally(() => {
        submit.disabled = false;
      });
    });
    node.append(form);
  }

  function renderInteractiveEntry(node, entry) {
    const message = entry?.message || {};
    if (message.type === "widget") {
      const prompt = document.createElement("strong");
      prompt.textContent = textValue(message.widget?.prompt) || "Choose an option";
      node.append(prompt);
      const options = Array.isArray(message.widget?.options) ? message.widget.options : [];
      if (!entry.respondedValue && options.length) {
        approvalActions(node, options.slice(0, 6).flatMap((option) => {
          const label = textValue(option?.label);
          if (!label) return [];
          return [{
            label,
            danger: option?.style === "danger",
            handler: () => void respondToWidget(entry, textValue(option.value) || label),
          }];
        }));
      } else if (entry.respondedValue) {
        const status = document.createElement("span");
        status.textContent = `Selected: ${entry.respondedValue}`;
        node.append(status);
      }
      return;
    }

    const title = document.createElement("strong");
    title.textContent = message.type === "connectors" ? "Connectors" : `Connector: ${textValue(message.connector) || "service"}`;
    const detail = document.createElement("span");
    detail.textContent = message.type === "connectors"
      ? (Array.isArray(message.connectors) ? message.connectors.join(", ") : "Connector options")
      : textValue(message.reason) || "Connection action available through the Agent runtime.";
    node.append(title, detail);
  }

  async function reactToMessage(entry, emoji) {
    if (!state.activeAgentId || !entry?.id || !emoji) return;
    const reactions = Array.isArray(entry.reactions) ? entry.reactions : (entry.reactions = []);
    const mineIndex = reactions.findIndex((reaction) => reaction?.by === "me" && reaction?.emoji === emoji);
    if (mineIndex >= 0) reactions.splice(mineIndex, 1);
    else reactions.push({ emoji, by: "me" });
    renderEntries();

    try {
      await coordinatorCall("reactToMessage", {
        entryId: entry.id,
        emoji,
        agentId: state.activeAgentId,
      }, { timeoutMs: 20_000 });
    } catch {
      scheduleTranscriptRefresh();
    }
  }

  async function resolveLocalToolPermission(entry, resolution) {
    const ask = entry?.message?.ask;
    if (!state.activeAgentId || !entry?.id || !ask?.requestId) return;
    try {
      await coordinatorCall("resolveLocalToolPermission", {
        entryId: entry.id,
        requestId: ask.requestId,
        resolution,
        agentId: state.activeAgentId,
      }, { timeoutMs: 30_000 });
      await refreshTranscript();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function resolveAutoReviewApproval(entry, resolution) {
    const approval = entry?.message?.approval;
    if (!state.activeAgentId || !entry?.id || !approval?.requestId) return;
    try {
      await coordinatorCall("resolveAutoReviewApproval", {
        entryId: entry.id,
        requestId: approval.requestId,
        resolution,
        agentId: state.activeAgentId,
      }, { timeoutMs: 30_000 });
      await refreshTranscript();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function submitSecret(entry, value) {
    if (!state.activeAgentId || !entry?.id || !String(value || "").trim()) return;
    try {
      await coordinatorCall("submitSecret", {
        entryId: entry.id,
        value: String(value),
        agentId: state.activeAgentId,
      }, { timeoutMs: 30_000 });
      await refreshTranscript();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function respondToWidget(entry, value) {
    if (!state.activeAgentId || !entry?.id || !String(value || "").trim()) return;
    try {
      const result = await coordinatorCall("respondToWidget", {
        entryId: entry.id,
        value: String(value).trim(),
        agentId: state.activeAgentId,
      }, { timeoutMs: 30_000 });
      if (result && typeof result === "object" && result.accepted === false) {
        showBanner?.("That choice is no longer waiting for an answer.", "warning");
      }
      await refreshTranscript();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  function hasPendingWaitingUserEntry(entries) {
    return entries.some((entry) => {
      const message = entry?.message;
      if (message?.type === "local-tool-permission") return message.ask?.status === "pending";
      if (message?.type === "auto-review-approval") return message.approval?.status === "pending";
      if (message?.type === "widget") return !entry.respondedValue && entry.widgetDismissed !== true;
      if (message?.type === "secret-request") return entry.secretProvided !== true;
      return false;
    });
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
      } else if (kind === "approval") {
        renderApprovalEntry(node, entry);
      } else if (kind === "secret") {
        renderSecretEntry(node, entry);
      } else if (kind === "interactive") {
        renderInteractiveEntry(node, entry);
      } else if (kind === "tool") {
        const label = document.createElement("strong");
        label.textContent = textValue(entry.toolName || entry.name || entry.message?.name) || "Tool";
        const detail = document.createElement("span");
        detail.textContent = copy || textValue(entry.status || entry.phase) || "running";
        node.append(label, detail);
      } else {
        node.textContent = copy || textValue(entry.kind || entry.type);
      }
      renderReactions(node, entry);
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
      pluginStatus.append(actionButton("Sync plugin skills", () => void syncPluginSkills()));
      return;
    }

    const row = document.createElement("div");
    row.className = "context-row";
    const names = blocked.slice(0, 3).map((item) => item.pluginName).filter(Boolean);
    row.textContent = names.length
      ? `${names.join(", ")}${blocked.length > names.length ? ` +${blocked.length - names.length}` : ""} need setup`
      : `${blocked.length} installed plugin${blocked.length === 1 ? "" : "s"} need setup`;
    pluginStatus.append(row);
    const actions = document.createElement("div");
    actions.className = "context-actions";
    actions.append(
      actionButton("Fix with Setup Agent", () => void fixPluginAuthentication()),
      actionButton("Sync", () => void syncPluginSkills())
    );
    pluginStatus.append(actions);
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

  function renderSnapshotList(container, snapshot, emptyText, renderItem) {
    if (!container) return;
    container.replaceChildren();

    if (!state.activeAgentId) {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Choose an Agent.";
      container.append(row);
      return;
    }

    if (snapshot.status === "loading") {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = "Loading…";
      container.append(row);
      return;
    }

    if (snapshot.status === "failed") {
      const row = document.createElement("div");
      row.className = "context-row context-error";
      row.textContent = snapshot.error || "Unavailable.";
      container.append(row);
      return;
    }

    const items = Array.isArray(snapshot.items) ? snapshot.items : [];
    if (!items.length) {
      const row = document.createElement("div");
      row.className = "context-muted";
      row.textContent = emptyText;
      container.append(row);
      return;
    }

    for (const item of items) {
      const node = renderItem(item);
      if (node) container.append(node);
    }
  }

  function renderAsyncTasks() {
    renderSnapshotList(asyncTasksList, state.asyncTasks, "No async tasks in progress.", (task) => {
      const row = document.createElement("div");
      row.className = "context-row";
      const title = document.createElement("strong");
      title.textContent = textValue(task?.label) || textValue(task?.id) || "Async task";
      const detail = document.createElement("div");
      detail.className = "context-muted";
      const kind = textValue(task?.kind) || "task";
      const extra = textValue(task?.detail);
      detail.textContent = extra ? `${kind} · ${extra}` : kind;
      row.append(title, detail);
      return row;
    });
  }

  function outlineLabel(item) {
    const kind = textValue(item?.kind);
    if (kind === "user" || kind === "assistant-text" || kind === "thinking") return textValue(item?.text);
    if (kind === "send-message") {
      const message = item?.message;
      return message?.type === "text" ? textValue(message.content) : textValue(message?.alt) || "Attachment";
    }
    if (kind === "tool-call") {
      const name = textValue(item?.name) || "Tool";
      const summary = textValue(item?.summary);
      return summary ? `${name} · ${summary}` : name;
    }
    return kind || "Conversation item";
  }

  function renderOutline() {
    renderSnapshotList(outlineList, state.outline, "No conversation outline yet.", (item) => {
      const row = document.createElement("div");
      row.className = "context-row";
      const title = document.createElement("strong");
      title.textContent = textValue(item?.kind) || "item";
      const detail = document.createElement("div");
      detail.className = "context-muted";
      const label = outlineLabel(item);
      detail.textContent = label.length > 180 ? `${label.slice(0, 177)}…` : label;
      row.append(title, detail);
      return row;
    });
  }

  function renderWorkflows() {
    renderSnapshotList(workflowsList, state.workflows, "No workflows available for this Agent.", (workflow) => {
      const row = document.createElement("div");
      row.className = "context-row context-row-actions";

      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = textValue(workflow?.name) || "Workflow";
      const detail = document.createElement("div");
      detail.className = "context-muted";
      const enabled = workflow?.isEnabledForAgent !== false;
      const trigger = workflow?.trigger?.schedule || workflow?.scheduleDescription || "";
      detail.textContent = trigger ? `${enabled ? "Enabled" : "Disabled"} · ${trigger}` : enabled ? "Enabled" : "Disabled";
      copy.append(title, detail);
      row.append(copy);

      if (textValue(workflow?.id)) {
        row.append(actionButton(enabled ? "Disable" : "Enable", () => void setWorkflowEnabled(workflow, !enabled)));
      }
      return row;
    });
  }

  function renderAutomations() {
    renderSnapshotList(automationsList, state.automations, "No automations configured.", (automation) => {
      const row = document.createElement("div");
      row.className = "context-row context-row-actions";

      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = textValue(automation?.name) || "Automation";
      const detail = document.createElement("div");
      detail.className = "context-muted";
      const trigger = textValue(automation?.triggerDescription) || textValue(automation?.trigger?.schedule) || "Manual";
      detail.textContent = `${automation?.isEnabled === false ? "Disabled" : "Enabled"} · ${trigger}`;
      copy.append(title, detail);
      row.append(copy);

      if (textValue(automation?.id)) {
        row.append(
          actionButton("Run now", () => void runAutomationNow(automation)),
          actionButton(automation?.isEnabled === false ? "Enable" : "Disable", () => void setAutomationEnabled(automation, automation?.isEnabled === false))
        );
      }
      return row;
    });
  }

  function renderContext() {
    renderAccount();
    renderPlugins();
    renderChannels();
    renderAsyncTasks();
    renderOutline();
    renderWorkflows();
    renderAutomations();

    if (mcpList) {
      mcpList.replaceChildren();
      const shown = state.mcp.slice(0, 12);
      for (const tool of shown) {
        const row = document.createElement("div");
        row.className = "context-row context-row-actions";

        const copy = document.createElement("div");
        const name = document.createElement("strong");
        name.textContent = textValue(tool.title || tool.name || tool.toolName) || "MCP tool";
        const detail = document.createElement("div");
        detail.className = "context-muted";
        const provider = textValue(tool.providerIdentifier);
        const status = tool.isDisabled === true ? "disabled" : "ready";
        detail.textContent = provider ? `${provider} · ${status}` : status;
        copy.append(name, detail);
        row.append(copy);

        if (canTestMcpTool(tool) && state.activeAgentId) {
          row.append(actionButton("Test", () => void testMcpTool(tool)));
        }
        mcpList.append(row);

        const result = state.mcpResults[textValue(tool.name)];
        if (result) {
          const output = document.createElement("div");
          output.className = result.ok ? "context-muted" : "context-muted context-error";
          output.textContent = result.text;
          mcpList.append(output);
        }
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
    if (avatar) avatar.textContent = avatarGlyph(active || { id: state.activeAgentId, name: "Agent" });
    if (empty) empty.hidden = Boolean(state.activeAgentId);
    if (conversation) conversation.hidden = !state.activeAgentId;

    state.channels = { status: state.activeAgentId ? "loading" : "idle", manifests: [], connections: [], error: "" };
    renderRoster();
    renderContext();
    void runtime.setActiveAgent(state.activeAgentId).catch(() => {});
    if (state.activeAgentId) void refreshChannels();
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
    if (hasPendingWaitingUserEntry(state.entries)) {
      state.phase = "waiting-user";
      renderPhase();
    }
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

  async function refreshAccount() {
    try {
      const value = await runtime.accountStatus();
      state.account = value && typeof value === "object"
        ? value
        : { loggedIn: false, loggingIn: false, connected: false, account: null, error: "" };
    } catch (error) {
      state.account = { loggedIn: false, loggingIn: false, connected: false, account: null, error: error?.message || String(error) };
    }
    renderContext();
  }

  async function accountLogin() {
    state.account = { ...state.account, loggingIn: true, error: "" };
    renderContext();
    try {
      await runtime.accountLogin();
      await refreshAccount();
    } catch (error) {
      state.account = { ...state.account, loggingIn: false, error: error?.message || String(error) };
      renderContext();
    }
  }

  async function accountLogout() {
    try {
      await runtime.accountLogout();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    } finally {
      await refreshAccount();
    }
  }

  async function refreshPluginStatus() {
    state.pluginSync = { ...state.pluginSync, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getPluginSyncStatus", {}, { timeoutMs: 20_000 });
      const blocked = Array.isArray(result?.authBlocked)
        ? result.authBlocked.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object") return [];
          const pluginId = textValue(candidate.pluginId);
          const pluginName = textValue(candidate.pluginName);
          if (!pluginId || !pluginName) return [];
          return [{ pluginId, pluginName, marketplaceName: textValue(candidate.marketplaceName) }];
        })
        : [];
      state.pluginSync = { status: "ready", authBlocked: blocked, error: "" };
    } catch (error) {
      state.pluginSync = { status: "failed", authBlocked: [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function sendDirectPrompt(agentId, prompt) {
    const nonce = crypto.randomUUID();
    const createdAtMs = Date.now();
    const requestId = `send-${nonce}`;
    state.inFlightRequestId = requestId;
    state.phase = "accepted";
    renderPhase();

    try {
      await coordinatorCall("sendPrompt", {
        agentId,
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
      return true;
    } catch (error) {
      if (error?.code === "coordinator-transport-lost" || error?.delivery === "unknown") {
        state.phase = "recovering";
        showBanner?.(
          "Coordinator acknowledgement was lost after dispatch. Fabushi will resync this run instead of sending the setup request again.",
          "warning"
        );
        return false;
      }
      state.phase = error?.code === "coordinator-unavailable" ? "recovering" : "failed";
      state.inFlightRequestId = "";
      showBanner?.(error?.message || String(error), "error");
      return false;
    } finally {
      renderPhase();
    }
  }

  async function fixPluginAuthentication() {
    let setupAgent = state.agents.find((agent) => agent.raw?.purpose === PLUGIN_AUTH_AGENT_PURPOSE) || null;
    try {
      if (!setupAgent) {
        const created = await coordinatorCall("createAgent", {
          name: PLUGIN_AUTH_AGENT_NAME,
          description: "Sets up credentials for installed plugins on the Agent runtime.",
          purpose: PLUGIN_AUTH_AGENT_PURPOSE,
          isIntroductionSuppressed: true,
          clientNonce: crypto.randomUUID(),
        }, { timeoutMs: 30_000 });
        setupAgent = projectAgent(created?.agent || created);
        await refreshRoster();
      }
      if (!setupAgent) throw new Error("Plugin Setup Agent creation returned no Agent id.");
      await openAgent(setupAgent.id);
      await sendDirectPrompt(setupAgent.id, PLUGIN_AUTH_PROMPT);
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  function projectChannels(value) {
    const view = value?.view && typeof value.view === "object" ? value.view : value;
    const manifests = Array.isArray(view?.manifests)
      ? view.manifests.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const platform = textValue(candidate.platform);
        const displayName = textValue(candidate.displayName);
        const availability = candidate.availability === "coming-soon" ? "coming-soon" : "available";
        if (!platform || !displayName) return [];
        return [{
          platform,
          displayName,
          blurb: textValue(candidate.blurb),
          credentialLabel: textValue(candidate.credentialLabel),
          connectGuide: textValue(candidate.connectGuide),
          availability,
        }];
      })
      : [];
    const connections = Array.isArray(view?.connections)
      ? view.connections.flatMap((candidate) => {
        if (!candidate || typeof candidate !== "object") return [];
        const platform = textValue(candidate.platform);
        const label = textValue(candidate.label);
        const status = textValue(candidate.status);
        if (!platform || !label || !status) return [];
        return [{ platform, label, status, detail: textValue(candidate.detail) }];
      })
      : [];
    return { manifests, connections };
  }

  async function refreshAsyncTasks() {
    if (!state.activeAgentId) {
      state.asyncTasks = { status: "idle", items: [], error: "" };
      renderContext();
      return;
    }
    state.asyncTasks = { ...state.asyncTasks, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getAsyncTasks", { id: state.activeAgentId }, { timeoutMs: 20_000 });
      state.asyncTasks = { status: "ready", items: asArray(result).slice(0, 16), error: "" };
    } catch (error) {
      state.asyncTasks = { status: "failed", items: state.asyncTasks.items || [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function refreshOutline() {
    if (!state.activeAgentId) {
      state.outline = { status: "idle", items: [], error: "" };
      renderContext();
      return;
    }
    state.outline = { ...state.outline, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getConversationOutline", { id: state.activeAgentId }, { timeoutMs: 20_000 });
      state.outline = { status: "ready", items: asArray(result).slice(-20), error: "" };
    } catch (error) {
      state.outline = { status: "failed", items: state.outline.items || [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function refreshWorkflows() {
    if (!state.activeAgentId) {
      state.workflows = { status: "idle", items: [], error: "" };
      renderContext();
      return;
    }
    state.workflows = { ...state.workflows, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getAgentWorkflows", { id: state.activeAgentId }, { timeoutMs: 20_000 });
      state.workflows = { status: "ready", items: asArray(result).slice(0, 24), error: "" };
    } catch (error) {
      state.workflows = { status: "failed", items: state.workflows.items || [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function setWorkflowEnabled(workflow, isEnabled) {
    if (!state.activeAgentId || !textValue(workflow?.id)) return;
    try {
      await coordinatorCall("setAgentWorkflowEnabled", {
        id: state.activeAgentId,
        workflowId: workflow.id,
        isEnabled: Boolean(isEnabled),
      }, { timeoutMs: 30_000 });
      await refreshWorkflows();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function refreshAutomations() {
    if (!state.activeAgentId) {
      state.automations = { status: "idle", items: [], error: "" };
      renderContext();
      return;
    }
    state.automations = { ...state.automations, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getAgentAutomations", { id: state.activeAgentId }, { timeoutMs: 20_000 });
      state.automations = { status: "ready", items: asArray(result).slice(0, 24), error: "" };
    } catch (error) {
      state.automations = { status: "failed", items: state.automations.items || [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function setAutomationEnabled(automation, isEnabled) {
    if (!state.activeAgentId || !textValue(automation?.id)) return;
    try {
      await coordinatorCall("setAgentAutomationEnabled", {
        id: state.activeAgentId,
        automationId: automation.id,
        isEnabled: Boolean(isEnabled),
      }, { timeoutMs: 30_000 });
      await refreshAutomations();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function runAutomationNow(automation) {
    if (!state.activeAgentId || !textValue(automation?.id)) return;
    try {
      await coordinatorCall("runAgentAutomationNow", {
        id: state.activeAgentId,
        automationId: automation.id,
      }, { timeoutMs: 60_000 });
      await refreshAutomations();
    } catch (error) {
      showBanner?.(error?.message || String(error), "error");
    }
  }

  async function refreshAgentInfo() {
    await Promise.allSettled([
      refreshAsyncTasks(),
      refreshOutline(),
      refreshWorkflows(),
      refreshAutomations(),
    ]);
  }

  async function refreshChannels() {
    if (!state.activeAgentId) {
      state.channels = { status: "idle", manifests: [], connections: [], error: "" };
      renderContext();
      return;
    }
    state.channels = { ...state.channels, status: "loading", error: "" };
    renderContext();
    try {
      const result = await coordinatorCall("getAgentChannels", { id: state.activeAgentId }, { timeoutMs: 20_000 });
      const projected = projectChannels(result);
      state.channels = { status: "ready", ...projected, error: "" };
    } catch (error) {
      state.channels = { status: "failed", manifests: [], connections: [], error: error?.message || String(error) };
    }
    renderContext();
  }

  async function refreshChannel(platform) {
    if (!state.activeAgentId || !platform) return;
    try {
      const result = await coordinatorCall("refreshChannel", { id: state.activeAgentId, platform }, { timeoutMs: 30_000 });
      const projected = projectChannels(result);
      state.channels = { status: "ready", ...projected, error: "" };
    } catch (error) {
      state.channels = { ...state.channels, status: "failed", error: error?.message || String(error) };
    }
    renderContext();
  }

  async function disconnectChannel(platform) {
    if (!state.activeAgentId || !platform) return;
    try {
      const result = await coordinatorCall("disconnectChannel", { id: state.activeAgentId, platform }, { timeoutMs: 30_000 });
      const projected = projectChannels(result);
      state.channels = { status: "ready", ...projected, error: "" };
    } catch (error) {
      state.channels = { ...state.channels, status: "failed", error: error?.message || String(error) };
    }
    renderContext();
  }

  async function startChannelSetup(manifest) {
    if (!state.activeAgentId || !manifest?.platform) return;
    const guide = textValue(manifest.connectGuide);
    const prompt = [
      `Help me connect the ${manifest.displayName || manifest.platform} channel to this Agent.`,
      guide ? `Follow this setup guidance: ${guide}` : "",
      "Do not print, persist, or guess credentials. Ask me through the normal waiting-user/approval flow whenever authentication or a secret is required.",
      "After the connection is established, verify it with a non-destructive status check and report the connected account label.",
    ].filter(Boolean).join(" ");
    await sendDirectPrompt(state.activeAgentId, prompt);
  }

  function canTestMcpTool(tool) {
    if (!tool || typeof tool !== "object" || tool.isDisabled === true) return false;
    const label = `${textValue(tool.name)} ${textValue(tool.toolName)} ${textValue(tool.description)}`.toLowerCase();
    const readOnly = /(^|[^a-z])(read|search|find|list|get|fetch|query|lookup|inspect|view|download|retrieve)([^a-z]|$)/.test(label)
      && !/(send|create|update|delete|remove|write|upload|post|reply|archive|move|rename|modify|cancel|purchase|buy)/.test(label);
    const required = Array.isArray(tool.inputSchema?.required) ? tool.inputSchema.required : [];
    return readOnly && required.length === 0
      && Boolean(textValue(tool.providerIdentifier))
      && Boolean(textValue(tool.name))
      && Boolean(textValue(tool.toolName));
  }

  function summarizeMcpResult(value) {
    const content = Array.isArray(value?.content) ? value.content : [];
    const textItem = content.find((item) => item?.type === "text" && typeof item.text === "string");
    if (textItem?.text) return textItem.text.slice(0, 320);
    try {
      return JSON.stringify(value).slice(0, 320);
    } catch {
      return "MCP tool returned a non-serializable result.";
    }
  }

  async function testMcpTool(tool) {
    if (!state.activeAgentId || !canTestMcpTool(tool)) return;
    const key = textValue(tool.name);
    state.mcpResults[key] = { ok: true, text: "Running read-only test…" };
    renderContext();
    try {
      const result = await coordinatorCall("executeRoutedMcpTool", {
        providerIdentifier: tool.providerIdentifier,
        name: tool.name,
        toolName: tool.toolName,
        args: {},
        toolCallId: crypto.randomUUID(),
        agentId: state.activeAgentId,
      }, { timeoutMs: 60_000 });
      state.mcpResults[key] = {
        ok: result?.isError !== true,
        text: summarizeMcpResult(result),
      };
    } catch (error) {
      state.mcpResults[key] = { ok: false, text: error?.message || String(error) };
    }
    renderContext();
  }

  async function syncPluginSkills() {
    state.pluginSync = { ...state.pluginSync, status: "loading", error: "" };
    renderContext();
    try {
      await coordinatorCall("syncPluginSkills", {}, { timeoutMs: 60_000 });
      await Promise.allSettled([refreshPluginStatus(), refreshMcp()]);
    } catch (error) {
      state.pluginSync = { status: "failed", authBlocked: state.pluginSync.authBlocked || [], error: error?.message || String(error) };
      renderContext();
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

  async function reconnectRuntime() {
    state.phase = "recovering";
    renderPhase();
    if (reconnectButton) reconnectButton.disabled = true;
    try {
      const attached = await runtime.attach(state.activeAgentId);
      state.transport = attached.transport || state.transport;
      if (attached.cursor?.activeAgentId && attached.cursor.activeAgentId !== state.activeAgentId) {
        state.activeAgentId = attached.cursor.activeAgentId;
      }
      state.phase = attached.cursor?.runPhase || (state.transport.connected ? "accepted" : "recovering");
      hideBanner?.();
      await Promise.allSettled([
        refreshRoster(),
        refreshMcp(),
        refreshPluginStatus(),
        refreshChannels(),
        refreshAccount(),
        refreshBrowser(),
      ]);
    } catch (error) {
      state.transport = { ...state.transport, connected: false, error: error?.message || String(error) };
      state.phase = "recovering";
      showBanner?.(error?.message || String(error), "error");
    } finally {
      if (reconnectButton) reconnectButton.disabled = false;
      renderPhase();
    }
  }

  function bind() {
    $("#new-chat")?.addEventListener("click", () => void createAgent());
    reconnectButton?.addEventListener("click", () => void reconnectRuntime());

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
    $("#agent-refresh-context")?.addEventListener("click", () => void Promise.allSettled([refreshMcp(), refreshPluginStatus(), refreshChannels(), refreshAccount(), refreshBrowser()]));
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
      await Promise.allSettled([refreshRoster(), refreshMcp(), refreshPluginStatus(), refreshChannels(), refreshAccount(), refreshBrowser()]);
    },

    async refresh() {
      await Promise.allSettled([refreshRoster(), refreshMcp(), refreshPluginStatus(), refreshChannels(), refreshAccount(), refreshBrowser()]);
    },

    reconnect: reconnectRuntime,

    async createAgent() {
      await createAgent();
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
