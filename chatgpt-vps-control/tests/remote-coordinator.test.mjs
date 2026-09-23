import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  send(value) {
    if (this.readyState !== FakeWebSocket.OPEN) throw new Error("socket not open");
    this.sent.push(JSON.parse(value));
  }

  open() {
    this.readyState = FakeWebSocket.OPEN;
    this.onopen?.();
  }

  message(frame) {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  close(code = 1000, reason = "") {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.onclose?.({ code, reason });
  }
}

async function loadFactory() {
  globalThis.WebSocket = FakeWebSocket;
  globalThis.chrome = {
    alarms: {
      create() {},
      onAlarm: { addListener() {} },
    },
  };
  globalThis.__fabushiGetCoordinatorAccountSession = async () => null;

  const protocolSource = await readFile(new URL("../chrome-platform/extension/agent-protocol.js", import.meta.url), "utf8");
  const protocolUrl = `data:text/javascript;base64,${Buffer.from(protocolSource).toString("base64")}`;
  let source = await readFile(new URL("../chrome-platform/extension/remote-coordinator.js", import.meta.url), "utf8");
  source = source.replace("./agent-protocol.js", protocolUrl);
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}#${Math.random()}`);
  FakeWebSocket.instances.length = 0;
  return module.createRemoteCoordinatorTransport;
}

function latestSocket() {
  return FakeWebSocket.instances.at(-1);
}

async function readyTransport(factory) {
  const transport = factory({
    url: "wss://fabushi-mcp.ombhrum.com/coordinator",
    sessionProvider: async () => ({ accessToken: "short-lived-token" }),
    alarms: { create() {} },
  });
  const statusPromise = transport.status();
  const socket = latestSocket();
  assert.ok(socket);
  assert.equal(socket.url, "wss://fabushi-mcp.ombhrum.com/coordinator");
  assert.equal(socket.url.includes("short-lived-token"), false);
  socket.open();
  assert.deepEqual(socket.sent[0], {
    kind: "authenticate",
    protocolVersion: 1,
    accessToken: "short-lived-token",
    client: { kind: "chrome-extension", transport: "remote-coordinator" },
  });
  socket.message({ kind: "authenticated", protocolVersion: 1 });
  assert.deepEqual(await statusPromise, { connected: true, protocolVersion: 1 });
  return { transport, socket };
}

test("remote Coordinator authenticates with short-lived account token in the first frame, never the URL", async () => {
  const factory = await loadFactory();
  const { transport, socket } = await readyTransport(factory);
  assert.equal(socket.sent[0].accessToken, "short-lived-token");
  transport.close();
});

test("remote Coordinator call reply event and resume use the typed v1 protocol", async () => {
  const factory = await loadFactory();
  const { transport, socket } = await readyTransport(factory);

  const events = [];
  transport.subscribe((frame) => events.push(frame));

  const callPromise = transport.call({
    clientId: "view-1",
    requestId: "req-1",
    method: "listAgents",
    args: {},
  });
  assert.deepEqual(socket.sent.at(-1), {
    kind: "request",
    requestId: "req-1",
    method: "listAgents",
    args: {},
    clientId: "view-1",
  });
  socket.message({
    kind: "reply",
    requestId: "req-1",
    outcome: { status: "ok", value: [{ id: "agent-1" }] },
  });
  assert.deepEqual(await callPromise, [{ id: "agent-1" }]);

  socket.message({ kind: "event", family: "transcript", payload: { agentId: "agent-1" } });
  assert.equal(events.at(-1).family, "transcript");

  const resumePromise = transport.resume({
    clientId: "view-1",
    activeAgentId: "agent-1",
    runId: "run-1",
    generation: "g1",
    sequence: 7,
  });
  const resumeFrame = socket.sent.at(-1);
  assert.equal(resumeFrame.kind, "request");
  assert.equal(resumeFrame.method, "resume");
  assert.deepEqual(resumeFrame.args, {
    activeAgentId: "agent-1",
    runId: "run-1",
    generation: "g1",
    sequence: 7,
  });
  socket.message({
    kind: "reply",
    requestId: resumeFrame.requestId,
    outcome: { status: "ok", value: { runId: "run-1", generation: "g1" } },
  });
  assert.deepEqual(await resumePromise, { runId: "run-1", generation: "g1" });
  transport.close();
});

test("remote Coordinator never automatically resends an unknown-delivery request after disconnect", async () => {
  const factory = await loadFactory();
  const { transport, socket } = await readyTransport(factory);

  const callPromise = transport.call({
    clientId: "view-1",
    requestId: "send-once",
    method: "sendPrompt",
    args: { prompt: "hello" },
  });
  assert.equal(socket.sent.filter((frame) => frame.requestId === "send-once").length, 1);
  socket.close(1006, "network lost");

  await assert.rejects(
    callPromise,
    (error) => error?.code === "coordinator-transport-lost"
      && error?.delivery === "unknown"
      && error?.requestId === "send-once"
  );

  const reconnectPromise = transport.reconnect();
  const next = latestSocket();
  assert.notEqual(next, socket);
  next.open();
  next.message({ kind: "authenticated", protocolVersion: 1 });
  await reconnectPromise;

  assert.equal(
    FakeWebSocket.instances.flatMap((candidate) => candidate.sent).filter((frame) => frame.requestId === "send-once").length,
    1
  );
  transport.close();
});

test("remote Coordinator refuses to become ready without an account session", async () => {
  const factory = await loadFactory();
  const transport = factory({
    sessionProvider: async () => null,
    socketFactory: () => { throw new Error("socket must not be created"); },
    alarms: { create() {} },
  });
  const status = await transport.status();
  assert.equal(status.connected, false);
  assert.match(status.error, /account login is required/i);
});
