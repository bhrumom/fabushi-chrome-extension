const REQUEST_SOURCE = "fabushi-userscript";
const RESPONSE_SOURCE = "fabushi-extension";
const NAVIGATION_PLUGIN_ID = "chatgpt-auto-confirm";

function postResponse(requestId, ok, payload) {
  window.postMessage({
    source: RESPONSE_SOURCE,
    type: "response",
    requestId,
    ok,
    ...(ok ? { result: payload } : { error: String(payload ?? "Fabushi 用户脚本请求失败") }),
  }, "*");
}

function postRecoveryResponse(requestId, response) {
  const granted = response?.ok === true && response?.granted === true;
  window.postMessage({
    source: RESPONSE_SOURCE,
    type: granted ? "recovery-capability.granted" : "recovery-capability.denied",
    requestId: String(requestId),
    granted,
    ...(granted ? {
      capability: response.capability,
      expiresAt: response.expiresAt,
      monitorIntervalMs: response.monitorIntervalMs,
    } : { error: String(response?.error || "Fabushi 宿主未授予标签页恢复能力") }),
  }, "*");
}

function postNavigationResponse(requestId, response) {
  const granted = response?.ok === true && response?.granted === true;
  const capability = String(response?.capability || "tab-navigation-guard").slice(0, 64);
  window.postMessage({
    source: RESPONSE_SOURCE,
    type: granted ? "navigation-guard.granted" : "navigation-guard.denied",
    requestId: String(requestId),
    granted,
    capability,
    ...(granted ? {
      leaseId: String(response?.leaseId || "").slice(0, 128),
      expiresAt: Number(response?.expiresAt) || 0,
      minIntervalMs: Number(response?.minIntervalMs) || 0,
    } : {
      reason: String(response?.reason || "denied").slice(0, 120),
      retryAfterMs: Math.max(0, Math.min(60_000, Number(response?.retryAfterMs) || 0)),
      error: String(response?.error || "Fabushi 宿主暂未授予页面导航能力").slice(0, 160),
    }),
  }, "*");
}

function navigationPayload(payload) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    capability: String(value.capability || "").slice(0, 64),
    ownerTabId: String(value.ownerTabId || "").slice(0, 120),
    taskId: String(value.taskId || "").slice(0, 160),
    taskURL: String(value.taskURL || "").slice(0, 2_000),
    targetURL: String(value.targetURL || "").slice(0, 2_000),
    phase: String(value.phase || "work").slice(0, 40),
    round: Number.isFinite(Number(value.round)) ? Math.max(0, Math.min(100_000, Number(value.round))) : 0,
    goalRevision: Number.isFinite(Number(value.goalRevision)) ? Math.max(0, Math.min(100_000, Number(value.goalRevision))) : 0,
    reason: String(value.reason || "route-switch").slice(0, 80),
    force: value.force === true,
    recovery: value.recovery === true,
  };
}

function navigationCancelPayload(payload) {
  const value = payload && typeof payload === "object" && !Array.isArray(payload) ? payload : {};
  return {
    capability: String(value.capability || "").slice(0, 64),
    leaseId: String(value.leaseId || "").slice(0, 128),
    reason: String(value.reason || "stale-ticket").slice(0, 80),
  };
}

