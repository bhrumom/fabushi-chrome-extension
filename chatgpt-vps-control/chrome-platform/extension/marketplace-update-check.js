import { normalizeUserScript } from "./userscript-core.js";
import { installUserScript, loadRemoteRecord, readRecords } from "./userscript-runner.js";
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

const BUNDLED_PLUGIN_ID = "chatgpt-auto-confirm";
const REQUEST_TIMEOUT_MS = 8_000;
const MAX_REMOTE_USERSCRIPT_BYTES = 2 * 1024 * 1024;
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
  // `version` comes from the script metadata and is authoritative. Older
  // records may have a stale sourcePluginVersion copied from the catalog.
  return String(record?.version || record?.sourcePluginVersion || "").trim();
}

function installedDigest(record) {
  return String(record?.sourceArtifactSha256 || record?.artifactSha256 || record?.sha256 || "")
    .trim()
    .toLowerCase();
}

function normalizeStatus(status = {}) {
  return {
    schemaVersion: 2,
    checkedAt: Number(status.checkedAt) || 0,
    reason: String(status.reason || "").slice(0, 80),
    error: String(status.error || "").slice(0, 240),
    updates: Array.isArray(status.updates) ? status.updates.slice(0, MAX_UPDATE_COUNT) : [],
    applied: Array.isArray(status.applied) ? status.applied.slice(0, MAX_UPDATE_COUNT) : [],
  };
}

function repositoryParts(value) {
  try {
    const url = new URL(String(value || "").trim());
    const parts = url.pathname.split("/").filter(Boolean);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "github.com"
      || parts.length !== 2 || url.username || url.password || url.port || url.search || url.hash) return null;
    return parts;
  } catch {
    return null;
  }
}

function itemRepository(item) {
  return marketplaceInstallContract(item)?.source?.repository
    || item?.source?.repository
    || marketplaceReleaseManifest(item)?.source?.repository
    || "";
}

function itemUpdateURL(item) {
  const contract = marketplaceInstallContract(item);
  const declared = contract?.update?.updateURL
    || contract?.update?.url
    || contract?.updateURL
    || item?.updateURL
    || item?.source?.updateURL
    || marketplaceReleaseManifest(item)?.updateURL;
  if (declared) return String(declared).trim();

  // Backward-compatible migration for the old catalog contract: derive one
  // stable branch URL from the original commit-pinned raw artifact. This is
  // used only to bootstrap the updater; future releases do not touch catalog
  // metadata as long as the path remains the same.
  const artifactURL = String(marketplaceUserscriptArtifact(item)?.source?.url || "").trim();
  try {
    const url = new URL(artifactURL);
    const parts = url.pathname.split("/").filter(Boolean);
    const repository = repositoryParts(itemRepository(item));
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "raw.githubusercontent.com"
      || parts.length < 4 || !repository || parts[0] !== repository[0] || parts[1] !== repository[1]) return "";
    return `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/main/${parts.slice(3).join("/")}`;
  } catch {
    return "";
  }
}

function trustedUpdateURL(value, item, record) {
  let url;
  try {
    url = new URL(String(value || "").trim());
  } catch {
    return "";
  }
  if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "raw.githubusercontent.com"
    || url.username || url.password || url.port || url.hash) return "";
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts.length < 4) return "";
  const repository = repositoryParts(itemRepository(item) || record?.sourceRepository);
  if (repository && (parts[0] !== repository[0] || parts[1] !== repository[1])) return "";
  return url.toString();
}

function cacheBustedURL(value) {
  const url = new URL(value);
  url.searchParams.set("fabushi_update", String(Date.now()));
  return url.toString();
}

function isUserScriptSource(item) {
  return Boolean(marketplaceUserscriptArtifact(item)
    || item?.runtime === "userscript"
    || item?.kind === "userscript"
    || item?.surfaces?.some?.((surface) => surface?.kind === "userscript" || surface?.id === "userscript"));
}

function metadataOnly(source) {
  const normalized = String(source || "");
  const end = normalized.search(/==\/UserScript==/i);
  return end >= 0 && !normalized.slice(end + "==/UserScript==".length).trim();
}

async function sha256Text(source) {
  const bytes = new TextEncoder().encode(String(source || ""));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchRemoteUserscript(url, item, record) {
  const trusted = trustedUpdateURL(url, item, record);
  if (!trusted) throw new Error("用户脚本更新地址不是同一公开 GitHub 仓库的 HTTPS raw 地址。");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(cacheBustedURL(trusted), {
      headers: { Accept: "text/javascript, text/plain" },
      cache: "no-store",
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`用户脚本更新地址读取失败（${response.status}）。`);
    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_REMOTE_USERSCRIPT_BYTES) {
      throw new Error("远程用户脚本超过 2 MiB 大小限制。");
    }
    const bytes = await response.arrayBuffer();
    if (bytes.byteLength > MAX_REMOTE_USERSCRIPT_BYTES) throw new Error("远程用户脚本超过 2 MiB 大小限制。");
    return new TextDecoder().decode(bytes);
  } finally {
    clearTimeout(timer);
  }
}

function candidateFromMetadata(item, record, remote, updateURL, downloadURL, source) {
  const currentVersion = installedVersion(record);
  if (!currentVersion || !remote?.version || compareMarketplaceVersions(remote.version, currentVersion) <= 0) return null;
  if (record?.name && remote.name !== record.name) throw new Error("更新脚本名称与本地脚本不一致。");
  if (record?.namespace && remote.namespace !== record.namespace) throw new Error("更新脚本命名空间与本地脚本不一致。");
  return {
    pluginId: installedPluginId(record) || marketplaceItemId(item) || remote.id,
    displayName: String(item?.displayName || item?.name || item?.title || remote.name || installedPluginId(record) || "用户脚本").slice(0, 160),
    installedVersion: currentVersion,
    latestVersion: remote.version,
    updateURL,
    downloadURL,
    source,
    sourceRepository: itemRepository(item) || record?.sourceRepository || "",
    sourceRef: String(record?.sourceRef || marketplaceInstallContract(item)?.source?.sourceRef || "").slice(0, 80),
    reason: "update-url",
  };
}

