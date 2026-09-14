const REQUEST_SOURCE = "fabushi-userscript";
const RESPONSE_SOURCE = "fabushi-extension";

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
function announceReady() {
  const url = location.href;
  if (!/^https?:\/\//i.test(url)) return;
  lastUrl = url;
  chrome.runtime.sendMessage({ type: "fabushi.userscript.pageReady", url })
    .then((response) => {
      // An acknowledged handshake is enough to stop the one-second retry
      // loop. A matching page can legitimately have no enabled optional
      // userscript; repeatedly asking the service worker to inject it only
      // creates needless churn and can race page navigation.
      readyAcknowledged = response?.ok === true;
    })
    .catch(() => {
      readyAcknowledged = false;
    });
}

announceReady();
window.setInterval(() => {
  if (location.href !== lastUrl || !readyAcknowledged) announceReady();
}, 1_000);
