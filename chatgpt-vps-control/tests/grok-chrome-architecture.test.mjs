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

  assert.match(runtime, /fabushi\.agent\.attach/);
  assert.match(runtime, /fabushi\.agent\.call/);
  assert.doesNotMatch(workspace, /chrome\.runtime\.sendMessage/);

  assert.match(broker, /coordinator\.call/);
  assert.match(broker, /COORDINATOR_PROTOCOL_VERSION/);
  assert.match(broker, /chrome\.storage\.local/);
  assert.match(broker, /delivery = "unknown"/);
});

test("unknown delivery never falls back to a duplicate legacy send", async () => {
  const workspace = await source("agent-workspace.js");
  assert.match(workspace, /error\?\.code !== "coordinator-unavailable" \|\| error\?\.delivery !== "not-sent"/);
  assert.match(workspace, /will resync this run instead of sending the prompt again/);
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
  assert.match(broker, /latestRecoveryCursor/);
  assert.match(broker, /recoverClient/);
  assert.match(broker, /recoveredFromPreviousView/);
  assert.match(broker, /coordinator\.resume/);
  assert.match(broker, /runId:\s*cursor\.fence\?\.runId/);
  assert.match(broker, /generation:\s*cursor\.fence\?\.generation/);
  assert.match(broker, /sequence:\s*Number\(cursor\.fence\?\.sequence/);
});
