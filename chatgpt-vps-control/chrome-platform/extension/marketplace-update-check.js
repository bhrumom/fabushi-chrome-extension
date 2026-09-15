import {
  compareMarketplaceVersions,
  marketplaceInstallContract,
  marketplaceItemId,
  marketplaceItemVersion,
  marketplaceReleaseManifest,
  marketplaceUserscriptArtifact,
} from "./marketplace-install.js";

export const MARKETPLACE_UPDATE_STORAGE_KEY = "fabushi.marketplace-updates.v1";
export const MARKETPLACE_UPDATE_ALARM = "fabushi-marketplace-update-check";
export const MARKETPLACE_UPDATE_PERIOD_MINUTES = 30;
export const MARKETPLACE_UPDATE_API_URL = "https://api.ombhrum.com/v1/marketplace/plugins?platform=chrome-extension";

const USERSCRIPT_STORAGE_KEY = "fabushi.userscripts.v1";
const BUNDLED_STATE_KEY = "fabushi.bundled-chatgpt-auto-confirm.enabled";
const BUNDLED_PLUGIN_ID = "chatgpt-auto-confirm";
const BUNDLED_USERSCRIPT_PATH = "userscript/chatgpt-auto-confirm.user.js";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_UPDATE_COUNT = 32;
let checkPromise = null;

function marketplaceItems(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["items", "plugins", "results", "entries"]) {
    if (Array.isArray(result?.[key])) return result[key];
  }
  return [];
}

function itemArtifacts(item) {
  const contract = marketplaceInstallContract(item);
  const release = marketplaceReleaseManifest(item);
  return [
    ...(Array.isArray(contract?.artifacts) ? contract.artifacts : []),
    ...(Array.isArray(release?.artifacts) ? release.artifacts : []),
  ];
}

function itemDigest(item) {
  const artifact = marketplaceUserscriptArtifact(item)
    || itemArtifacts(item).find((candidate) => candidate?.sha256 || candidate?.artifactSha256);
  return String(artifact?.sha256 || artifact?.artifactSha256 || "").trim().toLowerCase();
}

function installedPluginId(record) {
  return String(record?.sourcePluginId || record?.pluginId || record?.id || "").trim();
}

function installedVersion(record) {
  return String(record?.sourcePluginVersion || record?.version || "").trim();
}

function installedDigest(record) {
  return String(record?.sourceArtifactSha256 || record?.artifactSha256 || record?.sha256 || "")
    .trim()
    .toLowerCase();
}

function normalizeStatus(status = {}) {
  return {
    schemaVersion: 1,
    checkedAt: Number(status.checkedAt) || 0,
    reason: String(status.reason || "").slice(0, 80),
    error: String(status.error || "").slice(0, 240),
    updates: Array.isArray(status.updates) ? status.updates.slice(0, MAX_UPDATE_COUNT) : [],
  };
}

/**
 * Compare a Marketplace response with the records installed in this
 * extension. This pure function is shared by the service worker and tests so
 * update detection cannot silently diverge between background and UI paths.
 */
export function marketplaceUpdateCandidates(items, records) {
  const installedByPlugin = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const pluginId = installedPluginId(record);
    if (pluginId) installedByPlugin.set(pluginId, record);
  }
  const updates = [];
  for (const item of marketplaceItems(items)) {
    const pluginId = marketplaceItemId(item);
    const record = installedByPlugin.get(pluginId);
    if (!pluginId || !record) continue;
    const latestVersion = marketplaceItemVersion(item);
    const currentVersion = installedVersion(record);
    if (!latestVersion || !currentVersion) continue;
    const comparison = compareMarketplaceVersions(latestVersion, currentVersion);
    const expectedDigest = itemDigest(item);
    const currentDigest = installedDigest(record);
    const versionUpdate = comparison > 0;
    const artifactUpdate = comparison === 0
      && Boolean(expectedDigest && currentDigest && expectedDigest !== currentDigest);
    if (!versionUpdate && !artifactUpdate) continue;
    updates.push({
      pluginId,
      displayName: String(item.displayName || item.name || item.title || pluginId).slice(0, 160),
      installedVersion: currentVersion,
      latestVersion,
      sourceRef: String(
        item.install?.source?.sourceRef
          || item.source?.sourceRef
          || marketplaceReleaseManifest(item)?.source?.sourceRef
          || "",
      ).slice(0, 80),
      artifactSha256: expectedDigest,
      reason: versionUpdate ? "version" : "artifact-digest",
    });
  }
  return updates.slice(0, MAX_UPDATE_COUNT);
}

async function readStoredStatus() {
  try {
    const result = await chrome.storage.local.get(MARKETPLACE_UPDATE_STORAGE_KEY);
    return normalizeStatus(result?.[MARKETPLACE_UPDATE_STORAGE_KEY]);
  } catch {
    return normalizeStatus();
  }
}

