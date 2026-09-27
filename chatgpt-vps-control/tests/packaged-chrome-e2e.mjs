#!/usr/bin/env node
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
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
const packagedManifest = JSON.parse(await readFile(join(extensionDir, "manifest.json"), "utf8"));
const packagedProvenance = JSON.parse(await readFile(join(extensionDir, "fabushi-build-provenance.json"), "utf8"));
const evidenceDir = process.env.FABUSHI_E2E_EVIDENCE_DIR
  ? resolve(process.env.FABUSHI_E2E_EVIDENCE_DIR)
  : "";
if (evidenceDir) await mkdir(evidenceDir, { recursive: true });

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

  send(method, params = {}, sessionId, timeoutMs = 15_000) {
    const id = ++this.nextId;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolvePromise, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
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

function unpackedExtensionId(pathname) {
  const digest = createHash("sha256").update(resolve(pathname), "utf8").digest();
  let id = "";
  for (const byte of digest.subarray(0, 16)) {
    id += String.fromCharCode(97 + ((byte >> 4) & 15));
    id += String.fromCharCode(97 + (byte & 15));
  }
  return id;
}

const extensionId = unpackedExtensionId(extensionDir);
assert.match(extensionId, /^[a-p]{32}$/);

const hostManifest = {
  name: "com.fabushi.chrome_platform",
  description: "Fabushi packaged Chrome E2E native Coordinator fixture",
  path: hostExecutable,
  type: "stdio",
  allowed_origins: [`chrome-extension://${extensionId}/`]
};

const hostDirs = [
  join(profile, "NativeMessagingHosts"),
  join(homedir(), ".config", "google-chrome", "NativeMessagingHosts"),
  join(homedir(), ".config", "google-chrome-for-testing", "NativeMessagingHosts"),
  join(homedir(), ".config", "chromium", "NativeMessagingHosts")
];
for (const directory of hostDirs) {
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "com.fabushi.chrome_platform.json"), JSON.stringify(hostManifest, null, 2) + "\n");
}

let stderr = "";
let child = null;
let cdp = null;

function launchChrome({ loadExtension = false } = {}) {
  const args = [
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
    "--enable-unsafe-extension-debugging",
    ...(loadExtension ? [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
    ] : []),
    "--remote-debugging-pipe",
    "about:blank"
  ];
  child = spawn(chromeBin, args, {
    stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"],
    env: { ...process.env, FABUSHI_E2E_STATE: statePath }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  cdp = new CdpPipe(child);
}

async function stopChrome() {
  const running = child;
  if (!running) return;
  if (running.exitCode == null && running.signalCode == null) running.kill("SIGTERM");
  await Promise.race([
    new Promise((resolvePromise) => running.once("exit", resolvePromise)),
    sleep(3_000)
  ]);
  if (running.exitCode == null && running.signalCode == null) running.kill("SIGKILL");
  child = null;
  cdp = null;
}

launchChrome();

async function targets() {
  return (await cdp.send("Target.getTargets")).targetInfos || [];
}

async function waitForCdpReady() {
  await waitFor(async () => {
    try {
      const version = await cdp.send("Browser.getVersion", {}, undefined, 3_000);
      return Boolean(version?.product);
    } catch {
      return false;
    }
  }, "Chrome CDP ready", 25_000, 150);
}

async function loadExactExtension() {
  await waitForCdpReady();
  let lastError;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const loaded = await cdp.send("Extensions.loadUnpacked", { path: extensionDir }, undefined, 30_000);
      assert.equal(String(loaded?.id || ""), extensionId, "Chrome loaded a different unpacked extension identity");
      return loaded;
    } catch (error) {
      lastError = error;
      if (attempt === 0) await sleep(500);
    }
  }
  throw lastError;
}

