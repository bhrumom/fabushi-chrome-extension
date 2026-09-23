export const MEMORY_CAPABILITY = "tab-memory-discard";
export const MEMORY_PLUGIN_ID = "chatgpt-auto-confirm";
export const MEMORY_DISCARD_COOLDOWN_MS = 5 * 60 * 1000;

const MAX_MEMORY_BYTES = 16 * 1024 * 1024 * 1024;
const ELEVATED_DISCARD_MIN_BYTES = 1024 * 1024 * 1024;
const CHATGPT_URL = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i;
const PRESSURES = new Set(["normal", "elevated", "high", "unsupported"]);

function boundedNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.min(number, MAX_MEMORY_BYTES) : 0;
}

export function normalizeMemoryPayload(value) {
  const payload = value && typeof value === "object" && !Array.isArray(value) ? value : {};
  const pressure = String(payload.pressure || "unsupported").trim().toLowerCase();
  return {
    capability: String(payload.capability || "").trim().slice(0, 64),
    version: String(payload.version || "").trim().slice(0, 32),
    pressure: PRESSURES.has(pressure) ? pressure : "unsupported",
    usedBytes: boundedNumber(payload.usedBytes),
    totalBytes: boundedNumber(payload.totalBytes),
    limitBytes: boundedNumber(payload.limitBytes),
    ratio: Math.min(Math.max(Number(payload.ratio) || 0, 0), 4),
    hidden: payload.hidden === true,
    safeToDiscard: payload.safeToDiscard === true,
    hasDraft: payload.hasDraft === true,
    hasPendingAttachment: payload.hasPendingAttachment === true,
    userInitiated: payload.userInitiated === true,
    reason: String(payload.reason || "").trim().slice(0, 80),
  };
}

export function validateMemoryRequest(message, { record, tab, cooldownRemaining = 0 } = {}) {
  const payload = normalizeMemoryPayload(message?.payload);
  const tabId = Number(tab?.id);
  if (payload.capability !== MEMORY_CAPABILITY || message?.pluginId !== MEMORY_PLUGIN_ID) {
    return { ok:false, discarded:false, reason:"invalid-capability" };
  }
  if (!record || record.sourcePluginId !== MEMORY_PLUGIN_ID || record.enabled === false) {
    return { ok:false, discarded:false, reason:"script-not-enabled" };
  }
  if (!Number.isInteger(tabId) || tabId < 0) {
    return { ok:false, discarded:false, reason:"tab-unavailable" };
  }
  if (!CHATGPT_URL.test(String(tab?.url || ""))) {
    return { ok:false, discarded:false, reason:"unapproved-page", tabId };
  }
  // Chrome itself refuses to discard an active tab. Return a structured
  // result so the userscript can ask the user to switch away from it.
  if (tab.active === true) return { ok:true, discarded:false, reason:"active-tab", tabId };
  if (tab.discarded === true) return { ok:true, discarded:true, reason:"already-discarded", tabId };
  if (!payload.userInitiated && payload.pressure !== "high"
    && !(payload.pressure === "elevated" && payload.usedBytes >= ELEVATED_DISCARD_MIN_BYTES)) {
    return { ok:true, discarded:false, reason:"pressure-not-elevated", tabId };
  }
  if (payload.safeToDiscard !== true || payload.hasDraft || payload.hasPendingAttachment) {
    return { ok:true, discarded:false, reason:"unsafe-state", tabId };
  }
  if (Number(cooldownRemaining) > 0) {
    return { ok:true, discarded:false, reason:"cooldown", retryAfterMs:Math.ceil(Number(cooldownRemaining)), tabId };
  }
  return { ok:true, canDiscard:true, discarded:false, reason:"ready", tabId, payload };
}
