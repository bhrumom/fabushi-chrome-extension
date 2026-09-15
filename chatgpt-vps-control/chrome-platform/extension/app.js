import {
  compareMarketplaceVersions as compareVersions,
  marketplaceItemId,
  marketplaceInstallAction,
  marketplaceInstalledVersion,
  marketplaceInstallContract,
  marketplaceItemInstallable,
  marketplaceItemKind,
  marketplaceItemVersion,
  marketplaceReleaseManifest,
  marketplaceUserscriptArtifact,
} from "./marketplace-install.js";

const views = ["chats", "miniapps", "marketplace", "browser", "settings"];
const labels = { chats: "聊天", miniapps: "小程序", marketplace: "Marketplace", browser: "浏览器", settings: "设置" };
const BUNDLED_USERSCRIPT_PATH = "userscript/chatgpt-auto-confirm.user.js";
const MARKETPLACE_API_ROOT = "https://api.ombhrum.com";
const MARKETPLACE_USERSCRIPT_REPOSITORY = "https://github.com/bhrumom/fabushi-chatgpt-auto-confirm-userscript";
const MARKETPLACE_USERSCRIPT_COMMIT = "480ebe61ba039f15e7023bbc0253ea23c373aba0";
const MARKETPLACE_USERSCRIPT_SHA256 = "d15040a5d420b0fa4cc38b195f178143a2d22a166e3357f88c7159c6b7a3b14a";
const MARKETPLACE_USERSCRIPT_SIZE = 224113;
const MARKETPLACE_TASK_QUEUE_REPOSITORY = "https://github.com/bhrumom/fabushi";
const MARKETPLACE_TASK_QUEUE_COMMIT = "a9d0b883c68dd45c14f9966ab79656bcf43c4d0e";
const MARKETPLACE_TASK_QUEUE_SHA256 = "38bec5437d9a2ad3d04c4e138b2cf681fb788932b133696744ffdf05e4d45b38";
const MARKETPLACE_TASK_QUEUE_SIZE = 13314;
const MAX_REMOTE_USERSCRIPT_BYTES = 2 * 1024 * 1024;
const MARKETPLACE_AUTO_REFRESH_MS = 5 * 60 * 1000;
const state = {
  view: "chats",
  desktopConnected: false,
  auth: { loggedIn: false },
  browserAccount: { loggedIn: false, connected: false },
  conversations: [],
  activeConversationId: "",
  messages: new Map(),
  installed: [],
  userscripts: [],
  marketplace: [],
  marketplaceUpdate: { checkedAt: 0, updates: [], error: "" },
  marketplaceAutoRefreshTimer: null,
  marketplaceRequestId: 0,
  userscriptsLoaded: false,
  // Standalone Chrome has no desktop package list; an empty list is a valid
  // loaded state. A later Native Messaging connection replaces it with the
  // Host-owned installed package list.
  installedLoaded: true,
  browser: { connected: false, tabs: [] },
};

const $ = (selector) => document.querySelector(selector);
const navButtons = [...document.querySelectorAll("[data-view]")];
const loading = $("#loading");
const banner = $("#banner");
const desktopState = $("#desktop-state");
const accountName = $("#account-name");
const accountDetail = $("#account-detail");
const accountAvatar = $("#account-avatar");
const search = $("#search");

function runtimeMessage(message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Chrome 消息超时：${String(message?.type || "request")}`));
    }, Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 120_000)));
    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };
    try {
      chrome.runtime.sendMessage(message, finish((response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message));
        else resolve(response);
      }));
    } catch (error) {
      finish(reject)(error);
    }
  });
}

async function desktopRequest(method, params = {}, timeoutMs) {
  const response = await runtimeMessage({ type: "fabushi.platform.request", method, params, timeoutMs });
  if (!response?.ok) throw new Error(response?.error || `Desktop request failed: ${method}`);
  return response.result;
}

function requestId(prefix) {
  return `${prefix}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
}

function showBanner(message, kind = "warning") {
  banner.textContent = message;
  banner.className = `banner${kind === "error" ? " error" : ""}`;
  banner.hidden = false;
}

function hideBanner() {
  banner.hidden = true;
  banner.textContent = "";
}

function setDesktopConnection(connected, error = "") {
  state.desktopConnected = connected;
  desktopState.classList.toggle("connected", connected);
  desktopState.classList.toggle("error", false);
  desktopState.querySelector("strong").textContent = connected ? "桌面增强已连接" : "插件独立运行中";
  desktopState.querySelector("span:last-child").textContent = connected
    ? "可选共享 Fabushi 账户；GitHub 包由 Host 校验安装"
    : "油猴脚本可独立运行；GitHub 小程序包需要 Host 安装";
  desktopState.title = connected ? "桌面端为可选增强能力" : (error || "Chrome 本地运行器已就绪");
}

function setAuth(auth) {
  state.auth = auth && typeof auth === "object" ? auth : { loggedIn: false };
  const user = state.auth.user || {};
  const label = user.nickname || user.username || user.email || "Fabushi";
  accountName.textContent = label;
  accountDetail.textContent = state.auth.loggedIn
    ? `${state.auth.provider || "Fabushi"} · 桌面会话`
    : state.auth.deferred ? "桌面增强已连接 · 首次授权时读取" : "独立模式 · 本地脚本运行器";
  accountAvatar.textContent = String(label).trim().slice(0, 1).toUpperCase() || "F";
  $("#settings-auth").textContent = state.auth.loggedIn ? "已登录" : "可选";
}

function setBrowserAccount(status) {
  state.browserAccount = status && typeof status === "object" ? status : { loggedIn: false, connected: false };
  const loggedIn = Boolean(state.browserAccount.loggedIn);
  const connected = Boolean(state.browserAccount.connected);
  const loggingIn = Boolean(state.browserAccount.loggingIn);
  const label = state.browserAccount.account?.user?.nickname || state.browserAccount.account?.user?.username || state.browserAccount.account?.user?.email || "Fabushi";
  $("#browser-account-detail").textContent = loggedIn
    ? `${label} · ${connected ? "已连接官方 MCP" : "正在连接官方 MCP"}`
    : (state.browserAccount.error || "登录后，官方 MCP 只会发现同一账号下的这个 Chrome。");
  $("#browser-account-action").textContent = loggedIn ? "退出登录" : (loggingIn ? "等待登录" : "登录 Fabushi");
  $("#settings-browser").textContent = connected ? "已直连" : (loggedIn ? "连接中" : "需登录");
  if (loggedIn) setAuth(state.browserAccount.account);
  else if (!state.desktopConnected) setAuth({ loggedIn: false, standalone: true });
}

