// Stable Fabushi-owned host name. The legacy ChatGPT Computer Control host is
// intentionally not used by the production package after migration.
const NATIVE_HOST = "com.fabushi.browser_control";
const HEARTBEAT_ALARM = "fabushi-browser-heartbeat";
const RECONNECT_ALARM = "fabushi-browser-reconnect";
const STORAGE = {
  instanceId: "fabushiBrowserInstanceId",
  generation: "fabushiBrowserGeneration",
  claimed: "fabushiClaimedTabs",
  automation: "fabushiAutomationTabs",
  retained: "fabushiRetainedTabs",
  automationGroup: "fabushiAutomationGroupId",
};

let nativePort = null;
let nativeConnected = false;
let nativeError = "";
let reconnectTimer = null;
let reconnectDelayMs = 500;
let stateSeedPromise = null;
const attachedTabs = new Set();
const queues = new Map();
const childSessions = new Map();
const childSessionWaiters = new Map();

function randomId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function isOrdinaryWebUrl(value) {
  try { return ["http:", "https:"].includes(new URL(String(value || "")).protocol); }
  catch { return false; }
}

async function seedState() {
  if (stateSeedPromise) return stateSeedPromise;
  stateSeedPromise = (async () => {
    const [local, session] = await Promise.all([
      chrome.storage.local.get([STORAGE.instanceId]),
      chrome.storage.session.get([STORAGE.generation]),
    ]);
    if (!local[STORAGE.instanceId]) {
      await chrome.storage.local.set({ [STORAGE.instanceId]: randomId() });
    }
    if (!session[STORAGE.generation]) {
      await chrome.storage.session.set({ [STORAGE.generation]: randomId() });
    }
  })().finally(() => { stateSeedPromise = null; });
  return stateSeedPromise;
}

async function state() {
  // Multiple tab events can wake a cold worker simultaneously. Serialize the
  // one-time seed so every listing/claim in this worker observes one
  // generation instead of racing two random values into storage.session.
  await seedState();
  const [local, session] = await Promise.all([
    chrome.storage.local.get([STORAGE.instanceId]),
    chrome.storage.session.get([
      STORAGE.generation,
      STORAGE.claimed,
      STORAGE.automation,
      STORAGE.retained,
      STORAGE.automationGroup,
    ]),
  ]);
  return {
    instanceId: local[STORAGE.instanceId],
    generation: session[STORAGE.generation],
    claimed: new Set((session[STORAGE.claimed] || []).map(Number)),
    automation: new Set((session[STORAGE.automation] || []).map(Number)),
    retained: new Set((session[STORAGE.retained] || []).map(Number)),
    automationGroup: Number.isInteger(session[STORAGE.automationGroup]) ? session[STORAGE.automationGroup] : null,
  };
}

async function saveState(current) {
  await chrome.storage.session.set({
    [STORAGE.generation]: current.generation,
    [STORAGE.claimed]: [...current.claimed],
    [STORAGE.automation]: [...current.automation],
    [STORAGE.retained]: [...current.retained],
    [STORAGE.automationGroup]: current.automationGroup,
  });
  const count = new Set([...current.claimed, ...current.automation]).size;
  await chrome.action.setBadgeBackgroundColor({ color: count ? "#111827" : "#9ca3af" });
  await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 99)) : "" });
}

async function visibleTabs() {
  const current = await state();
  const tabs = await chrome.tabs.query({});
  const present = new Set(tabs.map((tab) => tab.id));
  let changed = false;
  for (const set of [current.claimed, current.automation, current.retained]) {
    for (const id of set) if (!present.has(id)) { set.delete(id); changed = true; }
  }
  if (changed) await saveState(current);
  return tabs
    .filter((tab) => current.automation.has(tab.id) || isOrdinaryWebUrl(tab.url || tab.pendingUrl))
    .map((tab) => ({
      id: String(tab.id),
      title: String(tab.title || ""),
      url: String(tab.url || tab.pendingUrl || ""),
      // The generation is intentionally exposed with every listing. A claim
      // is valid only for the exact extension instance/generation that was
      // enumerated; a worker restart therefore fails closed.
      generation: current.generation,
      active: tab.active === true,
      windowId: tab.windowId,
      owner: current.automation.has(tab.id) ? "automation" : "user",
      retained: current.automation.has(tab.id) ? current.retained.has(tab.id) : true,
      claimed: current.claimed.has(tab.id) || current.automation.has(tab.id),
    }));
}

