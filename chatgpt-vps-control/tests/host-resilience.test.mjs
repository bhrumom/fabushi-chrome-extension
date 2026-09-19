import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestPath = new URL("../chrome-platform/extension/manifest.json", import.meta.url);
const recoveryPath = new URL("../chrome-platform/extension/userscript-recovery.js", import.meta.url);
const bundledPath = new URL("../chrome-platform/extension/userscript/chatgpt-auto-confirm.user.js", import.meta.url);

test("Fabushi host keeps only the system awake while an active recovery lease exists", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recovery = await readFile(recoveryPath, "utf8");
  assert.equal(manifest.version, "0.6.19");
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
  assert.match(bundled, /^\/\/ @version\s+2\.9\.46$/m);
  assert.match(bundled, /const VERSION = '2\.9\.46'/);
  assert.match(bundled, /CONNECTION_INTERRUPTED_REFRESH_LIMIT = 3/);
  assert.match(bundled, /RATE_LIMIT_FRESH_RETRY_AFTER = 3/);
  assert.match(bundled, /STOP_MISSING_CONTINUE_GRACE_MS/);
  assert.match(bundled, /CONVERSATION_LENGTH_CARRY_MAX/);
  assert.match(bundled, /conversationLengthLimitNotice/);
  assert.match(bundled, /queueConversationLengthHandoff/);
  assert.match(bundled, /conversationLengthContinuationContext/);
  assert.match(bundled, /connectionInterruptedPattern/);
  assert.match(bundled, /connectionInterruptedNotice\(turn/);
  assert.match(bundled, /CONNECTION_INTERRUPTED_REFRESH_COOLDOWN_MS = 10 \* 1000/);
  assert.match(bundled, /temporary no-banner hydration|reload is between/);
  assert.match(bundled, /queuePendingContinuation/);
  assert.match(bundled, /attemptPendingContinuation/);
  assert.match(bundled, /pendingContinuationStopClickedAt/);
  assert.match(bundled, /ignoreCooldown:true/);
  assert.match(bundled, /已点击停止失败生成/);
  assert.match(bundled, /NAVIGATION_COMMIT_WATCHDOG_MS = 8000/);
  assert.match(bundled, /armNavigationCommitWatchdog/);
  assert.match(bundled, /sameRoute && recovery/);
  assert.match(bundled, /const STALLED_REFRESH_MS = 15 \* 60 \* 1000/);
  assert.match(bundled, /const AMBIGUOUS_SEND_REFRESH_MS = 3 \* 60 \* 1000/);
});
