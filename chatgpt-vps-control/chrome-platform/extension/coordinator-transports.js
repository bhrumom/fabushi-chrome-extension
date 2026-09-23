import { COORDINATOR_PROTOCOL_VERSION } from "./agent-protocol.js";

export class CoordinatorTransportError extends Error {
  constructor(code, message, delivery = "not-sent", transportKind = "none") {
    super(message);
    this.name = "CoordinatorTransportError";
    this.code = code;
    this.delivery = delivery;
    this.transportKind = transportKind;
  }
}

function validStatus(value) {
  return value && typeof value === "object"
    && value.connected === true
    && value.protocolVersion === COORDINATOR_PROTOCOL_VERSION;
}

function remoteAdapter(provider) {
  const remote = provider?.();
  if (!remote || typeof remote.call !== "function") return null;
  return {
    kind: "remote",
    async status() {
      const value = typeof remote.status === "function"
        ? await remote.status()
        : { connected: true, protocolVersion: COORDINATOR_PROTOCOL_VERSION };
      return validStatus(value)
        ? { kind: "remote", connected: true, protocolVersion: COORDINATOR_PROTOCOL_VERSION }
        : null;
    },
    call(envelope) {
      return remote.call(envelope);
    },
    cancel(envelope) {
      if (typeof remote.cancel !== "function") {
        throw new CoordinatorTransportError("cancel-unsupported", "Remote Coordinator transport does not expose cancellation.", "not-sent", "remote");
      }
      return remote.cancel(envelope);
    },
    async resume(envelope) {
      if (typeof remote.resume !== "function") return { supported: false };
      return { supported: true, value: await remote.resume(envelope) };
    },
    stageAttachment(envelope) {
      if (typeof remote.stageAttachment !== "function") {
        throw new CoordinatorTransportError("attachment-unsupported", "Remote Coordinator transport does not support Chrome attachment staging.", "not-sent", "remote");
      }
      return remote.stageAttachment(envelope);
    },
    discardAttachment(envelope) {
      if (typeof remote.discardAttachment !== "function") return null;
      return remote.discardAttachment(envelope);
    },
  };
}

function nativeAdapter(nativeRequest) {
  if (typeof nativeRequest !== "function") return null;
  return {
    kind: "native",
    async status() {
      const value = await nativeRequest("coordinator.status", {
        protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      }, 8_000);
      return validStatus(value)
        ? { kind: "native", connected: true, protocolVersion: COORDINATOR_PROTOCOL_VERSION }
        : null;
    },
    call(envelope) {
      return nativeRequest("coordinator.call", envelope, 60_000);
    },
    cancel(envelope) {
      return nativeRequest("coordinator.cancel", envelope, 15_000);
    },
    async resume(envelope) {
      try {
        return { supported: true, value: await nativeRequest("coordinator.resume", envelope, 20_000) };
      } catch (error) {
        if (/not allowed|unknown|unavailable|unsupported/i.test(String(error?.message || error))) {
          return { supported: false };
        }
        throw error;
      }
    },
    stageAttachment(envelope) {
      return nativeRequest("coordinator.attachment.stage", envelope, 60_000);
    },
    discardAttachment(envelope) {
      return nativeRequest("coordinator.attachment.discard", envelope, 15_000);
    },
  };
}

export function createCoordinatorTransportRouter({
  nativeRequest = null,
  remoteProvider = () => null,
  prefer = "remote",
} = {}) {
  let selected = null;

  function adapters() {
    const remote = remoteAdapter(remoteProvider);
    const native = nativeAdapter(nativeRequest);
    return prefer === "native" ? [native, remote].filter(Boolean) : [remote, native].filter(Boolean);
  }

  async function select() {
    for (const adapter of adapters()) {
      try {
        const status = await adapter.status();
        if (status) {
          selected = adapter;
          return status;
        }
      } catch {}
    }
    selected = null;
    throw new CoordinatorTransportError(
      "coordinator-unavailable",
      "No authenticated remote Coordinator or Coordinator-capable native host is available.",
      "not-sent",
      "none"
    );
  }

  async function current() {
    const status = await select();
    return { status, adapter: selected };
  }

  function envelope(clientId, fields = {}) {
    return {
      protocolVersion: COORDINATOR_PROTOCOL_VERSION,
      clientId,
      ...fields,
    };
  }

  return {
    async status() {
      return select();
    },

    async call({ clientId, requestId, method, args }) {
      const { status, adapter } = await current();
      try {
        const value = await adapter.call(envelope(clientId, { requestId, method, args }));
        return { transport: status, value };
      } catch (error) {
        throw new CoordinatorTransportError(
          "coordinator-transport-lost",
          `${status.kind} Coordinator transport was lost after dispatch: ${error?.message || String(error)}`,
          "unknown",
          status.kind
        );
      }
    },

    async cancel({ clientId, requestId }) {
      const { status, adapter } = await current();
      try {
        const value = await adapter.cancel(envelope(clientId, { requestId }));
        return { transport: status, value };
      } catch (error) {
        if (error instanceof CoordinatorTransportError) throw error;
        throw new CoordinatorTransportError(
          "coordinator-cancel-failed",
          `${status.kind} Coordinator cancellation failed: ${error?.message || String(error)}`,
          "not-sent",
          status.kind
        );
      }
    },

    async resume({ clientId, activeAgentId, runId = "", generation = "", sequence = 0 }) {
      const { status, adapter } = await current();
      const result = await adapter.resume(envelope(clientId, {
        activeAgentId,
        runId,
        generation,
        sequence,
      }));
      return { transport: status, ...result };
    },

    async stageAttachment({ clientId, attachmentId, name, mimeType, size, bytesBase64 }) {
      const { status, adapter } = await current();
      try {
        const value = await adapter.stageAttachment(envelope(clientId, {
          attachmentId,
          name,
          mimeType,
          size,
          bytesBase64,
        }));
        return { transport: status, value };
      } catch (error) {
        if (error instanceof CoordinatorTransportError) throw error;
        throw new CoordinatorTransportError(
          "attachment-stage-failed",
          `${status.kind} Coordinator attachment staging failed: ${error?.message || String(error)}`,
          "not-sent",
          status.kind
        );
      }
    },

    async discardAttachment({ clientId, attachmentId, reference }) {
      const { status, adapter } = await current();
      try {
        const value = await adapter.discardAttachment(envelope(clientId, { attachmentId, reference }));
        return { transport: status, value };
      } catch (error) {
        if (error instanceof CoordinatorTransportError) throw error;
        throw new CoordinatorTransportError(
          "attachment-discard-failed",
          `${status.kind} Coordinator attachment discard failed: ${error?.message || String(error)}`,
          "not-sent",
          status.kind
        );
      }
    },
  };
}
