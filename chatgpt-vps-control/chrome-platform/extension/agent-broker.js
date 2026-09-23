import {
  COORDINATOR_PROTOCOL_VERSION,
  acceptRunEvent,
  createRunFence,
  parseCoordinatorFrame,
  projectRunPhase,
  serializeRunFence,
} from "./agent-protocol.js";
import { createCoordinatorTransportRouter } from "./coordinator-transports.js";

const CLIENT_STATE_KEY = "fabushiAgentClientStateV1";
const MAX_CLIENTS = 8;
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const ALLOWED_ATTACHMENT_MIME = new Set([
  "application/json",
  "application/pdf",
  "application/rtf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/html",
  "text/markdown",
  "text/plain",
]);
const COORDINATOR_METHODS = new Set([
  "getAgentTranscriptWindow", "getAgentThread", "getAgentTranscriptTail", "openAgentTail",
  "sendPrompt", "promptAcceptanceStatus", "respondToWidget", "resolveAutoReviewApproval",
  "resolveLocalToolPermission", "dismissWidget", "submitSecret", "reactToMessage",
  "listAgents", "countAgents", "searchAgents", "searchMedia", "createAgent", "createGroup",
  "setGroupMembers", "updateAgent", "deleteAgents", "duplicateAgent", "kickstartAgent",
  "getAgentWorkflows", "createAgentWorkflow", "updateAgentWorkflow", "setAgentWorkflowEnabled",
  "deleteAgentWorkflow", "runAgentWorkflowNow", "importAgentWorkflowText", "importAgentWorkflowUrl",
  "portAgentLocalSkills", "getConversationOutline", "skillsCatalog", "syncPluginSkills",
  "getPluginSyncStatus", "listRoutedMcpTools", "executeRoutedMcpTool", "getSkillPublishTargets",
  "publishSkill", "resyncPublishedSkill", "unpublishSkill", "getSubagents", "getAsyncTasks",
  "getForeverBoxStatus", "ensureForeverBox", "handBackForeverBox", "startTeachRecording",
  "stopTeachRecording", "getTeachRecordingStatus", "getTrays", "dismissTray", "clearTrays",
  "getAgentChannels", "connectChannel", "disconnectChannel", "refreshChannel", "getBoxSecretsStatus",
  "getAgentAutomations", "listAllAutomations", "isAgentNetworkEnabled", "isGlobalSearchEnabled",
  "isEgressTunnelAvailable", "getSharingState", "createRoomFromAgent", "createRoomInvite",
  "joinSharedRoom", "respondToRoomJoinRequest", "createSharedRoom", "addOwnAgentToSharedRoom",
  "removeOwnAgentFromSharedRoom", "setSharedRoomTyping", "leaveSharedRoom",
  "setAgentAutomationEnabled", "createAgentAutomation", "updateAgentAutomation",
  "deleteAgentAutomation", "runAgentAutomationNow",
]);

let cachedClients = null;
let transportState = {
  kind: "none",
  connected: false,
  protocolVersion: COORDINATOR_PROTOCOL_VERSION,
  error: "Coordinator transport has not been discovered.",
};

async function loadClients() {
  if (cachedClients) return cachedClients;
  const stored = await chrome.storage.local.get(CLIENT_STATE_KEY);
  const raw = stored[CLIENT_STATE_KEY];
  cachedClients = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  return cachedClients;
}

async function saveClients() {
  const clients = await loadClients();
  const entries = Object.entries(clients)
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
    .slice(0, MAX_CLIENTS);
  cachedClients = Object.fromEntries(entries);
  await chrome.storage.local.set({ [CLIENT_STATE_KEY]: cachedClients });
}

async function updateClient(clientId, patch = {}) {
  const clients = await loadClients();
  const current = clients[clientId] && typeof clients[clientId] === "object" ? clients[clientId] : {};
  clients[clientId] = { ...current, ...patch, updatedAt: Date.now() };
  await saveClients();
  return clients[clientId];
}

async function removeClient(clientId) {
  const clients = await loadClients();
  delete clients[clientId];
  await saveClients();
}

