import { userScriptMatches } from "./userscript-core.js";
import { canonicalTaskScript, probeTaskRecovery } from "./userscript-task-recovery.js";
import { probeScriptPage } from "./userscript-tab-health.js";
import { RESCUE_KEY, rescueSameTab, restoreRescue, samePage, webURL } from "./userscript-tab-rescue.js";

export const WATCHDOG_KEY = "fabushi.scriptTabWatchdog.v1";
export const HISTORY_KEY = "fabushi.scriptTabRecoveryHistory.v1";
export const UNHEALTHY_MS = 90_000;
const COOLDOWN_MS = 120_000;
const BUDGET_MS = 10 * 60_000;
let scanPromise;
const repairs = new Set();

export async function repairUnclaimedTask(tabId, expectedURL) {
  if (!Number.isInteger(tabId) || !webURL(expectedURL) || repairs.has(tabId)) throw Error("invalid-repair-target");
  repairs.add(tabId);
  try {
    const tab = await chrome.tabs.get(tabId);
    if (!samePage(tab.url, expectedURL) || tab.discarded || tab.frozen
      || (tab.pendingUrl && !samePage(tab.pendingUrl, expectedURL))) throw Error("tab-navigated-or-suspended");
    const data = await chrome.storage.local.get("fabushi.userscripts.v1");
    const scripts = data["fabushi.userscripts.v1"] || [];
    if (!scripts.some(script => script.enabled !== false && canonicalTaskScript(script)
      && userScriptMatches(script, tab.url))) throw Error("unmanaged-tab");
    const checkpoint = await probeTaskRecovery(tabId);
    if (!checkpoint.resumable || checkpoint.currentOwner === checkpoint.ownerTabId) throw Error("task-not-unclaimed");
    const health = await probeScriptPage(tabId);
    if (!health.healthy || health.protected) throw Error("page-unreadable-or-protected");
    const history = (await chrome.storage.session.get(HISTORY_KEY))[HISTORY_KEY] || [];
    const event = { tabId, url: tab.url, trigger: "explicit-task-repair", reason: "unclaimed-running-task", at: Date.now(), status: "started" };
    history.push(event);
    await chrome.storage.session.set({ [HISTORY_KEY]: history.slice(-100) });
    try {
      const result = await rescueSameTab(tabId, tab.url, recoveryDestination(tab, {}, true));
      Object.assign(event, { status: "restoration-dispatched", action: result.action, restoredTabId: result.tabId });
      return result;
    } catch (error) {
      Object.assign(event, { status: "failed", error: String(error.message).slice(0, 160) });
      throw error;
    } finally {
      await chrome.storage.session.set({ [HISTORY_KEY]: history.slice(-100) });
    }
  } finally { repairs.delete(tabId); }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "fabushi.taskRepair") return false;
  if (sender.url !== chrome.runtime.getURL("tab-health.html")) {
    sendResponse({ ok: false, error: "invalid-repair-sender" });
    return false;
  }
  void repairUnclaimedTask(message.tabId, message.url).then(
    result => sendResponse({ ok: true, ...result }),
    error => sendResponse({ ok: false, error: String(error.message) }),
  );
  return true;
});

export function recoveryDestination(tab, leases, canonical = false) {
  if (canonical) {
    const url = new URL(tab.url);
    url.hash = "fabushi-resume=fabushi-host-" + crypto.randomUUID();
    return url.href;
  }
  // A saved checkpoint survives even if the page's lease expired while hung.
  const lease = Object.values(leases || {}).find(record => record?.tabId === tab.id
    && record.status !== "released" && samePage(record.sourceURL, tab.url)
    && samePage(record.recoveryURL, tab.url) && webURL(record.recoveryURL));
  return lease?.recoveryURL || tab.url;
}