async function refreshBrowserAccount() {
  setBrowserAccount(await runtimeMessage({ type: "fabushi.account.status" }));
}

function activateView(name) {
  if (!views.includes(name)) return;
  state.view = name;
  $("#view-title").textContent = labels[name];
  for (const button of navButtons) button.toggleAttribute("aria-current", button.dataset.view === name);
  for (const view of views) $(`#${view}-view`).hidden = view !== name;
  search.placeholder = name === "marketplace" ? "搜索 Marketplace" : name === "chats" ? "搜索聊天" : "搜索 Fabushi";
  if (name === "marketplace") {
    void refreshMarketplace(search.value);
    void refreshMarketplaceUpdateStatus({ check: true });
  }
  if (name === "miniapps") void refreshInstalled();
  if (name === "browser") void refreshBrowser();
}

function conversationSubtitle(item) {
  const unread = Number(item.unreadCount || 0);
  const kind = item.kind || "conversation";
  return unread > 0 ? `${kind} · ${unread} 条未读` : kind;
}

function renderConversations(query = "") {
  const needle = query.trim().toLowerCase();
  const list = $("#chat-list");
  list.replaceChildren();
  const filtered = state.conversations.filter((item) => !needle || `${item.title} ${item.kind || ""}`.toLowerCase().includes(needle));
  $("#chat-count").textContent = String(filtered.length);
  for (const item of filtered) {
    const button = document.createElement("button");
    button.type = "button";
    button.classList.toggle("active", item.id === state.activeConversationId);
    const title = document.createElement("strong");
    title.textContent = item.title || "未命名对话";
    const subtitle = document.createElement("span");
    subtitle.textContent = conversationSubtitle(item);
    button.append(title, subtitle);
    button.addEventListener("click", () => void openConversation(item));
    list.append(button);
  }
  if (!filtered.length) {
    const empty = document.createElement("div");
    empty.className = "empty compact";
    empty.innerHTML = "<p>没有匹配的聊天。</p>";
    list.append(empty);
  }
}

function renderMessages() {
  const container = $("#messages");
  container.replaceChildren();
  const messages = state.messages.get(state.activeConversationId) || [];
  for (const message of messages) {
    const node = document.createElement("div");
    node.className = `message${message.role === "user" ? " me" : ""}`;
    node.textContent = message.text || "";
    container.append(node);
  }
  container.scrollTop = container.scrollHeight;
}

async function openConversation(item) {
  state.activeConversationId = item.id;
  renderConversations(search.value);
  $("#conversation-empty").hidden = true;
  $("#conversation").hidden = false;
  $("#conversation-title").textContent = item.title || "聊天";
  renderMessages();
  await desktopRequest("feature.execute", { command: { type: "conversation.open", requestId: requestId("conversation-open"), conversationId: item.id } });
}

function appendMessage(conversationId, message) {
  const id = conversationId || state.activeConversationId || "new";
  const current = state.messages.get(id) || [];
  current.push(message);
  state.messages.set(id, current.slice(-240));
  if (id === state.activeConversationId || (!state.activeConversationId && id === "new")) renderMessages();
}

function handlePlatformEvent(event) {
  if (!event || typeof event !== "object") return;
  if (event.type === "conversation.listed" && Array.isArray(event.conversations)) {
    state.conversations = event.conversations;
    renderConversations(state.view === "chats" ? search.value : "");
    return;
  }
  if (event.type === "conversation.opened") {
    if (event.conversationId) state.activeConversationId = event.conversationId;
    if (Array.isArray(event.messages) && event.conversationId) state.messages.set(event.conversationId, event.messages.map((message) => ({ role: message.role, text: message.text || message.content || "" })));
    renderMessages();
    return;
  }
  if (event.type === "chat.message") {
    appendMessage(state.activeConversationId, { role: event.role, text: event.text || "" });
    return;
  }
  if (event.type === "chat.delta") {
    const id = state.activeConversationId || "new";
    const current = state.messages.get(id) || [];
    const last = current.at(-1);
    if (last?.role === "assistant" && last.streaming) last.text += event.delta || "";
    else current.push({ role: "assistant", text: event.delta || "", streaming: true });
    state.messages.set(id, current);
    renderMessages();
    return;
  }
  if (["operation.completed", "operation.failed", "operation.interrupted"].includes(event.type)) {
    const id = state.activeConversationId || "new";
    const current = state.messages.get(id) || [];
    if (current.at(-1)?.streaming) current.at(-1).streaming = false;
    renderMessages();
  }
}

function marketplaceItems(result) {
  if (Array.isArray(result)) return result;
  for (const key of ["items", "plugins", "results", "entries"]) if (Array.isArray(result?.[key])) return result[key];
  return [];
}

