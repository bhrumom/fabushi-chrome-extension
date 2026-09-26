import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { validateMemoryRequest } from "../chrome-platform/extension/userscript-memory-policy.js";
import { CHATGPT_USERSCRIPT_UPDATE_URL, readRecords, runMatchingScripts } from "../chrome-platform/extension/userscript-runner.js";

const manifestPath = new URL("../chrome-platform/extension/manifest.json", import.meta.url);
const recoveryPath = new URL("../chrome-platform/extension/userscript-recovery.js", import.meta.url);

test("Fabushi host keeps only the system awake while an active recovery lease exists", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recovery = await readFile(recoveryPath, "utf8");
  assert.equal(manifest.version, "0.6.23");
  assert.ok(manifest.permissions.includes("power"));
  assert.match(recovery, /requestKeepAwake\(["']system["']\)/);
  assert.doesNotMatch(recovery, /requestKeepAwake\(["']display["']\)/);
  assert.match(recovery, /releaseKeepAwake\(\)/);
  assert.match(recovery, /keepAwakeNeeded/);
  assert.match(recovery, /syncKeepAwake/);
});

test("page-ready activation failure is returned to the bridge and a later retry can start the script", async () => {
  const previousChrome = globalThis.chrome;
  const storage = new Map();
  let executionAttempts = 0;
  let registration;
  const source = `// ==UserScript==\n// @name ChatGPT 自动确认\n// @namespace fabushi\n// @version 2.9.87\n// @match https://chatgpt.com/*\n// @run-at document-start\n// @updateURL ${CHATGPT_USERSCRIPT_UPDATE_URL}\n// @downloadURL ${CHATGPT_USERSCRIPT_UPDATE_URL}\n// @grant none\n// ==/UserScript==\nvoid 0;`;
  globalThis.chrome = {
    storage: { local: {
      async get(keys) { return Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])); },
      async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
    } },
    userScripts: {
      async getScripts() { return []; },
      async register(definitions) { registration = definitions[0]; },
      async execute() {
        executionAttempts += 1;
        if (executionAttempts === 1) throw new Error("temporary injection fault");
      },
    },
  };
  try {
    storage.set("fabushi.userscripts.v1", [{
      id: "chatgpt-auto-confirm-test",
      name: "ChatGPT 自动确认",
      sourcePluginId: "chatgpt-auto-confirm",
      version: "2.9.87",
      source,
      matches: ["https://chatgpt.com/*"],
      excludes: [],
      runAt: "document-idle",
      noFrames: true,
      enabled: true,
    }]);
    storage.set("fabushi.chatgpt-auto-confirm.update-checked-at", Date.now());
    await assert.rejects(
      runMatchingScripts(42, "https://chatgpt.com/c/stuck", { requireSuccessfulMatches: true }),
      /chatgpt-auto-confirm-test.*temporary injection fault/,
    );
    assert.equal(registration.runAt, "document_start", "Fabushi ChatGPT workbench registers for the start of document loading");
    assert.deepEqual(await runMatchingScripts(42, "https://chatgpt.com/c/stuck", { requireSuccessfulMatches: true }), ["chatgpt-auto-confirm-test"]);
    assert.equal(executionAttempts, 2);
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("page-ready bridge retries with backoff, has one in-flight request, and stops after success", async () => {
  const content = await readFile(new URL("../chrome-platform/extension/userscript-content.js", import.meta.url), "utf8");
  let now = 0;
  let interval;
  let calls = 0;
  let currentUrl = "https://chatgpt.com/c/stuck";
  const context = {
    Date: { now: () => now },
    location: { get href() { return currentUrl; } },
    chrome: { runtime: { sendMessage: async () => ({ ok: ++calls >= 3 }) } },
    window: {
      addEventListener() {},
      postMessage() {},
      setInterval(callback) { interval = callback; },
    },
  };
  vm.runInNewContext(content, context);
  const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
  await flush();
  now = 999;
  interval();
  await flush();
  assert.equal(calls, 1);
  now = 1_000;
  interval();
  await flush();
  assert.equal(calls, 2);
  now = 2_999;
  interval();
  await flush();
  assert.equal(calls, 2);
  now = 3_000;
  interval();
  await flush();
  assert.equal(calls, 3);
  now = 60_000;
  interval();
  await flush();
  assert.equal(calls, 3, "successful handshake stops polling");
  currentUrl = "https://chatgpt.com/c/next";
  interval();
  await flush();
  assert.equal(calls, 4, "URL changes trigger an immediate handshake");
});

test("an SPA route change during an in-flight page-ready handshake is not lost", async () => {
  const content = await readFile(new URL("../chrome-platform/extension/userscript-content.js", import.meta.url), "utf8");
  let interval;
  let calls = 0;
  let resolveFirst;
  let currentUrl = "https://chatgpt.com/c/old";
  const context = {
    Date: { now: () => 0 },
    location: { get href() { return currentUrl; } },
    chrome: { runtime: { sendMessage: () => {
      calls += 1;
      if (calls === 1) return new Promise((resolve) => { resolveFirst = resolve; });
      return Promise.resolve({ ok: true });
    } } },
    window: { addEventListener() {}, postMessage() {}, setInterval(callback) { interval = callback; } },
  };
  vm.runInNewContext(content, context);
  currentUrl = "https://chatgpt.com/c/new";
  interval();
  assert.equal(calls, 1, "does not overlap the request already in flight");
  resolveFirst({ ok: true });
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2, "sends a fresh handshake after the stale response settles");
});

test("MV3 lifecycle and the recovery watchdog re-synchronize keep-awake state", async () => {
  const recovery = await readFile(recoveryPath, "utf8");
  assert.match(recovery, /periodInMinutes:\s*0\.5/);
  assert.match(recovery, /onStartup/);
  assert.match(recovery, /onInstalled/);
  assert.match(recovery, /service-worker-start/);
  assert.match(recovery, /await syncKeepAwake\(trimmed\)/);
  assert.match(recovery, /await syncKeepAwake\(records/);
});

test("released browser package loads ChatGPT auto-confirm through its stable update URL", async () => {
  const runner = await readFile(new URL("../chrome-platform/extension/userscript-runner.js", import.meta.url), "utf8");
  const app = await readFile(new URL("../chrome-platform/extension/app.js", import.meta.url), "utf8");
  assert.match(runner, /raw\.githubusercontent\.com\/bhrumom\/fabushi-chatgpt-auto-confirm-userscript\/main\/chatgpt-auto-confirm\.user\.js/);
  assert.match(runner, /compareVersions\(remote\.version, current\.version/);
  assert.match(runner, /cache:\s*'no-store'/);
  assert.match(app, /remoteUpdateFallback:\s*true/);
  await assert.rejects(readFile(new URL("../chrome-platform/extension/userscript/chatgpt-auto-confirm.user.js", import.meta.url)));
  await readFile(new URL("../chrome-platform/extension/marketplace/chatgpt-task-queue.user.js", import.meta.url));
});

test("remote userscript upgrades only to a newer version and keeps the last good record on errors", async () => {
  const previousChrome = globalThis.chrome;
  const storage = new Map();
  globalThis.chrome = { storage: { local: {
    async get(keys) { return Object.fromEntries(keys.filter((key) => storage.has(key)).map((key) => [key, storage.get(key)])); },
    async set(values) { for (const [key, value] of Object.entries(values)) storage.set(key, value); },
  } } };
  const key = "fabushi.userscripts.v1";
  const updateKey = "fabushi.chatgpt-auto-confirm.update-checked-at";
  const makeSource = (version) => `// ==UserScript==\n// @name ChatGPT 自动确认\n// @namespace fabushi\n// @version ${version}\n// @match https://chatgpt.com/*\n// @updateURL ${CHATGPT_USERSCRIPT_UPDATE_URL}\n// @downloadURL ${CHATGPT_USERSCRIPT_UPDATE_URL}\n// @grant none\n// ==/UserScript==\nconsole.log(${JSON.stringify(version)});`;
  try {
    storage.set(key, [{ id: "stable-id", sourcePluginId: "chatgpt-auto-confirm", version: "2.9.64", sourcePluginVersion: "2.9.64", source: makeSource("2.9.64"), enabled: false, installedAt: 123, commands: ["keep"] }]);
    let requested;
    const upgraded = await readRecords({ now: 10_000_000, fetcher: async (url, options) => {
      requested = { url, options };
      return { ok: true, text: async () => makeSource("2.9.65") };
    } });
    assert.equal(new URL(requested.url).origin + new URL(requested.url).pathname, CHATGPT_USERSCRIPT_UPDATE_URL);
    assert.equal(requested.options.cache, "no-store");
    assert.equal(upgraded[0].version, "2.9.65");
    assert.equal(upgraded[0].id, "stable-id");
    assert.equal(upgraded[0].installedAt, 123);
    assert.equal(upgraded[0].enabled, false);
    assert.deepEqual(upgraded[0].commands, ["keep"]);

    storage.set(updateKey, 0);
    const equal = await readRecords({ now: 20_000_000, fetcher: async () => ({ ok: true, text: async () => makeSource("2.9.65") }) });
    assert.equal(equal[0].version, "2.9.65");
    storage.set(updateKey, 0);
    const older = await readRecords({ now: 25_000_000, fetcher: async () => ({ ok: true, text: async () => makeSource("2.9.64") }) });
    assert.equal(older[0].version, "2.9.65");
    storage.set(updateKey, 0);
    const offline = await readRecords({ now: 30_000_000, fetcher: async () => { throw new Error("offline"); } });
    assert.equal(offline[0].version, "2.9.65");
  } finally {
    if (previousChrome === undefined) delete globalThis.chrome;
    else globalThis.chrome = previousChrome;
  }
});

test("automatic tab discard accepts elevated pressure only at or above 1 GiB", () => {
  const record = { sourcePluginId: "chatgpt-auto-confirm", enabled: true };
  const tab = { id: 42, url: "https://chatgpt.com/c/example", active: false, discarded: false };
  const message = (pressure, usedBytes = 1024 ** 3) => ({
    pluginId: "chatgpt-auto-confirm",
    payload: {
      capability: "tab-memory-discard",
      pressure,
      usedBytes,
      safeToDiscard: true,
    },
  });

  assert.equal(validateMemoryRequest(message("elevated"), { record, tab }).reason, "ready");
  assert.equal(validateMemoryRequest(message("elevated", 1024 ** 3 - 1), { record, tab }).reason, "pressure-not-elevated");
  assert.equal(validateMemoryRequest(message("high", 0), { record, tab }).reason, "ready", "high pressure retains its existing eligibility");
  assert.equal(validateMemoryRequest(message("normal", 0), { record, tab }).reason, "pressure-not-elevated");
  assert.equal(validateMemoryRequest(message("elevated"), { record, tab: { ...tab, active:true } }).reason, "active-tab");
  assert.equal(validateMemoryRequest({ ...message("elevated"), payload:{ ...message("elevated").payload, safeToDiscard:false } }, { record, tab }).reason, "unsafe-state");
  assert.equal(validateMemoryRequest({ ...message("normal"), payload:{ ...message("normal").payload, userInitiated:true } }, { record, tab }).reason, "ready", "manual requests remain pressure independent");
});