async function extensionIdFromProfile() {
  for (const fileName of ["Secure Preferences", "Preferences"]) {
    try {
      const preferences = JSON.parse(await readFile(join(profile, "Default", fileName), "utf8"));
      const settings = preferences?.extensions?.settings;
      if (!settings || typeof settings !== "object") continue;
      for (const [extensionId, setting] of Object.entries(settings)) {
        if (!setting || typeof setting !== "object") continue;
        const configuredPath = typeof setting.path === "string" ? resolve(setting.path) : "";
        const manifestName = String(setting.manifest?.name || "");
        if (
          setting.state !== 0
          && (configuredPath === extensionDir || manifestName === "Fabushi")
        ) {
          return extensionId;
        }
      }
    } catch {}
  }
  return "";
}

async function extensionWorker(extensionId) {
  const infos = await targets();
  const prefix = `chrome-extension://${extensionId}/`;
  return infos.find((target) => target.type === "service_worker" && target.url.startsWith(prefix));
}

async function extensionIdFromManager() {
  const created = await cdp.send("Target.createTarget", { url: "chrome://extensions/" });
  const attached = await cdp.send("Target.attachToTarget", { targetId: created.targetId, flatten: true });
  const sessionId = attached.sessionId;
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Page.enable", {}, sessionId);
  try {
    await waitFor(
      async () => (await evaluate(sessionId, "document.readyState")).value === "complete",
      "chrome extensions manager load",
      10_000
    );
    return await waitFor(async () => {
      const result = (await evaluate(sessionId, `(() => {
        const manager = document.querySelector("extensions-manager");
        const list = manager?.shadowRoot?.querySelector("extensions-item-list");
        const items = [...(list?.shadowRoot?.querySelectorAll("extensions-item") || [])];
        return items.map((item) => ({
          id: item.id || item.data?.id || "",
          name: item.data?.name || item.shadowRoot?.querySelector("#name")?.textContent?.trim() || ""
        }));
      })()`)).value || [];
      const fabushi = result.find((item) => item?.name === "Fabushi");
      return fabushi?.id || "";
    }, "Fabushi in chrome://extensions", 15_000, 250);
  } finally {
    await cdp.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
  }
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
  const identity = (await evaluate(sessionId, `({
    runtimeId: globalThis.chrome?.runtime?.id || "",
    title: document.title,
    href: location.href
  })`)).value || {};
  if (identity.runtimeId !== extensionId || identity.title !== "Fabushi") {
    const currentTargets = await targets();
    throw new Error(
      `Opened target is not Fabushi extension app: ${JSON.stringify(identity)}; targets=${JSON.stringify(currentTargets.map(({type,url,title}) => ({type,url,title})))}`
    );
  }
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

async function extensionMessage(page, payload) {
  return (await evaluate(page.sessionId, `new Promise((resolve) => {
    try {
      let settled = false;
      const finish = (response) => {
        if (settled) return;
        settled = true;
        resolve({
          response: response ?? null,
          error: chrome.runtime.lastError?.message || ""
        });
      };
      const maybe = chrome.runtime.sendMessage(${JSON.stringify(payload)}, finish);
      if (maybe && typeof maybe.then === "function") {
        maybe.then(
          (response) => finish(response),
          (error) => {
            if (settled) return;
            settled = true;
            resolve({ response: null, error: error?.message || String(error) });
          }
        );
      }
    } catch (error) {
      resolve({ response: null, error: error?.message || String(error) });
    }
  })`)).value || {};
}

async function waitNative(page) {
  const deadline = Date.now() + 35_000;
  let lastPlatform = {};
  let lastUiState = "";
  let lastDesktopState = "";

  while (Date.now() < deadline) {
    await extensionMessage(page, { type: "fabushi.platform.reconnect" });
    await sleep(150);
    lastPlatform = await extensionMessage(page, { type: "fabushi.platform.status" });
    lastUiState = await textContent(page.sessionId, "#agent-transport-state");

    if (lastPlatform.response?.connected === true && !lastUiState.includes("native connected")) {
      await evaluate(page.sessionId, `document.querySelector("#agent-reconnect-runtime")?.click(); true`);
      await sleep(150);
      lastUiState = await textContent(page.sessionId, "#agent-transport-state");
    }

    lastDesktopState = await textContent(page.sessionId, "#desktop-state");
    if (lastUiState.includes("native connected")) {
      await waitFor(
        async () => (await textContent(page.sessionId, "#chat-list")).includes("Packaged Agent"),
        "Agent roster",
        25_000
      );
      return;
    }
    await sleep(200);
  }

  throw new Error(
    `Timed out waiting for native Coordinator connection; platform=${JSON.stringify(lastPlatform)}; ui=${JSON.stringify(lastUiState)}; desktop=${JSON.stringify(lastDesktopState)}`
  );
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
  // Native Messaging manifest is already present before this browser process
  // starts. Load the exact unpacked verify/ package through Chrome's extension
  // debugging domain, then independently verify chrome.runtime.id in app.html.
  await loadExactExtension();

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
  const workerBeforeRestart = await waitFor(() => extensionWorker(extensionId), "Service Worker before restart");
  await cdp.send("Target.closeTarget", { targetId: workerBeforeRestart.targetId });
  await cdp.send("Target.closeTarget", { targetId: page.targetId });

  await waitFor(async () => {
    const worker = await extensionWorker(extensionId);
    return !worker || worker.targetId !== workerBeforeRestart.targetId;
  }, "old Service Worker termination", 10_000);

  page = await openApp(extensionId);
  await waitNative(page);
  await waitFor(async () => (await readState()).resumeCount >= 2, "Service Worker recovery Coordinator resume", 25_000);
  await waitFor(async () => (await readState()).finalSent === true, "Coordinator terminal settlement", 25_000);
  await waitFor(async () => (await textContent(page.sessionId, "#agent-run-state")).includes("completed"), "terminal completed phase", 25_000);
  await waitFor(async () => (await textContent(page.sessionId, "#messages")).includes("Packaged recovery completed"), "final transcript", 25_000);

  const finalState = await readState();
  assert.equal(finalState.sendPromptCount, 1, "prompt must not be sent twice");
  assert.ok(finalState.browserToolResultCount >= 2, "replayed Browser Runner call should replay its durable result");
  const finalTabCount = await exampleTabCount(page);
  assert.equal(finalTabCount, 1, "replayed Browser Runner call must not create a duplicate tab");
  assert.equal(finalState.finalSent, true);

  const phase = await textContent(page.sessionId, "#agent-run-state");
  const transcriptText = await textContent(page.sessionId, "#messages");
  const browserVersion = await cdp.send("Browser.getVersion");
  const evidence = {
    schemaVersion: 1,
    sourceSha: packagedProvenance.sourceSha,
    extensionVersion: packagedManifest.version,
    extensionId,
    chrome: {
      product: browserVersion.product || "",
      userAgent: browserVersion.userAgent || "",
      protocolVersion: browserVersion.protocolVersion || "",
    },
    runId: finalState.runId,
    generation: finalState.generation,
    sendPromptCount: finalState.sendPromptCount,
    resumeCount: finalState.resumeCount,
    browserToolResultCount: finalState.browserToolResultCount,
    exampleTabCount: finalTabCount,
    phase,
    finalSent: finalState.finalSent,
    transcriptContainsFinal: transcriptText.includes("Packaged recovery completed"),
    lastBrowserResult: finalState.lastBrowserResult || null,
  };

  if (evidenceDir) {
    const screenshot = await cdp.send("Page.captureScreenshot", { format: "png" }, page.sessionId);
    await writeFile(join(evidenceDir, "packaged-chrome-final.png"), Buffer.from(screenshot.data || "", "base64"));
    await writeFile(join(evidenceDir, "packaged-chrome-e2e.json"), JSON.stringify(evidence, null, 2) + "\n");
  }

  console.log(JSON.stringify(evidence));
} finally {
  await stopChrome();
  if (process.env.FABUSHI_KEEP_E2E_TEMP !== "1") await rm(temp, { recursive: true, force: true });
  if (stderr) process.stderr.write(stderr.slice(-12_000));
}
