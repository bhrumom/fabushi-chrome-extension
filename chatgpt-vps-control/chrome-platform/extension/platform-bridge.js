const NATIVE_HOST = "com.fabushi.chrome_platform";
const RECONNECT_ALARM = "fabushi-platform-reconnect";
const HEARTBEAT_ALARM = "fabushi-platform-heartbeat";

let nativePort = null;
let connected = false;
let lastError = "";
let reconnectDelayMs = 500;
let reconnectTimer = null;
const pending = new Map();

function failPending(error) {
  for (const entry of pending.values()) entry.reject(error);
  pending.clear();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectNative();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
}

function post(message) {
  if (!nativePort) return false;
  try {
    nativePort.postMessage(message);
    return true;
  } catch (error) {
    lastError = error?.message || String(error);
    return false;
  }
}

function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  connected = false;
  let port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (error) {
    lastError = error?.message || String(error);
    nativePort = null;
    scheduleReconnect();
    return;
  }
  nativePort = port;

  port.onMessage.addListener((message) => {
    if (message?.type === "platform_hello_ack") {
      connected = true;
      lastError = "";
      reconnectDelayMs = 500;
      chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
      chrome.runtime.sendMessage({ type: "fabushi.platform.connection", connected: true }).catch(() => {});
      return;
    }
    if (message?.type === "platform_response") {
      const request = pending.get(String(message.requestId || ""));
      if (!request) return;
      pending.delete(String(message.requestId));
      if (message.ok === false) request.reject(new Error(String(message.error || "Desktop request failed.")));
      else request.resolve(message.result);
      return;
    }
    if (message?.type === "platform_event") {
      chrome.runtime.sendMessage({ type: "fabushi.platform.event", event: message.event }).catch(() => {});
    }
  });

  port.onDisconnect.addListener(() => {
    const reason = chrome.runtime.lastError?.message || "Fabushi desktop bridge disconnected.";
    lastError = reason;
    connected = false;
    if (nativePort === port) nativePort = null;
    failPending(new Error(reason));
    chrome.runtime.sendMessage({ type: "fabushi.platform.connection", connected: false, error: reason }).catch(() => {});
    scheduleReconnect();
  });

  post({
    type: "platform_hello",
    extensionId: chrome.runtime.id,
    version: chrome.runtime.getManifest().version,
    platform: "chrome-extension",
  });
}

function requestDesktop(method, params = {}, timeoutMs = 30_000) {
  if (!nativePort) connectNative();
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      reject(new Error(`Fabushi desktop request timed out: ${method}`));
    }, Math.max(500, Math.min(Number(timeoutMs) || 30_000, 60_000)));
    pending.set(requestId, {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    });
    if (!post({ type: "platform_request", requestId, method: String(method), params })) {
      pending.delete(requestId);
      clearTimeout(timer);
      reject(new Error(lastError || "Fabushi desktop app is not connected."));
    }
  });
}

// The existing Fabushi userscript runner is a sibling service-worker module.
// It reuses this authenticated product channel instead of opening a second
// Native Messaging port or receiving any desktop credential material.
globalThis.__fabushiDesktopRequest = requestDesktop;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "fabushi.platform.status") {
    sendResponse({ connected, error: lastError, extensionId: chrome.runtime.id, version: chrome.runtime.getManifest().version });
    return false;
  }
  if (message.type === "fabushi.platform.reconnect") {
    connectNative();
    sendResponse({ connected });
    return false;
  }
  if (message.type === "fabushi.platform.request") {
    requestDesktop(message.method, message.params || {}, message.timeoutMs)
      .then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) connectNative();
  if (alarm.name === HEARTBEAT_ALARM) {
    if (nativePort) post({ type: "platform_heartbeat", timestamp: Date.now() });
    else connectNative();
  }
});

connectNative();
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
