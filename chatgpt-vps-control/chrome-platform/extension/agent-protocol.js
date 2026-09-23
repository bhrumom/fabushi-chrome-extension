export const COORDINATOR_PROTOCOL_VERSION = 1;

export const RUN_PHASES = Object.freeze([
  "accepted",
  "queued",
  "preparing",
  "thinking",
  "tool-running",
  "streaming",
  "waiting-user",
  "completed",
  "failed",
  "cancelled",
  "recovering",
]);

const RUN_PHASE_SET = new Set(RUN_PHASES);

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

export function parseCoordinatorFrame(value) {
  if (!record(value)) return { accepted: false, detail: "frame must be an object" };

  if (value.kind === "lifecycle") {
    if (value.phase === "hello" || value.phase === "ready") {
      if (typeof value.protocolVersion !== "number") return { accepted: false, detail: "lifecycle protocolVersion must be a number" };
      return { accepted: true, frame: { kind: "lifecycle", phase: value.phase, protocolVersion: value.protocolVersion } };
    }
    if (value.phase === "shutdown") {
      if (value.reason !== "requested" && value.reason !== "protocol-error") return { accepted: false, detail: "invalid shutdown reason" };
      if (value.reason === "protocol-error" && !nonEmpty(value.detail)) return { accepted: false, detail: "protocol-error requires detail" };
      if (value.reason === "requested" && value.detail !== null) return { accepted: false, detail: "requested shutdown detail must be null" };
      return { accepted: true, frame: { kind: "lifecycle", phase: "shutdown", reason: value.reason, detail: value.detail } };
    }
    return { accepted: false, detail: "invalid lifecycle phase" };
  }

  if (value.kind === "request") {
    if (!nonEmpty(value.requestId) || !nonEmpty(value.method) || !("args" in value)) return { accepted: false, detail: "malformed request frame" };
    return { accepted: true, frame: { kind: "request", requestId: value.requestId, method: value.method, args: value.args } };
  }

  if (value.kind === "cancel") {
    return nonEmpty(value.requestId)
      ? { accepted: true, frame: { kind: "cancel", requestId: value.requestId } }
      : { accepted: false, detail: "malformed cancel frame" };
  }

  if (value.kind === "reply") {
    if (!nonEmpty(value.requestId) || !record(value.outcome)) return { accepted: false, detail: "malformed reply frame" };
    if (value.outcome.status === "ok" && "value" in value.outcome) {
      return { accepted: true, frame: { kind: "reply", requestId: value.requestId, outcome: { status: "ok", value: value.outcome.value } } };
    }
    if (value.outcome.status === "failed" && record(value.outcome.failure)
        && nonEmpty(value.outcome.failure.code) && typeof value.outcome.failure.message === "string") {
      return {
        accepted: true,
        frame: {
          kind: "reply",
          requestId: value.requestId,
          outcome: {
            status: "failed",
            failure: {
              code: value.outcome.failure.code,
              message: value.outcome.failure.message,
              ...(nonEmpty(value.outcome.failure.transportKind) ? { transportKind: value.outcome.failure.transportKind } : {}),
            },
          },
        },
      };
    }
    return { accepted: false, detail: "malformed reply outcome" };
  }

  if (value.kind === "event") {
    if (!nonEmpty(value.family) || !("payload" in value)) return { accepted: false, detail: "malformed event frame" };
    return { accepted: true, frame: { kind: "event", family: value.family, payload: value.payload } };
  }

  return { accepted: false, detail: "unknown coordinator frame kind" };
}

export function normalizeRunPhase(value) {
  if (RUN_PHASE_SET.has(value)) return value;
  const raw = String(value || "").toLowerCase().replaceAll("_", "-");
  if (RUN_PHASE_SET.has(raw)) return raw;
  if (raw.includes("tool")) return "tool-running";
  if (raw.includes("think")) return "thinking";
  if (raw.includes("prepar")) return "preparing";
  if (raw.includes("stream") || raw.includes("delta")) return "streaming";
  if (raw.includes("wait") || raw.includes("approval") || raw.includes("permission")) return "waiting-user";
  if (raw.includes("recover") || raw.includes("reconnect") || raw.includes("down")) return "recovering";
  if (raw.includes("cancel") || raw.includes("interrupt")) return "cancelled";
  if (raw.includes("fail") || raw.includes("error")) return "failed";
  if (raw.includes("complete") || raw.includes("finish") || raw.includes("settle")) return "completed";
  if (raw.includes("queue")) return "queued";
  if (raw.includes("accept")) return "accepted";
  return null;
}

export function projectRunPhase(family, payload) {
  if (record(payload)) {
    for (const candidate of [payload.phase, payload.status, payload.state, payload.type, payload.kind]) {
      const phase = normalizeRunPhase(candidate);
      if (phase) return phase;
    }
    if (record(payload.entry)) {
      for (const candidate of [payload.entry.phase, payload.entry.status, payload.entry.type, payload.entry.kind]) {
        const phase = normalizeRunPhase(candidate);
        if (phase) return phase;
      }
      if (payload.entry.streaming === true) return "streaming";
    }
  }
  return normalizeRunPhase(family);
}

export function createRunFence(snapshot = {}) {
  return {
    runId: nonEmpty(snapshot.runId) ? snapshot.runId : "",
    generation: nonEmpty(snapshot.generation) ? snapshot.generation : "",
    sequence: Number.isSafeInteger(snapshot.sequence) && snapshot.sequence >= 0 ? snapshot.sequence : 0,
    retiredGenerations: new Set(Array.isArray(snapshot.retiredGenerations) ? snapshot.retiredGenerations.filter(nonEmpty) : []),
  };
}

export function acceptRunEvent(fence, event) {
  if (!record(event)) return { accepted: false, reason: "event-not-object" };
  const runId = nonEmpty(event.runId) ? event.runId : fence.runId;
  const generation = nonEmpty(event.generation) ? event.generation : fence.generation;
  const sequence = Number.isSafeInteger(event.sequence) ? event.sequence : null;

  if (fence.runId && runId && fence.runId !== runId) return { accepted: false, reason: "run-mismatch" };
  if (generation && fence.retiredGenerations.has(generation)) return { accepted: false, reason: "retired-generation" };

  if (generation && fence.generation && generation !== fence.generation) {
    fence.retiredGenerations.add(fence.generation);
    fence.generation = generation;
    fence.sequence = 0;
  } else if (generation && !fence.generation) {
    fence.generation = generation;
  }

  if (runId && !fence.runId) fence.runId = runId;

  if (sequence !== null) {
    if (sequence <= fence.sequence) return { accepted: false, reason: "duplicate-or-out-of-order" };
    fence.sequence = sequence;
  }

  return { accepted: true, runId: fence.runId, generation: fence.generation, sequence: fence.sequence };
}

export function serializeRunFence(fence) {
  return {
    runId: fence.runId || "",
    generation: fence.generation || "",
    sequence: fence.sequence || 0,
    retiredGenerations: [...fence.retiredGenerations].slice(-8),
  };
}

export function makeRequestId(prefix = "r") {
  return `${prefix}-${Date.now()}-${crypto.randomUUID()}`;
}
