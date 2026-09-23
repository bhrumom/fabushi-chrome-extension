import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "chrome-platform", "extension");
const source = (name) => readFile(join(extension, name), "utf8");

test("Browser Control keeps debugger CDP OOPIF download navigation and generation fencing contracts", async () => {
  const manifest = JSON.parse(await source("manifest.json"));
  for (const permission of [
    "debugger", "downloads", "nativeMessaging", "power", "scripting",
    "storage", "tabGroups", "tabs", "userScripts", "webNavigation",
  ]) {
    assert.ok(manifest.permissions.includes(permission), permission);
  }

  const browser = await source("browser-control.js");
  assert.match(browser, /com\.fabushi\.browser_control/);
  assert.match(browser, /chrome\.debugger\.attach/);
  assert.match(browser, /sendCdpCommand/);
  assert.match(browser, /cdp_auto_attach_frame/);
  assert.match(browser, /Target\.attachedToTarget/);
  assert.match(browser, /chrome\.downloads/);
  assert.match(browser, /chrome\.tabs/);
  assert.match(browser, /chrome\.webNavigation/);
  assert.match(browser, /generation changed before Fabushi could claim/);
  assert.match(browser, /STORAGE\.generation/);
});

test("same-account browser MCP keeps trusted session isolation and browser command surface", async () => {
  const account = await source("account-browser-agent.js");
  assert.match(account, /\/api\/auth\/browser\/start/);
  assert.match(account, /\/api\/auth\/browser\/attempts/);
  assert.match(account, /wss:\/\/fabushi-mcp\.ombhrum\.com\/browser-agent/);
  assert.match(account, /chrome\.storage\.session/);
  assert.match(account, /__fabushiBrowserCommand/);
  assert.match(account, /browser_events/);
  assert.doesNotMatch(account, /refreshToken|refresh_token/);
});

test("userscript recovery keeps watchdog lease system keep-awake and navigation guards", async () => {
  const recovery = await source("userscript-recovery.js");
  const guard = await source("userscript-navigation-guard.js");
  const runner = await source("userscript-runner.js");

  assert.match(recovery, /requestKeepAwake\(["']system["']\)/);
  assert.match(recovery, /releaseKeepAwake\(\)/);
  assert.match(recovery, /periodInMinutes:\s*0\.5/);
  assert.match(recovery, /onStartup/);
  assert.match(recovery, /onInstalled/);

  assert.match(guard, /webNavigation|tabs|navigation/i);
  assert.match(runner, /CHATGPT_USERSCRIPT_UPDATE_URL/);
  assert.match(runner, /compareVersions\(remote\.version, current\.version/);
  assert.match(runner, /loadRemoteRecord/);
});

test("Mini Apps Marketplace and userscript management remain in the full extension app", async () => {
  const html = await source("app.html");
  const app = await source("app.js");
  const worker = await source("service-worker.js");

  for (const id of ["miniapps-view", "marketplace-view", "browser-view", "settings-view", "import-userscript"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }

  assert.match(app, /marketplaceInstallAction/);
  assert.match(app, /fabushi\.userscript\.install/);
  assert.match(app, /fabushi\.userscript\.setEnabled/);
  assert.match(app, /fabushi\.userscript\.uninstall/);
  assert.match(app, /sourceArtifactSha256/);

  assert.match(worker, /marketplace-update-check\.js/);
  assert.match(worker, /userscript-runner\.js/);
  assert.match(worker, /userscript-recovery\.js/);
});

test("Native Messaging remains optional and the Agent surface does not expose credentials", async () => {
  const bridge = await source("platform-bridge.js");
  const runtime = await source("extension-runtime.js");
  const workspace = await source("agent-workspace.js");

  assert.match(bridge, /com\.fabushi\.chrome_platform/);
  assert.match(bridge, /platform_hello/);
  assert.match(bridge, /scheduleReconnect/);

  assert.doesNotMatch(`${runtime}\n${workspace}`, /refreshToken|refresh_token|password\s*[:=]|accessToken\s*[:=]/);
  assert.doesNotMatch(workspace, /connectNative|nativeMessaging/);
});


test("same-account browser tool calls are idempotent across Service Worker reconnects", async () => {
  const account = await source("account-browser-agent.js");
  assert.match(account, /CALL_REPLAY_KEY/);
  assert.match(account, /cachedCallResponse\(requestId\)/);
  assert.match(account, /cacheCallResponse\(requestId, response\)/);
  assert.match(account, /activeCalls\.get\(requestId\)/);
  assert.match(account, /already executed; its original result exceeded the durable replay limit/);
  assert.match(account, /chrome\.storage\.session\.set/);
});
