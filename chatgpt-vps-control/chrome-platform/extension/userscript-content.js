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
