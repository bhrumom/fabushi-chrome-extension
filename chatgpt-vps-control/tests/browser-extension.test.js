import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFile, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  ExtensionCdpClient,
  browserExtensionRequest,
  listBrowserExtensionConnections,
  startBrowserExtensionBridge,
  stopBrowserExtensionBridgeForTests,
} from "../lib/browser-extension-bridge.js";
import { browserExtensionPaths, NATIVE_HOST_NAME } from "../lib/browser-extension-paths.js";
import { browserExtensionStatus, CHROME_PLATFORM_NATIVE_HOST_NAME, installBrowserExtension, quarantineLegacyBrowserExtension, unregisterLegacyNativeMessaging } from "../lib/browser-extension-install.js";
import { browserSessionCua, browserSessionUtility, listBrowserSessions } from "../lib/browser-session.js";

function lineClient(path) {
  const socket = connect(path);
  let buffer = "";
  const messages = [];
  const handlers = [];
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    while (buffer.includes("\n")) {
      const index = buffer.indexOf("\n");
      const message = JSON.parse(buffer.slice(0, index));
      messages.push(message);
      for (const handler of handlers) handler(message);
      buffer = buffer.slice(index + 1);
    }
  });
  return { socket, messages, onMessage: (handler) => handlers.push(handler) };
}

function writeNativeMessage(stream, message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  stream.write(Buffer.concat([header, body]));
}

async function waitFor(check, timeout = 2_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = check();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for browser extension test event.");
}

test("browser extension install creates a stable first-class platform and two allow-listed native hosts", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-install-"));
  const nativeDir = join(root, "native-manifests");
  const oldHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  const oldPublishedId = process.env.FABUSHI_CHROME_EXTENSION_ID;
  process.env.COMPUTER_BROWSER_EXTENSION_HOME = join(root, "bridge");
  try {
    const privateHost = join(root, "private-runtime", "scripts", "browser-extension-host.mjs");
    const runtimeInstaller = async () => ({ root: resolve("."), browserHostPath: privateHost });
    const first = await installBrowserExtension({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: nativeDir }], runtimeInstaller });
    const second = await installBrowserExtension({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: nativeDir }], runtimeInstaller });
    assert.equal(first.extensionId, second.extensionId);
    assert.match(first.extensionId, /^[a-p]{32}$/);
    const manifest = JSON.parse(await readFile(join(first.extension, "manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, 3);
    assert.ok(manifest.permissions.includes("nativeMessaging"));
    assert.ok(manifest.permissions.includes("debugger"));
    assert.ok(manifest.permissions.includes("tabGroups"));
    assert.ok(manifest.permissions.includes("webNavigation"));
    assert.ok(manifest.permissions.includes("scripting"));
    assert.ok(manifest.permissions.includes("userScripts"));
    assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
    assert.equal(manifest.content_scripts?.[0]?.js?.[0], "userscript-content.js");
    const browserNative = JSON.parse(await readFile(join(nativeDir, `${NATIVE_HOST_NAME}.json`), "utf8"));
    const platformNative = JSON.parse(await readFile(join(nativeDir, `${CHROME_PLATFORM_NATIVE_HOST_NAME}.json`), "utf8"));
    assert.deepEqual(browserNative.allowed_origins, [`chrome-extension://${first.extensionId}/`]);
    assert.deepEqual(platformNative.allowed_origins, [`chrome-extension://${first.extensionId}/`]);
    assert.equal(browserNative.type, "stdio");
    assert.equal(platformNative.type, "stdio");
    const launcher = await readFile(first.launcher, "utf8");
    const platformLauncher = await readFile(first.platformLauncher, "utf8");
    assert.ok(launcher.includes(privateHost));
    assert.match(platformLauncher, /chrome-platform-host\.mjs/);
    assert.equal(first.runtime, resolve("."));
    const status = await browserExtensionStatus();
    assert.equal(status.installed, true);
    assert.equal(status.platform, "chrome-extension");
    assert.equal(status.version, "0.6.0");
    assert.equal(status.publishedExtensionId, null);

    // A production install must explicitly bind the native hosts to the Web
    // Store ID. Reusing the generated key is allowed only when that exact ID
    // is supplied as the configured published identity.
    process.env.FABUSHI_CHROME_EXTENSION_ID = first.extensionId;
    const published = await installBrowserExtension({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: nativeDir }], runtimeInstaller });
    assert.equal(published.publishedExtensionId, first.extensionId);
    assert.equal((await browserExtensionStatus()).publishedExtensionId, first.extensionId);
  } finally {
    if (oldHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME; else process.env.COMPUTER_BROWSER_EXTENSION_HOME = oldHome;
    if (oldPublishedId === undefined) delete process.env.FABUSHI_CHROME_EXTENSION_ID; else process.env.FABUSHI_CHROME_EXTENSION_ID = oldPublishedId;
    await rm(root, { recursive: true, force: true });
  }
});