function post(message) {
  try { globalThis.__fabushiBrowserEvent?.(message); } catch {}
  try { nativePort?.postMessage(message); return Boolean(nativePort); }
  catch (error) { nativeError = error?.message || String(error); return false; }
}

async function announce(type = "tabs") {
  const current = await state();
  post({ type, instanceId: current.instanceId, generation: current.generation, browser: navigator.userAgent, tabs: await visibleTabs() });
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

function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  nativeConnected = false;
  let port;
  try { port = chrome.runtime.connectNative(NATIVE_HOST); }
  catch (error) {
    nativePort = null;
    nativeError = error?.message || String(error);
    scheduleReconnect();
    return;
  }
  nativePort = port;
  port.onMessage.addListener((message) => {
    if (message?.type === "hello_ack") {
      nativeConnected = true;
      nativeError = "";
      reconnectDelayMs = 500;
      chrome.alarms.clear(RECONNECT_ALARM).catch(() => {});
      return;
    }
    if (message?.type === "request") void handleRequest(message);
  });
  port.onDisconnect.addListener(() => {
    nativeError = chrome.runtime.lastError?.message || "Fabushi browser-control bridge disconnected.";
    nativeConnected = false;
    if (nativePort === port) nativePort = null;
    scheduleReconnect();
  });
  void announce("hello");
}

async function locked(tabId, operation) {
  const previous = queues.get(tabId) || Promise.resolve();
  const current = previous.catch(() => {}).then(operation);
  queues.set(tabId, current);
  try { return await current; }
  finally { if (queues.get(tabId) === current) queues.delete(tabId); }
}

async function ensureDebugger(tabId) {
  await locked(tabId, async () => {
    if (attachedTabs.has(tabId)) return;
    try { await chrome.debugger.attach({ tabId }, "1.3"); }
    catch (error) { if (!/already attached/i.test(String(error?.message))) throw error; }
    attachedTabs.add(tabId);
  });
}

function isScreenshotSurfaceError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /(?:unable to capture screenshot|only screenshots from surface are allowed|screenshots? from surface|captureScreenshot.*(?:timed out|timeout)|timed out.*captureScreenshot)/i.test(message);
}

async function sendCdpCommand(target, method, params = {}) {
  try {
    return await chrome.debugger.sendCommand(target, method, params);
  } catch (error) {
    // Chrome can transiently have no composited surface for a background tab,
    // or reject a surface-mode capture while the target is being activated.
    // Bring the target forward and retry the requested mode first; if Chrome
    // still reports a surface restriction, use the non-surface capture path.
    if (method !== "Page.captureScreenshot" || params.fromSurface === false || !isScreenshotSurfaceError(error)) throw error;
    await chrome.debugger.sendCommand(target, "Page.bringToFront").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 100));
    try {
      return await chrome.debugger.sendCommand(target, method, params);
    } catch (retryError) {
      if (!isScreenshotSurfaceError(retryError)) throw retryError;
      return chrome.debugger.sendCommand(target, method, { ...params, fromSurface: false });
    }
  }
}

function childSessionKey(tabId, parentSessionId, targetId) {
  return `${tabId}:${String(parentSessionId || "")}:${String(targetId || "")}`;
}

function clearChildSessions(tabId) {
  const prefix = `${tabId}:`;
  for (const key of childSessions.keys()) if (key.startsWith(prefix)) childSessions.delete(key);
  for (const [key, waiters] of childSessionWaiters) {
    if (!key.startsWith(prefix)) continue;
    for (const waiter of waiters) waiter.reject(new Error("Browser debugger child session closed."));
    childSessionWaiters.delete(key);
  }
}