const TERMINAL_RUN_PHASES = new Set(["completed", "failed", "cancelled"]);

function latestRecoveryCursor(clients, requestedAgentId = "") {
  const candidates = Object.values(clients)
    .filter((snapshot) => snapshot && typeof snapshot === "object")
    .filter((snapshot) => !requestedAgentId || snapshot.activeAgentId === requestedAgentId)
    .sort((left, right) => {
      const leftActive = left.runPhase && !TERMINAL_RUN_PHASES.has(left.runPhase) ? 1 : 0;
      const rightActive = right.runPhase && !TERMINAL_RUN_PHASES.has(right.runPhase) ? 1 : 0;
      if (leftActive !== rightActive) return rightActive - leftActive;
      return Number(right.updatedAt || 0) - Number(left.updatedAt || 0);
    });
  return candidates[0] || null;
}

async function recoverClient(clientId, requestedAgentId = "") {
  const clients = await loadClients();
  const own = clients[clientId] && typeof clients[clientId] === "object" ? clients[clientId] : null;
  const prior = own || latestRecoveryCursor(clients, requestedAgentId);
  const activeAgentId = requestedAgentId || prior?.activeAgentId || "";
  const recovered = {
    ...(prior || {}),
    activeAgentId,
    recoveredFromPreviousView: !own && Boolean(prior),
    updatedAt: Date.now(),
  };
  clients[clientId] = recovered;
  await saveClients();
  return recovered;
}

async function resumeTransport(cursor, clientId) {
  if (!cursor?.activeAgentId) return { attempted: false, supported: false };
  try {
    const result = await transportRouter.resume({
      clientId,
      activeAgentId: cursor.activeAgentId,
      runId: cursor.fence?.runId || "",
      generation: cursor.fence?.generation || "",
      sequence: Number(cursor.fence?.sequence || 0),
    });
    transportState = result.transport;
    return { attempted: true, supported: result.supported, result: result.value };
  } catch (error) {
    if (error?.code === "coordinator-unavailable") {
      return { attempted: false, supported: false, error: error.message };
    }
    return { attempted: true, supported: true, error: error?.message || String(error) };
  }
}

const transportRouter = createCoordinatorTransportRouter({
  nativeRequest(method, params, timeoutMs) {
    if (typeof globalThis.__fabushiDesktopRequest !== "function") {
      throw new Error("Native Messaging transport is not initialized.");
    }
    return globalThis.__fabushiDesktopRequest(method, params, timeoutMs);
  },
  remoteProvider() {
    return globalThis.__fabushiRemoteCoordinatorTransport || null;
  },
});

async function discoverTransport() {
  try {
    transportState = await transportRouter.status();
    return transportState;
  } catch (error) {
    transportState = {
      kind: "none",
      connected: false,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      error: error?.message || String(error),
    };
    throw error;
  }
}

async function callTransport(method, args, requestId, clientId) {
  if (!COORDINATOR_METHODS.has(method)) {
    const error = new Error(`Coordinator method is not allowed from the Chrome renderer: ${method}`);
    error.code = "coordinator-method-not-allowed";
    error.delivery = "not-sent";
    throw error;
  }
  const result = await transportRouter.call({ clientId, requestId, method, args });
  transportState = result.transport;
  return result.value;
}

async function cancelTransport(requestId, clientId) {
  const result = await transportRouter.cancel({ clientId, requestId });
  transportState = result.transport;
  return result.value;
}

async function broadcast(family, payload) {
  await chrome.runtime.sendMessage({ type: "fabushi.agent.event", family, payload }).catch(() => {});
}

function eventIdentity(payload) {
  if (!payload || typeof payload !== "object") return {};
  const entry = payload.entry && typeof payload.entry === "object" ? payload.entry : {};
  return {
    runId: payload.runId || entry.runId,
    generation: payload.generation || payload.epoch || entry.generation,
    sequence: payload.sequence ?? payload.seq ?? entry.sequence,
  };
}