async function readBundledVersion() {
  try {
    const url = `${chrome.runtime.getURL(BUNDLED_USERSCRIPT_PATH)}?update=${Date.now()}`;
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) return "";
    const source = await response.text();
    return String(source.match(/^\s*\/\/\s*@version\s+([^\s]+)/im)?.[1] || "").trim();
  } catch {
    return "";
  }
}

async function readInstalledRecords() {
  try {
    const result = await chrome.storage.local.get([USERSCRIPT_STORAGE_KEY, BUNDLED_STATE_KEY]);
    const records = Array.isArray(result?.[USERSCRIPT_STORAGE_KEY])
      ? result[USERSCRIPT_STORAGE_KEY].filter((item) => item && typeof item === "object")
      : [];
    if (!records.some((record) => installedPluginId(record) === BUNDLED_PLUGIN_ID)
      && result?.[BUNDLED_STATE_KEY] !== false) {
      const version = await readBundledVersion();
      if (version) records.push({ sourcePluginId: BUNDLED_PLUGIN_ID, version, sourcePluginVersion: version });
    }
    return records;
  } catch {
    return [];
  }
}

async function fetchMarketplaceItems() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(MARKETPLACE_UPDATE_API_URL, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Marketplace 请求失败（${response.status}）。`);
    return marketplaceItems(await response.json());
  } finally {
    clearTimeout(timer);
  }
}

async function sendStatusToOpenViews(status) {
  try {
    await chrome.runtime.sendMessage({ type: "fabushi.marketplace.updates", status });
  } catch {
    // The popup is normally closed while an alarm runs. No receiver is an
    // expected state, not a failed update check.
  }
}

export async function applyMarketplaceUpdateBadge(updates) {
  if (typeof chrome === "undefined" || !chrome.action) return;
  const count = Array.isArray(updates) ? updates.length : 0;
  try { await chrome.action.setBadgeText({ text: count ? String(Math.min(count, 9)) : "" }); } catch {}
  try { await chrome.action.setBadgeBackgroundColor({ color: count ? "#b45309" : "#6b7280" }); } catch {}
  try {
    await chrome.action.setTitle({
      title: count ? `Fabushi：发现 ${count} 个 Marketplace 更新` : "Fabushi：已自动检查 Marketplace",
    });
  } catch {}
}

export async function checkMarketplaceUpdates({ reason = "alarm" } = {}) {
  if (checkPromise) return checkPromise;
  checkPromise = (async () => {
    const previous = await readStoredStatus();
    try {
      const [items, records] = await Promise.all([fetchMarketplaceItems(), readInstalledRecords()]);
      const status = normalizeStatus({
        checkedAt: Date.now(),
        reason,
        updates: marketplaceUpdateCandidates(items, records),
      });
      await chrome.storage.local.set({ [MARKETPLACE_UPDATE_STORAGE_KEY]: status });
      await applyMarketplaceUpdateBadge(status.updates);
      await sendStatusToOpenViews(status);
      return status;
    } catch (error) {
      const status = normalizeStatus({
        ...previous,
        checkedAt: Date.now(),
        reason,
        error: error?.message || String(error),
      });
      try { await chrome.storage.local.set({ [MARKETPLACE_UPDATE_STORAGE_KEY]: status }); } catch {}
      await applyMarketplaceUpdateBadge(status.updates);
      await sendStatusToOpenViews(status);
      return status;
    } finally {
      checkPromise = null;
    }
  })();
  return checkPromise;
}

export async function getMarketplaceUpdateStatus() {
  return readStoredStatus();
}

function scheduleMarketplaceUpdateAlarm() {
  if (typeof chrome === "undefined" || !chrome.alarms) return;
  try {
    void chrome.alarms.create(MARKETPLACE_UPDATE_ALARM, {
      periodInMinutes: MARKETPLACE_UPDATE_PERIOD_MINUTES,
    });
  } catch {}
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.alarms) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "fabushi.marketplace.update.status") {
      getMarketplaceUpdateStatus().then((status) => sendResponse({ ok: true, status }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    if (message?.type === "fabushi.marketplace.update.check") {
      checkMarketplaceUpdates({ reason: "popup" }).then((status) => sendResponse({ ok: true, status }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
      return true;
    }
    return false;
  });

  chrome.runtime.onInstalled.addListener(() => {
    scheduleMarketplaceUpdateAlarm();
    void checkMarketplaceUpdates({ reason: "installed" });
  });
  chrome.runtime.onStartup.addListener(() => {
    scheduleMarketplaceUpdateAlarm();
    void checkMarketplaceUpdates({ reason: "startup" });
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm?.name === MARKETPLACE_UPDATE_ALARM) void checkMarketplaceUpdates({ reason: "alarm" });
  });
  scheduleMarketplaceUpdateAlarm();
}
