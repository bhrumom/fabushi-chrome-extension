import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function harness() {
  const storage = {};
  const lifecycle = [];
  const sent = [];
  let executions = 0;

  globalThis.chrome = {
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(values) { Object.assign(storage, structuredClone(values)); },
      },
    },
    runtime: {
      async sendMessage(message) { lifecycle.push(structuredClone(message)); },
    },
  };
  globalThis.__fabushiBrowserCommand = async (toolName, args) => {
    executions += 1;
    return { toolName, args, execution: executions };
  };
  globalThis.__fabushiAgentBrokerSendBrowserToolResult = async (result) => {
    sent.push(structuredClone(result));
  };

  const source = await readFile(new URL("../chrome-platform/extension/browser-runner.js", import.meta.url), "utf8");
  await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`);

  return {
    storage,
    lifecycle,
    sent,
    get executions() { return executions; },
    handle: globalThis.__fabushiBrowserRunnerHandleCoordinatorEvent,
  };
}

function call(overrides = {}) {
  return {
    version: 1,
    kind: "call",
    agentId: "agent-1",
    runId: "run-1",
    generation: "g1",
    sequence: 1,
    toolCallId: "tool-1",
    toolName: "list_tabs",
    arguments: {},
    ...overrides,
  };
}

test("Browser Runner executes a toolCallId once and replays its durable result", async () => {
  const h = await harness();
  assert.equal(await h.handle("fabushi-browser-runner", call()), true);
  assert.equal(h.executions, 1);
  assert.equal(h.sent.at(-1).ok, true);
  assert.equal(h.sent.at(-1).toolCallId, "tool-1");

  assert.equal(await h.handle("fabushi-browser-runner", call()), true);
  assert.equal(h.executions, 1);
  assert.equal(h.sent.length, 2);
  assert.deepEqual(h.sent[1], h.sent[0]);

  const events = h.lifecycle.filter((message) => message.family === "browser-runner-lifecycle");
  assert.equal(events.filter((message) => message.payload.event === "ToolStarted").length, 1);
  assert.equal(events.filter((message) => message.payload.event === "ToolCompleted").length, 1);
});

test("Browser Runner refuses to repeat an execution that was only durably marked started before recovery", async () => {
  const h = await harness();
  const stateKey = "fabushiBrowserRunnerStateV1";
  h.storage[stateKey] = {
    fences: {
      "agent-1:run-1": { generation: "g1", sequence: 2, retiredGenerations: [] },
    },
    executions: {
      "agent-1:run-1:g1:tool-2": {
        status: "started",
        agentId: "agent-1",
        runId: "run-1",
        generation: "g1",
        sequence: 2,
        toolCallId: "tool-2",
        toolName: "create_tab",
        updatedAt: Date.now(),
      },
    },
  };

  await h.handle("fabushi-browser-runner", call({
    sequence: 2,
    toolCallId: "tool-2",
    toolName: "create_tab",
    arguments: { url: "https://example.com" },
  }));
  assert.equal(h.executions, 0);
  assert.equal(h.sent.at(-1).ok, false);
  assert.match(h.sent.at(-1).error, /will not execute the Chrome action twice/i);
  assert.equal(h.storage[stateKey].executions["agent-1:run-1:g1:tool-2"].status, "completed");
});

test("Browser Runner generation fence rejects stale and out-of-order calls before Chrome execution", async () => {
  const h = await harness();
  await h.handle("fabushi-browser-runner", call({ sequence: 2, toolCallId: "tool-a" }));
  assert.equal(h.executions, 1);

  await h.handle("fabushi-browser-runner", call({ sequence: 1, toolCallId: "tool-b" }));
  assert.equal(h.executions, 1);
  assert.equal(h.sent.at(-1).ok, false);
  assert.match(h.sent.at(-1).error, /stale or out-of-order/i);

  await h.handle("fabushi-browser-runner", call({ generation: "g2", sequence: 1, toolCallId: "tool-c" }));
  assert.equal(h.executions, 2);

  await h.handle("fabushi-browser-runner", call({ generation: "g1", sequence: 3, toolCallId: "tool-d" }));
  assert.equal(h.executions, 2);
  assert.equal(h.sent.at(-1).ok, false);
});
