#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";

const statePath = process.env.FABUSHI_E2E_STATE;
if (!statePath) throw new Error("FABUSHI_E2E_STATE is required");

let input = Buffer.alloc(0);
let writing = Promise.resolve();

async function readState() {
  try {
    return JSON.parse(await readFile(statePath, "utf8"));
  } catch {
    return {
      sendPromptCount: 0,
      resumeCount: 0,
      browserToolResultCount: 0,
      transcript: [],
      runId: "run-packaged-e2e",
      generation: "generation-1",
      active: false,
      finalSent: false
    };
  }
}

async function mutate(mutator) {
  const state = await readState();
  await mutator(state);
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  return state;
}

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

function send(value) {
  writing = writing.then(() => new Promise((resolve, reject) => {
    process.stdout.write(frame(value), (error) => error ? reject(error) : resolve());
  })).catch(() => {});
  return writing;
}

function response(requestId, result) {
  return send({ type: "platform_response", requestId, ok: true, result });
}

function failure(requestId, error) {
  return send({ type: "platform_response", requestId, ok: false, error: String(error?.message || error) });
}

function event(family, payload) {
  return send({
    type: "platform_event",
    event: { type: "coordinator.event", family, payload }
  });
}

async function emitBrowserCall(state) {
  await event("fabushi-browser-runner", {
    version: 1,
    kind: "call",
    agentId: "agent-packaged-e2e",
    runId: state.runId,
    generation: state.generation,
    sequence: 1,
    toolCallId: "tool-create-tab-1",
    toolName: "create_tab",
    arguments: { url: "https://example.com/" }
  });
}

async function emitFinal(state) {
  if (state.finalSent) return;
  state.finalSent = true;
  state.active = false;
  state.transcript.push({
    id: "assistant-final",
    kind: "send-message",
    role: "assistant",
    text: "Packaged recovery completed after Browser Runner result.",
    timestampMs: Date.now()
  });
  await writeFile(statePath, JSON.stringify(state, null, 2) + "\n");
  await event("transcript", {
    agentId: "agent-packaged-e2e",
    runId: state.runId,
    generation: state.generation,
    sequence: 2,
    phase: "streaming"
  });
  await event("run-state", {
    agentId: "agent-packaged-e2e",
    runId: state.runId,
    generation: state.generation,
    sequence: 3,
    phase: "completed"
  });
}

async function coordinatorCall(params) {
  const method = String(params?.method || "");
  const args = params?.args && typeof params.args === "object" ? params.args : {};
  const state = await readState();

  if (method === "listAgents") {
    return [{
      id: "agent-packaged-e2e",
      name: "Packaged Agent",
      description: "Exact-HEAD Chrome acceptance Agent",
      updatedAt: Date.now(),
      isRunning: state.active
    }];
  }
  if (method === "getAgentTranscriptWindow") {
    return { entries: state.transcript, threadCounts: {} };
  }
  if (method === "listRoutedMcpTools") {
    return [{ name: "browser.create_tab", title: "Browser create tab" }];
  }
  if (method === "getPluginSyncStatus") {
    return { authBlocked: [] };
  }
  if (method === "getAgentChannels") {
    return { manifests: [], connections: [] };
  }
  if (method === "sendPrompt") {
    const next = await mutate(async (draft) => {
      draft.sendPromptCount += 1;
      draft.active = true;
      draft.transcript.push({
        id: String(args.clientNonce || "user-prompt"),
        kind: "send-message",
        role: "user",
        text: String(args.prompt || ""),
        clientNonce: String(args.clientNonce || ""),
        timestampMs: Date.now()
      });
    });
    await event("transcript", {
      agentId: "agent-packaged-e2e",
      runId: next.runId,
      generation: next.generation,
      sequence: 1,
      phase: "thinking"
    });
    await emitBrowserCall(next);
    return { accepted: true, runId: next.runId, generation: next.generation };
  }
  if (method === "createAgent") {
    return { agent: { id: "agent-packaged-e2e", name: "Packaged Agent", updatedAt: Date.now() } };
  }
  if (method === "updateAgent") {
    return { id: "agent-packaged-e2e" };
  }
  if (method === "deleteAgents") {
    return { deleted: [] };
  }
  if (method === "reactToMessage") return null;
  if (method === "syncPluginSkills") return [];
  return null;
}

async function handle(message) {
  if (message?.type === "platform_hello") {
    await send({
      type: "platform_hello_ack",
      desktopVersion: "packaged-e2e",
      platform: process.platform
    });
    return;
  }

  if (message?.type === "platform_heartbeat") {
    await send({ type: "platform_heartbeat_ack", timestamp: Date.now() });
    return;
  }

  if (message?.type !== "platform_request") return;
  const requestId = String(message.requestId || "");
  const method = String(message.method || "");
  const params = message.params && typeof message.params === "object" ? message.params : {};

  try {
    if (method === "coordinator.status") {
      await response(requestId, { connected: true, protocolVersion: 1 });
      return;
    }

    if (method === "coordinator.call") {
      await response(requestId, await coordinatorCall(params));
      return;
    }

    if (method === "coordinator.cancel") {
      await mutate(async (state) => { state.active = false; });
      await response(requestId, { cancelled: true });
      return;
    }

    if (method === "coordinator.resume") {
      const state = await mutate(async (draft) => { draft.resumeCount += 1; });
      await response(requestId, {
        resumed: true,
        runId: state.runId,
        generation: state.generation,
        sequence: Number(params.sequence || 0)
      });
      if (state.active) {
        await emitBrowserCall(state);
        if (state.resumeCount >= 2 && state.browserToolResultCount >= 1) {
          const latest = await readState();
          await emitFinal(latest);
        }
      }
      return;
    }

    if (method === "coordinator.browserToolResult") {
      const state = await mutate(async (draft) => {
        draft.browserToolResultCount += 1;
        draft.lastBrowserResult = params.result || null;
      });
      await response(requestId, { accepted: true });
      if (state.resumeCount >= 2 && state.active) {
        const latest = await readState();
        await emitFinal(latest);
      }
      return;
    }

    if (method === "coordinator.attachment.stage") {
      await response(requestId, {
        reference: `e2e-attachment:${String(params.attachmentId || "unknown")}`
      });
      return;
    }

    if (method === "coordinator.attachment.discard") {
      await response(requestId, { discarded: true });
      return;
    }

    if (method === "feature.info") {
      await response(requestId, { version: "packaged-e2e" });
      return;
    }
    if (method === "feature.auth.status") {
      await response(requestId, { loggedIn: false, provider: "Fabushi" });
      return;
    }
    if (method === "feature.marketplace.browse" || method === "feature.plugin.listInstalled") {
      await response(requestId, []);
      return;
    }

    await response(requestId, null);
  } catch (error) {
    await failure(requestId, error);
  }
}

process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32LE(0);
    if (length > 32 * 1024 * 1024) process.exit(2);
    if (input.length < 4 + length) return;
    const payload = input.subarray(4, 4 + length);
    input = input.subarray(4 + length);
    let message;
    try { message = JSON.parse(payload.toString("utf8")); }
    catch { continue; }
    void handle(message);
  }
});

process.stdin.on("end", () => {
  void writing.finally(() => process.exit(0));
});
