import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifestPath = new URL("../chrome-platform/extension/manifest.json", import.meta.url);
const recoveryPath = new URL("../chrome-platform/extension/userscript-recovery.js", import.meta.url);
const bundledPath = new URL("../chrome-platform/extension/userscript/chatgpt-auto-confirm.user.js", import.meta.url);

test("Fabushi host keeps only the system awake while an active recovery lease exists", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const recovery = await readFile(recoveryPath, "utf8");
  assert.equal(manifest.version, "0.6.15");
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
  assert.match(bundled, /^\/\/ @version\s+2\.9\.41$/m);
  assert.match(bundled, /const VERSION = '2\.9\.41'/);
  assert.match(bundled, /CONNECTION_INTERRUPTED_REFRESH_LIMIT = 3/);
  assert.match(bundled, /RATE_LIMIT_FRESH_RETRY_AFTER = 3/);
  assert.match(bundled, /STOP_MISSING_CONTINUE_GRACE_MS/);
});