test("private browser bridge authenticates native hosts and correlates extension requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-bridge-"));
  const oldHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  const oldSessions = process.env.COMPUTER_BROWSER_SESSION_DIR;
  process.env.COMPUTER_BROWSER_EXTENSION_HOME = root;
  process.env.COMPUTER_BROWSER_SESSION_DIR = join(root, "sessions");
  const paths = browserExtensionPaths();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(paths.secret, "test-secret-at-least-thirty-two-characters\n", { mode: 0o600 });
    await startBrowserExtensionBridge();
    const client = lineClient(paths.socket);
    await new Promise((resolve, reject) => { client.socket.once("connect", resolve); client.socket.once("error", reject); });
    client.socket.write(`${JSON.stringify({ type: "hello", secret: "test-secret-at-least-thirty-two-characters", instanceId: "instance-test-123", generation: "generation-test-123", browser: "Test Chrome", tabs: [{ id: "7", title: "Signed in", url: "https://example.test/", owner: "user", retained: true }] })}\n`);
    await waitFor(() => client.messages.find((message) => message.type === "hello_ack"));
    assert.equal(listBrowserExtensionConnections()[0].tabs[0].id, "7");
    assert.equal(listBrowserExtensionConnections()[0].generation, "generation-test-123");
    const sessions = await listBrowserSessions();
    const extension = sessions.find((session) => session.kind === "extension");
    assert.ok(extension);
    assert.equal(extension.targets[0].owner, "user");
    assert.match(extension.targets[0].claim, /^[A-Za-z0-9_-]{40,}$/);
    const pending = browserExtensionRequest("instance-test-123", "cdp", { targetId: "7", method: "Page.enable" });
    const request = await waitFor(() => client.messages.find((message) => message.type === "request"));
    client.socket.write(`${JSON.stringify({ type: "response", requestId: request.requestId, ok: true, result: { enabled: true } })}\n`);
    assert.deepEqual(await pending, { enabled: true });

    const extensionCdp = new ExtensionCdpClient("instance-test-123", "7");
    const childPending = extensionCdp.sendSession("child-session-7", "Runtime.evaluate", { expression: "document.title" });
    const childRequest = await waitFor(() => client.messages.find((message) => message.type === "request" && message.params?.sessionId === "child-session-7"));
    assert.equal(childRequest.params.targetId, "7");
    assert.equal(childRequest.params.method, "Runtime.evaluate");
    client.socket.write(`${JSON.stringify({ type: "response", requestId: childRequest.requestId, ok: true, result: { result: { value: "child-frame" } } })}\n`);
    assert.equal((await childPending).result.value, "child-frame");

    const attachPending = extensionCdp.attachFrameTarget("oopif-target-7", "parent-session-7");
    const attachRequest = await waitFor(() => client.messages.find((message) => message.type === "request" && message.command === "cdp_auto_attach_frame"));
    assert.equal(attachRequest.params.targetId, "7");
    assert.equal(attachRequest.params.frameTargetId, "oopif-target-7");
    assert.equal(attachRequest.params.parentSessionId, "parent-session-7");
    client.socket.write(`${JSON.stringify({ type: "response", requestId: attachRequest.requestId, ok: true, result: { sessionId: "oopif-session-7" } })}\n`);
    assert.deepEqual(await attachPending, { sessionId: "oopif-session-7" });

    let captureAttempts = 0;
    const cdpRequests = [];
    client.onMessage((message) => {
      if (message.type !== "request") return;
      let result = {};
      let ok = true;
      let error = "";
      if (message.command === "list_tabs") result = { tabs: [{ id: "7", title: "Signed in", url: "https://example.test/", owner: "user", retained: true }] };
      if (message.command === "cdp") {
        cdpRequests.push(message.params);
        if (message.params?.method === "Runtime.evaluate") result = { result: { value: "signed-in page text" } };
        if (message.params?.method === "Page.captureScreenshot") {
          captureAttempts += 1;
          if (captureAttempts === 1) { ok = false; error = "CDP Page.captureScreenshot timed out."; }
          else result = { data: Buffer.from("test-png").toString("base64") };
        }
      }
      client.socket.write(`${JSON.stringify({ type: "response", requestId: message.requestId, ok, ...(ok ? { result } : { error }) })}\n`);
    });
    const exported = await browserSessionUtility({
      name: extension.name,
      action: "export_text",
      targetId: extension.targets[0].id,
      targetClaim: extension.targets[0].claim,
    });
    assert.equal(exported.text, "signed-in page text");

    const cua = await browserSessionCua({
      name: extension.name,
      targetId: extension.targets[0].id,
      targetClaim: extension.targets[0].claim,
      actions: [{ action: "move", x: 10, y: 10 }],
    });
    assert.equal(cua.actionCount, 1);
    assert.equal(cua.screenshot?.mimeType, "image/png");
    assert.equal(captureAttempts, 2);
    assert.ok(cdpRequests.some((request) => request.method === "Page.bringToFront"));
    assert.equal(cdpRequests.filter((request) => request.method === "Page.captureScreenshot").at(-1)?.params?.fromSurface, false);
    client.socket.end();
  } finally {
    await stopBrowserExtensionBridgeForTests().catch(() => {});
    if (oldHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME; else process.env.COMPUTER_BROWSER_EXTENSION_HOME = oldHome;
    if (oldSessions === undefined) delete process.env.COMPUTER_BROWSER_SESSION_DIR; else process.env.COMPUTER_BROWSER_SESSION_DIR = oldSessions;
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy native-host cleanup is exact and refuses to move a current Fabushi extension", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-legacy-cleanup-"));
  const oldHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  process.env.COMPUTER_BROWSER_EXTENSION_HOME = join(root, "bridge");
  const paths = browserExtensionPaths();
  const nativeDir = join(root, "native");
  try {
    await mkdir(nativeDir, { recursive: true });
    const legacyPath = join(nativeDir, "com.fabushi.chatgpt_computer_control.json");
    await writeFile(legacyPath, "{}\n");
    const cleanup = await unregisterLegacyNativeMessaging({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: nativeDir }] });
    assert.deepEqual(cleanup.removed, [legacyPath]);
    const extensionDir = paths.extension;
    await mkdir(extensionDir, { recursive: true });
    await writeFile(join(extensionDir, "manifest.json"), JSON.stringify({ name: "Fabushi", version: "0.5.0" }));
    const quarantine = await quarantineLegacyBrowserExtension({ trashDirectory: join(root, "trash") });
    assert.equal(quarantine.moved, false);
    assert.equal(quarantine.reason, "legacy manifest not present");
  } finally {
    if (oldHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME; else process.env.COMPUTER_BROWSER_EXTENSION_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy Bridge install rotates its extension identity without overwriting the legacy source", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-legacy-rotation-"));
  const oldHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  const oldPublishedId = process.env.FABUSHI_CHROME_EXTENSION_ID;
  process.env.COMPUTER_BROWSER_EXTENSION_HOME = join(root, "bridge");
  delete process.env.FABUSHI_CHROME_EXTENSION_ID;
  const paths = browserExtensionPaths();
  try {
    const runtimeInstaller = async () => ({ root: resolve(".") });
    const first = await installBrowserExtension({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: join(root, "native") }], runtimeInstaller });
    const previous = JSON.parse(await readFile(paths.metadata, "utf8"));
    await writeFile(paths.metadata, `${JSON.stringify({ publicKey: previous.publicKey, extensionId: previous.extensionId })}\n`, { mode: 0o600 });
    await mkdir(paths.legacyExtension, { recursive: true });
    await writeFile(join(paths.legacyExtension, "manifest.json"), JSON.stringify({ name: "ChatGPT Computer Control Bridge" }));
    const migrated = await installBrowserExtension({ currentPlatform: "linux", manifestDestinations: [{ browser: "test", directory: join(root, "native-2") }], runtimeInstaller });
    assert.notEqual(migrated.extensionId, first.extensionId);
    const metadata = JSON.parse(await readFile(paths.metadata, "utf8"));
    assert.equal(metadata.legacyExtensionId, first.extensionId);
    assert.equal(JSON.parse(await readFile(join(paths.legacyExtension, "manifest.json"), "utf8")).name, "ChatGPT Computer Control Bridge");
    const quarantine = await quarantineLegacyBrowserExtension({ trashDirectory: join(root, "trash") });
    assert.equal(quarantine.moved, true);
  } finally {
    if (oldHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME; else process.env.COMPUTER_BROWSER_EXTENSION_HOME = oldHome;
    if (oldPublishedId === undefined) delete process.env.FABUSHI_CHROME_EXTENSION_ID; else process.env.FABUSHI_CHROME_EXTENSION_ID = oldPublishedId;
    await rm(root, { recursive: true, force: true });
  }
});

