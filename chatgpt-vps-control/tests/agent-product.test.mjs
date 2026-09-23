import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extension = join(root, "chrome-platform", "extension");
const source = (name) => readFile(join(extension, name), "utf8");

test("Agent product surface includes identity lifecycle attachments plugins connectors and runtime context", async () => {
  const html = await source("app.html");
  const workspace = await source("agent-workspace.js");

  for (const id of [
    "agent-avatar",
    "agent-run-state",
    "agent-transport-state",
    "agent-reconnect-runtime",
    "attachment-input",
    "attachment-tray",
    "agent-account-status",
    "agent-plugin-status",
    "agent-mcp-list",
    "agent-channel-list",
    "agent-browser-context",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));

  assert.match(workspace, /getPluginSyncStatus/);
  assert.match(workspace, /purpose:\s*PLUGIN_AUTH_AGENT_PURPOSE/);
  assert.match(workspace, /getAgentChannels/);
  assert.match(workspace, /refreshChannel/);
  assert.match(workspace, /disconnectChannel/);
  assert.match(workspace, /stageFiles/);
  assert.match(workspace, /reconnectRuntime/);
});

test("waiting-user cards resolve through exact Grok Coordinator contracts", async () => {
  const workspace = await source("agent-workspace.js");

  assert.match(workspace, /resolveLocalToolPermission/);
  assert.match(workspace, /resolveLocalToolPermission\(entry, ["']allow-once["']\)/);
  assert.match(workspace, /resolveLocalToolPermission\(entry, ["']deny["']\)/);
  assert.match(workspace, /resolveAutoReviewApproval/);
  assert.match(workspace, /resolveAutoReviewApproval\(entry, ["']approved["']\)/);
  assert.match(workspace, /resolveAutoReviewApproval\(entry, ["']denied["']\)/);
  assert.match(workspace, /respondToWidget/);
  assert.match(workspace, /submitSecret/);
  assert.match(workspace, /input\.type = ["']password["']/);
  assert.match(workspace, /input\.value = ["']["'];/);
  assert.doesNotMatch(workspace, /state\.(?:secret|password|token)\s*=/i);
});

test("transcript supports reactions and tool/approval cards", async () => {
  const workspace = await source("agent-workspace.js");
  assert.match(workspace, /reactToMessage/);
  assert.match(workspace, /entryId:\s*entry\.id/);
  assert.match(workspace, /emoji/);
  assert.match(workspace, /Tool/);
  assert.match(workspace, /waiting-user/);
});

test("settings expose help about feedback and command navigation", async () => {
  const html = await source("app.html");
  const app = await source("app.js");

  for (const id of ["settings-help", "settings-about-version", "settings-feedback"]) {
    assert.match(html, new RegExp(`id=["']${id}["']`));
  }
  assert.match(app, /executeSearchCommand/);
  assert.match(app, /\/new/);
  assert.match(app, /\/reconnect/);
  assert.match(app, /fabushi-build-provenance\.json/);
  assert.match(app, /fabushi-chrome-extension\/issues\/new/);
});

test("Browser Runner is service-worker-owned capability execution with durable fencing", async () => {
  const worker = await source("service-worker.js");
  const runner = await source("browser-runner.js");
  const broker = await source("agent-broker.js");
  const transports = await source("coordinator-transports.js");

  assert.match(worker, /browser-control\.js/);
  assert.match(worker, /browser-runner\.js/);
  assert.match(worker, /agent-broker\.js/);
  assert.ok(worker.indexOf('browser-control.js') < worker.indexOf('browser-runner.js'));
  assert.ok(worker.indexOf('browser-runner.js') < worker.indexOf('agent-broker.js'));

  assert.match(runner, /fabushiBrowserRunnerStateV1/);
  assert.match(runner, /status:\s*["']started["']/);
  assert.match(runner, /will not execute the Chrome action twice/);
  assert.match(runner, /ToolStarted/);
  assert.match(runner, /ToolCompleted/);
  assert.match(runner, /__fabushiBrowserCommand/);

  assert.match(broker, /__fabushiBrowserRunnerHandleCoordinatorEvent/);
  assert.match(broker, /__fabushiAgentBrokerSendBrowserToolResult/);
  assert.match(transports, /coordinator\.browserToolResult/);
});


test("Grok Agent info projects async tasks outline workflows and automations through Coordinator ownership", async () => {
  const html = await source("app.html");
  const workspace = await source("agent-workspace.js");
  const broker = await source("agent-broker.js");

  for (const id of [
    "agent-async-tasks",
    "agent-conversation-outline",
    "agent-workflows",
    "agent-automations",
  ]) assert.match(html, new RegExp(`id=["']${id}["']`));

  for (const method of [
    "getAsyncTasks",
    "getConversationOutline",
    "getAgentWorkflows",
    "setAgentWorkflowEnabled",
    "getAgentAutomations",
    "setAgentAutomationEnabled",
    "runAgentAutomationNow",
  ]) {
    assert.match(workspace, new RegExp(method));
    assert.match(broker, new RegExp(`["']${method}["']`));
  }

  assert.doesNotMatch(workspace, /setInterval\([^)]*getAsyncTasks|setInterval\([^)]*getAgentAutomations/);
  assert.match(workspace, /family === ["']async-tasks["']/);
  assert.match(workspace, /family === ["']outline["']/);
});
