import { normalizeUserScript, publicUserScript, userScriptMatches } from "./userscript-core.js";

const STORAGE_KEY = "fabushi.userscripts.v1";
const BUNDLED_PLUGIN_ID = "chatgpt-auto-confirm";
const BUNDLED_STATE_KEY = "fabushi.bundled-chatgpt-auto-confirm.enabled";
const MAX_CALL_TIMEOUT_MS = 86_400_000;
let reconcilePromise;
const registerPromises = new Map();
const activationPromises = new Map();

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
  const aPrerelease = /-/.test(a);
  const bPrerelease = /-/.test(b);
  if (aPrerelease !== bPrerelease) return aPrerelease ? -1 : 1;
  return 0;
}

async function loadBundledRecord() {
  const response = await fetch(`${chrome.runtime.getURL('userscript/chatgpt-auto-confirm.user.js')}?update=${Date.now()}`, { cache: 'no-store' });
  if (!response.ok) throw new Error('无法读取内置脚本');
  const source = await response.text();
  const record = normalizeUserScript(source, {
    sourcePluginId: BUNDLED_PLUGIN_ID,
    enabled: true,
  });
  // The script metadata is the authoritative version. Keeping it in the
  // source-plugin field makes the installed list and Marketplace agree.
  return { ...record, sourcePluginVersion: record.version };
}

async function readRecords() {
  const result = await chrome.storage.local.get([STORAGE_KEY, BUNDLED_STATE_KEY]);
  const records = Array.isArray(result?.[STORAGE_KEY]) ? result[STORAGE_KEY].filter((item) => item && typeof item === "object") : [];
  let changed = false;
  const bundledIndex = records.findIndex((record) => record.sourcePluginId === BUNDLED_PLUGIN_ID);
  if (bundledIndex < 0 && result?.[BUNDLED_STATE_KEY] !== false) {
    records.push(await loadBundledRecord());
    changed = true;
  } else if (bundledIndex >= 0 && result?.[BUNDLED_STATE_KEY] !== false) {
    // An unpacked extension can receive a newer bundled script without a
    // fresh install. Upgrade the persisted record in place, preserving the
    // user's enabled/disabled choice and the stable script id.
    try {
      const bundled = await loadBundledRecord();
      const current = records[bundledIndex];
      const currentVersion = current.version || current.sourcePluginVersion || "";
      if (compareVersions(bundled.version, currentVersion) > 0) {
        const replacement = {
          ...bundled,
          id: current.id || bundled.id,
          installedAt: Number(current.installedAt) || bundled.installedAt,
          enabled: current.enabled !== false,
          commands: Array.isArray(current.commands) && current.commands.length ? current.commands : bundled.commands,
        };
        records[bundledIndex] = replacement;
        if (replacement.enabled !== false) {
          await registerUserScript(replacement).catch((error) => console.warn("[Fabushi] 内置用户脚本升级注册失败", error));
        }
        changed = true;
      }
    } catch (error) {
      console.warn("[Fabushi] 内置用户脚本版本检查失败", error);
    }
  }
  if (changed) await writeRecords(records);
  return records;
}

async function writeRecords(records) {
  await chrome.storage.local.set({ [STORAGE_KEY]: records });
}

