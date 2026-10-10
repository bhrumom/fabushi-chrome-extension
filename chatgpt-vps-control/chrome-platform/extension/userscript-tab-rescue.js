export const RESCUE_KEY = "fabushi.tabRescue.v1";
export const RESTORE_SETTLE_MS = 120_000;
const operations = new Map();
let storageQueue = Promise.resolve();
function changePending(operation) {
  const result = storageQueue.then(async () => {
    const records = (await chrome.storage.session.get(RESCUE_KEY))[RESCUE_KEY] || {};
    await operation(records);
    await chrome.storage.session.set({ [RESCUE_KEY]: records });
  });
  storageQueue = result.catch(() => {});
  return result;
}

export async function transferRescueTab(addedTabId, removedTabId) {
  // Some Chrome releases replace WebContents on discard and issue onReplaced.
  // This is the same tab-strip slot, not a tabs.create replacement window/tab.
  await changePending(async records => {
    const pending = records[removedTabId];
    if (!pending) return;
    records[addedTabId] = pending;
    delete records[removedTabId];
    const key = "fabushi.scriptTabWatchdog.v1";
    const observed = (await chrome.storage.session.get(key))[key] || {};
    if (observed[removedTabId]) {
      observed[addedTabId] = { ...observed[removedTabId], tabId: addedTabId, originalTabId: removedTabId };
      delete observed[removedTabId];
      await chrome.storage.session.set({ [key]: observed });
    }
    const leaseKey = "fabushi.userscriptRecovery.v1";
    const leases = (await chrome.storage.local.get(leaseKey))[leaseKey] || {};
    for (const lease of Object.values(leases)) if (lease?.tabId === removedTabId) lease.tabId = addedTabId;
    await chrome.storage.local.set({ [leaseKey]: leases });
  });
}

export function samePage(left, right) {
  try {
    const a = new URL(left), b = new URL(right);
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch { return false; }
}

export function webURL(value) {
  try {
    const url = new URL(value);
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch { return ""; }
}

async function terminateHungExecution(tabId) {
  const target = { tabId };
  let attached = false, expired = false, timer;
  // If attachment finishes after the deadline, detach immediately. Never take
  // over an existing Browser Control or user DevTools session.
  const work = (async () => {
    try {
      await chrome.debugger.attach(target, "1.3");
      attached = true;
      if (!expired) await chrome.debugger.sendCommand(target, "Runtime.terminateExecution");
    } catch {} finally {
      if (attached) await chrome.debugger.detach(target).catch(() => {});
    }
  })();
  try {
    await Promise.race([work, new Promise(resolve => { timer = setTimeout(() => { expired = true; resolve(); }, 3_000); })]);
  } finally { clearTimeout(timer); }
}

export async function restoreRescue(tabId) {
  const records = (await chrome.storage.session.get(RESCUE_KEY))[RESCUE_KEY] || {};
  const record = records[tabId];
  if (!record) return false;
  const tab = await chrome.tabs.get(tabId).catch(() => null);
  if (!tab || (tab.url !== record.transitURL && !samePage(tab.url, record.sourceURL))) {
    await changePending(current => { if (current[tabId]?.transitURL === record.transitURL) delete current[tabId]; });
    return false;
  }
  // A worker can stop after navigation commits but before pending cleanup.
  // This is completion of restoration, not another prepared hung-page rescue.
  if (record.stage === "restoring" && samePage(tab.url, record.recoveryURL) && !tab.discarded) {
    await changePending(current => { if (current[tabId]?.transitURL === record.transitURL) delete current[tabId]; });
    return true;
  }
  if (tab.discarded || tab.url === record.transitURL) {
    // Persist before navigation: the alarm and a restarted worker must agree
    // that the destination is allowed time to hydrate, even without a heartbeat.
    await changePending(current => { if (current[tabId]?.transitURL === record.transitURL) current[tabId].stage = "restoring"; });
    const key = "fabushi.scriptTabWatchdog.v1";
    const observed = (await chrome.storage.session.get(key))[key] || {};
    observed[tabId] = { ...observed[tabId], tabId, url: record.recoveryURL,
      settleUntil: Date.now() + RESTORE_SETTLE_MS, unhealthySince: 0, status: "restoring-loading" };
    await chrome.storage.session.set({ [key]: observed });
  }
  // A discard path retains the original URL; transit gets a full navigation.
  if (tab.discarded) {
    if (tab.url !== record.recoveryURL) await chrome.tabs.update(tabId, { url: record.recoveryURL });
    await chrome.tabs.reload(tabId, { bypassCache: true });
  } else if (tab.url === record.transitURL) {
    await chrome.tabs.update(tabId, { url: record.recoveryURL });
  } else if (record.stage === "prepared" && samePage(tab.url, record.sourceURL)) {
    if (operations.has(tabId)) return false;
    await rescueSameTab(tabId, record.sourceURL, record.recoveryURL);
    return true;
  } else return false;
  await changePending(current => { if (current[tabId]?.transitURL === record.transitURL) delete current[tabId]; });
  return true;
}

export function rescueSameTab(tabId, sourceURL, recoveryURL) {
  if (operations.has(tabId)) return operations.get(tabId);
  const originalTabId = tabId;
  const operation = (async () => {
    if (!webURL(sourceURL) || !webURL(recoveryURL) || !samePage(sourceURL, recoveryURL)) throw Error("invalid-recovery-target");
    let tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading" || !samePage(tab.url, sourceURL) || (tab.pendingUrl && !samePage(tab.pendingUrl, sourceURL))) throw Error("tab-loading-or-navigated");
    const transitURL = chrome.runtime.getURL("tab-rescue.html") + "#" + crypto.randomUUID();
    await changePending(records => { records[tabId] = { sourceURL, recoveryURL, transitURL, stage: "prepared", startedAt: Date.now() }; });
    // Chrome can replace the extension tab ID on discard. Use the same
    // browser-initiated navigation for inactive tabs to retain numeric identity.
    await terminateHungExecution(tabId);
    tab = await chrome.tabs.get(tabId);
    if (tab.status === "loading" || !samePage(tab.url, sourceURL) || (tab.pendingUrl && !samePage(tab.pendingUrl, sourceURL))) throw Error("tab-loading-or-navigated");
    // Cross-origin navigation is initiated in the browser, not by executing
    // location.replace inside the hung renderer. No tabs.create or activation.
    await chrome.tabs.update(tabId, { url: transitURL });
    return { action: "terminate-transit-original-tab", tabId };
  })().finally(() => operations.delete(originalTabId));
  operations.set(originalTabId, operation);
  return operation;
}

chrome.tabs.onReplaced?.addListener((addedTabId, removedTabId) => {
  void transferRescueTab(addedTabId, removedTabId).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "fabushi.tabRescue.ready") return false;
  void (async () => {
    const records = (await chrome.storage.session.get(RESCUE_KEY))[RESCUE_KEY] || {};
    const record = records[sender.tab?.id];
    if (!record || sender.url !== record.transitURL) throw Error("invalid-rescue-sender");
    return { ok: await restoreRescue(sender.tab.id) };
  })().then(sendResponse, error => sendResponse({ ok: false, error: String(error.message) }));
  return true;
});
