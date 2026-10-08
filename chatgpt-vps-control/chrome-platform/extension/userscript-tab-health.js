// Isolated-world probe: return health metadata, never page text.
export function inspectScriptPage() {
  const visible = element => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.display !== "none"
      && style.visibility !== "hidden" && Number(style.opacity) !== 0;
  };
  const editors = [...document.querySelectorAll('textarea, input:not([type=hidden]), [contenteditable=true]')];
  const hasDraft = editors.some(element => visible(element) && !element.closest('#fabushi-auto-confirm-root')
    && String(element.value || element.innerText || "").trim());
  const hasAttachment = [...document.querySelectorAll('input[type=file]')].some(element => element.files?.length)
    || [...document.querySelectorAll('[data-testid*="attachment"], [data-testid*="file-preview"]')].some(visible);
  if (hasDraft || hasAttachment) return { healthy: true, protected: true, reason: "protected-input" };
  const body = document.body;
  const text = body && visible(body) && String(body.innerText || "").trim();
  const content = [...document.querySelectorAll('button, a[href], textarea, input, [contenteditable=true], img, svg, canvas, video, iframe')].some(visible);
  return { healthy: Boolean(text || content), reason: text || content ? "content-visible" : "blank-document" };
}

export async function probeScriptPage(tabId, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func: inspectScriptPage })
        .then(results => results?.[0]?.result || { healthy: false, reason: "probe-empty" })
        .catch(() => ({ healthy: false, reason: "probe-unavailable" })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ healthy: false, reason: "probe-timeout" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