const BUILTIN_MARKETPLACE_ITEM = {
  pluginId: "chatgpt-auto-confirm",
  displayName: "ChatGPT 自动确认",
  description: "独立运行于 ChatGPT 网页的自动确认、对话和可恢复任务队列控制台，不依赖 Fabushi 桌面端。",
  // Keep a signed local compatibility copy while the remote catalogue is
  // unavailable. The install/update path below uses the pinned GitHub release.
  latestVersion: "2.9.30",
  bundledFallback: true,
  platforms: ["desktop", "cli", "chrome-extension"],
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  releaseStatus: "approved",
  installMode: "package",
  source: {
    provider: "github",
    repository: MARKETPLACE_USERSCRIPT_REPOSITORY,
    sourceRef: MARKETPLACE_USERSCRIPT_COMMIT,
    releaseUrl: `${MARKETPLACE_USERSCRIPT_REPOSITORY}/releases/tag/v2.9.30`,
    surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT 网页油猴脚本", entry: "userscript/chatgpt-auto-confirm.user.js", platforms: ["chrome-extension"] }],
    commands: [],
  },
  surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT 网页油猴脚本", entry: "userscript/chatgpt-auto-confirm.user.js", platforms: ["chrome-extension"] }],
  commands: [],
  permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
  install: {
    protocol: "fabushi.marketplace.install.v1",
    strategy: "github-immutable",
    pluginId: "chatgpt-auto-confirm",
    version: "2.9.30",
    source: {
      provider: "github",
      repository: MARKETPLACE_USERSCRIPT_REPOSITORY,
      sourceRef: MARKETPLACE_USERSCRIPT_COMMIT,
      releaseUrl: `${MARKETPLACE_USERSCRIPT_REPOSITORY}/releases/tag/v2.9.30`,
      marketplaceHostsPackage: false,
    },
    artifacts: [{
      id: "chatgpt-auto-confirm-userscript",
      runtime: "userscript",
      platforms: ["chrome-extension"],
      source: {
        type: "https",
        url: `https://raw.githubusercontent.com/bhrumom/fabushi-chatgpt-auto-confirm-userscript/${MARKETPLACE_USERSCRIPT_COMMIT}/chatgpt-auto-confirm.user.js`,
      },
      sha256: MARKETPLACE_USERSCRIPT_SHA256,
      size: MARKETPLACE_USERSCRIPT_SIZE,
      format: "user-js",
      entry: "chatgpt-auto-confirm.user.js",
    }],
    update: {
      check: "marketplace-release",
      comparison: "version-then-artifact-sha256",
      allowDowngrade: false,
      rollback: "previous-active",
    },
    permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
  },
  releaseManifest: {
    schemaVersion: 1,
    protocol: "mahayana.external-release.v1",
    pluginId: "chatgpt-auto-confirm",
    version: "2.9.30",
    runtimeForm: "userscript",
    permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
    artifacts: [{
      id: "chatgpt-auto-confirm-userscript",
      runtime: "userscript",
      platforms: ["chrome-extension"],
      source: {
        type: "https",
        url: `https://raw.githubusercontent.com/bhrumom/fabushi-chatgpt-auto-confirm-userscript/${MARKETPLACE_USERSCRIPT_COMMIT}/chatgpt-auto-confirm.user.js`,
      },
      sha256: MARKETPLACE_USERSCRIPT_SHA256,
      size: MARKETPLACE_USERSCRIPT_SIZE,
      format: "user-js",
      entry: "chatgpt-auto-confirm.user.js",
    }],
    install: {
      protocol: "fabushi.marketplace.install.v1",
      strategy: "github-immutable",
      pluginId: "chatgpt-auto-confirm",
      version: "2.9.30",
      source: {
        provider: "github",
        repository: MARKETPLACE_USERSCRIPT_REPOSITORY,
        sourceRef: MARKETPLACE_USERSCRIPT_COMMIT,
        releaseUrl: `${MARKETPLACE_USERSCRIPT_REPOSITORY}/releases/tag/v2.9.30`,
        marketplaceHostsPackage: false,
      },
      artifacts: [{
        id: "chatgpt-auto-confirm-userscript",
        runtime: "userscript",
        platforms: ["chrome-extension"],
        source: {
          type: "https",
          url: `https://raw.githubusercontent.com/bhrumom/fabushi-chatgpt-auto-confirm-userscript/${MARKETPLACE_USERSCRIPT_COMMIT}/chatgpt-auto-confirm.user.js`,
        },
        sha256: MARKETPLACE_USERSCRIPT_SHA256,
        size: MARKETPLACE_USERSCRIPT_SIZE,
        format: "user-js",
        entry: "chatgpt-auto-confirm.user.js",
      }],
      update: {
        check: "marketplace-release",
        comparison: "version-then-artifact-sha256",
        allowDowngrade: false,
        rollback: "previous-active",
      },
      permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
    },
  },
};

const BUILTIN_TASK_QUEUE_ITEM = {
  pluginId: "userscript-chatgpt-task-queue",
  displayName: "ChatGPT Task Queue",
  description: "在 ChatGPT 页面提供顺序任务、失败重试和明确 @ChatGPT 确认提示；由 Fabushi 的现有用户脚本运行器执行。",
  latestVersion: "1.0.0",
  bundledFallback: true,
  platforms: ["chrome-extension"],
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  releaseStatus: "approved",
  installMode: "package",
  source: {
    provider: "github",
    repository: MARKETPLACE_TASK_QUEUE_REPOSITORY,
    sourceRef: MARKETPLACE_TASK_QUEUE_COMMIT,
    releaseUrl: `${MARKETPLACE_TASK_QUEUE_REPOSITORY}/tree/${MARKETPLACE_TASK_QUEUE_COMMIT}/chatgpt-vps-control/chrome-platform/extension/marketplace`,
    surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT Task Queue", entry: "marketplace/chatgpt-task-queue.user.js", platforms: ["chrome-extension"] }],
    commands: [],
  },
  surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT Task Queue", entry: "marketplace/chatgpt-task-queue.user.js", platforms: ["chrome-extension"] }],
  commands: [],
  sourcePath: "marketplace/chatgpt-task-queue.user.js",
  permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
  install: {
    protocol: "fabushi.marketplace.install.v1",
    strategy: "github-immutable",
    pluginId: "userscript-chatgpt-task-queue",
    version: "1.0.0",
    source: {
      provider: "github",
      repository: MARKETPLACE_TASK_QUEUE_REPOSITORY,
      sourceRef: MARKETPLACE_TASK_QUEUE_COMMIT,
      releaseUrl: `${MARKETPLACE_TASK_QUEUE_REPOSITORY}/tree/${MARKETPLACE_TASK_QUEUE_COMMIT}/chatgpt-vps-control/chrome-platform/extension/marketplace`,
      marketplaceHostsPackage: false,
    },
    artifacts: [{
      id: "chatgpt-task-queue-userscript",
      runtime: "userscript",
      platforms: ["chrome-extension"],
      source: {
        type: "https",
        url: `https://raw.githubusercontent.com/bhrumom/fabushi/${MARKETPLACE_TASK_QUEUE_COMMIT}/chatgpt-vps-control/chrome-platform/extension/marketplace/chatgpt-task-queue.user.js`,
      },
      sha256: MARKETPLACE_TASK_QUEUE_SHA256,
      size: MARKETPLACE_TASK_QUEUE_SIZE,
      format: "user-js",
      entry: "chatgpt-task-queue.user.js",
    }],
    update: {
      check: "marketplace-release",
      comparison: "version-then-artifact-sha256",
      allowDowngrade: false,
      rollback: "previous-active",
    },
    permissions: ["读取 ChatGPT 页面状态", "显示任务队列", "仅在匹配页面运行"],
  },
};

const BUILTIN_MARKETPLACE_ITEMS = [BUILTIN_MARKETPLACE_ITEM, BUILTIN_TASK_QUEUE_ITEM];

function itemPluginId(item) {
  return String(item?.pluginId || item?.id || item?.name || "").trim();
}

function itemVersion(item) {
  return marketplaceItemVersion(item);
}

function itemSurfaces(item) {
  return [
    ...(Array.isArray(item?.surfaces) ? item.surfaces : []),
    ...(Array.isArray(item?.source?.surfaces) ? item.source.surfaces : []),
    ...(Array.isArray(item?.releaseManifest?.surfaces) ? item.releaseManifest.surfaces : []),
  ];
}