test("native messaging host reconnects and re-registers after the local bridge restarts", async () => {
  const root = await mkdtemp(join(tmpdir(), "browser-extension-reconnect-"));
  const oldHome = process.env.COMPUTER_BROWSER_EXTENSION_HOME;
  process.env.COMPUTER_BROWSER_EXTENSION_HOME = root;
  const paths = browserExtensionPaths();
  let host;
  try {
    await mkdir(root, { recursive: true });
    await writeFile(paths.secret, "reconnect-secret-at-least-thirty-two-characters\n", { mode: 0o600 });
    await startBrowserExtensionBridge();
    host = spawn(process.execPath, [resolve("scripts/browser-extension-host.mjs")], {
      env: { ...process.env, COMPUTER_BROWSER_EXTENSION_HOME: root },
      stdio: ["pipe", "pipe", "pipe"],
    });
    host.stdout.resume();
    host.stderr.resume();
    writeNativeMessage(host.stdin, {
      type: "hello",
      instanceId: "instance-reconnect-123",
      generation: "generation-reconnect-123",
      browser: "Test Chrome",
      tabs: [{ id: "11", title: "Reconnect", url: "https://example.test/" }],
    });
    await waitFor(() => listBrowserExtensionConnections().find((item) => item.instanceId === "instance-reconnect-123"));

    await stopBrowserExtensionBridgeForTests();
    await startBrowserExtensionBridge();
    const reconnected = await waitFor(
      () => listBrowserExtensionConnections().find((item) => item.instanceId === "instance-reconnect-123"),
      4_000,
    );
    assert.equal(reconnected.tabs[0].id, "11");
  } finally {
    host?.kill();
    await stopBrowserExtensionBridgeForTests().catch(() => {});
    if (oldHome === undefined) delete process.env.COMPUTER_BROWSER_EXTENSION_HOME; else process.env.COMPUTER_BROWSER_EXTENSION_HOME = oldHome;
    await rm(root, { recursive: true, force: true });
  }
});

