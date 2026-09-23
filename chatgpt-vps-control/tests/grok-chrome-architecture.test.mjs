import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "chrome-platform", "extension");
const source = (name) => readFile(join(extension, name), "utf8");

test("toolbar opens the full extension app instead of using app.html as a popup", async () => {
  const manifest = JSON.parse(await source("manifest.json"));
  assert.equal(manifest.version, "0.7.0");
  assert.equal(manifest.action.default_popup, undefined);

  const broker = await source("agent-broker.js");
  assert.match(broker, /chrome\.action\.onClicked\.addListener/);
  assert.match(broker, /chrome\.runtime\.getURL\("app\.html"\)/);
  assert.match(broker, /chrome\.tabs\.create/);
});

test("Agent renderer uses a typed platform runtime and the worker remains a broker", async () => {
  const runtime = await source("extension-runtime.js");
  const workspace = await source("agent-workspace.js");
  const broker = await source("agent-broker.js");
  const transports = await source("coordinator-transports.js");

  assert.match(runtime, /fabushi\.agent\.attach/);
  assert.match(runtime, /fabushi\.agent\.call/);
  assert.doesNotMatch(workspace, /chrome\.runtime\.sendMessage/);

  assert.match(broker, /transportRouter\.call/);
  assert.match(broker, /COORDINATOR_PROTOCOL_VERSION/);
  assert.match(broker, /chrome\.storage\.local/);
  assert.match(transports, /coordinator\.call/);
  assert.match(transports, /"unknown"/);
});

test("unknown delivery never falls back to a duplicate legacy send", async () => {
  const workspace = await source("agent-workspace.js");
  assert.match(workspace, /error\?\.code !== "coordinator-unavailable" \|\| error\?\.delivery !== "not-sent"/);
  assert.match(workspace, /will resync this run instead of sending the prompt/);
});

test("existing Chrome-native capabilities remain imported beside the Agent broker", async () => {
  const worker = await source("service-worker.js");
  for (const module of [
    "platform-bridge.js",
    "browser-control.js",
    "account-browser-agent.js",
    "userscript-recovery.js",
    "userscript-navigation-guard.js",
    "userscript-runner.js",
    "marketplace-update-check.js",
    "agent-broker.js",
  ]) {
    assert.match(worker, new RegExp(module.replace(".", "\\.")));
  }
});

test("Grok-shaped workspace projects lifecycle MCP tools and Browser context", async () => {
  const html = await source("app.html");
  const workspace = await source("agent-workspace.js");

  assert.match(html, /id="agent-run-state"/);
  assert.match(html, /id="agent-transport-state"/);
  assert.match(html, /id="agent-mcp-list"/);
  assert.match(html, /id="agent-browser-context"/);

  assert.match(workspace, /listRoutedMcpTools/);
  assert.match(workspace, /getAgentTranscriptWindow/);
  assert.match(workspace, /sendPrompt/);
  assert.match(workspace, /client-side-tool-v2/);
});


test("app reload recovery reclaims the latest durable cursor and asks transport to resume it", async () => {
  const broker = await source("agent-broker.js");
  const transports = await source("coordinator-transports.js");
  assert.match(broker, /latestRecoveryCursor/);
  assert.match(broker, /recoverClient/);
  assert.match(broker, /recoveredFromPreviousView/);
  assert.match(broker, /transportRouter\.resume/);
  assert.match(transports, /coordinator\.resume/);
  assert.match(broker, /runId:\s*cursor\.fence\?\.runId/);
  assert.match(broker, /generation:\s*cursor\.fence\?\.generation/);
  assert.match(broker, /sequence:\s*Number\(cursor\.fence\?\.sequence/);
});


test("shipping Agent workspace has one Coordinator client and no hidden legacy chat fallback", async () => {
  const app = await source("app.js");
  const workspace = await source("agent-workspace.js");
  assert.doesNotMatch(workspace, /feature\.execute|chat\.send|legacy-native|handleLegacyPlatformEvent/);
  assert.doesNotMatch(app, /conversation\.listed|conversation\.opened|chat\.delta|handlePlatformEvent/);
  assert.match(app, /createAgentWorkspace/);
});


test("Chrome-native attachments use staging references instead of arbitrary local paths", async () => {
  const html = await source("app.html");
  const runtime = await source("extension-runtime.js");
  const workspace = await source("agent-workspace.js");
  const broker = await source("agent-broker.js");
  const transports = await source("coordinator-transports.js");

  assert.match(html, /id="attachment-input"/);
  assert.match(html, /id="attachment-tray"/);
  assert.match(workspace, /stageFiles/);
  assert.match(workspace, /dragover/);
  assert.match(workspace, /clipboardData/);
  assert.match(workspace, /attachmentPaths:\s*promptAttachments\.map/);
  assert.doesNotMatch(workspace, /webkitRelativePath|file\.path|showOpenFilePicker/);
  assert.match(runtime, /fabushi\.agent\.attachment\.stage/);
  assert.match(broker, /MAX_ATTACHMENT_BYTES = 8 \* 1024 \* 1024/);
  assert.match(broker, /ALLOWED_ATTACHMENT_MIME/);
  assert.match(transports, /coordinator\.attachment\.stage/);
});


test("shipping remote Coordinator is authenticated, service-worker-only, and registered before the broker", async () => {
  const worker = await source("service-worker.js");
  const remote = await source("remote-coordinator.js");
  const account = await source("account-browser-agent.js");
  const runtime = await source("extension-runtime.js");
  const workspace = await source("agent-workspace.js");

  assert.match(worker, /remote-coordinator\.js/);
  assert.ok(worker.indexOf('account-browser-agent.js') < worker.indexOf('remote-coordinator.js'));
  assert.ok(worker.indexOf('remote-coordinator.js') < worker.indexOf('agent-broker.js'));

  assert.match(remote, /wss:\/\/fabushi-mcp\.ombhrum\.com\/coordinator/);
  assert.match(remote, /kind:\s*["']authenticate["']/);
  assert.match(remote, /accessToken:\s*current\.accessToken/);
  assert.match(remote, /clearPending\(lastError\)/);
  assert.doesNotMatch(remote, /\?accessToken=|searchParams\.set\([^)]*token/i);

  assert.match(account, /__fabushiGetCoordinatorAccountSession/);
  assert.doesNotMatch(`${runtime}\n${workspace}`, /__fabushiGetCoordinatorAccountSession|short-lived-token|accessToken:\s*current\.accessToken/);
});