function userscriptSurface(item) {
  return itemSurfaces(item).find((surface) => surface?.kind === "userscript"
    || surface?.id === "userscript"
    || /\.user\.js$/i.test(String(surface?.entry || ""))) || null;
}

function userscriptInstalled(pluginId) {
  return state.userscripts.find((script) => script.sourcePluginId === pluginId);
}

function localMarketplaceUpdateCandidates() {
  return state.marketplace.flatMap((item) => {
    const pluginId = itemPluginId(item);
    if (!pluginId) return [];
    const installed = state.installed.find((candidate) => itemPluginId(candidate) === pluginId);
    const script = userscriptInstalled(pluginId);
    const action = marketplaceInstallAction(item, installed, script);
    if (action !== "update" && action !== "reinstall") return [];
    return [{
      pluginId,
      displayName: String(item.displayName || item.name || item.title || pluginId),
      installedVersion: marketplaceInstalledVersion(item, installed, script) || "未知",
      latestVersion: itemVersion(item),
      reason: action === "reinstall" ? "artifact-digest" : "version",
    }];
  });
}

function updateStatusCopy(status) {
  const updates = Array.isArray(status?.updates) ? status.updates : [];
  if (updates.length) {
    return `发现 ${updates.length} 个更新：${updates.map((item) => `${item.displayName || item.pluginId} ${item.installedVersion || "旧版本"} → ${item.latestVersion || "新版本"}`).join("、")}`;
  }
  if (status?.error) return "自动检查暂时失败，将在后台继续重试。";
  if (status?.checkedAt) return `已自动检查 · 暂无新版本（${new Date(status.checkedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}）`;
  return "正在检查线上版本…";
}

function setMarketplaceUpdateStatus(status = {}) {
  const localUpdates = state.userscriptsLoaded && state.installedLoaded
    ? localMarketplaceUpdateCandidates()
    : [];
  const remoteUpdates = Array.isArray(status.updates) ? status.updates : [];
  const updates = localUpdates.length ? localUpdates : remoteUpdates;
  state.marketplaceUpdate = {
    checkedAt: Number(status.checkedAt) || (localUpdates.length ? Date.now() : 0),
    updates,
    error: String(status.error || ""),
    reason: String(status.reason || ""),
  };
  const container = $("#marketplace-update-status");
  const copy = $("#marketplace-update-copy");
  if (!container || !copy) return;
  container.hidden = false;
  container.classList.toggle("has-update", updates.length > 0);
  copy.textContent = updateStatusCopy(state.marketplaceUpdate);
}

function marketplaceCatalogStatus(query = "") {
  const queryActive = Boolean(String(query || "").trim());
  const ready = state.userscriptsLoaded && state.installedLoaded;
  return {
    ...state.marketplaceUpdate,
    checkedAt: ready && !queryActive ? Date.now() : state.marketplaceUpdate.checkedAt,
    updates: ready && !queryActive ? localMarketplaceUpdateCandidates() : state.marketplaceUpdate.updates,
    error: "",
    reason: "catalog",
  };
}
async function refreshMarketplaceUpdateStatus({ check = false } = {}) {
  const type = check ? "fabushi.marketplace.update.check" : "fabushi.marketplace.update.status";
  try {
    const response = await runtimeMessage({ type }, check ? 5_000 : 2_000);
    if (response?.ok && response.status) setMarketplaceUpdateStatus(response.status);
  } catch {
    // Older extension workers have no background checker yet. The direct
    // Marketplace fetch still performs the same version comparison below.
  }
}

function scheduleMarketplaceAutoRefresh() {
  if (state.marketplaceAutoRefreshTimer !== null) return;
  const refresh = () => {
    if (document.visibilityState === "hidden" || state.view !== "marketplace") return;
    void refreshMarketplace(search.value);
  };
  state.marketplaceAutoRefreshTimer = window.setInterval(refresh, MARKETPLACE_AUTO_REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });
}

function shouldShowBundledFallback(query) {
  const normalized = String(query || "").trim().toLowerCase();
  return !normalized || ["chatgpt", "task queue", "自动确认", "任务", "油猴", "userscript", "脚本"].some((term) => normalized.includes(term));
}

async function loadBundledUserscript(item = BUILTIN_MARKETPLACE_ITEM) {
  const sourcePath = item?.sourcePath || BUNDLED_USERSCRIPT_PATH;
  const response = await fetch(`${chrome.runtime.getURL(sourcePath)}?update=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) throw new Error(`内置油猴脚本读取失败（${response.status}）。`);
  const source = await response.text();
  if (!source.includes("// ==UserScript==") || !source.includes("// ==/UserScript==")) throw new Error("内置油猴脚本元数据无效。");
  for (const match of item?.matches || BUILTIN_MARKETPLACE_ITEM.matches) {
    if (!source.includes(`// @match        ${match}`) && !source.includes(`// @match ${match}`)) throw new Error(`内置油猴脚本缺少批准的站点：${match}`);
  }
  return source;
}

async function officialMarketplaceItem() {
  // The bundled copy is only a bootstrap/rollback compatibility asset. The
  // Marketplace version is pinned to the separately released GitHub artifact
  // in BUILTIN_MARKETPLACE_ITEM and must not be inferred from this copy.
  return BUILTIN_MARKETPLACE_ITEM;
}

async function bundledMarketplaceItems() {
  const official = await officialMarketplaceItem();
  return [official, ...BUILTIN_MARKETPLACE_ITEMS.slice(1)];
}

