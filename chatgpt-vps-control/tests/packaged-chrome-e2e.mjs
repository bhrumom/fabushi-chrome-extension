#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile
} from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const extensionDir = resolve(process.argv[2] || "");
if (!process.argv[2]) throw new Error("usage: packaged-chrome-e2e.mjs <unpacked-extension-dir>");
await access(join(extensionDir, "manifest.json"), fsConstants.R_OK);

const here = dirname(fileURLToPath(import.meta.url));
const hostScript = join(here, "packaged-chrome-native-host.mjs");
const temp = await mkdtemp(join(tmpdir(), "fabushi-chrome-e2e-"));
const profile = join(temp, "profile");
const statePath = join(temp, "native-state.json");
const hostExecutable = join(temp, "native-host");
await mkdir(profile, { recursive: true });
await writeFile(statePath, JSON.stringify({
  sendPromptCount: 0,
  resumeCount: 0,
  browserToolResultCount: 0,
  transcript: [],
  runId: "run-packaged-e2e",
  generation: "generation-1",
  active: false,
  finalSent: false
}, null, 2) + "\n");

const browserCandidates = [
  process.env.CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser"
].filter(Boolean);

let chromeBin = "";
for (const candidate of browserCandidates) {
  try {
    await access(candidate, fsConstants.X_OK);
    chromeBin = candidate;
    break;
  } catch {}
}
if (!chromeBin) throw new Error("Chrome/Chromium executable not found");

const quote = (value) => "'" + String(value).replaceAll("'", "'\\''") + "'";
await writeFile(
  hostExecutable,
  `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(hostScript)}\n`
);
await chmod(hostExecutable, 0o755);

class CdpPipe {
  constructor(child) {
    this.child = child;
    this.nextId = 0;
    this.pending = new Map();
    this.buffer = Buffer.alloc(0);
    child.stdio[4].on("data", (chunk) => this.onData(chunk));
  }

  onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (true) {
      const end = this.buffer.indexOf(0);
      if (end < 0) return;
      const raw = this.buffer.subarray(0, end).toString("utf8");
      this.buffer = this.buffer.subarray(end + 1);
      if (!raw) continue;
      let message;
      try { message = JSON.parse(raw); }
      catch { continue; }
      if (!message.id) continue;
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method}: ${message.error.message || JSON.stringify(message.error)}`));
      else pending.resolve(message.result || {});
    }
  }

  send(method, params = {}, sessionId) {
    const id = ++this.nextId;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, 15_000);
      this.pending.set(id, { resolve: resolvePromise, reject, timer, method });
      this.child.stdio[3].write(Buffer.from(JSON.stringify(message) + "\0"));
    });
  }
}

function sleep(ms) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function waitFor(check, label, timeoutMs = 20_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

async function readState() {
  return JSON.parse(await readFile(statePath, "utf8"));
}

let stderr = "";
const child = spawn(chromeBin, [
  "--no-sandbox",
  "--disable-gpu",
  "--disable-dev-shm-usage",
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-background-networking",
  "--disable-component-update",
  "--disable-sync",
  "--metrics-recording-only",
  `--user-data-dir=${profile}`,
  `--disable-extensions-except=${extensionDir}`,
  `--load-extension=${extensionDir}`,
  "--remote-debugging-pipe",
  "about:blank"
], {
  stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
  env: { ...process.env, FABUSHI_E2E_STATE: statePath }
});
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

const cdp = new CdpPipe(child);

async function targets() {
  return (await cdp.send("Target.getTargets")).targetInfos || [];
}

async function extensionWorker() {
  const infos = await targets();
  return infos.find((target) => target.type === "service_worker" && /^chrome-extension:\/\//.test(target.url));
}

async function openApp(extensionId) {
  const url = `chrome-extension://${extensionId}/app.html`;
  const created = await cdp.send("Target.createTarget", { url });
  const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  await waitFor(
    async () => (await evaluate(sessionId, "document.readyState")).value === "complete",
    "app page load"
  );
  return { targetId: created.targetId, sessionId, url };
}

async function evaluate(sessionId, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  }, sessionId);
  if (result.exceptionDetails) {
    const description = result.exceptionDetails.exception?.description
      || result.exceptionDetails.exception?.value
      || result.exceptionDetails.text
      || "Runtime.evaluate failed";
    throw new Error(String(description));
  }
  return result.result || {};
}

async function textContent(sessionId, selector) {
  return (await evaluate(sessionId, `document.querySelector(${JSON.stringify(selector)})?.textContent || ""`)).value || "";
}

async function waitNative(page) {
  await evaluate(page.sessionId, `new Promise((resolve) => {
    try {
      const maybe = chrome.runtime.sendMessage({type:"fabushi.platform.reconnect"}, (response) => resolve(response ?? true));
      if (maybe && typeof maybe.then === "function") maybe.then(resolve, () => resolve(false));
    } catch {
      resolve(false);
    }
  })`);
  await evaluate(page.sessionId, `document.querySelector("#agent-reconnect-runtime")?.click(); true`);
  await waitFor(async () => (await textContent(page.sessionId, "#agent-transport-state")).includes("native connected"), "native Coordinator connection", 25_000);
  await waitFor(async () => (await textContent(page.sessionId, "#chat-list")).includes("Packaged Agent"), "Agent roster", 25_000);
}

