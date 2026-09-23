import { makeRequestId } from "./agent-protocol.js";

function runtimeMessage(message, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      settled = true;
      reject(new Error(`Extension runtime timed out: ${String(message?.type || "request")}`));
    }, Math.max(1_000, Math.min(Number(timeoutMs) || 30_000, 120_000)));

    const finish = (callback) => (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback(value);
    };

    try {
      chrome.runtime.sendMessage(message, finish((response) => {
        const runtimeError = chrome.runtime.lastError;
        if (runtimeError) reject(new Error(runtimeError.message));
        else resolve(response);
      }));
    } catch (error) {
      finish(reject)(error);
    }
  });
}

function runtimeError(response) {
  const error = new Error(response?.error || "Fabushi Agent runtime request failed.");
  error.code = response?.code || "agent-runtime-error";
  error.delivery = response?.delivery || "not-sent";
  return error;
}

export function createExtensionPlatformRuntime() {
  const clientId = `extension-view-${crypto.randomUUID()}`;
  const listeners = new Set();
  let disposed = false;
  let activeAgentId = "";

  const onMessage = (message) => {
    if (disposed || message?.type !== "fabushi.agent.event") return;
    for (const listener of listeners) listener({ family: message.family, payload: message.payload });
  };
  chrome.runtime.onMessage.addListener(onMessage);

  async function checked(message, timeoutMs) {
    const response = await runtimeMessage(message, timeoutMs);
    if (!response?.ok) throw runtimeError(response);
    return response;
  }

  return {
    clientId,

    async attach(agentId = activeAgentId) {
      activeAgentId = String(agentId || "");
      return checked({ type: "fabushi.agent.attach", clientId, activeAgentId });
    },

    async setActiveAgent(agentId) {
      activeAgentId = String(agentId || "");
      return checked({ type: "fabushi.agent.setActive", clientId, activeAgentId });
    },

    async status() {
      return checked({ type: "fabushi.agent.status", clientId });
    },

    async call(method, args = {}, options = {}) {
      const requestId = String(options.requestId || makeRequestId("coordinator"));
      const response = await checked({
        type: "fabushi.agent.call",
        clientId,
        requestId,
        method: String(method),
        args,
      }, options.timeoutMs || 60_000);
      return { requestId, result: response.result, transport: response.transport };
    },

    async cancel(requestId) {
      return checked({ type: "fabushi.agent.cancel", clientId, requestId: String(requestId || "") }, 15_000);
    },

    async browserStatus() {
      const response = await runtimeMessage({ type: "fabushi.browser.status" }, 15_000);
      return response || { connected: false, tabs: [] };
    },

    async accountStatus() {
      return runtimeMessage({ type: "fabushi.account.status" }, 15_000);
    },

    async accountLogin() {
      const response = await runtimeMessage({ type: "fabushi.account.login" }, 10 * 60_000);
      if (!response?.ok) throw runtimeError(response);
      return response.account;
    },

    async accountLogout() {
      const response = await runtimeMessage({ type: "fabushi.account.logout" }, 30_000);
      if (!response?.ok) throw runtimeError(response);
      return response.account;
    },

    async stageAttachment(file, options = {}) {
      if (!(file instanceof File)) throw new TypeError("stageAttachment requires a File.");
      const attachmentId = crypto.randomUUID();
      const bytes = new Uint8Array(await file.arrayBuffer());
      let binary = "";
      const chunkSize = 0x8000;
      for (let offset = 0; offset < bytes.length; offset += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize)));
      }
      const response = await checked({
        type: "fabushi.agent.attachment.stage",
        clientId,
        attachment: {
          attachmentId,
          name: file.name,
          mimeType: String(options.mimeType || file.type || "application/octet-stream"),
          size: file.size,
          bytesBase64: btoa(binary),
        },
      }, 90_000);
      return { attachmentId, ...response };
    },

    async discardAttachment({ attachmentId, reference = "" }) {
      return checked({
        type: "fabushi.agent.attachment.discard",
        clientId,
        attachmentId: String(attachmentId || ""),
        reference: String(reference || ""),
      }, 20_000);
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      chrome.runtime.onMessage.removeListener(onMessage);
      void runtimeMessage({ type: "fabushi.agent.detach", clientId }).catch(() => {});
    },
  };
}
