import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(root, "..");
const extension = join(root, "chrome-platform", "extension");
const require = createRequire(import.meta.url);
const desktopServer = require(join(repo, "desktop", "electron", "chrome-platform-server.cjs"));

async function source(relative) {
  return readFile(join(extension, relative), "utf8");
}

test("Fabushi Chrome platform includes the product shell, browser bridge, and integrated userscript runtime", async () => {
  const manifest = JSON.parse(await source("manifest.json"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.name, "Fabushi");
  assert.equal(manifest.version, "0.5.0");
  assert.equal(manifest.action.default_popup, "app.html");
  assert.equal(manifest.background.service_worker, "service-worker.js");
  for (const permission of ["debugger", "nativeMessaging", "downloads", "tabs", "tabGroups", "webNavigation", "scripting", "userScripts", "storage", "alarms"]) assert.ok(manifest.permissions.includes(permission), permission);
  assert.deepEqual(manifest.host_permissions, ["<all_urls>"]);
  assert.equal(manifest.content_scripts?.[0]?.js?.[0], "userscript-content.js");
  const worker = await source("service-worker.js");
  assert.match(worker, /platform-bridge\.js/);
  assert.match(worker, /browser-control\.js/);
  assert.match(worker, /userscript-runner\.js/);
  assert.match(worker, /platform-bridge\.js/);
  await source("userscript-core.js");
  await source("userscript-runner.js");
  await source("userscript-content.js");
  await source("userscript.css");
  await source("userscript/chatgpt-auto-confirm.user.js");
  await source("marketplace/chatgpt-task-queue.user.js");
});

test("Chrome UI delegates account/product work to desktop Host and exposes safe userscript controls", async () => {
  const app = await source("app.js");
  const bridge = await source("platform-bridge.js");
  assert.match(bridge, /com\.fabushi\.chrome_platform/);
  assert.match(app, /feature\.auth\.status/);
  assert.match(app, /feature\.marketplace\.browse/);
  assert.match(app, /desktop\.settings\.open/);
  assert.match(app, /fabushi\.userscript\.install/);
  assert.match(app, /fabushi\.userscript\.setEnabled/);
  assert.match(app, /fabushi\.userscript\.uninstall/);
  assert.match(app, /userscript-chatgpt-task-queue/);
  assert.doesNotMatch(`${app}\n${bridge}`, /refreshToken|refresh_token|password\s*[:=]|accessToken\s*[:=]/);
});

test("desktop platform bridge forces Chrome Marketplace platform and blocks credential/session mutation", () => {
  const browse = desktopServer.sanitizeRequest("feature.marketplace.browse", { platform: "desktop", query: "bot" });
  assert.equal(browse.params.platform, "chrome-extension");
  const install = desktopServer.sanitizeRequest("feature.plugin.install", { platform: "desktop", release: { pluginId: "demo" } });
  assert.equal(install.params.platform, "chrome-extension");
  for (const type of ["secret.provide", "session.clear", "update.install"]) {
    assert.throws(() => desktopServer.sanitizeRequest("feature.execute", { command: { type } }), /cannot execute/);
  }
  assert.throws(() => desktopServer.sanitizeRequest("feature.auth.passwordLogin", {}), /not allowed/);
  const source = require("node:fs").readFileSync(join(repo, "desktop", "electron", "chrome-platform-server.cjs"), "utf8");
  assert.match(source, /requires the published extension ID/);
});

test("desktop browser control uses the current Chrome through the renamed native host and debugger", async () => {
  const browser = await source("browser-control.js");
  assert.match(browser, /com\.fabushi\.browser_control/);
  assert.doesNotMatch(browser, /com\.fabushi\.chatgpt_computer_control/);
  assert.match(browser, /chrome\.tabs\.query/);
  assert.match(browser, /chrome\.debugger\.attach/);
  assert.match(browser, /claim_tab/);
  assert.match(browser, /cdp_auto_attach_frame/);
  assert.match(browser, /generation changed before Fabushi could claim/);
  const browserSession = await readFile(join(root, "lib", "browser-session.js"), "utf8");
  assert.match(browserSession, /kind: "extension"/);
  assert.match(browserSession, /generation: connection\.generation/);
  assert.match(browserSession, /generation: selected\.generation/);
});

test("desktop Host process owns and forwards the Chrome platform server", async () => {
  const host = await readFile(join(repo, "desktop", "electron", "host-process.cjs"), "utf8");
  assert.match(host, /createChromePlatformServer/);
  assert.match(host, /chromePlatformServer\.start/);
  assert.match(host, /chromePlatformServer\.broadcastEvent/);
  assert.match(host, /chromePlatformServer\.close/);
});
