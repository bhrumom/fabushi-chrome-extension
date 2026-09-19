const STORAGE_KEY = "fabushi.userscriptRecovery.v1";
const RECOVERY_ALARM = "fabushi-userscript-recovery";
const CAPABILITY = "tab-recovery";
// The lease must outlive the stale-heartbeat threshold. Otherwise a dead
// renderer would be removed from storage before the watchdog ever got a
// chance to recover its tab.
const LEASE_MS = 5 * 60_000;
const HEARTBEAT_STALE_MS = 120_000;
const RECOVERY_COOLDOWN_MS = 60_000;
const MAX_RECORDS = 50;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const ACTIVE_STATES = new Set(["queued", "sending", "uploading", "waiting", "loading", "generating", "approval", "reviewing"]);

let scanPromise = null;

function chatGPTURL(value) {
  try {
    const target = new URL(String(value || ""));
    return target.protocol === "https:" && CHATGPT_HOSTS.has(target.hostname.toLowerCase()) ? target : null;
  } catch {
    return null;
  }
}

function isCrashURL(value) {
  return /^chrome-error:\/\//i.test(String(value || ""));
}

function isCrashTitle(value) {
  return /(?:aw,? snap|崩溃啦|页面崩溃|页面崩溃啦|崩溃了)/i.test(String(value || ""));
}

function safeOwner(value) {
  const owner = String(value || "").trim();
  return owner && owner.length <= 240 && !/[\u0000-\u001f\u007f]/.test(owner) ? owner : "";
}

function safeTaskId(value) {
  const taskId = String(value || "").trim();
  return taskId && taskId.length <= 240 && !/[\u0000-\u001f\u007f]/.test(taskId) ? taskId : "";
}

