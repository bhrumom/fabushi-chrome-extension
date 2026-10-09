chrome.runtime.sendMessage({ type: "fabushi.tabRescue.ready" }).then(response => {
  if (!response?.ok) document.getElementById("status").textContent = "恢复暂未完成，Fabushi 后台将检查原标签页。";
}).catch(() => {});