test("packaged extension contains no remotely hosted executable code", async () => {
  const manifest = JSON.parse(await readFile(resolve("extension/manifest.json"), "utf8"));
  const background = await readFile(resolve("extension/background.js"), "utf8");
  assert.equal(manifest.background.service_worker, "background.js");
  assert.doesNotMatch(background, /eval\s*\(|new Function\s*\(|https?:\/\/.*\.js/i);
  assert.match(background, /claim_tab/);
  assert.match(background, /chrome\.debugger\.sendCommand/);
  assert.match(background, /sessionId/);
  assert.match(background, /Target\.setAutoAttach/);
  assert.match(background, /cdp_auto_attach_frame/);
  assert.match(background, /chrome\.storage\.session/);
  assert.match(background, /onCreatedNavigationTarget/);
  assert.match(background, /ensureAutomationGroup/);
  assert.match(background, /HEARTBEAT_ALARM/);
});

test("first-class browser control preserves the legacy Bridge command, action, and event contract", async () => {
  const legacy = await readFile(resolve("extension/background.js"), "utf8");
  const current = await readFile(resolve("chrome-platform/extension/browser-control.js"), "utf8");
  const commands = ["list_tabs", "claim_tab", "cdp", "cdp_auto_attach_frame", "downloads", "tab_action", "create_tab", "cleanup_tabs", "detach"];
  const actions = ["activate_tab", "close_tab", "navigate", "reload", "back", "forward", "retain_tab", "release_tab"];
  for (const command of commands) {
    assert.match(legacy, new RegExp(`\\"${command}\\"`));
    assert.match(current, new RegExp(`\\"${command}\\"`));
  }
  for (const action of actions) {
    assert.match(legacy, new RegExp(`\\"${action}\\"`));
    assert.match(current, new RegExp(`\\"${action}\\"`));
  }
  for (const event of ["Target.attachedToTarget", "Target.detachedFromTarget", "cdp_event"]) {
    assert.ok(legacy.includes(event));
    assert.ok(current.includes(event));
  }
  assert.match(current, /The tab changed before Fabushi could claim it/);
  assert.match(current, /generation changed before Fabushi could claim/);
  assert.match(current, /Only ordinary http\/https tabs can be controlled/);
  const manifest = JSON.parse(await readFile(resolve("chrome-platform/extension/manifest.json"), "utf8"));
  for (const permission of ["debugger", "nativeMessaging", "downloads", "tabs", "tabGroups", "webNavigation", "scripting", "userScripts", "storage", "alarms"]) assert.ok(manifest.permissions.includes(permission), permission);
});
