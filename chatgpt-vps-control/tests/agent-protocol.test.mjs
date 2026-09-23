import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

async function loadProtocol() {
  const source = await readFile(new URL("../chrome-platform/extension/agent-protocol.js", import.meta.url), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

test("Coordinator v1 frames use strict lifecycle request reply event and cancel contracts", async () => {
  const { COORDINATOR_PROTOCOL_VERSION, parseCoordinatorFrame } = await loadProtocol();
  assert.equal(COORDINATOR_PROTOCOL_VERSION, 1);
  assert.equal(parseCoordinatorFrame({ kind: "lifecycle", phase: "hello", protocolVersion: 1 }).accepted, true);
  assert.equal(parseCoordinatorFrame({ kind: "request", requestId: "r1", method: "listAgents", args: {} }).accepted, true);
  assert.equal(parseCoordinatorFrame({ kind: "reply", requestId: "r1", outcome: { status: "ok", value: [] } }).accepted, true);
  assert.equal(parseCoordinatorFrame({ kind: "event", family: "transcript", payload: {} }).accepted, true);
  assert.equal(parseCoordinatorFrame({ kind: "cancel", requestId: "r1" }).accepted, true);
  assert.equal(parseCoordinatorFrame({ kind: "request", requestId: "", method: "listAgents", args: {} }).accepted, false);
  assert.equal(parseCoordinatorFrame({ kind: "lifecycle", phase: "shutdown", reason: "protocol-error", detail: "" }).accepted, false);
});

test("run fencing rejects stale generations and duplicate or out-of-order events", async () => {
  const { createRunFence, acceptRunEvent, serializeRunFence } = await loadProtocol();
  const fence = createRunFence();

  assert.equal(acceptRunEvent(fence, { runId: "run-1", generation: "g1", sequence: 1 }).accepted, true);
  assert.equal(acceptRunEvent(fence, { runId: "run-1", generation: "g1", sequence: 1 }).accepted, false);
  assert.equal(acceptRunEvent(fence, { runId: "run-1", generation: "g1", sequence: 0 }).accepted, false);

  assert.equal(acceptRunEvent(fence, { runId: "run-1", generation: "g2", sequence: 1 }).accepted, true);
  assert.equal(acceptRunEvent(fence, { runId: "run-1", generation: "g1", sequence: 2 }).accepted, false);

  assert.deepEqual(serializeRunFence(fence), {
    runId: "run-1",
    generation: "g2",
    sequence: 1,
    retiredGenerations: ["g1"],
  });
});

test("canonical Grok run phases are projected without inventing Host state", async () => {
  const { RUN_PHASES, projectRunPhase } = await loadProtocol();
  assert.deepEqual(RUN_PHASES, [
    "accepted", "queued", "preparing", "thinking", "tool-running", "streaming",
    "waiting-user", "completed", "failed", "cancelled", "recovering",
  ]);
  assert.equal(projectRunPhase("transcript", { state: "thinking" }), "thinking");
  assert.equal(projectRunPhase("client-side-tool-v2", { kind: "tool-call" }), "tool-running");
  assert.equal(projectRunPhase("transport", { state: "reconnecting" }), "recovering");
});


test("authoritative resync snapshot restores phase and advances the durable fence without moving backward", async () => {
  const { mergeRunSnapshot } = await loadProtocol();
  const prior = {
    activeAgentId: "agent-1",
    runPhase: "recovering",
    fence: { runId: "run-1", generation: "g1", sequence: 2, retiredGenerations: [] },
  };

  const completed = mergeRunSnapshot(prior, {
    runId: "run-1",
    generation: "g1",
    sequence: 3,
    phase: "completed",
  });
  assert.equal(completed.runPhase, "completed");
  assert.deepEqual(completed.fence, {
    runId: "run-1",
    generation: "g1",
    sequence: 3,
    retiredGenerations: [],
  });

  const staleSnapshot = mergeRunSnapshot(completed, {
    runId: "run-1",
    generation: "g1",
    sequence: 1,
    phase: "thinking",
  });
  assert.equal(staleSnapshot.fence.sequence, 3);
  assert.equal(staleSnapshot.runPhase, "completed");

  const nextGeneration = mergeRunSnapshot(completed, {
    runId: "run-1",
    generation: "g2",
    sequence: 1,
    phase: "thinking",
  });
  assert.equal(nextGeneration.runPhase, "thinking");
  assert.deepEqual(nextGeneration.fence, {
    runId: "run-1",
    generation: "g2",
    sequence: 1,
    retiredGenerations: ["g1"],
  });
});
