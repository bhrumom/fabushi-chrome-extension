import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateMemoryRequest } from "../chrome-platform/extension/userscript-memory-policy.js";

const manifestPath = new URL("../chrome-platform/extension/manifest.json", import.meta.url);
const recoveryPath = new URL("../chrome-platform/extension/userscript-recovery.js", import.meta.url);
const bundledPath = new URL("../chrome-platform/extension/userscript/chatgpt-auto-confirm.user.js", import.meta.url);

test("Fabushi host keeps only the system awake while an active recovery lease exists", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recovery = await readFile(recoveryPath, "utf8");
  assert.equal(manifest.version, "0.6.21");
  assert.ok(manifest.permissions.includes("power"));
  assert.match(recovery, /requestKeepAwake\(["']system["']\)/);
  assert.doesNotMatch(recovery, /requestKeepAwake\(["']display["']\)/);
  assert.match(recovery, /releaseKeepAwake\(\)/);
  assert.match(recovery, /keepAwakeNeeded/);
  assert.match(recovery, /syncKeepAwake/);
});

test("MV3 lifecycle and the recovery watchdog re-synchronize keep-awake state", async () => {
  const recovery = await readFile(recoveryPath, "utf8");
  assert.match(recovery, /periodInMinutes:\s*0\.5/);
  assert.match(recovery, /onStartup/);
  assert.match(recovery, /onInstalled/);
  assert.match(recovery, /service-worker-start/);
  assert.match(recovery, /await syncKeepAwake\(trimmed\)/);
  assert.match(recovery, /await syncKeepAwake\(records/);
});

test("released browser package bundles the paired userscript release", async () => {
  const bundled = await readFile(bundledPath, "utf8");
  assert.match(bundled, /^\/\/ @version\s+2\.9\.64$/m);
  assert.match(bundled, /const VERSION = '2\.9\.64'/);
  assert.match(bundled, /RATE_LIMIT_FRESH_RETRY_AFTER = 3/);
  assert.match(bundled, /CONVERSATION_LENGTH_CARRY_MAX/);
  assert.match(bundled, /conversationLengthLimitNotice/);
  assert.match(bundled, /queueConversationLengthHandoff/);
  assert.match(bundled, /conversationLengthContinuationContext/);
  assert.match(bundled, /connectionInterruptedPattern/);
  assert.match(bundled, /connectionInterruptedNotice/);
  assert.match(bundled, /已在原会话输入并发送/);
  assert.match(bundled, /CONTINUATION_SEND_COOLDOWN_MS = 60 \* 1000/);
  assert.match(bundled, /NAVIGATION_COMMIT_WATCHDOG_MS = 8000/);
  assert.match(bundled, /armNavigationCommitWatchdog/);
  assert.match(bundled, /const STALLED_REFRESH_MS = 15 \* 60 \* 1000/);
  assert.match(bundled, /composerHasRecoveryDraft/);
  assert.match(bundled, /MEMORY_HOST_REQUEST_MIN_BYTES = 1024 \* 1024 \* 1024/);
  assert.match(bundled, /assistantTurnContent/);
  assert.match(bundled, /retainedPreparedComposer/);
  assert.match(bundled, /VISIBLE_SCAN_INTERVAL_MS = 4000/);
  assert.match(bundled, /HIDDEN_SCAN_INTERVAL_MS = 15000/);
});

test("automatic tab discard accepts elevated pressure only at or above 1 GiB", () => {
  const record = { sourcePluginId: "chatgpt-auto-confirm", enabled: true };
  const tab = { id: 42, url: "https://chatgpt.com/c/example", active: false, discarded: false };
  const message = (pressure, usedBytes = 1024 ** 3) => ({
    pluginId: "chatgpt-auto-confirm",
    payload: {
      capability: "tab-memory-discard",
      pressure,
      usedBytes,
      safeToDiscard: true,
    },
  });

  assert.equal(validateMemoryRequest(message("elevated"), { record, tab }).reason, "ready");
  assert.equal(validateMemoryRequest(message("elevated", 1024 ** 3 - 1), { record, tab }).reason, "pressure-not-elevated");
  assert.equal(validateMemoryRequest(message("high", 0), { record, tab }).reason, "ready", "high pressure retains its existing eligibility");
  assert.equal(validateMemoryRequest(message("normal", 0), { record, tab }).reason, "pressure-not-elevated");
  assert.equal(validateMemoryRequest(message("elevated"), { record, tab: { ...tab, active:true } }).reason, "active-tab");
  assert.equal(validateMemoryRequest({ ...message("elevated"), payload:{ ...message("elevated").payload, safeToDiscard:false } }, { record, tab }).reason, "unsafe-state");
  assert.equal(validateMemoryRequest({ ...message("normal"), payload:{ ...message("normal").payload, userInitiated:true } }, { record, tab }).reason, "ready", "manual requests remain pressure independent");
});
