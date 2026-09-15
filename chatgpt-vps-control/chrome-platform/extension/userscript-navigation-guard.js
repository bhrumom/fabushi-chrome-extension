const STORAGE_KEY = "fabushi.userscriptNavigation.v1";
const CAPABILITY = "tab-navigation-guard";
const PLUGIN_ID = "chatgpt-auto-confirm";
const LEASE_MS = 45_000;
const NAVIGATION_COOLDOWN_MS = 30_000;
const NAVIGATION_WINDOW_MS = 5 * 60_000;
const NAVIGATION_BURST_LIMIT = 6;
const NAVIGATION_BREAK_MS = 60_000;
const IN_FLIGHT_TTL_MS = 20_000;
const CHATGPT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
const PATH_PATTERN = /^\/(?:c\/[^/?#]+)?$/;
const CRASH_TITLE_PATTERN = /(?:aw,? snap|崩溃啦|页面崩溃|页面崩溃啦|崩溃了)/i;

let memoryState = { tabs: {} };
let mutation = Promise.resolve();

function storageArea() {
  return chrome.storage?.session || chrome.storage?.local;
}

async function readState() {
  try {
    const result = await storageArea().get([STORAGE_KEY]);
    const value = result?.[STORAGE_KEY];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      memoryState = value;
    }
  } catch {
    // MV3 service workers may be between lifetimes; keep the bounded
    // in-memory state and let the next request reconcile it.
  }
  if (!memoryState.tabs || typeof memoryState.tabs !== "object" || Array.isArray(memoryState.tabs)) {
    memoryState = { tabs: {} };
  }
  return memoryState;
}

async function writeState(state) {
  memoryState = state;
  try { await storageArea().set({ [STORAGE_KEY]: state }); } catch {}
}

function serial(task) {
  const next = mutation.then(task, task);
  mutation = next.catch(() => {});
  return next;
}

function safeText(value, max = 240) {
  const text = String(value || "").trim().slice(0, max);
  return text && !/[\u0000-\u001f\u007f]/.test(text) ? text : "";
}

function chatGPTURL(value, { allowRecoveryHash = false } = {}) {
  try {
    const target = new URL(String(value || ""));
    if (target.protocol !== "https:" || !CHATGPT_HOSTS.has(target.hostname.toLowerCase())) return "";
    if (!PATH_PATTERN.test(target.pathname) || target.search) return "";
    if (target.hash && (!allowRecoveryHash || !/^#fabushi-resume=[^&]+$/.test(target.hash))) return "";
    return target.href;
  } catch {
    return "";
  }
}

function isCrashTab(tab) {
  return !tab
    || tab.discarded === true
    || tab.status === "unloaded"
    || /^chrome-error:\/\//i.test(String(tab.url || tab.pendingUrl || ""))
    || CRASH_TITLE_PATTERN.test(String(tab.title || ""));
}

function senderTab(sender) {
  const tabId = sender?.tab?.id;
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error("导航保护请求没有关联有效标签页。");
  const senderURL = chatGPTURL(sender?.tab?.url || sender?.tab?.pendingUrl);
  if (!senderURL) throw new Error("导航保护只允许由 ChatGPT 页面请求。");
  return { tabId, senderURL };
}

function normalizeRequest(message, sender, tab) {
  const { tabId } = senderTab(sender);
  const payload = message?.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
    ? message.payload
    : {};
  if (safeText(payload.capability, 64) !== CAPABILITY) throw new Error("未声明受支持的导航保护能力。");
  if (safeText(message?.pluginId, 64) !== PLUGIN_ID) throw new Error("导航保护插件身份无效。");
  const targetURL = chatGPTURL(payload.targetURL, { allowRecoveryHash: payload.recovery === true });
  if (!targetURL) throw new Error("导航保护请求缺少安全的 ChatGPT 目标地址。");
  const ownerTabId = safeText(payload.ownerTabId);
  const taskId = safeText(payload.taskId);
  if (!ownerTabId || !taskId) throw new Error("导航保护请求缺少工作区或任务身份。");
  return {
    tabId,
    ownerTabId,
    taskId,
    targetURL,
    phase:safeText(payload.phase, 40) || "work",
    round:Math.max(0, Math.min(100_000, Number(payload.round) || 0)),
    goalRevision:Math.max(0, Math.min(100_000, Number(payload.goalRevision) || 0)),
    reason:safeText(payload.reason, 80) || "route-switch",
    force:payload.force === true,
    recovery:payload.recovery === true,
    at:Date.now(),
    tabURL:String(tab?.url || tab?.pendingUrl || "").slice(0, 2000),
  };
}

function emptyRecord(tabId, now) {
  return {
    tabId,
    lastGrantedAt:0,
    lastCommittedAt:0,
    cooldownUntil:0,
    recent:[],
    inFlight:null,
    updatedAt:now,
  };
}

function pruneRecord(record, now) {
  const next = record && typeof record === "object" ? record : emptyRecord(0, now);
  next.recent = Array.isArray(next.recent)
    ? next.recent.map(value => Number(value)).filter(value => Number.isFinite(value)
      && now - value >= 0 && now - value < NAVIGATION_WINDOW_MS).slice(-NAVIGATION_BURST_LIMIT)
    : [];
  if (next.inFlight && now - Number(next.inFlight.at || 0) > IN_FLIGHT_TTL_MS) next.inFlight = null;
  if (Number(next.cooldownUntil || 0) <= now) next.cooldownUntil = 0;
  return next;
}

function deny(reason, retryAfterMs = 0) {
  return {
    granted:false,
    capability:CAPABILITY,
    reason:String(reason || "denied").slice(0, 120),
    retryAfterMs:Math.max(0, Math.min(NAVIGATION_BREAK_MS, Number(retryAfterMs) || 0)),
  };
}

async function requestNavigationGuard(message, sender) {
  return serial(async () => {
    const { tabId } = senderTab(sender);
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return deny("tab-unavailable", 15_000); }
    const request = normalizeRequest(message, sender, tab);
    if (isCrashTab(tab)) return deny("renderer-unavailable", 15_000);
    if (tab.status === "loading") return deny("page-loading", 10_000);

    const now = Date.now();
    const state = await readState();
    const key = String(tabId);
    const record = pruneRecord(state.tabs[key] || emptyRecord(tabId, now), now);
    const currentURL = chatGPTURL(tab.url || tab.pendingUrl, { allowRecoveryHash: request.recovery });
    if (currentURL === request.targetURL && !request.recovery) {
      record.lastCommittedAt = now;
      record.updatedAt = now;
      state.tabs[key] = record;
      await writeState(state);
      return { granted:true, capability:CAPABILITY, reason:"same-route", expiresAt:now + LEASE_MS, retryAfterMs:0 };
    }
    if (record.inFlight && now - Number(record.inFlight.at || 0) <= IN_FLIGHT_TTL_MS) {
      return deny("navigation-in-flight", Math.max(1_000, IN_FLIGHT_TTL_MS - (now - Number(record.inFlight.at || 0))));
    }

    const forced = request.force || request.recovery;
    if (!forced) {
      const cooldownUntil = Math.max(
        Number(record.cooldownUntil || 0),
        Number(record.lastGrantedAt || 0) + NAVIGATION_COOLDOWN_MS,
      );
      if (cooldownUntil > now) return deny("cooldown", cooldownUntil - now);
      if (record.recent.length >= NAVIGATION_BURST_LIMIT) {
        record.cooldownUntil = now + NAVIGATION_BREAK_MS;
        record.updatedAt = now;
        state.tabs[key] = record;
        await writeState(state);
        return deny("rotation-break", NAVIGATION_BREAK_MS);
      }
    }

    const leaseId = "fabushi-navigation-lease-" + crypto.randomUUID();
    record.tabId = tabId;
    record.updatedAt = now;
    record.inFlight = {
      leaseId,
      targetURL:request.targetURL,
      taskId:request.taskId,
      ownerTabId:request.ownerTabId,
      phase:request.phase,
      round:request.round,
      goalRevision:request.goalRevision,
      at:now,
      recovery:request.recovery,
    };
    state.tabs[key] = record;
    const entries = Object.entries(state.tabs)
      .filter(([, value]) => value && now - Number(value.updatedAt || 0) < NAVIGATION_WINDOW_MS * 2)
      .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
      .slice(0, 100);
    state.tabs = Object.fromEntries(entries);
    await writeState(state);
    return {
      granted:true,
      capability:CAPABILITY,
      leaseId,
      expiresAt:now + LEASE_MS,
      minIntervalMs:NAVIGATION_COOLDOWN_MS,
      reason:forced ? "forced" : "granted",
    };
  });
}

async function cancelNavigationGuard(message, sender) {
  return serial(async () => {
    const { tabId } = senderTab(sender);
    if (safeText(message?.pluginId, 64) !== PLUGIN_ID) throw new Error("导航保护插件身份无效。");
    const payload = message?.payload && typeof message.payload === "object" && !Array.isArray(message.payload)
      ? message.payload
      : {};
    if (safeText(payload.capability, 64) !== CAPABILITY) throw new Error("未声明受支持的导航保护能力。");
    const leaseId = safeText(payload.leaseId, 128);
    if (!leaseId) throw new Error("导航保护取消请求缺少 lease。");
    const state = await readState();
    const key = String(tabId);
    const record = pruneRecord(state.tabs[key] || emptyRecord(tabId, Date.now()), Date.now());
    if (record.inFlight?.leaseId === leaseId) {
      record.inFlight = null;
      record.updatedAt = Date.now();
      state.tabs[key] = record;
      await writeState(state);
      return { cancelled:true, capability:CAPABILITY, leaseId };
    }
    return { cancelled:false, capability:CAPABILITY, leaseId };
  });
}

async function noteTabUpdate(tabId, changeInfo, tab) {
  return serial(async () => {
    const state = await readState();
    const key = String(tabId);
    const record = state.tabs[key];
    if (!record) return;
    const now = Date.now();
    const next = pruneRecord(record, now);
    if (isCrashTab(tab) || /^chrome-error:\/\//i.test(String(changeInfo?.url || ""))) {
      next.inFlight = null;
      next.cooldownUntil = Math.max(Number(next.cooldownUntil || 0), now + NAVIGATION_BREAK_MS);
    } else {
      const currentURL = chatGPTURL(changeInfo?.url || tab?.url || tab?.pendingUrl, {
        allowRecoveryHash:next.inFlight?.recovery === true,
      });
      if (next.inFlight && currentURL === next.inFlight.targetURL) {
        // A grant is only a lease. Account for cooldown/burst limits after
        // Chrome confirms that the exact leased target route was committed.
        // If the userscript rejects a stale generation/ticket, its explicit
        // cancel (or the TTL) clears the lease without creating a phantom
        // 30-second cooldown.
        next.lastCommittedAt = now;
        next.lastGrantedAt = now;
        if (!next.inFlight.recovery) next.recent.push(now);
        next.inFlight = null;
      } else if (changeInfo?.status === "complete" && !next.inFlight) {
        next.lastCommittedAt = Math.max(Number(next.lastCommittedAt || 0), now);
      }
    }
    next.updatedAt = now;
    state.tabs[key] = next;
    await writeState(state);
  });
}

async function removeTabState(tabId) {
  return serial(async () => {
    const state = await readState();
    delete state.tabs[String(tabId)];
    await writeState(state);
  });
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const handler = message.type === "fabushi.userscript.navigation.request"
    ? requestNavigationGuard
    : message.type === "fabushi.userscript.navigation.cancel"
      ? cancelNavigationGuard
      : null;
  if (!handler) return false;
  handler(message, sender)
    .then(result => sendResponse({ ok:true, ...result }))
    .catch(error => sendResponse({ ok:false, error:error?.message || String(error), ...deny("invalid-request") }));
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo?.url && !changeInfo?.status && changeInfo?.discarded !== true
    && !changeInfo?.title && !isCrashTab(tab)) return;
  void noteTabUpdate(tabId, changeInfo, tab).catch(() => {});
});

chrome.tabs.onRemoved.addListener(tabId => {
  void removeTabState(tabId).catch(() => {});
});
