const API_BASE = "https://api.ombhrum.com";
const GATEWAY_URL = "wss://fabushi-mcp.ombhrum.com/browser-agent";
const SESSION_KEY = "fabushiBrowserAccountSession";
const LOGIN_KEY = "fabushiBrowserLoginAttempt";
const PROFILE_KEY = "fabushiBrowserProfileId";
const RECONNECT_ALARM = "fabushi-account-browser-reconnect";
const LOGIN_ALARM = "fabushi-account-browser-login";
const HEARTBEAT_MS = 20_000;

const commandNames = ["list_tabs", "claim_tab", "cdp", "cdp_auto_attach_frame", "downloads", "tab_action", "create_tab", "cleanup_tabs", "detach", "browser_events"];
const tools = commandNames.map((name) => ({
  name,
  title: `Fabushi Chrome ${name}`,
  description: `Run the fused ChatGPT Computer Control Bridge ${name} command in this signed-in Chrome profile.`,
  inputSchema: { type: "object", additionalProperties: true },
  outputSchema: { type: "object" },
}));

let socket = null;
let heartbeatTimer = null;
let reconnectDelayMs = 500;
let reconnectTimer = null;
let lastError = "";
let account = null;
let loginPromise = null;
let registered = false;
const events = [];
const activeCalls = new Set();

// Keep account material and the in-progress login attempt out of content
// scripts; only trusted extension pages and the service worker can read it.
void Promise.resolve(chrome.storage.session.setAccessLevel?.({ accessLevel: "TRUSTED_CONTEXTS" })).catch(() => {});