/**
 * Pure comparison used by the background checker and contract tests. The
 * Marketplace catalog is not involved in the version decision for a script
 * that declares an update URL.
 */
export function userscriptUpdateCandidate(item, record, remote, details = {}) {
  return candidateFromMetadata(
    item,
    record,
    remote,
    String(details.updateURL || remote?.updateURL || record?.updateURL || "").trim(),
    String(details.downloadURL || remote?.downloadURL || record?.downloadURL || "").trim(),
    details.source || remote?.source || "",
  );
}

/**
 * Compare a Marketplace response with the records installed in this
 * extension. Package updates retain the catalog contract; userscript updates
 * are additionally checked against their own @updateURL in the async path.
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

async function readInstalledRecords() {
  try {
    const records = await readRecords();
    if (records.some((record) => installedPluginId(record) === BUNDLED_PLUGIN_ID)) return records;
    const remoteRecord = await loadRemoteRecord();
    return [...records, remoteRecord];
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

async function findUserscriptUpdate(item, record) {
  const updateURL = trustedUpdateURL(record?.updateURL || itemUpdateURL(item), item, record);
  if (!updateURL) return null;
  const metadataSource = await fetchRemoteUserscript(updateURL, item, record);
  let remote = normalizeUserScript(metadataSource, {
    sourcePluginId: record?.sourcePluginId || marketplaceItemId(item),
    sourceRepository: itemRepository(item) || record?.sourceRepository,
    sourceRef: record?.sourceRef || marketplaceInstallContract(item)?.source?.sourceRef,
    updateURL,
    downloadURL: record?.downloadURL,
  });
  let source = metadataSource;
  let downloadURL = trustedUpdateURL(remote.downloadURL || record?.downloadURL || updateURL, item, record);
  if (!downloadURL) throw new Error("用户脚本 @downloadURL 不是同一公开 GitHub 仓库的 HTTPS raw 地址。");
  if (metadataOnly(metadataSource)) {
    source = await fetchRemoteUserscript(downloadURL, item, record);
    remote = normalizeUserScript(source, {
      sourcePluginId: record?.sourcePluginId || marketplaceItemId(item),
      sourceRepository: itemRepository(item) || record?.sourceRepository,
      sourceRef: record?.sourceRef || marketplaceInstallContract(item)?.source?.sourceRef,
      updateURL,
      downloadURL,
    });
  }
  const candidate = userscriptUpdateCandidate(item, record, remote, {
    updateURL,
    downloadURL,
    source,
  });
  if (!candidate) return null;
  candidate.sha256 = await sha256Text(source);
  candidate.remote = remote;
  return candidate;
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
      // A userscript already has its own update URL. Keep that path usable
      // even when the Marketplace projection is temporarily unavailable;
      // only catalog-driven package updates depend on this request.
      const [catalog, records] = await Promise.all([
        fetchMarketplaceItems().then((items) => ({ items, error: null }))
          .catch((error) => ({ items: [], error })),
        readInstalledRecords(),
      ]);
      const items = catalog.items;
      const packageUpdates = marketplaceUpdateCandidates(items, records);
      const applied = [];
      const pendingUserscriptUpdates = [];
      const errors = catalog.error ? [catalog.error?.message || String(catalog.error)] : [];
      const itemByPlugin = new Map(items.map((item) => [marketplaceItemId(item), item]));
      for (const record of records) {
        const item = itemByPlugin.get(installedPluginId(record));
        if (item && !isUserScriptSource(item) && !record.updateURL) continue;
        try {
          const candidate = await findUserscriptUpdate(item, record);
          if (!candidate) continue;
          await installUserScript({
            id: record.id,
            source: candidate.source,
            sourcePluginId: record.sourcePluginId || (item ? candidate.pluginId : undefined),
            sourcePluginVersion: candidate.latestVersion,
            sourceRepository: candidate.sourceRepository,
            sourceRef: candidate.sourceRef,
            sourceArtifactSha256: candidate.sha256,
            sourceURL: candidate.downloadURL,
            updateURL: candidate.updateURL,
            downloadURL: candidate.downloadURL,
            commands: record.commands,
            enabled: record.enabled !== false,
            installedAt: record.installedAt,
          });
          applied.push({
            pluginId: candidate.pluginId,
            displayName: candidate.displayName,
            installedVersion: candidate.installedVersion,
            latestVersion: candidate.latestVersion,
            reason: candidate.reason,
          });
        } catch (error) {
          errors.push(error?.message || String(error));
          const updateURL = itemUpdateURL(item) || record.updateURL || "";
          pendingUserscriptUpdates.push({
            pluginId: installedPluginId(record) || marketplaceItemId(item),
            displayName: String(item?.displayName || item?.name || record?.name || "用户脚本").slice(0, 160),
            installedVersion: installedVersion(record),
            latestVersion: "更新地址检查失败",
            updateURL,
            reason: "update-error",
          });
        }
      }
      const appliedIds = new Set(applied.map((item) => item.pluginId));
      const updates = [...packageUpdates, ...pendingUserscriptUpdates]
        .filter((item) => !appliedIds.has(item.pluginId))
        .slice(0, MAX_UPDATE_COUNT);
      const status = normalizeStatus({
        checkedAt: Date.now(),
        reason,
        error: errors[0] || "",
        updates,
        applied,
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