async function exampleTabCount(page) {
  return Number((await evaluate(page.sessionId, `new Promise((resolve) => {
    try {
      const done = (tabs) => resolve((tabs || []).filter((tab) => String(tab.url || "").startsWith("https://example.com/")).length);
      const maybe = chrome.tabs.query({}, done);
      if (maybe && typeof maybe.then === "function") maybe.then(done, () => resolve(0));
    } catch {
      resolve(0);
    }
  })`)).value || 0);
}

try {
  const firstWorker = await waitFor(extensionWorker, "initial extension Service Worker", 25_000);
  const extensionId = new URL(firstWorker.url).host;
  assert.match(extensionId, /^[a-p]{32}$/);

  const hostManifest = {
    name: "com.fabushi.chrome_platform",
    description: "Fabushi packaged Chrome E2E native Coordinator fixture",
    path: hostExecutable,
    type: "stdio",
    allowed_origins: [`chrome-extension://${extensionId}/`]
  };

  const hostDirs = [
    join(homedir(), ".config", "google-chrome", "NativeMessagingHosts"),
    join(homedir(), ".config", "chromium", "NativeMessagingHosts")
  ];
  for (const directory of hostDirs) {
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "com.fabushi.chrome_platform.json"), JSON.stringify(hostManifest, null, 2) + "\n");
  }

  let page = await openApp(extensionId);
  await waitNative(page);

  await evaluate(page.sessionId, `document.querySelector("#chat-list button")?.click(); true`);
  await waitFor(async () => (await textContent(page.sessionId, "#conversation-title")).includes("Packaged Agent"), "Agent open");

  await evaluate(page.sessionId, `(() => {
    const input = document.querySelector("#composer-input");
    input.value = "Create one real browser tab and continue after recovery.";
    document.querySelector("#composer").requestSubmit();
    return true;
  })()`);

  await waitFor(async () => (await readState()).sendPromptCount === 1, "single prompt dispatch");
  await waitFor(async () => (await readState()).browserToolResultCount >= 1, "Browser Runner result", 25_000);
  await waitFor(async () => (await exampleTabCount(page)) === 1, "single real Chrome tab", 25_000);

  // Close and reopen the full extension app while the durable run is still active.
  await cdp.send("Target.closeTarget", { targetId: page.targetId });
  page = await openApp(extensionId);
  await waitNative(page);
  await waitFor(async () => (await readState()).resumeCount >= 1, "app-reopen Coordinator resume", 25_000);
  assert.equal((await readState()).sendPromptCount, 1);
  assert.equal(await exampleTabCount(page), 1, "app reopen must not execute Browser Runner twice");

  // Terminate the MV3 Service Worker, then reopen the app. The second resume
  // is the signal for the fixture to publish the terminal transcript.
  const workerBeforeRestart = await waitFor(extensionWorker, "Service Worker before restart");
  await cdp.send("Target.closeTarget", { targetId: workerBeforeRestart.targetId });
  await cdp.send("Target.closeTarget", { targetId: page.targetId });

  await waitFor(async () => {
    const worker = await extensionWorker();
    return !worker || worker.targetId !== workerBeforeRestart.targetId;
  }, "old Service Worker termination", 10_000);

  page = await openApp(extensionId);
  await waitNative(page);
  await waitFor(async () => (await readState()).resumeCount >= 2, "Service Worker recovery Coordinator resume", 25_000);
  await waitFor(async () => (await textContent(page.sessionId, "#agent-run-state")).includes("completed"), "terminal completed phase", 25_000);
  await waitFor(async () => (await textContent(page.sessionId, "#messages")).includes("Packaged recovery completed"), "final transcript", 25_000);

  const finalState = await readState();
  assert.equal(finalState.sendPromptCount, 1, "prompt must not be sent twice");
  assert.ok(finalState.browserToolResultCount >= 2, "replayed Browser Runner call should replay its durable result");
  assert.equal(await exampleTabCount(page), 1, "replayed Browser Runner call must not create a duplicate tab");
  assert.equal(finalState.finalSent, true);

  console.log(JSON.stringify({
    extensionId,
    source: "packaged",
    sendPromptCount: finalState.sendPromptCount,
    resumeCount: finalState.resumeCount,
    browserToolResultCount: finalState.browserToolResultCount,
    exampleTabCount: await exampleTabCount(page),
    phase: await textContent(page.sessionId, "#agent-run-state")
  }));
} finally {
  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => child.once("exit", resolvePromise)),
    sleep(3_000)
  ]);
  if (child.exitCode == null) child.kill("SIGKILL");
  if (process.env.FABUSHI_KEEP_E2E_TEMP !== "1") await rm(temp, { recursive: true, force: true });
  if (child.exitCode && child.exitCode !== 0) {
    process.stderr.write(stderr.slice(-12_000));
  }
}
