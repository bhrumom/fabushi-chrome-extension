const BROWSER_RUNNER_FAMILY = "fabushi-browser-runner";
const BROWSER_RUNNER_VERSION = 1;
const BROWSER_RUNNER_STATE_KEY = "fabushiBrowserRunnerStateV1";
const MAX_EXECUTIONS = 64;
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_RESULT_BYTES = 512 * 1024;
const ALLOWED_COMMANDS = new Set([
  "list_tabs",
  "claim_tab",
  "downloads",
  "cdp",
  "cdp_auto_attach_frame",
  "detach",
  "create_tab",
  "cleanup_tabs",
  "tab_action",
]);

function text(value) {
  return typeof value === "string" ? value : "";
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function executionKey(call) {
  return [call.agentId, call.runId, call.generation, call.toolCallId].join(":");
}

function fenceKey(call) {
  return [call.agentId, call.runId].join(":");
}

function parseCall(value) {
  if (!isRecord(value) || value.version !== BROWSER_RUNNER_VERSION || value.kind !== "call") return null;
  const agentId = text(value.agentId);
  const runId = text(value.runId);
  const generation = text(value.generation);
  const toolCallId = text(value.toolCallId);
  const toolName = text(value.toolName);
  const sequence = value.sequence;
  const args = isRecord(value.arguments) ? value.arguments : {};
  if (!agentId || !runId || !generation || !toolCallId || !ALLOWED_COMMANDS.has(toolName)) return null;
  if (!Number.isSafeInteger(sequence) || sequence < 1) return null;
  if (JSON.stringify(args).length > MAX_ARGUMENT_BYTES) return null;
  return { version: BROWSER_RUNNER_VERSION, kind: "call", agentId, runId, generation, toolCallId, toolName, sequence, arguments: args };
}

async function loadState() {
  const stored = await chrome.storage.local.get(BROWSER_RUNNER_STATE_KEY);
  const raw = stored[BROWSER_RUNNER_STATE_KEY];
  return raw && typeof raw === "object"
    ? {
      fences: raw.fences && typeof raw.fences === "object" ? raw.fences : {},
      executions: raw.executions && typeof raw.executions === "object" ? raw.executions : {},
    }
    : { fences: {}, executions: {} };
}

async function saveState(state) {
  const entries = Object.entries(state.executions)
    .sort((left, right) => Number(right[1]?.updatedAt || 0) - Number(left[1]?.updatedAt || 0))
    .slice(0, MAX_EXECUTIONS);
  state.executions = Object.fromEntries(entries);
  await chrome.storage.local.set({ [BROWSER_RUNNER_STATE_KEY]: state });
}

function acceptFence(state, call) {
  const key = fenceKey(call);
  const current = state.fences[key] && typeof state.fences[key] === "object"
    ? state.fences[key]
    : { generation: call.generation, sequence: 0, retiredGenerations: [] };
  const retired = new Set(Array.isArray(current.retiredGenerations) ? current.retiredGenerations : []);

  if (retired.has(call.generation)) return { accepted: false, reason: "retired-generation" };
  if (current.generation && current.generation !== call.generation) {
    retired.add(current.generation);
    current.generation = call.generation;
    current.sequence = 0;
  }
  if (call.sequence <= Number(current.sequence || 0)) return { accepted: false, reason: "duplicate-or-out-of-order" };

  current.sequence = call.sequence;
  current.retiredGenerations = [...retired].slice(-8);
  state.fences[key] = current;
  return { accepted: true };
}

function boundedResultEnvelope(call, ok, value) {
  const base = {
    version: BROWSER_RUNNER_VERSION,
    kind: "result",
    agentId: call.agentId,
    runId: call.runId,
    generation: call.generation,
    sequence: call.sequence,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    ok,
  };
  const payload = ok ? { ...base, result: value } : { ...base, error: text(value) || "Browser Runner failed." };
  let serialized = "";
  try {
    serialized = JSON.stringify(payload);
  } catch {
    return { ...base, ok: false, error: "Browser Runner result could not be serialized." };
  }
  if (serialized.length > MAX_RESULT_BYTES) {
    return {
      ...base,
      ok: false,
      error: "Browser Runner completed the tool, but the result exceeded the replay-safe size limit.",
    };
  }
  return payload;
}

async function emitLifecycle(event, call, detail = "") {
  await chrome.runtime.sendMessage({
    type: "fabushi.agent.event",
    family: "browser-runner-lifecycle",
    payload: {
      event,
      agentId: call.agentId,
      runId: call.runId,
      generation: call.generation,
      sequence: call.sequence,
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      phase: event === "ToolStarted" ? "tool-running" : "thinking",
      detail,
    },
  }).catch(() => {});
}

async function sendResult(result) {
  const sender = globalThis.__fabushiAgentBrokerSendBrowserToolResult;
  if (typeof sender !== "function") throw new Error("Coordinator Browser Runner result transport is unavailable.");
  await sender(result);
}

async function replayOrFence(call, state) {
  const key = executionKey(call);
  const execution = state.executions[key];
  if (execution?.status === "completed" && execution.result) {
    await sendResult(execution.result);
    return true;
  }
  if (execution?.status === "started") {
    const unknown = boundedResultEnvelope(
      call,
      false,
      "Browser Runner saw this toolCallId before Service Worker recovery, but no terminal result was durably recorded. It will not execute the Chrome action twice."
    );
    state.executions[key] = { status: "completed", result: unknown, updatedAt: Date.now() };
    await saveState(state);
    await emitLifecycle("ToolCompleted", call, unknown.error);
    await sendResult(unknown);
    return true;
  }

  const fence = acceptFence(state, call);
  if (!fence.accepted) {
    const stale = boundedResultEnvelope(call, false, `Browser Runner rejected a stale or out-of-order call: ${fence.reason}`);
    await sendResult(stale);
    return true;
  }

  state.executions[key] = {
    status: "started",
    agentId: call.agentId,
    runId: call.runId,
    generation: call.generation,
    sequence: call.sequence,
    toolCallId: call.toolCallId,
    toolName: call.toolName,
    updatedAt: Date.now(),
  };
  await saveState(state);
  return false;
}

async function execute(call) {
  const state = await loadState();
  if (await replayOrFence(call, state)) return;

  await emitLifecycle("ToolStarted", call);
  let result;
  try {
    const executor = globalThis.__fabushiBrowserCommand;
    if (typeof executor !== "function") throw new Error("Chrome Browser Control is unavailable.");
    const value = await executor(call.toolName, call.arguments);
    result = boundedResultEnvelope(call, true, value);
  } catch (error) {
    result = boundedResultEnvelope(call, false, error?.message || String(error));
  }

  const latest = await loadState();
  latest.executions[executionKey(call)] = { status: "completed", result, updatedAt: Date.now() };
  await saveState(latest);
  await emitLifecycle("ToolCompleted", call, result.ok ? "" : result.error);
  await sendResult(result);
}

globalThis.__fabushiBrowserRunnerHandleCoordinatorEvent = async (family, payload) => {
  if (family !== BROWSER_RUNNER_FAMILY) return false;
  const call = parseCall(payload);
  if (call == null) return true;
  await execute(call);
  return true;
};