function executeUserScriptInMainWorld(source, id) {
  const registry = window.__FABUSHI_USERSCRIPT_REGISTRY__ || (window.__FABUSHI_USERSCRIPT_REGISTRY__ = Object.create(null));
  if (registry[id] === source) return { alreadyRunning: true };
  registry[id] = source;

  const storagePrefix = `fabushi-gm:${id}:`;
  const readValue = (key, fallback) => {
    try {
      const value = window.localStorage.getItem(`${storagePrefix}${String(key)}`);
      return value === null ? fallback : JSON.parse(value);
    } catch {
      return fallback;
    }
  };
  const writeValue = (key, value) => {
    try { window.localStorage.setItem(`${storagePrefix}${String(key)}`, JSON.stringify(value)); } catch {}
  };
  window.GM_getValue ||= readValue;
  window.GM_setValue ||= writeValue;
  window.GM_deleteValue ||= (key) => { try { window.localStorage.removeItem(`${storagePrefix}${String(key)}`); } catch {} };
  window.GM_listValues ||= () => {
    const values = [];
    try {
      for (let index = 0; index < window.localStorage.length; index += 1) {
        const key = window.localStorage.key(index);
        if (key?.startsWith(storagePrefix)) values.push(key.slice(storagePrefix.length));
      }
    } catch {}
    return values;
  };
  window.GM_addStyle ||= (css) => {
    const style = document.createElement("style");
    style.textContent = String(css ?? "");
    (document.head || document.documentElement).append(style);
    return style;
  };
  window.GM_openInTab ||= (url) => window.open(String(url), "_blank", "noopener");

  const script = document.createElement("script");
  script.dataset.fabushiUserscript = id;
  script.textContent = String(source);
  (document.head || document.documentElement).append(script);
  script.remove();
  return { started: true };
}

function supportsNativeUserScripts() {
  return Boolean(chrome.userScripts && typeof chrome.userScripts.register === "function");
}

async function registeredUserScripts(id) {
  if (!supportsNativeUserScripts() || typeof chrome.userScripts.getScripts !== "function") return [];
  try { return await chrome.userScripts.getScripts({ ids: [id] }); } catch { return []; }
}

