import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadModules() {
  const protocolSource = await readFile(new URL("../chrome-platform/extension/agent-protocol.js", import.meta.url), "utf8");
  const protocolUrl = `data:text/javascript;base64,${Buffer.from(protocolSource).toString("base64")}`;
  let transportSource = await readFile(new URL("../chrome-platform/extension/coordinator-transports.js", import.meta.url), "utf8");
  transportSource = transportSource.replace("./agent-protocol.js", protocolUrl);
  return import(`data:text/javascript;base64,${Buffer.from(transportSource).toString("base64")}`);
}

test("native and remote adapters expose the same logical Coordinator envelope", async () => {
  const { createCoordinatorTransportRouter } = await loadModules();
  const nativeCalls = [];
  const native = createCoordinatorTransportRouter({
    prefer: "native",
    nativeRequest: async (method, params) => {
      nativeCalls.push({ method, params });
      if (method === "coordinator.status") return { connected: true, protocolVersion: 1 };
      if (method === "coordinator.call") return { source: "native" };
      if (method === "coordinator.cancel") return { cancelled: true };
      if (method === "coordinator.resume") return { resumed: true };
      throw new Error("unexpected");
    },
  });

  const nativeCall = await native.call({ clientId: "c1", requestId: "r1", method: "listAgents", args: {} });
  assert.equal(nativeCall.transport.kind, "native");
  assert.deepEqual(nativeCalls.at(-1), {
    method: "coordinator.call",
    params: { protocolVersion: 1, clientId: "c1", requestId: "r1", method: "listAgents", args: {} },
  });

  const remoteFrames = [];
  const remote = createCoordinatorTransportRouter({
    nativeRequest: null,
    remoteProvider: () => ({
      status: async () => ({ connected: true, protocolVersion: 1 }),
      call: async (frame) => { remoteFrames.push(frame); return { source: "remote" }; },
      cancel: async () => ({ cancelled: true }),
      resume: async () => ({ resumed: true }),
    }),
  });

  const remoteCall = await remote.call({ clientId: "c1", requestId: "r1", method: "listAgents", args: {} });
  assert.equal(remoteCall.transport.kind, "remote");
  assert.deepEqual(remoteFrames[0], nativeCalls.at(-1).params);
});

test("core Coordinator calls work through remote transport with native messaging absent", async () => {
  const { createCoordinatorTransportRouter } = await loadModules();
  const router = createCoordinatorTransportRouter({
    nativeRequest: null,
    remoteProvider: () => ({
      status: async () => ({ connected: true, protocolVersion: 1 }),
      call: async ({ method }) => method === "listAgents" ? [{ id: "a1" }] : null,
      cancel: async () => null,
      resume: async () => ({ runId: "run-1", generation: "g1" }),
    }),
  });

  assert.deepEqual((await router.call({ clientId: "c1", requestId: "r1", method: "listAgents", args: {} })).value, [{ id: "a1" }]);
  const resumed = await router.resume({ clientId: "c1", activeAgentId: "a1", runId: "run-1", generation: "g1", sequence: 4 });
  assert.equal(resumed.transport.kind, "remote");
  assert.equal(resumed.supported, true);
});

test("transport loss after dispatch is marked unknown-delivery and must not be retried as a new send", async () => {
  const { createCoordinatorTransportRouter, CoordinatorTransportError } = await loadModules();
  const router = createCoordinatorTransportRouter({
    remoteProvider: () => ({
      status: async () => ({ connected: true, protocolVersion: 1 }),
      call: async () => { throw new Error("socket closed"); },
      cancel: async () => null,
    }),
  });

  await assert.rejects(
    router.call({ clientId: "c1", requestId: "send-nonce", method: "sendPrompt", args: {} }),
    (error) => error instanceof CoordinatorTransportError
      && error.code === "coordinator-transport-lost"
      && error.delivery === "unknown"
  );
});
