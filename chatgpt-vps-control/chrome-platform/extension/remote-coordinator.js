import { COORDINATOR_PROTOCOL_VERSION } from "./agent-protocol.js";

const COORDINATOR_URL = "wss://fabushi-mcp.ombhrum.com/coordinator";
const RECONNECT_ALARM = "fabushi-remote-coordinator-reconnect";
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const READY_TIMEOUT_MS = 8_000;
const MAX_BACKOFF_MS = 30_000;

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value) {
  return typeof value === "string" ? value : "";
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

export function createRemoteCoordinatorTransport({
  url = COORDINATOR_URL,
  socketFactory = (target) => new WebSocket(target),
  sessionProvider = () => globalThis.__fabushiGetCoordinatorAccountSession?.(),
  alarms = globalThis.chrome?.alarms,
} = {}) {
  const listeners = new Set();
  const pending = new Map();
  let socket = null;
  let ready = false;
  let epoch = 0;
  let reconnectDelayMs = 500;
  let reconnectTimer = null;
  let lastError = "";
  let statusWaiter = null;

  function notify(frame) {
    for (const listener of listeners) {
      try { listener(frame); } catch {}
    }
  }

  function clearPending(reason) {
    for (const [requestId, item] of pending) {
      item.reject(Object.assign(new Error(reason), {
        code: "coordinator-transport-lost",
        delivery: "unknown",
        requestId,
      }));
    }
    pending.clear();
  }

  function clearReconnectTimer() {
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  async function scheduleReconnect() {
    clearReconnectTimer();
    const current = await sessionProvider().catch(() => null);
    if (!current?.accessToken) return;
    const delay = reconnectDelayMs;
    reconnectDelayMs = Math.min(reconnectDelayMs * 2, MAX_BACKOFF_MS);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect().catch(() => {});
    }, delay);
    try { alarms?.create?.(RECONNECT_ALARM, { delayInMinutes: Math.max(delay / 60_000, 0.5) }); } catch {}
  }

  function send(frame) {
    const encoded = JSON.stringify(frame);
    if (encoded.length > MAX_FRAME_BYTES) throw new Error("Coordinator frame exceeds the extension transport limit.");
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Remote Coordinator socket is not open.");
    socket.send(encoded);
  }

  function settleReply(frame) {
    const item = pending.get(frame.requestId);
    if (!item) return false;
    pending.delete(frame.requestId);
    clearTimeout(item.timer);
    if (frame.outcome?.status === "ok") item.resolve(frame.outcome.value);
    else {
      const failure = frame.outcome?.failure || {};
      item.reject(Object.assign(new Error(text(failure.message) || "Remote Coordinator request failed."), {
        code: text(failure.code) || "coordinator-request-failed",
        transportKind: "remote",
      }));
    }
    return true;
  }

  function markReady(protocolVersion) {
    if (protocolVersion !== COORDINATOR_PROTOCOL_VERSION) {
      lastError = "Remote Coordinator protocol version mismatch.";
      try { socket?.close?.(4002, "protocol version mismatch"); } catch {}
      return;
    }
    ready = true;
    reconnectDelayMs = 500;
    lastError = "";
    statusWaiter?.resolve({
      connected: true,
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
    });
    statusWaiter = null;
    notify({ kind: "lifecycle", phase: "ready", protocolVersion: COORDINATOR_PROTOCOL_VERSION });
  }

  function handleMessage(activeEpoch, event) {
    if (activeEpoch !== epoch || typeof event?.data !== "string" || event.data.length > MAX_FRAME_BYTES) return;
    let frame;
    try { frame = JSON.parse(event.data); } catch { return; }
    if (!record(frame)) return;

    if (frame.kind === "authenticated") {
      markReady(Number(frame.protocolVersion));
      return;
    }
    if (frame.kind === "lifecycle" && frame.phase === "ready") {
      markReady(Number(frame.protocolVersion));
      return;
    }
    if (frame.kind === "reply" && text(frame.requestId)) {
      settleReply(frame);
      return;
    }
    if (frame.kind === "event" || frame.kind === "lifecycle") notify(frame);
  }

  async function connect() {
    const current = await sessionProvider().catch(() => null);
    if (!current?.accessToken) {
      ready = false;
      lastError = "Fabushi account login is required for the remote Coordinator.";
      return false;
    }
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return true;

    const activeEpoch = ++epoch;
    ready = false;
    const active = socketFactory(url);
    socket = active;

    active.onopen = () => {
      if (activeEpoch !== epoch || socket !== active) return;
      try {
        send({
          kind: "authenticate",
          protocolVersion: COORDINATOR_PROTOCOL_VERSION,
          accessToken: current.accessToken,
          client: { kind: "chrome-extension", transport: "remote-coordinator" },
        });
      } catch (error) {
        lastError = error?.message || String(error);
        try { active.close(); } catch {}
      }
    };

    active.onmessage = (event) => handleMessage(activeEpoch, event);

    active.onerror = () => {
      if (activeEpoch !== epoch) return;
      lastError = "Remote Coordinator connection failed.";
    };

    active.onclose = (event) => {
      if (activeEpoch !== epoch) return;
      socket = null;
      ready = false;
      lastError = event?.reason || lastError || "Remote Coordinator disconnected.";
      statusWaiter?.resolve({
        connected: false,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        error: lastError,
      });
      statusWaiter = null;
      clearPending(lastError);
      notify({ kind: "lifecycle", phase: "shutdown", reason: "requested", detail: null });
      void scheduleReconnect();
    };
    return true;
  }

  async function waitReady() {
    if (ready && socket?.readyState === WebSocket.OPEN) {
      return { connected: true, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
    }
    const connecting = await connect();
    if (ready && socket?.readyState === WebSocket.OPEN) {
      return { connected: true, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
    }
    if (!connecting) {
      return {
        connected: false,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        error: lastError || "Remote Coordinator is unavailable.",
      };
    }
    if (statusWaiter) return statusWaiter.promise;

    statusWaiter = deferred();
    const waiter = statusWaiter;
    const timer = setTimeout(() => {
      if (statusWaiter !== waiter) return;
      statusWaiter = null;
      waiter.resolve({
        connected: false,
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
        error: lastError || "Remote Coordinator did not become ready.",
      });
    }, READY_TIMEOUT_MS);
    return waiter.promise.finally(() => clearTimeout(timer));
  }

  async function request(method, args, clientId, requestId) {
    const state = await waitReady();
    if (!state.connected) throw Object.assign(new Error(state.error || "Remote Coordinator unavailable."), {
      code: "coordinator-unavailable",
      delivery: "not-sent",
    });
    const id = text(requestId) || `remote-${Date.now()}-${crypto.randomUUID()}`;
    if (pending.has(id)) return pending.get(id).promise;
    const item = deferred();
    item.timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      item.reject(Object.assign(new Error(`Remote Coordinator request timed out: ${method}`), {
        code: "coordinator-timeout",
        delivery: "unknown",
      }));
    }, 60_000);
    pending.set(id, item);
    try {
      send({
        kind: "request",
        requestId: id,
        method,
        args,
        clientId: text(clientId),
      });
    } catch (error) {
      pending.delete(id);
      clearTimeout(item.timer);
      item.reject(Object.assign(error, { code: "coordinator-transport-lost", delivery: "unknown" }));
    }
    return item.promise;
  }

  return {
    async status() {
      return waitReady();
    },

    call({ requestId, method, args, clientId }) {
      return request(method, args, clientId, requestId);
    },

    async cancel({ requestId, clientId }) {
      const state = await waitReady();
      if (!state.connected) throw Object.assign(new Error(state.error || "Remote Coordinator unavailable."), {
        code: "coordinator-unavailable",
        delivery: "not-sent",
      });
      send({ kind: "cancel", requestId: text(requestId), clientId: text(clientId) });
      return { cancelled: true };
    },

    resume({ clientId, activeAgentId, runId, generation, sequence }) {
      return request("resume", {
        activeAgentId: text(activeAgentId),
        runId: text(runId),
        generation: text(generation),
        sequence: Number(sequence || 0),
      }, clientId, `resume-${crypto.randomUUID()}`);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async reconnect() {
      epoch += 1;
      const previous = socket;
      socket = null;
      ready = false;
      clearReconnectTimer();
      try { previous?.close?.(1000, "reconnect"); } catch {}
      return connect();
    },

    async authChanged() {
      epoch += 1;
      const previous = socket;
      socket = null;
      ready = false;
      clearPending("Fabushi account session changed.");
      clearReconnectTimer();
      try { previous?.close?.(1000, "account session changed"); } catch {}
      return connect();
    },

    close() {
      epoch += 1;
      clearReconnectTimer();
      clearPending("Remote Coordinator transport closed.");
      const previous = socket;
      socket = null;
      ready = false;
      try { previous?.close?.(1000, "closed"); } catch {}
    },
  };
}

const transport = createRemoteCoordinatorTransport();
globalThis.__fabushiRemoteCoordinatorTransport = transport;
globalThis.__fabushiRemoteCoordinatorAuthChanged = () => transport.authChanged();

chrome.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm?.name === RECONNECT_ALARM) void transport.reconnect().catch(() => {});
});

void transport.status().catch(() => {});