function matchPatterns(record) {
  return (Array.isArray(record.matches) ? record.matches : [])
    .filter((pattern) => /^\*?:\/\//.test(pattern) || /^[a-z][a-z\d+.-]*:\/\//i.test(pattern));
}

function sourceRevision(source) {
  let hash = 2166136261;
  for (const char of String(source)) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function executableSource(record) {
  if (record.sourcePluginId !== BUNDLED_PLUGIN_ID) return record.source;
  const revision = sourceRevision(record.source);
  return `(() => {
    const registry = window.__FABUSHI_USERSCRIPT_REVISIONS__ || (window.__FABUSHI_USERSCRIPT_REVISIONS__ = Object.create(null));
    const current = window.__FABUSHI_AUTO_CONFIRM_INSTANCE__;
    if (registry[${JSON.stringify(record.id)}] === ${JSON.stringify(revision)} && current?.active) return;
    registry[${JSON.stringify(record.id)}] = ${JSON.stringify(revision)};
    current?.shutdown?.();
    ${record.source}
  })();`;
}

function registerUserScript(record) {
  if (!supportsNativeUserScripts()) return Promise.resolve(false);
  const existing = registerPromises.get(record.id);
  if (existing) return existing;
  const promise = (async () => {
    const current = await registeredUserScripts(record.id);
    const matches = matchPatterns(record);
    if (!matches.length) throw new Error("油猴脚本没有可注册的 Chrome @match 规则。");
    const definition = {
      id: record.id,
      matches,
      excludeMatches: Array.isArray(record.excludes) ? record.excludes.filter((pattern) => /:\/\//.test(pattern)) : [],
      js: [{ code: executableSource(record) }],
      runAt: record.runAt.replaceAll("-", "_"),
      allFrames: record.noFrames !== true,
      world: record.sourcePluginId === "chatgpt-auto-confirm" ? "MAIN" : "USER_SCRIPT",
    };
    if (current.some((script) => script.id === record.id)) {
      await chrome.userScripts.update([definition]);
      return true;
    }
    try {
      await chrome.userScripts.register([definition]);
    } catch (error) {
      // Chrome can briefly overlap two service-worker lifetimes while an
      // extension is reloaded. If the other worker won the same registration,
      // treat that idempotent result as success instead of invalidating the
      // whole service worker with an uncaught duplicate-id rejection.
      const winner = await registeredUserScripts(record.id);
      if (!winner.some((script) => script.id === record.id)) throw error;
    }
    return true;
  })().finally(() => {
    if (registerPromises.get(record.id) === promise) registerPromises.delete(record.id);
  });
  registerPromises.set(record.id, promise);
  return promise;
}

async function unregisterUserScript(id) {
  if (!supportsNativeUserScripts() || !id) return;
  await chrome.userScripts.unregister({ ids: [id] }).catch(() => {});
}

async function runMatchingScripts(tabId, url) {
  if (!Number.isInteger(tabId) || !/^https?:\/\//i.test(String(url ?? ""))) return [];
  const records = await readRecords();
  const started = [];
  for (const record of records) {
    if (record.enabled === false || !userScriptMatches(record, url)) continue;
    const activationKey = `${tabId}:${record.id}`;
    let activation = activationPromises.get(activationKey);
    if (!activation) {
      activation = (async () => {
        if (supportsNativeUserScripts()) {
          // Registration is persistent and will run on future matching pages.
          // Chrome does not guarantee immediate execution on an already-open
          // document, so execute the current source once after an update too.
          await registerUserScript(record);
          await chrome.userScripts.execute({
            target: { tabId, allFrames: record.noFrames !== true },
            js: [{ code: executableSource(record) }],
            world: record.sourcePluginId === "chatgpt-auto-confirm" ? "MAIN" : "USER_SCRIPT",
          });
          return;
        }
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: record.noFrames !== true },
          world: "MAIN",
          func: executeUserScriptInMainWorld,
          args: [executableSource(record), record.id],
        });
      })().finally(() => {
        if (activationPromises.get(activationKey) === activation) activationPromises.delete(activationKey);
      });
      activationPromises.set(activationKey, activation);
    }
    try {
      await activation;
      started.push(record.id);
    } catch (error) {
      console.warn(`[Fabushi] 用户脚本 ${record.name || record.id} 未能在此页面启动`, error);
    }
  }
  return started;
}

async function installUserScript(message) {
  const record = normalizeUserScript(message.source, {
    sourcePluginId: message.sourcePluginId,
    sourcePluginVersion: message.sourcePluginVersion,
    commands: message.commands,
    enabled: message.enabled !== false,
  });
  const records = (await readRecords()).filter((item) => item.id !== record.id
    && (!record.sourcePluginId || item.sourcePluginId !== record.sourcePluginId));
  records.push(record);
  await registerUserScript(record);
  await writeRecords(records);
  if (record.sourcePluginId === BUNDLED_PLUGIN_ID) await chrome.storage.local.set({ [BUNDLED_STATE_KEY]: true });
  const tabs = await chrome.tabs.query({});
  let activated = 0;
  await Promise.all(tabs.map(async (tab) => {
    if (!tab.id || !tab.url || !userScriptMatches(record, tab.url)) return;
    const started = await runMatchingScripts(tab.id, tab.url);
    if (started.includes(record.id)) activated += 1;
  }));
  return { script: publicUserScript(record), activatedTabs: activated };
}

async function callInstalledPlugin(message, sender) {
  const pluginId = String(message.pluginId ?? "").trim();
  const tool = String(message.tool ?? "").trim();
  if (!pluginId || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(tool)) throw new Error("用户脚本桥接参数无效。");
  const records = await readRecords();
  const record = records.find((item) => item.sourcePluginId === pluginId || item.id === message.scriptId);
  if (!record) throw new Error("该用户脚本尚未在 Fabushi 中安装。");
  if (record.sourcePluginId === pluginId && record.commands?.length && !record.commands.includes(tool)) {
    throw new Error(`脚本未声明可调用 ${tool}。`);
  }
  if (sender?.tab?.id == null) throw new Error("用户脚本请求没有关联网页标签页。");
  const args = message.arguments && typeof message.arguments === "object" && !Array.isArray(message.arguments)
    ? message.arguments
    : {};
  const server = String(message.server ?? `${pluginId}-local`).trim().slice(0, 160);
  const request = globalThis.__fabushiDesktopRequest;
  if (typeof request !== "function") throw new Error("Fabushi 桌面 Host 尚未连接。");
  const timeoutMs = Math.max(1_000, Math.min(Number(message.timeoutMs) || 60_000, MAX_CALL_TIMEOUT_MS));
  return request("feature.execute", {
    command: {
      type: "mcp.toolCall",
      requestId: `userscript-${crypto.randomUUID()}`,
      server,
      tool,
      arguments: args,
    },
  }, timeoutMs);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  if (message.type === "fabushi.userscript.list") {
    readRecords().then((records) => sendResponse({ ok: true, scripts: records.map(publicUserScript) }), (error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.install") {
    installUserScript(message).then((result) => sendResponse({ ok: true, ...result }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.uninstall") {
    readRecords().then(async (records) => {
      const next = records.filter((item) => item.id !== message.id && item.sourcePluginId !== message.sourcePluginId);
      await Promise.all(records.filter((item) => item.id === message.id || item.sourcePluginId === message.sourcePluginId).map((item) => unregisterUserScript(item.id)));
      await writeRecords(next);
      if (message.sourcePluginId === BUNDLED_PLUGIN_ID || records.some((item) => item.id === message.id && item.sourcePluginId === BUNDLED_PLUGIN_ID)) {
        await chrome.storage.local.set({ [BUNDLED_STATE_KEY]: false });
      }
      sendResponse({ ok: true, removed: records.length - next.length });
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.setEnabled") {
    readRecords().then(async (records) => {
      let updated = null;
      const next = records.map((item) => {
        if (item.id !== message.id) return item;
        updated = { ...item, enabled: message.enabled !== false };
        return updated;
      });
      if (updated) {
        if (updated.enabled) await registerUserScript(updated);
        else await unregisterUserScript(updated.id);
      }
      await writeRecords(next);
      sendResponse({ ok: true, script: publicUserScript(updated) });
    }).catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.pageReady") {
    const tabId = sender?.tab?.id;
    void runMatchingScripts(tabId, message.url || sender?.tab?.url || "")
      .then((started) => sendResponse({ ok: true, started }))
      .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.userscript.request") {
    callInstalledPlugin(message, sender).then((result) => sendResponse({ ok: true, result }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.runtime.onStartup.addListener(() => {
  void (async () => {
    const tabs = await chrome.tabs.query({});
    const records = await readRecords();
    await Promise.all(records.filter((record) => record.enabled !== false).map((record) => registerUserScript(record)));
    await Promise.all(tabs.map((tab) => tab.id && tab.url ? runMatchingScripts(tab.id, tab.url) : null));
  })().catch((error) => console.warn("[Fabushi] 用户脚本启动恢复失败", error));
});

// Content-script handshakes can be lost while a service worker is being
// restarted. The tab lifecycle is the second activation signal, so a fully
// loaded matching page is still taken over without requiring a manual reload
// or a click in the Fabushi panel.
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete" || !tab?.url) return;
  void runMatchingScripts(tabId, tab.url).catch((error) => console.warn("[Fabushi] 页面自动接管失败", error));
});

async function reconcileRegisteredScripts() {
  if (reconcilePromise) return reconcilePromise;
  reconcilePromise = (async () => {
    const records = await readRecords();
    await Promise.all(records.filter((record) => record.enabled !== false).map((record) => registerUserScript(record)));
  })().finally(() => {
    reconcilePromise = null;
  });
  return reconcilePromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void reconcileRegisteredScripts().catch((error) => console.warn("[Fabushi] 用户脚本注册恢复失败", error));
});

void reconcileRegisteredScripts().catch((error) => console.warn("[Fabushi] 用户脚本注册初始化失败", error));