async function fetchPublicMarketplace(query = "") {
  const url = new URL("/v1/marketplace/plugins", MARKETPLACE_API_ROOT);
  url.searchParams.set("platform", "chrome-extension");
  if (query.trim()) url.searchParams.set("q", query.trim());
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Marketplace 读取失败（${response.status}）。`);
    return marketplaceItems(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

function isGithubArtifactUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    return url.protocol === "https:"
      && ["github.com", "raw.githubusercontent.com"].includes(url.hostname.toLowerCase())
      && !url.username
      && !url.password
      && !url.port
      && !url.search
      && !url.hash;
  } catch {
    return false;
  }
}

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function fetchVerifiedUserscript(item) {
  const contract = marketplaceInstallContract(item);
  const source = contract?.source;
  const artifact = marketplaceUserscriptArtifact(item);
  const repository = String(source?.repository || "").trim();
  const sourceRef = String(source?.sourceRef || "").trim();
  const artifactUrl = String(artifact?.source?.url || "").trim();
  const expectedSha256 = String(artifact?.sha256 || artifact?.artifactSha256 || "").trim().toLowerCase();
  const expectedSize = Number(artifact?.size ?? artifact?.sizeBytes);
  let repositoryUrl;
  try {
    repositoryUrl = new URL(repository);
  } catch {
    repositoryUrl = null;
  }
  if (contract?.protocol !== "fabushi.marketplace.install.v1"
    || contract.strategy !== "github-immutable"
    || contract.pluginId !== marketplaceItemId(item)
    || contract.version !== marketplaceItemVersion(item)
    || source?.marketplaceHostsPackage !== false
    || !repositoryUrl
    || repositoryUrl.protocol !== "https:"
    || repositoryUrl.hostname.toLowerCase() !== "github.com"
    || repositoryUrl.pathname.split("/").filter(Boolean).length !== 2
    || repositoryUrl.username
    || repositoryUrl.password
    || repositoryUrl.port
    || repositoryUrl.search
    || repositoryUrl.hash
    || !/^[a-f0-9]{40}$/i.test(sourceRef)
    || !isGithubArtifactUrl(artifactUrl)
    || !/^[a-f0-9]{64}$/.test(expectedSha256)
    || !Number.isSafeInteger(expectedSize)
    || expectedSize <= 0
    || expectedSize > MAX_REMOTE_USERSCRIPT_BYTES
    || contract.update?.allowDowngrade !== false) {
    throw new Error("市场用户脚本不是固定到公开 GitHub commit 的可验证 artifact。");
  }
  const repositoryParts = repositoryUrl.pathname.split("/").filter(Boolean);
  const artifactParts = new URL(artifactUrl).pathname.split("/").filter(Boolean);
  if (artifactParts.length < 4
    || artifactParts[0] !== repositoryParts[0]
    || artifactParts[1] !== repositoryParts[1]
    || artifactParts[2] !== sourceRef) {
    throw new Error("GitHub 用户脚本 URL 没有固定到合同声明的仓库 commit。");
  }
  const response = await fetch(artifactUrl, {
    headers: { Accept: "text/javascript, text/plain" },
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error(`GitHub 用户脚本读取失败（${response.status}）。`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength !== expectedSize) throw new Error("GitHub 用户脚本大小与市场清单不一致。");
  const actualSha256 = await sha256Hex(bytes);
  if (actualSha256 !== expectedSha256) throw new Error("GitHub 用户脚本 SHA-256 与市场清单不一致。");
  const script = new TextDecoder().decode(bytes);
  if (!script.includes("// ==UserScript==") || !script.includes("// ==/UserScript==")) {
    throw new Error("GitHub artifact 不是有效的油猴脚本。");
  }
  return { script, artifact };
}

function extractUserscriptFromHtml(html) {
  if (!html) return "";
  const document = new DOMParser().parseFromString(String(html), "text/html");
  return document.querySelector('script[type="application/x-fabushi-userscript"], script[data-fabushi-userscript]')?.textContent?.trim() || "";
}

function renderCards(container, items, emptyText) {
  container.replaceChildren();
  for (const item of items) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("h3");
    heading.textContent = item.name || item.displayName || item.title || item.id || "Fabushi App";
    const body = document.createElement("p");
    const release = marketplaceReleaseManifest(item);
    body.textContent = item.description || item.summary || item.blurb || "Fabushi 小程序";
    const meta = document.createElement("div");
    meta.className = "meta";
    const contract = marketplaceInstallContract(item);
    const sourceRef = String(contract?.source?.sourceRef || item.source?.sourceRef || "").trim();
    const releaseStatus = item.releaseStatus || release?.releaseStatus;
    const permissions = Array.isArray(item.permissions)
      ? item.permissions
      : Array.isArray(contract?.permissions) ? contract.permissions : [];
    for (const value of [
      itemVersion(item),
      sourceRef ? `GitHub · ${sourceRef.slice(0, 9)}` : "",
      releaseStatus === "approved" ? "已审核发布" : releaseStatus,
      permissions.length ? `权限 ${permissions.length} 项` : "",
      item.kind,
      item.category,
      item.publisher?.displayName || item.publisher,
    ].filter(Boolean).slice(0, 6)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = String(value);
      meta.append(tag);
    }
    card.append(heading, body, meta);
    const releaseNotes = item.releaseNotes || release?.releaseNotes;
    if (releaseNotes) {
      const notes = document.createElement("small");
      notes.className = "release-note";
      notes.textContent = `发布说明：${releaseNotes}`;
      card.append(notes);
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const pluginId = itemPluginId(item);
    if (container.id === "marketplace-list" && marketplaceItemInstallable(item)) {
      const installed = state.installed.find((candidate) => itemPluginId(candidate) === pluginId);
      const script = userscriptInstalled(pluginId);
      const action = marketplaceInstallAction(item, installed, script);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-action primary";
      button.textContent = action === "update" ? "更新" : action === "reinstall" ? "重新安装" : action === "blocked" ? "版本异常" : action === "current" ? "已是最新" : "安装";
      button.disabled = action === "blocked" || action === "current";
      button.title = action === "blocked" ? "本地版本比市场版本更新，市场不会静默降级" : action === "current" ? "当前版本与 GitHub 发布物一致" : "从已审核的 GitHub 发布物校验后安装";
      button.addEventListener("click", () => void installMarketplaceItem(item, button));
      actions.append(button);
      const hint = document.createElement("span");
      hint.className = "action-hint";
      const installedVersion = marketplaceInstalledVersion(item, installed, script);
      const kind = marketplaceItemKind(item);
      hint.textContent = action === "update"
        ? `已安装 ${installedVersion || "旧版本"} · 可更新到 ${itemVersion(item)}`
        : action === "blocked"
          ? `本地 ${installedVersion} 高于市场 ${itemVersion(item)}，已阻止降级`
          : action === "reinstall"
            ? (kind === "userscript" ? "已安装 · ChatGPT 页面可用" : "已安装 · 可重新校验 GitHub 发布物")
            : action === "current"
              ? `已安装 ${installedVersion || itemVersion(item)} · GitHub 发布物一致`
            : kind === "metadata" ? "打开已审核的线上页面" : "从 GitHub 发布物校验后安装";
      actions.append(hint);
    }
    card.append(actions);
    container.append(card);
  }
  if (!items.length) {
    const empty = document.createElement("div");
    empty.className = "empty compact";
    empty.innerHTML = `<h3>${emptyText}</h3>`;
    container.append(empty);
  }
}

async function refreshUserscripts() {
  try {
    const result = await runtimeMessage({ type: "fabushi.userscript.list" });
    state.userscripts = result?.ok && Array.isArray(result.scripts) ? result.scripts : [];
    state.userscriptsLoaded = true;
    renderUserScripts();
    if (state.view === "marketplace") {
      renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
      setMarketplaceUpdateStatus({
        ...state.marketplaceUpdate,
        checkedAt: state.installedLoaded ? Date.now() : state.marketplaceUpdate.checkedAt,
        updates: state.installedLoaded ? localMarketplaceUpdateCandidates() : state.marketplaceUpdate.updates,
        error: state.installedLoaded ? "" : state.marketplaceUpdate.error,
        reason: "local-state",
      });
    }
  } catch (error) {
    showBanner(`油猴脚本列表读取失败：${error.message}`, "error");
  }
}

function renderUserScripts() {
  const container = $("#userscript-list");
  if (!container) return;
  container.replaceChildren();
  for (const script of state.userscripts) {
    const card = document.createElement("article");
    card.className = "card";
    const heading = document.createElement("h3");
    heading.textContent = script.name || "未命名油猴脚本";
    const body = document.createElement("p");
    body.textContent = script.description || "Fabushi 用户脚本";
    const meta = document.createElement("div");
    meta.className = "meta";
    for (const value of [script.version, script.sourcePluginId || "本地导入", script.enabled === false ? "已停用" : "已启用"].filter(Boolean)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = String(value);
      meta.append(tag);
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "card-action";
    toggle.textContent = script.enabled === false ? "启用" : "停用";
    toggle.addEventListener("click", async () => {
      const result = await runtimeMessage({ type: "fabushi.userscript.setEnabled", id: script.id, enabled: script.enabled === false });
      if (!result?.ok) showBanner(result?.error || "油猴脚本状态更新失败", "error");
      await refreshUserscripts();
    });
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "card-action danger";
    remove.textContent = "卸载";
    remove.addEventListener("click", async () => {
      const result = await runtimeMessage({ type: "fabushi.userscript.uninstall", id: script.id, sourcePluginId: script.sourcePluginId });
      if (!result?.ok) showBanner(result?.error || "油猴脚本卸载失败", "error");
      else showBanner(`已卸载 ${script.name || "油猴脚本"}`, "warning");
      await refreshUserscripts();
    });
    actions.append(toggle, remove);
    card.append(heading, body, meta, actions);
    container.append(card);
  }
  $("#userscript-empty").hidden = state.userscripts.length > 0;
}

async function installMarketplaceItem(item, button) {
  const pluginId = itemPluginId(item);
  if (!pluginId) return;
  const previouslyInstalled = state.installed.find((candidate) => itemPluginId(candidate) === pluginId);
  const previouslyInstalledUserscript = userscriptInstalled(pluginId);
  const action = marketplaceInstallAction(item, previouslyInstalled, previouslyInstalledUserscript);
  if (action === "blocked") {
    showBanner(`${item.displayName || pluginId} 的本地版本高于市场版本，已阻止静默降级。`, "error");
    return;
  }
  button.disabled = true;
  const version = itemVersion(item);
  const hasUserscriptSurface = Boolean(userscriptSurface(item));
  const kind = marketplaceItemKind(item);
  let desktopInstallError = "";
  let packageInstalled = false;
  let metadataOpened = false;
  try {
    let release = marketplaceReleaseManifest(item);
    const packageInstallRequired = kind === "package" && !hasUserscriptSurface;
    if (packageInstallRequired && !state.desktopConnected) {
      throw new Error("这个项目是 GitHub 小程序包，请先启动 Fabushi 桌面端；桌面 Host 会在本机校验后安装。");
    }
    if (packageInstallRequired && state.desktopConnected) {
      try {
        if (!release || !Array.isArray(release.artifacts) || !release.artifacts.length) {
          const result = await desktopRequest("feature.marketplace.release", { pluginId, version });
          release = marketplaceReleaseManifest(result);
        }
      } catch (error) {
        desktopInstallError = error.message;
        release = null;
      }
    }
    if (packageInstallRequired && state.desktopConnected && release && Array.isArray(release.artifacts) && release.artifacts.length) {
      if (release.protocol !== "mahayana.external-release.v1" || release.pluginId !== pluginId || release.version !== version) {
        throw new Error("市场版本清单的协议、插件 ID 或版本不一致。");
      }
      const installContract = marketplaceInstallContract(item) || release.install;
      const installSource = installContract?.source;
      if (installContract?.protocol !== "fabushi.marketplace.install.v1"
        || installContract.strategy !== "github-immutable"
        || installSource?.marketplaceHostsPackage === true
        || typeof installSource?.repository !== "string"
        || typeof installSource?.sourceRef !== "string"
        || !installSource.sourceRef.trim()) {
        throw new Error("市场版本没有提供可验证的 GitHub 安装合同。");
      }
      try {
        await desktopRequest("feature.plugin.install", { release, platform: "chrome-extension" }, 120_000);
        packageInstalled = true;
      } catch (error) {
        desktopInstallError = error.message;
        try {
          await desktopRequest("feature.plugin.install", { release, platform: "desktop" }, 120_000);
          desktopInstallError = "";
          packageInstalled = true;
        } catch (fallbackError) {
          desktopInstallError = `${desktopInstallError}; ${fallbackError.message}`;
        }
      }
    }
    if (packageInstallRequired && !packageInstalled) {
      throw new Error(desktopInstallError || "市场版本没有可安装的 GitHub artifact。");
    }

    if (kind === "metadata") {
      const surface = itemSurfaces(item).find((candidate) => candidate?.kind === "web" && candidate.url);
      const url = String(item.uiUrl || surface?.url || "").trim();
      if (!url) throw new Error("市场项目没有声明可打开的线上页面。");
      await chrome.tabs.create({ url });
      metadataOpened = true;
    }

    let source = "";
    let verifiedUserscriptArtifact = null;
    if (hasUserscriptSurface) {
      const remoteUserscript = marketplaceUserscriptArtifact(item);
      if (remoteUserscript) {
        const verified = await fetchVerifiedUserscript(item);
        source = verified.script;
        verifiedUserscriptArtifact = verified.artifact;
      } else if (item.bundledFallback) {
        // Only a legacy item without an install contract may use the signed
        // extension copy. Current Marketplace entries must take the verified
        // GitHub branch above.
        source = await loadBundledUserscript(item);
      }
    }
    if (hasUserscriptSurface && !source && state.desktopConnected) {
      try {
        const result = await desktopRequest("feature.plugin.userScript", { pluginId, version }, 20_000);
        source = String(result?.source || "").trim();
      } catch {}
    }
    if (hasUserscriptSurface && !source) {
      try {
        const result = await desktopRequest("feature.plugin.uiDocument", { pluginId }, 20_000);
        source = extractUserscriptFromHtml(result?.html);
      } catch {}
    }
    if (hasUserscriptSurface && !source && item.bundledFallback) source = await loadBundledUserscript(item);
    if (hasUserscriptSurface) {
      if (!source) throw new Error("市场项目没有提供可读取的 .user.js 文件。");
      const commands = (item.commands || item.source?.commands || []).map((command) => command.tool || command.name).filter(Boolean);
      const installed = await runtimeMessage({
        type: "fabushi.userscript.install",
        source,
        sourcePluginId: pluginId,
        sourcePluginVersion: version,
        sourceRepository: marketplaceInstallContract(item)?.source?.repository,
        sourceRef: marketplaceInstallContract(item)?.source?.sourceRef,
        sourceArtifactSha256: verifiedUserscriptArtifact?.sha256 || verifiedUserscriptArtifact?.artifactSha256,
        commands,
      });
      if (!installed?.ok) throw new Error(installed?.error || "扩展安装油猴脚本失败。");
    }
    await refreshUserscripts();
    await refreshInstalled();
    const suffix = metadataOpened
      ? "已打开线上页面；页面代码仍由声明的 HTTPS Hosted surface 提供。"
      : packageInstalled && hasUserscriptSurface
        ? "GitHub 包已校验安装，网页油猴脚本也已就绪。"
        : packageInstalled
          ? "GitHub 发布物已校验并安装到 Fabushi Host。"
        : hasUserscriptSurface
            ? verifiedUserscriptArtifact
              ? "GitHub 油猴脚本已校验安装；它独立运行在匹配的 ChatGPT 页面。"
              : "网页油猴脚本已安装；它独立运行在匹配的 ChatGPT 页面。"
            : "安装状态已刷新。";
    const actionLabel = action === "update" ? "已更新" : action === "reinstall" ? "已重新安装" : "已安装";
    showBanner(`${item.displayName || pluginId}${actionLabel}：${suffix}`, "warning");
    if (desktopInstallError && packageInstallRequired) showBanner(`GitHub 包安装失败：${desktopInstallError}`, "error");
  } catch (error) {
    showBanner(`安装失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function refreshMarketplace(query = "") {
  const requestId = ++state.marketplaceRequestId;
  // Chrome discovery is authoritative at the live Marketplace endpoint. A
  // connected desktop Host may be older than the extension and must not make
  // a published userscript update look like 2.9.28 is still current.
  try {
    const liveItems = await fetchPublicMarketplace(query);
    if (requestId !== state.marketplaceRequestId) return;
    state.marketplace = liveItems;
    if (shouldShowBundledFallback(query)) {
      const builtins = await bundledMarketplaceItems();
      if (requestId !== state.marketplaceRequestId) return;
      for (const builtin of builtins) {
        const index = state.marketplace.findIndex((item) => itemPluginId(item) === builtin.pluginId);
        if (index < 0) state.marketplace.unshift(builtin);
        else if (compareVersions(itemVersion(builtin), itemVersion(state.marketplace[index])) > 0) state.marketplace[index] = builtin;
      }
    }
    renderCards($("#marketplace-list"), state.marketplace, state.desktopConnected ? "没有找到兼容 Chrome 的项目" : "没有找到可独立安装的 Chrome 项目");
    setMarketplaceUpdateStatus(marketplaceCatalogStatus(query));
    return;
  } catch {
    // A transient live-catalog failure falls back to the connected Host. The
    // Host can still install verified artifacts, but never outranks live data.
  }

  if (!state.desktopConnected) {
    if (requestId !== state.marketplaceRequestId) return;
    state.marketplace = [];
    renderCards($("#marketplace-list"), state.marketplace, "没有找到可独立安装的 Chrome 项目");
    setMarketplaceUpdateStatus({ ...state.marketplaceUpdate, checkedAt: Date.now(), error: "线上 Marketplace 暂时不可用。", reason: "catalog" });
    return;
  }
  try {
    let result;
    try {
      result = await desktopRequest("feature.marketplace.browse", { query: query.trim() || undefined, platform: "chrome-extension" });
    } catch (error) {
      // Older Fabushi Hosts only know the desktop/web platform. Keep the
      // extension usable while the desktop app is being upgraded.
      result = await desktopRequest("feature.marketplace.browse", { query: query.trim() || undefined, platform: "web" });
    }
    if (requestId !== state.marketplaceRequestId) return;
    state.marketplace = marketplaceItems(result);
    if (shouldShowBundledFallback(query)) {
      const builtins = await bundledMarketplaceItems();
      if (requestId !== state.marketplaceRequestId) return;
      for (const builtin of builtins) {
        const index = state.marketplace.findIndex((item) => itemPluginId(item) === builtin.pluginId);
        if (index < 0) state.marketplace.unshift(builtin);
        else if (compareVersions(itemVersion(builtin), itemVersion(state.marketplace[index])) > 0
          || !userscriptSurface(state.marketplace[index])) state.marketplace[index] = builtin;
      }
    }
    renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
    setMarketplaceUpdateStatus(marketplaceCatalogStatus(query));
  } catch (error) {
    showBanner(error.message, "error");
    setMarketplaceUpdateStatus({ ...state.marketplaceUpdate, checkedAt: Date.now(), error: error.message, reason: "catalog" });
  }
}

async function refreshInstalled() {
  await refreshUserscripts();
  if (!state.desktopConnected) {
    state.installed = [];
    state.installedLoaded = true;
    renderCards($("#miniapp-list"), [], "桌面小程序属于可选增强；下方油猴脚本可独立运行");
    if (state.view === "marketplace") {
      renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
      setMarketplaceUpdateStatus({ ...state.marketplaceUpdate, checkedAt: Date.now(), updates: localMarketplaceUpdateCandidates(), error: "", reason: "local-state" });
    }
    return;
  }
  try {
    const result = await desktopRequest("feature.plugin.listInstalled");
    state.installed = Array.isArray(result) ? result : Array.isArray(result?.plugins) ? result.plugins : Array.isArray(result?.items) ? result.items : [];
    state.installedLoaded = true;
    renderCards($("#miniapp-list"), state.installed, "还没有已安装的小程序");
    if (state.view === "marketplace") {
      renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
      setMarketplaceUpdateStatus({ ...state.marketplaceUpdate, checkedAt: Date.now(), updates: localMarketplaceUpdateCandidates(), error: "", reason: "local-state" });
    }
    $("#miniapp-empty").hidden = state.installed.length > 0;
  } catch (error) {
    showBanner(error.message, "error");
  }
}

async function refreshBrowser() {
  try {
    const result = await runtimeMessage({ type: "fabushi.browser.status" });
    state.browser = result || { connected: false, tabs: [] };
    $("#browser-bridge-title").textContent = state.browser.connected ? "桌面浏览器增强已连接" : "Chrome 插件独立运行中";
    $("#browser-bridge-detail").textContent = state.browser.connected ? `${state.browser.tabs?.length || 0} 个网页标签页可供 Fabushi 使用` : "油猴脚本直接在匹配页面运行；桌面控制为可选增强";
    $("#settings-browser").textContent = state.browser.connected ? "已连接" : "未连接";
    const list = $("#tab-list");
    list.replaceChildren();
    for (const tab of state.browser.tabs || []) {
      const row = document.createElement("div");
      row.className = "tab-row";
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      title.textContent = tab.title || "未命名标签页";
      const url = document.createElement("span");
      url.textContent = tab.url || "";
      copy.append(title, url);
      const claim = document.createElement("span");
      claim.className = "claim";
      claim.textContent = tab.claimed ? "Fabushi 已接管" : "可连接";
      row.append(copy, claim);
      list.append(row);
    }
  } catch (error) {
    state.browser = { connected: false, tabs: [], error: error.message };
    $("#settings-browser").textContent = "未连接";
  }
}

async function openDesktopSettings() {
  try {
    await desktopRequest("desktop.settings.open", { section: "general" }, 10_000);
    hideBanner();
  } catch (error) {
    showBanner(`无法打开桌面设置：${error.message}`, "error");
  }
}

let desktopProbeBusy = false;
async function connectDesktopEnhancements() {
  if (desktopProbeBusy || state.desktopConnected) return;
  desktopProbeBusy = true;
  try {
    const platformStatus = await runtimeMessage({ type: "fabushi.platform.status" });
    if (!platformStatus?.connected) {
      void runtimeMessage({ type: "fabushi.platform.reconnect" }).catch(() => {});
      return;
    }
    await desktopRequest("feature.info", {}, 10_000);
    setDesktopConnection(true);
    // Account state remains owned by the desktop Host. The extension only
    // receives the redacted auth summary needed to render the account chip;
    // older Hosts that do not expose this method keep the deferred state.
    const auth = await desktopRequest("feature.auth.status", {}, 10_000)
      .catch(() => ({ loggedIn: false, deferred: true, provider: "Fabushi" }));
    if (!state.browserAccount.loggedIn) setAuth(auth);
    await Promise.allSettled([refreshBrowser(), refreshMarketplace(""), refreshInstalled()]);
  } catch (error) {
    setDesktopConnection(false, error.message);
  } finally {
    desktopProbeBusy = false;
  }
}

async function initialize() {
  // Paint the local extension runtime first. Native Messaging discovery can
  // take seconds or be permanently unavailable and must never cover the UI
  // with a blocking desktop-connection spinner.
  loading.hidden = false;
  hideBanner();
  setDesktopConnection(false);
  setAuth({ loggedIn: false, standalone: true });
  // Show the local shell before optional network and Native Messaging
  // discovery. A slow Marketplace/API response must never leave every view
  // hidden or make the extension appear frozen during startup.
  loading.hidden = true;
  activateView("marketplace");
  scheduleMarketplaceAutoRefresh();
  void Promise.allSettled([refreshUserscripts(), refreshBrowserAccount()]);
  void refreshMarketplaceUpdateStatus({ check: true });
  void connectDesktopEnhancements();
}

for (const button of navButtons) button.addEventListener("click", () => activateView(button.dataset.view));
$("#open-desktop-settings").addEventListener("click", () => void openDesktopSettings());
$("#settings-open-desktop").addEventListener("click", () => void openDesktopSettings());
$("#account-button").addEventListener("click", () => activateView("settings"));
$("#browser-account-action").addEventListener("click", async () => {
  const type = state.browserAccount.loggedIn ? "fabushi.account.logout" : "fabushi.account.login";
  $("#browser-account-action").disabled = true;
  try {
    const response = await runtimeMessage({ type });
    if (!response?.ok) throw new Error(response?.error || "Fabushi 账号操作失败。");
    await refreshBrowserAccount();
  } catch (error) {
    showBanner(error.message, "error");
  } finally {
    $("#browser-account-action").disabled = false;
  }
});
$("#refresh-browser").addEventListener("click", () => void refreshBrowser());
$("#marketplace-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  setMarketplaceUpdateStatus({ ...state.marketplaceUpdate, checkedAt: 0, updates: [], error: "" });
  try {
    await Promise.allSettled([refreshMarketplace(search.value), refreshMarketplaceUpdateStatus({ check: true })]);
  } finally {
    button.disabled = false;
  }
});
$("#new-chat").addEventListener("click", () => {
  state.activeConversationId = "new";
  $("#conversation-empty").hidden = true;
  $("#conversation").hidden = false;
  $("#conversation-title").textContent = "新对话";
  state.messages.set("new", []);
  renderMessages();
  $("#composer-input").focus();
});
$("#composer").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#composer-input");
  const text = input.value.trim();
  if (!text || !state.auth.loggedIn) return;
  input.value = "";
  const conversationId = state.activeConversationId === "new" ? undefined : state.activeConversationId || undefined;
  appendMessage(state.activeConversationId || "new", { role: "user", text });
  void desktopRequest("feature.execute", { command: { type: "chat.send", requestId: requestId("chat-send"), text, conversationId, agentId: conversationId ? undefined : "mahayana-assistant", mode: "agent" } })
    .catch((error) => showBanner(error.message, "error"));
});
search.addEventListener("input", () => {
  if (state.view === "chats") renderConversations(search.value);
  if (state.view === "marketplace") void refreshMarketplace(search.value);
});
$("#import-userscript").addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const result = await runtimeMessage({
      type: "fabushi.userscript.install",
      source: await file.text(),
      sourcePluginId: null,
      sourcePluginVersion: file.name,
    });
    if (!result?.ok) throw new Error(result?.error || "油猴脚本安装失败。");
    await refreshUserscripts();
    showBanner("已安装 " + (result.script?.name || file.name) + "，打开匹配网页即可运行。");
  } catch (error) {
    showBanner("油猴脚本安装失败：" + error.message, "error");
  }
});
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    search.focus();
  }
});
chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "fabushi.platform.event") handlePlatformEvent(message.event);
  if (message?.type === "fabushi.marketplace.updates" && message.status) {
    setMarketplaceUpdateStatus(message.status);
    if (state.view === "marketplace") renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
  }
  if (message?.type === "fabushi.platform.connection") {
    if (message.connected === true) void connectDesktopEnhancements();
    else setDesktopConnection(false, message.error || "");
  }
});

await initialize();