export function scanManagedTabs(trigger = "alarm", { now = Date.now, probe = probeScriptPage, rescue = rescueSameTab } = {}) {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const data = await chrome.storage.local.get(["fabushi.userscripts.v1", "fabushi.userscriptRecovery.v1"]);
    const scripts = (Array.isArray(data["fabushi.userscripts.v1"]) ? data["fabushi.userscripts.v1"] : []).filter(script => script?.enabled !== false);
    const session = await chrome.storage.session.get([WATCHDOG_KEY, RESCUE_KEY, HISTORY_KEY]);
    let records = session[WATCHDOG_KEY] || {};
    const history = session[HISTORY_KEY] || [];
    const pending = session[RESCUE_KEY] || {};
    for (const tabId of Object.keys(pending)) await restoreRescue(Number(tabId)).catch(() => {});
    if (Object.keys(pending).length) records = (await chrome.storage.session.get(WATCHDOG_KEY))[WATCHDOG_KEY] || {};
    const tabs = await chrome.tabs.query({});
    const candidates = tabs.filter(tab => webURL(tab.url) && scripts.some(script => userScriptMatches(script, tab.url)));
    const alive = new Set(candidates.map(tab => String(tab.id)));
    for (const key of Object.keys(records)) if (!alive.has(key)) delete records[key];
    const observations = await Promise.all(candidates.map(async tab => {
      const observation = records[tab.id];
      if (tab.status === "loading" || (samePage(observation?.url, tab.url) && Number(observation?.settleUntil || 0) > now())) {
        return { tab, deferred: true, deferReason: "restored-or-loading-document" };
      }
      if (tab.discarded || tab.frozen || (tab.pendingUrl && !samePage(tab.url, tab.pendingUrl))) return { tab, deferred: true };
      const canonical = scripts.some(script => canonicalTaskScript(script) && userScriptMatches(script, tab.url));
      const [health, checkpoint] = await Promise.all([probe(tab.id), canonical ? probeTaskRecovery(tab.id) : null]);
      return { tab, health, checkpoint };
    }));
    for (const { tab, health, checkpoint, deferred, deferReason } of observations) {
      const timestamp = now();
      const previous = records[tab.id];
      const record = previous && samePage(previous.url, tab.url) ? previous
        : { tabId: tab.id, url: tab.url, recoveryCount: 0, unhealthySince: 0 };
      records[tab.id] = record;
      record.url = tab.url;
      if (deferred) {
        record.unhealthySince = 0;
        record.lastHealthReason = deferReason || "browser-suspended-or-navigating";
        record.status = "deferred";
        continue;
      }
      // Sleep/eviction is not continuous evidence of unresponsiveness.
      if (timestamp - Number(record.lastProbeAt || timestamp) > 5 * 60_000) record.unhealthySince = 0;
      record.lastProbeAt = timestamp;
      record.lastHealthReason = health.reason;
      if (checkpoint?.resumable) record.taskCheckpoint = checkpoint;
      else if (checkpoint && health.healthy) record.taskCheckpoint = checkpoint;
      record.lastTrigger = trigger;
      if (health.healthy || health.protected) {
        record.unhealthySince = 0;
        record.status = "healthy";
        continue;
      }
      record.unhealthySince ||= timestamp;
      record.status = "suspect";
      if (timestamp - record.unhealthySince < UNHEALTHY_MS) continue;
      if (record.lastRecoveryAt && timestamp - record.lastRecoveryAt < COOLDOWN_MS) continue;
      if (!record.budgetStartedAt || timestamp - record.budgetStartedAt >= BUDGET_MS) {
        record.budgetStartedAt = timestamp;
        record.recoveryCount = 0;
      }
      if (record.recoveryCount >= 2) { record.status = "exhausted"; continue; }
      const current = await chrome.tabs.get(tab.id).catch(() => null);
      if (!current || current.status === "loading" || current.discarded || current.frozen || !samePage(current.url, tab.url)
        || (current.pendingUrl && !samePage(current.pendingUrl, tab.url))) continue;
      // Recheck draft/navigation immediately before the destructive unload.
      const finalHealth = await probe(tab.id);
      if (finalHealth.healthy || finalHealth.protected) { record.unhealthySince = 0; continue; }
      const canonical = scripts.some(script => canonicalTaskScript(script) && userScriptMatches(script, current.url));
      const recoveryURL = recoveryDestination(current, data["fabushi.userscriptRecovery.v1"], canonical);
      record.recoveryCount += 1;
      record.lastRecoveryAt = timestamp;
      record.lastRecoveryURL = recoveryURL;
      record.status = "recovering";
      record.unhealthySince = 0;
      // Reserve attempt BEFORE unloading so worker restart cannot reset budget.
      const event = { tabId: tab.id, url: current.url, trigger, reason: finalHealth.reason, at: timestamp, status: "started" };
      history.push(event);
      if (history.length > 100) history.splice(0, history.length - 100);
      await chrome.storage.session.set({ [WATCHDOG_KEY]: records, [HISTORY_KEY]: history });
      try {
        const result = await rescue(tab.id, current.url, recoveryURL);
        record.lastRecoveryAction = result.action;
        event.status = "restoration-dispatched";
        event.action = result.action;
        event.restoredTabId = result.tabId;
        if (result.tabId !== tab.id) {
          record.originalTabId = tab.id;
          record.tabId = result.tabId;
          records[result.tabId] = record;
          delete records[tab.id];
        }
      } catch (error) {
        record.status = "failed";
        record.lastError = String(error.message || error).slice(0, 160);
        event.status = "failed";
        event.error = record.lastError;
      }
    }
    await chrome.storage.session.set({ [WATCHDOG_KEY]: records, [HISTORY_KEY]: history });
    return { supervised: candidates.length, records };
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}
