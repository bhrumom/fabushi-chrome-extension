const views = ["chats", "miniapps", "marketplace", "browser", "settings"];
const labels = { chats: "聊天", miniapps: "小程序", marketplace: "Marketplace", browser: "浏览器", settings: "设置" };
const BUNDLED_USERSCRIPT_PATH = "userscript/chatgpt-auto-confirm.user.js";
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

function runtimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const runtimeError = chrome.runtime.lastError;
      if (runtimeError) reject(new Error(runtimeError.message));
      else resolve(response);
    });
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
    ? "可选共享 Fabushi 账户和 Host"
    : "油猴脚本与更新无需桌面端";
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
  if (name === "marketplace") void refreshMarketplace(search.value);
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
  // Keep a usable local fallback while the remote catalogue catches up. The
  // actual value is refreshed from the bundled script below whenever the
  // Marketplace opens.
  latestVersion: "2.9.2",
  bundledFallback: true,
  platforms: ["desktop", "cli", "chrome-extension"],
  matches: ["https://chatgpt.com/*", "https://chat.openai.com/*"],
  releaseStatus: "approved",
  installMode: "package",
  source: {
    surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT 网页油猴脚本", entry: "userscript/chatgpt-auto-confirm.user.js", platforms: ["chrome-extension"] }],
    commands: [],
  },
  surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT 网页油猴脚本", entry: "userscript/chatgpt-auto-confirm.user.js", platforms: ["chrome-extension"] }],
  commands: [],
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
    surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT Task Queue", entry: "marketplace/chatgpt-task-queue.user.js", platforms: ["chrome-extension"] }],
    commands: [],
  },
  surfaces: [{ id: "userscript", kind: "userscript", title: "ChatGPT Task Queue", entry: "marketplace/chatgpt-task-queue.user.js", platforms: ["chrome-extension"] }],
  commands: [],
  sourcePath: "marketplace/chatgpt-task-queue.user.js",
};

const BUILTIN_MARKETPLACE_ITEMS = [BUILTIN_MARKETPLACE_ITEM, BUILTIN_TASK_QUEUE_ITEM];

function itemPluginId(item) {
  return String(item?.pluginId || item?.id || item?.name || "").trim();
}

function itemVersion(item) {
  return String(item?.latestVersion || item?.version || item?.releaseManifest?.version || "").trim();
}

function compareVersions(left, right) {
  const a = String(left || "").trim().replace(/^v/i, "");
  const b = String(right || "").trim().replace(/^v/i, "");
  if (!a && !b) return 0;
  if (!a) return -1;
  if (!b) return 1;
  const tokenize = (value) => value.split(/[.+-]/).flatMap((part) => {
    const numbers = part.match(/\d+/g);
    return numbers ? numbers.map((number) => Number(number)) : [0];
  });
  const aParts = tokenize(a);
  const bParts = tokenize(b);
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const aPart = aParts[index] || 0;
    const bPart = bParts[index] || 0;
    if (aPart !== bPart) return aPart > bPart ? 1 : -1;
  }
  // A stable release should win over a prerelease with the same numeric
  // components (for example, 2.9.2 over 2.9.2-beta).
  const aPrerelease = /-/.test(a);
  const bPrerelease = /-/.test(b);
  if (aPrerelease !== bPrerelease) return aPrerelease ? -1 : 1;
  return 0;
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

function userscriptUpdateAvailable(item, installed) {
  if (!installed) return false;
  const available = itemVersion(item);
  const current = String(item?.bundledFallback ? installed.version : (installed.sourcePluginVersion || installed.version || "")).trim();
  return Boolean(available && (!current || compareVersions(available, current) > 0));
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
  // The script is shipped in the signed extension package. Updating it is an
  // extension release operation, so the browser never executes JavaScript
  // fetched from an arbitrary URL at runtime.
  const source = await loadBundledUserscript(BUILTIN_MARKETPLACE_ITEM);
  const version = source.match(/^\s*\/\/\s*@version\s+(.+?)\s*$/mi)?.[1]?.trim();
  return { ...BUILTIN_MARKETPLACE_ITEM, ...(version ? { latestVersion: version } : {}) };
}