function rememberChildSession(tabId, parentSessionId, targetId, sessionId) {
  const key = childSessionKey(tabId, parentSessionId, targetId);
  childSessions.set(key, String(sessionId));
  const waiters = childSessionWaiters.get(key);
  if (!waiters) return;
  childSessionWaiters.delete(key);
  for (const waiter of waiters) waiter.resolve(String(sessionId));
}

function forgetChildSession(tabId, sessionId) {
  const prefix = `${tabId}:`;
  for (const [key, value] of childSessions) if (key.startsWith(prefix) && value === String(sessionId)) childSessions.delete(key);
}

function waitForChildSession(key, timeoutMs = 3_000) {
  let waiter;
  const promise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const waiters = childSessionWaiters.get(key);
      waiters?.delete(waiter);
      if (!waiters?.size) childSessionWaiters.delete(key);
      reject(new Error("Timed out waiting for Chrome to attach the out-of-process iframe."));
    }, timeoutMs);
    waiter = {
      resolve: (value) => { clearTimeout(timer); resolve(value); },
      reject: (error) => { clearTimeout(timer); reject(error); },
    };
    const waiters = childSessionWaiters.get(key) ?? new Set();
    waiters.add(waiter);
    childSessionWaiters.set(key, waiters);
  });
  void promise.catch(() => {});
  return { promise, cancel(error) {
    const waiters = childSessionWaiters.get(key);
    waiters?.delete(waiter);
    if (!waiters?.size) childSessionWaiters.delete(key);
    waiter.reject(error);
  } };
}

async function autoAttachFrame(tabId, parentSessionId, frameTargetId) {
  const key = childSessionKey(tabId, parentSessionId, frameTargetId);
  const existing = childSessions.get(key);
  if (existing) return existing;
  const pending = waitForChildSession(key);
  try {
    const target = { tabId, ...(parentSessionId ? { sessionId: String(parentSessionId) } : {}) };
    await locked(tabId, () => chrome.debugger.sendCommand(target, "Target.setAutoAttach", {
      autoAttach: true,
      waitForDebuggerOnStart: false,
      flatten: true,
      filter: [{ type: "iframe", exclude: false }],
    }));
    return childSessions.get(key) ?? await pending.promise;
  } catch (error) {
    pending.cancel(error);
    throw error;
  }
}

async function ensureAutomationGroup(tabId, current) {
  try {
    if (current.automationGroup != null) {
      await chrome.tabs.group({ groupId: current.automationGroup, tabIds: tabId });
      return;
    }
  } catch { current.automationGroup = null; }
  try {
    current.automationGroup = await chrome.tabs.group({ tabIds: tabId });
    await chrome.tabGroups.update(current.automationGroup, { title: "Fabushi", color: "grey" });
    await saveState(current);
  } catch { current.automationGroup = null; }
}

async function requireClaimed(targetId) {
  const id = Number(targetId);
  if (!Number.isInteger(id)) throw new Error("Browser target id must be numeric.");
  const current = await state();
  if (!current.claimed.has(id) && !current.automation.has(id)) throw new Error("Tab has not been claimed by Fabushi.");
  return { id, current };
}