function postMemoryResponse(requestId, response) {
  const ok = response?.ok === true;
  window.postMessage({
    source: RESPONSE_SOURCE,
    type: "tab-memory.response",
    requestId: String(requestId),
    ok,
    ...(ok ? { result: response.result } : { error: String(response?.error || "Fabushi 宿主暂时无法回收标签页") }),
  }, "*");
}
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  const data = event.data;
  if (!data || data.source !== REQUEST_SOURCE || !data.requestId) return;
  if (data.type === "navigation-guard.request") {
    chrome.runtime.sendMessage({
      type: "fabushi.userscript.navigation.request",
      requestId: String(data.requestId),
      // v2.9.24-v2.9.30 omitted these envelope fields even though their
      // redacted payload identified the navigation capability. The content
      // bridge is bundled specifically for the canonical auto-confirm script,
      // so normalize the missing legacy envelope instead of feeding the host
      // an invalid request that repeats every 30 seconds forever.
      scriptId: String(data.scriptId || NAVIGATION_PLUGIN_ID).slice(0, 160),
      pluginId: String(data.pluginId || NAVIGATION_PLUGIN_ID).slice(0, 64),
      payload: navigationPayload(data.payload),
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      postNavigationResponse(data.requestId, runtimeError ? { ok:false, error:runtimeError.message } : response);
    });
    return;
  }
  if (data.type === "navigation-guard.cancel") {
    chrome.runtime.sendMessage({
      type: "fabushi.userscript.navigation.cancel",
      requestId: String(data.requestId),
      scriptId: String(data.scriptId || NAVIGATION_PLUGIN_ID).slice(0, 160),
      pluginId: String(data.pluginId || NAVIGATION_PLUGIN_ID).slice(0, 64),
      payload: navigationCancelPayload(data.payload),
    }).catch(() => {});
    return;
  }
  if (data.type === "recovery-capability.request") {
    chrome.runtime.sendMessage({
      type: "fabushi.userscript.recovery.request",
      requestId: String(data.requestId),
      payload: data.payload,
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      postRecoveryResponse(data.requestId, runtimeError ? { ok:false, error:runtimeError.message } : response);
    });
    return;
  }
  if (data.type === "recovery-capability.release") {
    chrome.runtime.sendMessage({
      type: "fabushi.userscript.recovery.release",
      requestId: String(data.requestId),
      payload: data.payload,
    }).catch(() => {});
    return;
  }
  if (data.type === "tab-memory.request") {
    chrome.runtime.sendMessage({
      type: "fabushi.userscript.memory.request",
      requestId: String(data.requestId),
      scriptId: data.scriptId,
      pluginId: data.pluginId,
      payload: data.payload && typeof data.payload === "object" && !Array.isArray(data.payload) ? {
        capability: String(data.payload.capability || "").slice(0, 64),
        version: String(data.payload.version || "").slice(0, 32),
        pressure: String(data.payload.pressure || "").slice(0, 16),
        usedBytes: Number(data.payload.usedBytes) || 0,
        totalBytes: Number(data.payload.totalBytes) || 0,
        limitBytes: Number(data.payload.limitBytes) || 0,
        ratio: Number(data.payload.ratio) || 0,
        hidden: data.payload.hidden === true,
        safeToDiscard: data.payload.safeToDiscard === true,
        hasDraft: data.payload.hasDraft === true,
        hasPendingAttachment: data.payload.hasPendingAttachment === true,
        userInitiated: data.payload.userInitiated === true,
        reason: String(data.payload.reason || "").slice(0, 80),
      } : {},
    }, (response) => {
      const runtimeError = chrome.runtime.lastError;
      postMemoryResponse(data.requestId, runtimeError ? { ok:false, error:runtimeError.message } : response);
    });
    return;
  }
  if (data.type !== "request") return;
  chrome.runtime.sendMessage({
    type: "fabushi.userscript.request",
    requestId: String(data.requestId),
    scriptId: data.scriptId,
    pluginId: data.pluginId,
    server: data.server,
    tool: data.tool,
    arguments: data.arguments,
    timeoutMs: data.timeoutMs,
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;
    if (runtimeError) postResponse(data.requestId, false, runtimeError.message);
    else if (!response?.ok) postResponse(data.requestId, false, response?.error || "Fabushi 用户脚本请求失败");
    else postResponse(data.requestId, true, response.result);
  });
});

let lastUrl = location.href;
let readyAcknowledged = false;
let readyRequestPending = false;
let readyRetryAt = 0;
let readyRetryDelayMs = 1_000;
function announceReady() {
  const url = location.href;
  if (!/^https?:\/\//i.test(url)) return;
  if (url !== lastUrl) {
    lastUrl = url;
    readyAcknowledged = false;
    readyRetryAt = 0;
    readyRetryDelayMs = 1_000;
  }
  if (readyAcknowledged || readyRequestPending || Date.now() < readyRetryAt) return;
  readyRequestPending = true;
  chrome.runtime.sendMessage({ type: "fabushi.userscript.pageReady", url })
    .then((response) => {
      readyRequestPending = false;
      if (location.href !== url) {
        readyAcknowledged = false;
        readyRetryAt = 0;
        readyRetryDelayMs = 1_000;
        announceReady();
        return;
      }
      readyAcknowledged = response?.ok === true;
      if (readyAcknowledged) {
        readyRetryAt = 0;
        readyRetryDelayMs = 1_000;
      } else {
        readyRetryAt = Date.now() + readyRetryDelayMs;
        readyRetryDelayMs = Math.min(readyRetryDelayMs * 2, 30_000);
      }
    })
    .catch(() => {
      readyRequestPending = false;
      readyAcknowledged = false;
      if (location.href !== url) {
        readyRetryAt = 0;
        readyRetryDelayMs = 1_000;
        announceReady();
        return;
      }
      readyRetryAt = Date.now() + readyRetryDelayMs;
      readyRetryDelayMs = Math.min(readyRetryDelayMs * 2, 30_000);
    });
}

announceReady();
window.setInterval(() => {
  if (location.href !== lastUrl || !readyAcknowledged) announceReady();
}, 1_000);
