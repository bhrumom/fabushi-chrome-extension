import { userScriptMatches } from "./userscript-core.js";
// Host scheduling is independent of hidden-page chained timers.
const ALARM = "fabushi.userscript.background-wake";
const CHATGPT = /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)(?:\/|$)/i;
const clocks = new Map();
let waking = false;
export async function wakeBackgroundTabs() {
  if (waking) return;
  waking = true;
  try {
    const stored = await chrome.storage.local.get("fabushi.userscripts.v1");
    const records = (stored["fabushi.userscripts.v1"] || []).filter(record => record?.sourcePluginId === "chatgpt-auto-confirm" && record.enabled !== false);
    if (!records.length) return;
    const tabs = await chrome.tabs.query({ url:["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    await Promise.allSettled(tabs.filter(tab => !tab.active && !tab.discarded && CHATGPT.test(tab.url || "") && records.some(record => userScriptMatches(record, tab.url)))
      .map(async tab => {
        const message = { type:"fabushi.userscript.wake" };
        try { await chrome.tabs.sendMessage(tab.id, message, { frameId:0 }); }
        catch {
          // Extension reload does not run manifest content scripts in existing
          // documents. Repair that bridge in place, then deliver this pulse.
          if (!chrome.scripting?.executeScript) return;
          await chrome.scripting.executeScript({ target:{tabId:tab.id,allFrames:false}, files:["userscript-content.js"] });
          await chrome.tabs.sendMessage(tab.id, message, { frameId:0 });
        }
      }));
  } finally { waking = false; }
}
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message?.type !== "fabushi.userscript.clock") return false;
  const tabId = sender?.tab?.id;
  const ms = Number(message.delayMs);
  if (!Number.isInteger(tabId) || sender.frameId !== 0 || !CHATGPT.test(sender.url || "")
    || !Number.isFinite(ms) || ms < 0 || ms > 20000 || (clocks.get(tabId) || 0) >= 8) {
    respond({ ok:false }); return false;
  }
  clocks.set(tabId, (clocks.get(tabId) || 0) + 1);
  setTimeout(() => {
    const remaining = (clocks.get(tabId) || 1) - 1;
    if (remaining) clocks.set(tabId, remaining); else clocks.delete(tabId);
    respond({ ok:true });
  }, ms);
  return true;
});
const ensureAlarm = () => chrome.alarms.create(ALARM, { periodInMinutes:0.5 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm?.name === ALARM) void wakeBackgroundTabs().catch(() => {});
});
chrome.runtime.onStartup.addListener(() => { void ensureAlarm().catch(() => {}); });
chrome.runtime.onInstalled.addListener(() => { void ensureAlarm().catch(() => {}); });
void ensureAlarm().catch(() => {});
