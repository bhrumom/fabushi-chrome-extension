export function canonicalTaskScript(record) {
  return record?.sourcePluginId === "chatgpt-auto-confirm" || (record?.name === "ChatGPT 自动确认 · Fabushi"
    && record?.namespace === "https://fabushi.ombhrum.com/userscripts/chatgpt-auto-confirm");
}

// Self-contained because it runs in the origin before standalone bootstrap.
// This adapter preserves that script's task orchestration and dispatch fences.
// It never changes task state, goal, round, send identity or attachment records.
export function taskRecoveryAdapter({ prepare = false } = {}) {
  try {
    if (location.protocol !== "https:" || !["chatgpt.com", "chat.openai.com"].includes(location.hostname)) return { resumable: false };
    const sameRoute = value => {
      try { const url = new URL(value); return url.origin === location.origin && url.pathname === location.pathname && url.search === location.search; }
      catch { return false; }
    };
    const stored = JSON.parse(localStorage.getItem("fabushi-workbench-v2") || "{}");
    const states = new Set(["queued", "sending", "uploading", "waiting", "loading", "generating", "approval", "reviewing"]);
    const candidates = (Array.isArray(stored.tasks) ? stored.tasks : []).filter(task => task?.ownerTabId
      && sameRoute(task.url) && states.has(task.state) && stored.tabControls?.[task.ownerTabId]?.autoResume !== false);
    const owners = [...new Set(candidates.map(task => task.ownerTabId))];
    if (owners.length !== 1) return { resumable: false, reason: owners.length ? "ambiguous-task-owner" : "no-running-route-task" };
    const ownerTabId = owners[0];
    const heartbeat = JSON.parse(localStorage.getItem("fabushi-workspace-heartbeat-v1:" + ownerTabId) || "{}");
    if (heartbeat.autoResume === false) return { resumable: false, reason: "workspace-paused" };
    const task = candidates.find(task => task.id === stored.selectedByTab?.[ownerTabId]) || candidates[0];
    const checkpoint = { resumable: true, ownerTabId, taskId: task.id, taskState: task.state,
      phase: task.phase, round: task.round, attempted: task.attempted === true,
      currentOwner: sessionStorage.getItem("fabushi-workbench-tab-session-v1") || "" };
    if (!prepare) return checkpoint;
    const token = new URLSearchParams(location.hash.slice(1)).get("fabushi-resume") || "";
    if (!/^fabushi-host-[a-f0-9-]{36}$/i.test(token)) return { ...checkpoint, prepared: false };
    // Persist first. Bootstrap reads this existing script contract and claims
    // its workspace Web Lock; a still-live owner cannot be stolen.
    const key = "fabushi-workspace-recovery-v1:" + token;
    localStorage.setItem(key, JSON.stringify({ ownerTabId, taskId: task.id, url: task.url, at: Date.now(), auto: true }));
    if (JSON.parse(localStorage.getItem(key) || "{}").ownerTabId !== ownerTabId) return { ...checkpoint, prepared: false };
    return { ...checkpoint, prepared: true };
  } catch { return { resumable: false, reason: "checkpoint-storage-unavailable" }; }
}

export async function probeTaskRecovery(tabId, timeoutMs = 5_000) {
  let timer;
  try {
    return await Promise.race([
      chrome.scripting.executeScript({ target: { tabId }, func: taskRecoveryAdapter })
        .then(results => results?.[0]?.result || { resumable: false }).catch(() => ({ resumable: false })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ resumable: false, reason: "checkpoint-probe-timeout" }), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}
