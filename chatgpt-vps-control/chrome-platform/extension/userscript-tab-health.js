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
  // Reading body.innerText forces layout and serializes an entire long chat.
  // A bounded set of visible controls/text nodes suffices for DOM liveness.
  const content = [...document.querySelectorAll('button, a[href], textarea, input, [contenteditable=true], img, svg, canvas, video, iframe')].slice(0, 80).some(visible);
  const text = !content && body && visible(body) && [...body.querySelectorAll('h1, h2, p, [role="main"]')].slice(0, 20)
    .some(element => visible(element) && Boolean(element.textContent?.trim()));
  return { healthy: Boolean(text || content), reason: text || content ? "content-visible" : "blank-document" };
}

const visualOperations = new Set();

// Runs in the extension worker, independently of a page's DOM and JS stack.
export async function probeBlackFrame(tab) {
  if (!tab?.active || !Number.isInteger(tab.windowId)) return null;
  if (visualOperations.has(tab.windowId)) return null;
  visualOperations.add(tab.windowId);
  const work = captureBlackFrame(tab).finally(() => visualOperations.delete(tab.windowId));
  let timer;
  try {
    return await Promise.race([work, new Promise(resolve => {
      timer = setTimeout(() => resolve(null), 5_000);
    })]);
  } finally { clearTimeout(timer); }
}

async function captureBlackFrame(tab) {
  try {
    const win = await chrome.windows.get(tab.windowId);
    if (!win.focused) return null;
    const active = await chrome.tabs.query({ active: true, windowId: tab.windowId });
    if (active.length !== 1 || active[0].id !== tab.id) return null;
    const url = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 20 });
    const response = await fetch(url);
    const bitmap = await createImageBitmap(await response.blob());
    try {
      const canvas = new OffscreenCanvas(16, 16);
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (!context) return null;
      context.drawImage(bitmap, 0, 0, 16, 16);
      const pixels = context.getImageData(0, 0, 16, 16).data;
      let black = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        if (pixels[i] < 16 && pixels[i + 1] < 16 && pixels[i + 2] < 16 && pixels[i + 3] > 240) black++;
      }
      const current = await chrome.tabs.get(tab.id);
      const currentWindow = await chrome.windows.get(tab.windowId);
      return current.active && currentWindow.focused && current.url === tab.url && black >= 252;
    } finally { bitmap.close(); }
  } catch { return null; }
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
