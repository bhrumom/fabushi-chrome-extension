let repairedTabId;
let renderedSnapshot;
async function refresh() {
  const result = await chrome.storage.session.get(["fabushi.scriptTabWatchdog.v1", "fabushi.scriptTabRecoveryHistory.v1"]);
  const records = Object.values(result["fabushi.scriptTabWatchdog.v1"] || {});
  const repaired = records.find(record => record.tabId === repairedTabId);
  if (repaired?.taskCheckpoint?.resumable && repaired.taskCheckpoint.currentOwner === repaired.taskCheckpoint.ownerTabId) {
    document.getElementById("action-status").textContent = "原任务已自动接回，标签页编号保持不变。";
  }
  const snapshot = JSON.stringify(result);
  if (snapshot === renderedSnapshot) return;
  renderedSnapshot = snapshot;
  document.getElementById("status").textContent = `已监测 ${records.length} 个脚本标签页`;
  const list = document.getElementById("records");
  list.replaceChildren(...records.map(record => {
    const row = document.createElement("li");
    row.textContent = `标签页 ${record.tabId} · ${record.status}\n${record.url}\n检测：${record.lastHealthReason || "等待检查"}\n恢复次数：${record.recoveryCount || 0}`
      + (record.lastProbeAt ? `\n检查时间：${new Date(record.lastProbeAt).toLocaleString()}` : "")
      + (record.unhealthySince ? `\n连续异常：${Math.floor((Date.now() - record.unhealthySince) / 1000)} 秒` : "")
      + (record.lastRecoveryAction ? `\n恢复动作：${record.lastRecoveryAction}` : "")
      + (record.lastRecoveryAt ? `\n最近恢复：${new Date(record.lastRecoveryAt).toLocaleString()}` : "")
      + (record.lastError ? `\n错误：${record.lastError}` : "");
    const checkpoint = record.taskCheckpoint;
    if (checkpoint?.resumable) {
      row.textContent += `\n任务：${checkpoint.taskId} · ${checkpoint.taskState} · ${checkpoint.phase} · 第 ${checkpoint.round} 轮\n工作区：${checkpoint.ownerTabId}\n当前脚本已接管：${checkpoint.currentOwner === checkpoint.ownerTabId ? "是" : "否"}`;
      if (record.status === "healthy" && checkpoint.currentOwner !== checkpoint.ownerTabId) {
        const button = document.createElement("button");
        button.textContent = "在原标签页接回任务";
        button.addEventListener("click", async () => {
          button.disabled = true;
          repairedTabId = record.tabId;
          const result = await chrome.runtime.sendMessage({ type: "fabushi.taskRepair", tabId: record.tabId, url: record.url }).catch(error => ({ error: error.message }));
          document.getElementById("action-status").textContent = result?.ok ? "已由 Fabushi 在原标签页重载并接回任务，正在验证…" : `未执行：${result?.error || "后台未响应"}`;
        });
        row.append(document.createElement("br"), button);
      }
    }
    else if (checkpoint?.reason) row.textContent += `\n任务恢复：${checkpoint.reason}`;
    return row;
  }));
  document.getElementById("history").replaceChildren(...(result["fabushi.scriptTabRecoveryHistory.v1"] || []).map(event => {
    const row = document.createElement("li");
    row.textContent = `${new Date(event.at).toLocaleString()} · ${event.status}\n${event.url}\n标签页 ${event.tabId} → ${event.restoredTabId || event.tabId}\n${event.reason} · ${event.action || event.error || "等待恢复"}`;
    return row;
  }));
}
void refresh();
setInterval(() => { void refresh(); }, 2_000);