async function handleCommand(command, params = {}) {
  if (command === "list_tabs") return { tabs: await visibleTabs() };
  if (command === "claim_tab") {
    const id = Number(params.targetId);
    if (!Number.isInteger(id)) throw new Error("claim_tab requires a numeric target id.");
    const tab = await chrome.tabs.get(id);
    const url = String(tab.url || tab.pendingUrl || "");
    const title = String(tab.title || "");
    const current = await state();
    if (!current.automation.has(id) && !isOrdinaryWebUrl(url)) throw new Error("Only ordinary http/https tabs can be controlled by Fabushi.");
    if (String(params.url || "") !== url || String(params.title || "") !== title) throw new Error("The tab changed before Fabushi could claim it. Refresh browser sessions and retry.");
    if (String(params.generation || "") !== current.generation) throw new Error("The browser extension generation changed before Fabushi could claim this tab. Refresh browser sessions and retry.");
    current.claimed.add(id);
    await saveState(current);
    return { targetId: String(id), title, url, generation: current.generation };
  }
  if (command === "downloads") {
    const id = Number(params.downloadGuid);
    if (params.action === "download_cancel") {
      if (!Number.isInteger(id)) throw new Error("download_cancel requires a numeric download id.");
      await chrome.downloads.cancel(id);
    }
    if (params.action === "download_wait") {
      if (!Number.isInteger(id)) throw new Error("download_wait requires a numeric download id.");
      const deadline = Date.now() + Math.max(0, Math.min(Number(params.timeoutMs) || 30_000, 30_000));
      while (Date.now() < deadline) {
        const [item] = await chrome.downloads.search({ id });
        if (!item || item.state !== "in_progress") break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    const items = await chrome.downloads.search({ limit: 100, orderBy: ["-startTime"] });
    return { downloads: items.map((item) => ({
      guid: String(item.id),
      url: String(item.finalUrl || item.url || ""),
      suggestedFilename: String(item.filename || "").split(/[\\/]/).pop() || "download",
      state: item.state === "in_progress" ? "inProgress" : String(item.state || "unknown"),
      receivedBytes: Number(item.bytesReceived) || 0,
      totalBytes: Number(item.totalBytes) >= 0 ? Number(item.totalBytes) : null,
      path: null,
      size: item.state === "complete" ? Number(item.fileSize) || null : null,
    })) };
  }
  if (command === "cdp") {
    const { id } = await requireClaimed(params.targetId);
    await ensureDebugger(id);
    const target = { tabId: id, ...(params.sessionId ? { sessionId: String(params.sessionId) } : {}) };
    return locked(id, () => sendCdpCommand(target, String(params.method), params.params || {}));
  }
  if (command === "cdp_auto_attach_frame") {
    const { id } = await requireClaimed(params.targetId);
    const frameTargetId = String(params.frameTargetId || "");
    const parentSessionId = String(params.parentSessionId || "");
    if (!frameTargetId || frameTargetId.length > 200) throw new Error("cdp_auto_attach_frame requires a frame target id.");
    if (parentSessionId.length > 200) throw new Error("cdp_auto_attach_frame parent session id is too long.");
    await ensureDebugger(id);
    return { sessionId: await autoAttachFrame(id, parentSessionId, frameTargetId) };
  }
  if (command === "detach") {
    const { id, current } = await requireClaimed(params.targetId);
    await chrome.debugger.detach({ tabId: id }).catch(() => {});
    attachedTabs.delete(id);
    clearChildSessions(id);
    if (!current.automation.has(id)) current.claimed.delete(id);
    await saveState(current);
    return {};
  }
  if (command === "create_tab") {
    const tab = await chrome.tabs.create({ url: String(params.url || "about:blank"), active: params.active !== false });
    const current = await state();
    current.automation.add(tab.id);
    current.claimed.add(tab.id);
    if (params.retained === true) current.retained.add(tab.id);
    await saveState(current);
    await ensureAutomationGroup(tab.id, current);
    await announce();
    return { targetId: String(tab.id) };
  }
  if (command === "cleanup_tabs") {
    const current = await state();
    const ids = [...current.automation].filter((id) => !current.retained.has(id));
    if (ids.length) await chrome.tabs.remove(ids).catch(() => {});
    for (const id of ids) {
      current.automation.delete(id);
      current.claimed.delete(id);
      current.retained.delete(id);
      attachedTabs.delete(id);
      clearChildSessions(id);
    }
    await saveState(current);
    await announce();
    return { closed: ids.map(String) };
  }
  if (command === "tab_action") {
    const { id, current } = await requireClaimed(params.targetId);
    if (params.action === "activate_tab") {
      const tab = await chrome.tabs.get(id);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(id, { active: true });
    } else if (params.action === "close_tab") await chrome.tabs.remove(id);
    else if (params.action === "navigate") await chrome.tabs.update(id, { url: String(params.url) });
    else if (params.action === "reload") await chrome.tabs.reload(id);
    else if (params.action === "back") await chrome.tabs.goBack(id);
    else if (params.action === "forward") await chrome.tabs.goForward(id);
    else if (params.action === "retain_tab" || params.action === "release_tab") {
      if (!current.automation.has(id)) throw new Error("Only Fabushi-created tabs can change lifecycle.");
      if (params.action === "retain_tab") current.retained.add(id); else current.retained.delete(id);
      await saveState(current);
    } else throw new Error(`Unsupported tab action: ${params.action}`);
    await announce();
    return {};
  }
  throw new Error(`Unsupported Fabushi browser command: ${command}`);
}

async function revokeClaims() {
  const current = await state();
  for (const tabId of attachedTabs) await chrome.debugger.detach({ tabId }).catch(() => {});
  attachedTabs.clear();
  childSessions.clear();
  current.claimed.clear();
  current.generation = randomId();
  await saveState(current);
  await announce();
}

globalThis.__fabushiBrowserCommand = handleCommand;
globalThis.__fabushiBrowserRevokeClaims = revokeClaims;

async function handleRequest(message) {
  try {
    const result = await handleCommand(String(message.command || ""), message.params || {});
    post({ type: "response", requestId: message.requestId, ok: true, result });
  } catch (error) {
    post({ type: "response", requestId: message.requestId, ok: false, error: error?.message || String(error) });
  }
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId == null) return;
  if (method === "Target.attachedToTarget" && params?.sessionId && params?.targetInfo?.targetId) {
    rememberChildSession(source.tabId, source.sessionId || "", params.targetInfo.targetId, params.sessionId);
  } else if (method === "Target.detachedFromTarget" && params?.sessionId) {
    forgetChildSession(source.tabId, params.sessionId);
  }
  post({ type: "cdp_event", targetId: String(source.tabId), method, params });
});
chrome.debugger.onDetach.addListener((source) => {
  if (source.tabId != null) { attachedTabs.delete(source.tabId); clearChildSessions(source.tabId); }
});
chrome.tabs.onUpdated.addListener(() => { void announce(); });
chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const current = await state();
    current.claimed.delete(tabId);
    current.automation.delete(tabId);
    current.retained.delete(tabId);
    attachedTabs.delete(tabId);
    clearChildSessions(tabId);
    await saveState(current);
    await announce();
  })();
});
chrome.tabGroups.onRemoved.addListener((group) => {
  void (async () => {
    const current = await state();
    if (current.automationGroup === group.id) {
      current.automationGroup = null;
      await saveState(current);
    }
  })();
});
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  void (async () => {
    const current = await state();
    if (!current.claimed.has(details.sourceTabId) && !current.automation.has(details.sourceTabId)) return;
    current.automation.add(details.tabId);
    current.claimed.add(details.tabId);
    current.retained.delete(details.tabId);
    await saveState(current);
    await ensureAutomationGroup(details.tabId, current);
    await announce();
  })();
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== "fabushi.browser.status") return false;
  visibleTabs().then((tabs) => sendResponse({ connected: nativeConnected, error: nativeError, tabs, extensionId: chrome.runtime.id }), (error) => sendResponse({ connected: false, error: error?.message || String(error), tabs: [] }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM && !nativePort) connectNative();
  if (alarm.name === HEARTBEAT_ALARM) {
    if (nativePort) post({ type: "heartbeat", timestamp: Date.now() });
    else connectNative();
  }
});

connectNative();
chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 0.5 });
// Keep service-worker startup synchronous. Chrome extension service workers
// must register listeners before any asynchronous initialization; a
// top-level await would leave the module in an unstarted state on Chrome.
void state().then((current) => saveState(current)).catch((error) => {
  nativeError = error?.message || String(error);
});