async function bundledMarketplaceItems() {
  const official = await officialMarketplaceItem();
  return [official, ...BUILTIN_MARKETPLACE_ITEMS.slice(1)];
}

async function loadOfficialUserscript(item) {
  return loadBundledUserscript(item);
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
    body.textContent = item.description || item.summary || item.blurb || "Fabushi 小程序";
    const meta = document.createElement("div");
    meta.className = "meta";
    for (const value of [itemVersion(item), item.kind, item.category, item.publisher?.displayName || item.publisher].filter(Boolean).slice(0, 4)) {
      const tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = String(value);
      meta.append(tag);
    }
    const actions = document.createElement("div");
    actions.className = "card-actions";
    const pluginId = itemPluginId(item);
    if (container.id === "marketplace-list" && userscriptSurface(item)) {
      const installed = userscriptInstalled(pluginId);
      const updateAvailable = userscriptUpdateAvailable(item, installed);
      const button = document.createElement("button");
      button.type = "button";
      button.className = "card-action primary";
      button.textContent = installed ? (updateAvailable ? "更新油猴脚本" : "重新安装油猴脚本") : "安装油猴脚本";
      button.addEventListener("click", () => void installMarketplaceUserscript(item, button));
      actions.append(button);
      const hint = document.createElement("span");
      hint.className = "action-hint";
      const installedVersion = item?.bundledFallback
        ? installed?.version
        : (installed?.sourcePluginVersion || installed?.version);
      hint.textContent = updateAvailable
        ? `已安装 ${installedVersion} · 可更新到 ${itemVersion(item)}`
        : installed ? "已安装 · ChatGPT 页面可用" : "安装后在 ChatGPT 页面出现按钮";
      actions.append(hint);
    }
    card.append(heading, body, meta, actions);
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
    renderUserScripts();
    if (state.view === "marketplace") renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
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

async function installMarketplaceUserscript(item, button) {
  const pluginId = itemPluginId(item);
  if (!pluginId) return;
  const previouslyInstalled = userscriptInstalled(pluginId);
  const updating = userscriptUpdateAvailable(item, previouslyInstalled);
  button.disabled = true;
  const version = itemVersion(item);
  const hasUserscriptSurface = Boolean(userscriptSurface(item));
  let desktopInstallError = "";
  try {
    let release = item.releaseManifest;
    if (!hasUserscriptSurface && state.desktopConnected) {
      try {
        if (!release || !Array.isArray(release.artifacts)) {
          const result = await desktopRequest("feature.marketplace.release", { pluginId, version });
          release = result?.releaseManifest || result;
        } else if (release.releaseManifest) {
          release = release.releaseManifest;
        }
      } catch (error) {
        desktopInstallError = error.message;
        release = null;
      }
    }
    if (!hasUserscriptSurface && state.desktopConnected && release && Array.isArray(release.artifacts) && release.artifacts.length) {
      try {
        await desktopRequest("feature.plugin.install", { release, platform: "chrome-extension" }, 120_000);
      } catch (error) {
        desktopInstallError = error.message;
        try {
          await desktopRequest("feature.plugin.install", { release, platform: "desktop" }, 120_000);
          desktopInstallError = "";
        } catch (fallbackError) {
          desktopInstallError = `${desktopInstallError}; ${fallbackError.message}`;
        }
      }
    }

    let source = item.bundledFallback ? await loadOfficialUserscript(item) : "";
    if (!source && state.desktopConnected) {
      try {
        const result = await desktopRequest("feature.plugin.userScript", { pluginId, version }, 20_000);
        source = String(result?.source || "").trim();
      } catch {}
    }
    if (!source) {
      try {
        const result = await desktopRequest("feature.plugin.uiDocument", { pluginId }, 20_000);
        source = extractUserscriptFromHtml(result?.html);
      } catch {}
    }
    if (!source && item.bundledFallback) source = await loadBundledUserscript(item);
    if (!source) throw new Error("市场项目没有提供可读取的 .user.js 文件。");
    const commands = (item.commands || item.source?.commands || []).map((command) => command.tool || command.name).filter(Boolean);
    const installed = await runtimeMessage({
      type: "fabushi.userscript.install",
      source,
      sourcePluginId: pluginId,
      sourcePluginVersion: version,
      commands,
    });
    if (!installed?.ok) throw new Error(installed?.error || "扩展安装油猴脚本失败。");
    await refreshUserscripts();
    await refreshInstalled();
    const suffix = hasUserscriptSurface
      ? "网页油猴脚本已安装；它独立运行在匹配的 ChatGPT 页面。"
      : desktopInstallError
      ? "网页脚本已安装；桌面运行时安装未完成，请查看提示。"
      : !state.desktopConnected
        ? "网页脚本已安装；桌面端未连接，连接后即可调用后台功能。"
        : "桌面运行时和网页脚本都已安装；账户将在首次授权的操作时读取。";
    const action = updating ? "已更新" : previouslyInstalled ? "已重新安装" : "已安装";
    showBanner(`${item.displayName || pluginId}${action}：${suffix}`, "warning");
    if (desktopInstallError && !hasUserscriptSurface) showBanner(`网页脚本已安装，但桌面插件安装失败：${desktopInstallError}`, "error");
  } catch (error) {
    showBanner(`安装失败：${error.message}`, "error");
  } finally {
    button.disabled = false;
  }
}

async function refreshMarketplace(query = "") {
  if (!state.desktopConnected) {
    // The official userscript catalogue and installer are extension-native.
    // A desktop Host is an optional enhancement, never a startup dependency.
    state.marketplace = shouldShowBundledFallback(query) ? await bundledMarketplaceItems() : [];
    renderCards($("#marketplace-list"), state.marketplace, "没有找到可独立安装的 Chrome 项目");
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
    state.marketplace = marketplaceItems(result);
    if (shouldShowBundledFallback(query)) {
      const builtins = await bundledMarketplaceItems();
      for (const builtin of builtins) {
        const index = state.marketplace.findIndex((item) => itemPluginId(item) === builtin.pluginId);
        if (index < 0) state.marketplace.unshift(builtin);
        else if (compareVersions(itemVersion(builtin), itemVersion(state.marketplace[index])) > 0
          || !userscriptSurface(state.marketplace[index])) state.marketplace[index] = builtin;
      }
    }
    renderCards($("#marketplace-list"), state.marketplace, "没有找到兼容 Chrome 的项目");
  } catch (error) {
    showBanner(error.message, "error");
  }
}

async function refreshInstalled() {
  await refreshUserscripts();
  if (!state.desktopConnected) {
    renderCards($("#miniapp-list"), [], "桌面小程序属于可选增强；下方油猴脚本可独立运行");
    return;
  }
  try {
    const result = await desktopRequest("feature.plugin.listInstalled");
    state.installed = Array.isArray(result) ? result : Array.isArray(result?.plugins) ? result.plugins : Array.isArray(result?.items) ? result.items : [];
    renderCards($("#miniapp-list"), state.installed, "还没有已安装的小程序");
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
    await Promise.allSettled([refreshBrowser(), refreshMarketplace("")]);
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
  await Promise.allSettled([refreshUserscripts(), refreshMarketplace(""), refreshBrowserAccount()]);
  loading.hidden = true;
  activateView("marketplace");
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
  if (message?.type === "fabushi.platform.connection") {
    if (message.connected === true) void connectDesktopEnhancements();
    else setDesktopConnection(false, message.error || "");
  }
});

await initialize();