async function jsonRequest(path, init = {}) {
  const response = await fetch(`${API_BASE}${path}`, {
    ...init,
    cache: "no-store",
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...(init.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(String(payload?.error?.message || payload?.message || `Fabushi account request failed (${response.status}).`));
  return payload;
}

async function profileId() {
  const stored = await chrome.storage.local.get(PROFILE_KEY);
  if (stored[PROFILE_KEY]) return stored[PROFILE_KEY];
  const id = `chrome-${crypto.randomUUID()}`;
  await chrome.storage.local.set({ [PROFILE_KEY]: id });
  return id;
}

async function session() {
  return (await chrome.storage.session.get(SESSION_KEY))[SESSION_KEY] || null;
}

async function setSession(value) {
  if (value) await chrome.storage.session.set({ [SESSION_KEY]: value });
  else await chrome.storage.session.remove(SESSION_KEY);
}

function closeSocket(reason = "Fabushi Chrome signed out.") {
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearInterval(heartbeatTimer);
  heartbeatTimer = null;
  if (socket) socket.close(1000, reason.slice(0, 120));
  socket = null;
  registered = false;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, reconnectDelayMs);
  reconnectDelayMs = Math.min(reconnectDelayMs * 2, 30_000);
  chrome.alarms.create(RECONNECT_ALARM, { delayInMinutes: 0.5 });
}

function send(message) {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function registerBrowser() {
  return profileId().then((deviceId) => send({
    type: "register",
    deviceId,
    name: `Chrome · ${navigator.platform || "browser"}`,
    platform: "chrome-extension",
    capabilities: commandNames,
    tools,
    leaseSeconds: 7_200,
    metadata: { kind: "chrome-extension" },
  }));
}

async function handleCall(message) {
  const operation = runCall(message);
  activeCalls.add(operation);
  try { await operation; } finally { activeCalls.delete(operation); }
}

async function runCall(message) {
  const requestId = String(message.requestId || "");
  try {
    const result = message.toolName === "browser_events"
      ? { events: events.splice(0, Math.max(1, Math.min(Number(message.arguments?.limit) || 100, 500))) }
      : await globalThis.__fabushiBrowserCommand(String(message.toolName || ""), message.arguments || {});
    send({ type: "result", requestId, ok: true, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
  } catch (error) {
    send({ type: "result", requestId, ok: false, error: error?.message || String(error) });
  }
}

async function connect() {
  if (socket) return;
  const current = await session();
  if (!current?.accessToken) return;
  const active = new WebSocket(GATEWAY_URL);
  socket = active;
  active.onopen = () => send({ type: "authenticate", accessToken: current.accessToken });
  active.onmessage = (event) => {
    let message;
    try { message = JSON.parse(event.data); } catch { return; }
    if (message.type === "authenticated") {
      account = { loggedIn: true, user: { nickname: String(message.accountLabel || "Fabushi") } };
      reconnectDelayMs = 500;
      lastError = "";
      void registerBrowser();
      clearInterval(heartbeatTimer);
      heartbeatTimer = setInterval(() => send({ type: "heartbeat", at: Date.now() }), HEARTBEAT_MS);
      return;
    }
    if (message.type === "registered") registered = true;
    if (message.type === "call") void handleCall(message);
  };
  active.onclose = async (event) => {
    if (socket === active) socket = null;
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
    if (event.code === 4003) {
      lastError = "Fabushi 登录已失效，请重新登录。";
      account = null;
      await setSession(null);
      await Promise.allSettled([...activeCalls]);
      await globalThis.__fabushiBrowserRevokeClaims?.();
    } else if (await session()) scheduleReconnect();
  };
  active.onerror = () => { lastError = "无法连接 Fabushi 官方 MCP。"; };
}

globalThis.__fabushiBrowserEvent = (message) => {
  if (!["tabs", "cdp_event"].includes(message?.type)) return;
  const serialized = JSON.stringify(message);
  events.push(serialized.length <= 256 * 1024
    ? { at: new Date().toISOString(), ...message }
    : { at: new Date().toISOString(), type: "event_overflow", originalType: message.type });
  if (events.length > 500) events.splice(0, events.length - 500);
};

async function pollLogin(started) {
    const expiresAt = Number(started.expiresAt || 0) * 1000 || Number(started.localExpiresAt || 0);
    while (Date.now() < expiresAt) {
      await new Promise((resolve) => setTimeout(resolve, Math.max(500, Number(started.pollAfterMs) || 750)));
      const result = await jsonRequest(`/api/auth/browser/attempts/${encodeURIComponent(started.attemptId)}`, {
        method: "POST",
        body: JSON.stringify({ pollSecret: started.pollSecret }),
      });
      if (result.status === "pending") continue;
      if (result.status !== "completed" || !result.session?.accessToken) throw new Error("Fabushi 登录未完成。");
      const user = await jsonRequest("/api/auth/user-info", { headers: { Authorization: `Bearer ${result.session.accessToken}` } });
      account = { loggedIn: true, user: { id: user.id || user.userId, nickname: user.nickname, username: user.username, email: user.email } };
      await setSession({ accessToken: result.session.accessToken });
      await chrome.storage.session.remove(LOGIN_KEY);
      await chrome.alarms.clear(LOGIN_ALARM);
      await connect();
      return account;
    }
    await chrome.storage.session.remove(LOGIN_KEY);
    await chrome.alarms.clear(LOGIN_ALARM);
    throw new Error("Fabushi 登录已超时，请重试。");
}

async function login() {
  if (loginPromise) return loginPromise;
  loginPromise = (async () => {
    const pending = (await chrome.storage.session.get(LOGIN_KEY))[LOGIN_KEY];
    if (pending) return pollLogin(pending);
    const started = await jsonRequest("/api/auth/browser/start", {
      method: "POST",
      body: JSON.stringify({ deviceId: await profileId(), platform: "web" }),
    });
    const attempt = { ...started, localExpiresAt: Date.now() + 10 * 60_000 };
    await chrome.storage.session.set({ [LOGIN_KEY]: attempt });
    await chrome.alarms.create(LOGIN_ALARM, { periodInMinutes: 0.5 });
    await chrome.tabs.create({ url: String(started.loginUrl), active: true });
    return pollLogin(attempt);
  })().finally(() => { loginPromise = null; });
  return loginPromise;
}

async function logout() {
  closeSocket();
  account = null;
  lastError = "";
  await setSession(null);
  await chrome.storage.session.remove(LOGIN_KEY);
  await chrome.alarms.clear(LOGIN_ALARM);
  await Promise.allSettled([...activeCalls]);
  await globalThis.__fabushiBrowserRevokeClaims?.();
  return { loggedIn: false };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id || !message || !String(message.type || "").startsWith("fabushi.account.")) return false;
  if (message.type === "fabushi.account.status") {
    chrome.storage.session.get(LOGIN_KEY).then((value) => sendResponse({ loggedIn: Boolean(account), loggingIn: Boolean(value[LOGIN_KEY]), account, connected: registered, error: lastError }));
    return true;
  }
  if (message.type === "fabushi.account.login") {
    login().then((result) => sendResponse({ ok: true, account: result }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  if (message.type === "fabushi.account.logout") {
    logout().then((result) => sendResponse({ ok: true, account: result }), (error) => sendResponse({ ok: false, error: error?.message || String(error) }));
    return true;
  }
  return false;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) void connect();
  if (alarm.name === LOGIN_ALARM) void login().catch((error) => { lastError = error?.message || String(error); });
});
void connect();