async function updateRecoveryCursor(family, payload) {
  if (!payload || typeof payload !== "object") return true;
  const clients = await loadClients();
  const explicitClientId = typeof payload.clientId === "string" ? payload.clientId : "";
  const targets = explicitClientId && clients[explicitClientId]
    ? [[explicitClientId, clients[explicitClientId]]]
    : Object.entries(clients);

  let acceptedByAny = targets.length === 0;
  for (const [clientId, snapshot] of targets) {
    const agentId = String(payload.agentId || payload.id || payload.entry?.agentId || "");
    if (snapshot.activeAgentId && agentId && snapshot.activeAgentId !== agentId) continue;

    const fence = createRunFence(snapshot.fence || {});
    const identity = eventIdentity(payload);
    const hasIdentity = identity.runId || identity.generation || Number.isSafeInteger(identity.sequence);
    if (hasIdentity) {
      const accepted = acceptRunEvent(fence, identity);
      if (!accepted.accepted) continue;
    }

    const phase = projectRunPhase(family, payload);
    clients[clientId] = {
      ...snapshot,
      ...(agentId ? { activeAgentId: snapshot.activeAgentId || agentId } : {}),
      ...(phase ? { runPhase: phase } : {}),
      fence: serializeRunFence(fence),
      updatedAt: Date.now(),
    };
    acceptedByAny = true;
  }
  if (targets.length) await saveClients();
  return acceptedByAny;
}

async function acceptCoordinatorFrame(value) {
  const intake = parseCoordinatorFrame(value);
  if (!intake.accepted) return false;
  const frame = intake.frame;

  if (frame.kind === "event") {
    if (await updateRecoveryCursor(frame.family, frame.payload)) await broadcast(frame.family, frame.payload);
    return true;
  }

  if (frame.kind === "lifecycle" && frame.phase === "ready") {
    if (frame.protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
      transportState = { ...transportState, connected: false, error: "Coordinator protocol version mismatch." };
      return true;
    }
    transportState = { ...transportState, connected: true, protocolVersion: frame.protocolVersion, error: "" };
    await broadcast("coordinator-transport-state", { state: "connected", transport: transportState.kind });
    return true;
  }

  if (frame.kind === "lifecycle" && frame.phase === "shutdown") {
    transportState = { ...transportState, connected: false, error: frame.detail || frame.reason };
    await broadcast("coordinator-transport-state", { state: "down", transport: transportState.kind, error: transportState.error });
    return true;
  }

  return false;
}

globalThis.__fabushiAgentBrokerPlatformEvent = (event) => {
  if (!event || typeof event !== "object") return;
  if (event.type === "coordinator.frame") {
    void acceptCoordinatorFrame(event.frame);
    return;
  }
  if (event.type === "coordinator.event" && typeof event.family === "string") {
    void updateRecoveryCursor(event.family, event.payload).then((accepted) => {
      if (accepted) return broadcast(event.family, event.payload);
      return undefined;
    });
  }
};

chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("app.html");
  const tabs = await chrome.tabs.query({}).catch(() => []);
  const existing = tabs.find((tab) => typeof tab.url === "string" && tab.url.startsWith(url));
  if (Number.isInteger(existing?.id)) {
    await chrome.tabs.update(existing.id, { active: true });
    if (Number.isInteger(existing.windowId)) await chrome.windows.update(existing.windowId, { focused: true }).catch(() => {});
    return;
  }
  await chrome.tabs.create({ url, active: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object" || !String(message.type || "").startsWith("fabushi.agent.")) return false;

  const clientId = String(message.clientId || "");
  if (!clientId || clientId.length > 200) {
    sendResponse({ ok: false, code: "invalid-client", delivery: "not-sent", error: "Agent runtime clientId is required." });
    return false;
  }

  const respond = (operation) => {
    Promise.resolve(operation).then(
      (value) => sendResponse({ ok: true, ...value }),
      (error) => sendResponse({
        ok: false,
        code: error?.code || "agent-runtime-error",
        delivery: error?.delivery || "not-sent",
        error: error?.message || String(error),
      })
    );
    return true;
  };

  if (message.type === "fabushi.agent.status") {
    return respond((async () => {
      const clients = await loadClients();
      const cursor = clients[clientId] || latestRecoveryCursor(clients) || null;
      let discovered = transportState;
      try { discovered = await discoverTransport(); } catch {}
      return { transport: discovered, cursor, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
    })());
  }

  if (message.type === "fabushi.agent.attach") {
    return respond((async () => {
      const cursor = await recoverClient(clientId, String(message.activeAgentId || ""));
      let discovered = transportState;
      try { discovered = await discoverTransport(); } catch {}
      const resync = discovered.connected ? await resumeTransport(cursor, clientId) : { attempted: false, supported: false };
      return { transport: discovered, cursor, resync, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
    })());
  }

  if (message.type === "fabushi.agent.setActive") {
    return respond((async () => {
      const cursor = await updateClient(clientId, {
        activeAgentId: String(message.activeAgentId || ""),
        fence: {},
        runPhase: "accepted",
      });
      let discovered = transportState;
      try { discovered = await discoverTransport(); } catch {}
      return { transport: discovered, cursor, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
    })());
  }

  if (message.type === "fabushi.agent.detach") {
    return respond(removeClient(clientId).then(() => ({ detached: true })));
  }

  if (message.type === "fabushi.agent.attachment.stage") {
    const attachment = message.attachment;
    const name = String(attachment?.name || "").trim();
    const mimeType = String(attachment?.mimeType || "application/octet-stream").toLowerCase();
    const size = Number(attachment?.size || 0);
    const bytesBase64 = String(attachment?.bytesBase64 || "");
    const attachmentId = String(attachment?.attachmentId || "");

    if (!attachmentId || !name || name.length > 512 || !Number.isSafeInteger(size) || size <= 0 || size > MAX_ATTACHMENT_BYTES) {
      sendResponse({ ok: false, code: "invalid-attachment", delivery: "not-sent", error: "Attachment name or size is invalid." });
      return false;
    }
    if (!ALLOWED_ATTACHMENT_MIME.has(mimeType)) {
      sendResponse({ ok: false, code: "unsupported-attachment", delivery: "not-sent", error: `Unsupported attachment type: ${mimeType}` });
      return false;
    }
    const estimatedBytes = Math.floor(bytesBase64.length * 3 / 4);
    if (!bytesBase64 || estimatedBytes < Math.max(1, size - 2) || estimatedBytes > size + 2) {
      sendResponse({ ok: false, code: "invalid-attachment", delivery: "not-sent", error: "Attachment payload size does not match its metadata." });
      return false;
    }

    return respond((async () => {
      const staged = await transportRouter.stageAttachment({
        clientId,
        attachmentId,
        name,
        mimeType,
        size,
        bytesBase64,
      });
      transportState = staged.transport;
      return { result: staged.value, transport: transportState };
    })());
  }

  if (message.type === "fabushi.agent.attachment.discard") {
    const attachmentId = String(message.attachmentId || "");
    const reference = String(message.reference || "");
    if (!attachmentId) {
      sendResponse({ ok: false, code: "invalid-attachment", delivery: "not-sent", error: "Attachment id is required." });
      return false;
    }
    return respond((async () => {
      const discarded = await transportRouter.discardAttachment({ clientId, attachmentId, reference });
      transportState = discarded.transport;
      return { result: discarded.value, transport: transportState };
    })());
  }

  if (message.type === "fabushi.agent.call") {
    const method = String(message.method || "");
    const requestId = String(message.requestId || "");
    if (!requestId || requestId.length > 240) {
      sendResponse({ ok: false, code: "invalid-request", delivery: "not-sent", error: "Coordinator requestId is required." });
      return false;
    }
    return respond((async () => {
      const result = await callTransport(method, message.args ?? {}, requestId, clientId);
      return { result, transport: transportState };
    })());
  }

  if (message.type === "fabushi.agent.cancel") {
    const requestId = String(message.requestId || "");
    if (!requestId) {
      sendResponse({ ok: false, code: "invalid-request", delivery: "not-sent", error: "Cancel requestId is required." });
      return false;
    }
    return respond(cancelTransport(requestId, clientId).then((result) => ({ result, transport: transportState })));
  }

  return false;
});