function safeRecoveryURL(value) {
  try {
    const target = new URL(String(value || ""));
    if (!chatGPTURL(target.href) || !/^\/(?:c\/[^/?#]+)?$/.test(target.pathname)) return "";
    if (target.search || !/^#fabushi-resume=[^&]+$/.test(target.hash)) return "";
    return target.href;
  } catch {
    return "";
  }
}

function contentState(value) {
  const state = String(value || "").trim().slice(0, 40);
  return ACTIVE_STATES.has(state) || state === "blocked" ? state : "";
}

function contentIds(value) {
  return Array.isArray(value)
    ? value.map((item) => String(item || "").trim()).filter((item) => item && item.length <= 240).slice(0, 50)
    : [];
}

async function readRecords() {
  const result = await chrome.storage.local.get([STORAGE_KEY]);
  const records = result?.[STORAGE_KEY];
  return records && typeof records === "object" && !Array.isArray(records) ? records : {};
}

async function writeRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records });
}

function recordNeedsKeepAwake(record, now = Date.now()) {
  if (!record || record.status === "released" || record.status === "exhausted") return false;
  if (Number(record.expiresAt || 0) <= now) return false;
  const state = String(record.taskState || "");
  return ACTIVE_STATES.has(state) || (state === "blocked" && record.recoveryEligible === true);
}

export function keepAwakeNeeded(records, now = Date.now()) {
  return Object.values(records || {}).some((record) => recordNeedsKeepAwake(record, now));
}

export async function syncKeepAwake(records = null, now = Date.now()) {
  const current = records || await readRecords();
  const keepAwake = keepAwakeNeeded(current, now);
  if (keepAwake) {
    // "system" keeps Chrome/network execution alive but still allows the
    // display to turn off and the workstation to lock normally.
    chrome.power.requestKeepAwake("system");
  } else {
    // Always release when no valid lease exists. This is intentionally
    // idempotent so a freshly restarted MV3 worker can clean up a request
    // made by its previous worker lifetime.
    chrome.power.releaseKeepAwake();
  }
  return { keepAwake };
}

function senderTab(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("恢复能力请求没有关联有效标签页。");
  const url = sender?.tab?.url || sender?.tab?.pendingUrl || "";
  if (!chatGPTURL(url)) throw new Error("恢复能力只允许由 ChatGPT 页面请求。");
  return { tabId, url };
}

function normalizeRequest(message, sender) {
  const { tabId, url } = senderTab(sender);
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  if (String(payload.capability || "") !== CAPABILITY) throw new Error("未声明受支持的恢复能力。");
  const ownerTabId = safeOwner(payload.ownerTabId);
  const taskId = safeTaskId(payload.taskId);
  const recoveryURL = safeRecoveryURL(payload.recoveryURL);
  if (!ownerTabId || !taskId || !recoveryURL) throw new Error("恢复能力请求缺少安全的工作区或会话信息。");
  const taskState = contentState(payload.taskState);
  if (!taskState || taskState === "paused" || taskState === "done" || taskState === "cancelled") {
    throw new Error("当前任务状态不支持自动恢复。");
  }
  if (taskState === "blocked" && payload.recoveryEligible !== true) {
    throw new Error("需要处理状态未声明可自动恢复条件。");
  }
  return {
    ownerTabId,
    tabId,
    taskId,
    taskState,
    taskURL: chatGPTURL(payload.taskURL)?.href || "",
    phase: String(payload.phase || "work").slice(0, 40),
    round: Math.max(0, Math.min(100_000, Number(payload.round) || 0)),
    recoveryToken: String(payload.recoveryToken || "").slice(0, 240),
    recoveryURL,
    attachmentIds: contentIds(payload.attachmentIds),
    running: payload.running === true,
    attempted: payload.attempted === true,
    recoveryEligible: payload.recoveryEligible === true,
    grantedAt: Date.now(),
    lastSeenAt: Date.now(),
    expiresAt: Date.now() + LEASE_MS,
    lastRecoveryAt: 0,
    recoveryCount: 0,
    status: "granted",
    sourceURL: url,
  };
}

function grantResponse(record) {
  return {
    granted: true,
    capability: CAPABILITY,
    expiresAt: record.expiresAt,
    monitorIntervalMs: 30_000,
  };
}

async function requestRecoveryCapability(message, sender) {
  const next = normalizeRequest(message, sender);
  const records = await readRecords();
  const previous = records[next.ownerTabId];
  const now = Date.now();
  if (previous && previous.tabId !== next.tabId && previous.expiresAt > now
    && now - Number(previous.lastSeenAt || 0) < HEARTBEAT_STALE_MS) {
    throw new Error("该工作区仍由另一个标签页持有恢复租约。");
  }
  const sameTabRefresh = previous?.tabId === next.tabId;
  records[next.ownerTabId] = {
    ...(sameTabRefresh ? previous : {}),
    ...next,
    // A heartbeat/lease refresh must not reset the bounded recovery budget.
    // Otherwise a crashed renderer could refresh the lease and regain an
    // unlimited sequence of reloads or replacement tabs.
    reloadUsed: sameTabRefresh && previous?.reloadUsed === true,
    takeoverUsed: sameTabRefresh && previous?.takeoverUsed === true,
    recoveryCount: sameTabRefresh ? Number(previous?.recoveryCount || 0) : 0,
    lastRecoveryAt: sameTabRefresh ? Number(previous?.lastRecoveryAt || 0) : 0,
    status: "granted",
  };
  const entries = Object.entries(records).sort((left, right) => Number(right[1]?.lastSeenAt || 0) - Number(left[1]?.lastSeenAt || 0));
  const trimmed = Object.fromEntries(entries.slice(0, MAX_RECORDS));
  await writeRecords(trimmed);
  await syncKeepAwake(trimmed);
  await ensureRecoveryAlarm();
  return grantResponse(next);
}

async function releaseRecoveryCapability(message, sender) {
  const { tabId } = senderTab(sender);
  const payload = message?.payload && typeof message.payload === "object" ? message.payload : {};
  if (String(payload.capability || "") !== CAPABILITY) return { released: false };
  const ownerTabId = safeOwner(payload.ownerTabId);
  if (!ownerTabId) return { released: false };
  const records = await readRecords();
  const record = records[ownerTabId];
  if (!record || record.tabId !== tabId) return { released: false };
  delete records[ownerTabId];
  await writeRecords(records);
  await syncKeepAwake(records);
  return { released: true };
}

async function recoverRecord(record, tab, reason) {
  const recoveryURL = safeRecoveryURL(record.recoveryURL);
  if (!recoveryURL) return null;
  const now = Date.now();
  if (now - Number(record.lastRecoveryAt || 0) < RECOVERY_COOLDOWN_MS) return null;
  let tabId = Number(record.tabId);
  let action = "reload";
  let reloadUsed = record.reloadUsed === true;
  let takeoverUsed = record.takeoverUsed === true;
  let reloadFailed = false;
  if (!reloadUsed) {
    try {
      await chrome.tabs.update(tabId, { url: recoveryURL });
      reloadUsed = true;
    } catch {
      reloadUsed = true;
      reloadFailed = true;
    }
  }
  if ((reloadFailed || record.reloadUsed === true) && !takeoverUsed) {
    // The original tab already had its one recovery attempt and is still not
    // usable, so take over exactly once in a fresh ChatGPT tab.
    try {
      const created = await chrome.tabs.create({ url: recoveryURL, active: true });
      tabId = created.id;
      action = "takeover";
      takeoverUsed = true;
    } catch {
      return { ...record, status: "exhausted", reloadUsed, takeoverUsed, lastRecoveryReason: "recovery-tab-create-failed" };
    }
  } else if (reloadUsed && record.reloadUsed === true && takeoverUsed) {
    return { ...record, status: "exhausted", reloadUsed, takeoverUsed, lastRecoveryReason: "recovery-budget-exhausted" };
  }
  return {
    ...record,
    tabId,
    reloadUsed,
    takeoverUsed,
    lastRecoveryAt: now,
    lastSeenAt: now,
    expiresAt: now + LEASE_MS,
    recoveryCount: Number(record.recoveryCount || 0) + 1,
    status: "recovering",
    lastRecoveryReason: String(reason || "stale-heartbeat").slice(0, 120),
    lastRecoveryAction: action,
    lastRecoveryURL: recoveryURL,
    lastObservedURL: String(tab?.url || "").slice(0, 2000),
  };
}

async function scanRecoveryRecords(trigger = "alarm") {
  if (scanPromise) return scanPromise;
  scanPromise = (async () => {
    const records = await readRecords();
    const now = Date.now();
    let changed = false;
    for (const [ownerTabId, record] of Object.entries(records)) {
      if (!record || record.status === "released" || record.status === "exhausted" || Number(record.expiresAt || 0) <= now) {
        delete records[ownerTabId];
        changed = true;
        continue;
      }
      let tab;
      try { tab = await chrome.tabs.get(Number(record.tabId)); } catch { tab = null; }
      const crash = !tab || tab.status === "unloaded" || isCrashURL(tab.url) || tab.discarded === true || isCrashTitle(tab.title);
      const stale = now - Number(record.lastSeenAt || 0) >= HEARTBEAT_STALE_MS;
      if (!crash && !stale) continue;
      const recovered = await recoverRecord(record, tab, crash ? "crashed-tab" : `${trigger}:stale-heartbeat`).catch(() => null);
      if (recovered) {
        records[ownerTabId] = recovered;
        changed = true;
      }
    }
    if (changed) await writeRecords(records);
    await syncKeepAwake(records, now);
    return { changed, keepAwake: keepAwakeNeeded(records, now) };
  })().finally(() => { scanPromise = null; });
  return scanPromise;
}

async function ensureRecoveryAlarm() {
  await chrome.alarms.create(RECOVERY_ALARM, { periodInMinutes: 0.5 });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "fabushi.userscript.recovery.request") {
    requestRecoveryCapability(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.recovery.release") {
    releaseRecoveryCapability(message, sender)
      .then((result) => sendResponse({ ok: true, ...result }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm?.name === RECOVERY_ALARM) void scanRecoveryRecords("alarm").catch(() => {});
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url && changeInfo.status !== "unloaded" && changeInfo.discarded !== true
    && !isCrashTitle(changeInfo.title) && !isCrashURL(tab?.url)) return;
  void scanRecoveryRecords("tab-updated").catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void (async () => {
    const records = await readRecords();
    let changed = false;
    for (const [ownerTabId, record] of Object.entries(records)) {
      if (Number(record?.tabId) !== tabId) continue;
      delete records[ownerTabId];
      changed = true;
    }
    if (changed) {
      await writeRecords(records);
      await syncKeepAwake(records);
    }
  })().catch(() => {});
});

chrome.runtime.onStartup?.addListener(() => {
  void Promise.all([ensureRecoveryAlarm(), scanRecoveryRecords("browser-startup")]).catch(() => {});
});

chrome.runtime.onInstalled?.addListener(() => {
  void Promise.all([ensureRecoveryAlarm(), scanRecoveryRecords("extension-installed")]).catch(() => {});
});

// Module evaluation is the MV3 service-worker start boundary. Reconcile
// immediately as well as through the 30-second alarm so lock/sleep protection
// is restored after worker eviction without waiting for a page message.
void Promise.all([ensureRecoveryAlarm(), scanRecoveryRecords("service-worker-start")]).catch(() => {});
