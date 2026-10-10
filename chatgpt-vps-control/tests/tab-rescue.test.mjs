import { test } from "node:test";
import assert from "node:assert/strict";

const events = [], session = {}, local = {};
const url = "https://chatgpt.com/c/recovery-test";
let tabs = [];
const clone = value => structuredClone(value);
const storage = data => ({
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])),
  set: async update => Object.assign(data, clone(update)),
});
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  runtime: { getURL: path => `chrome-extension://fabushi/${path}`, onMessage: { addListener() {} } },
  tabs: {
    query: async () => clone(tabs),
    get: async id => { const tab = tabs.find(tab => tab.id === id); if (!tab) throw Error("closed"); return clone(tab); },
    discard: async id => { events.push(["discard", id]); const tab = tabs.find(tab => tab.id === id); if (tab.active) throw Error("active"); tab.discarded = true; return clone(tab); },
    update: async (id, update) => { events.push(["update", id, update]); Object.assign(tabs.find(tab => tab.id === id), update); },
    reload: async (id, update) => { events.push(["reload", id, update]); tabs.find(tab => tab.id === id).discarded = false; },
  },
  debugger: { attach: async target => events.push(["attach", target]), sendCommand: async (target, command) => events.push([command, target]), detach: async target => events.push(["detach", target]) },
  scripting: { executeScript: async () => [{ result: { healthy: true, reason: "visible" } }] },
};
const { rescueSameTab, restoreRescue, RESCUE_KEY } = await import("../chrome-platform/extension/userscript-tab-rescue.js");
const { scanManagedTabs, WATCHDOG_KEY, repairUnclaimedTask } = await import("../chrome-platform/extension/userscript-watchdog.js");
const { probeScriptPage } = await import("../chrome-platform/extension/userscript-tab-health.js");
function reset() {
  events.length = 0;
  for (const data of [session, local]) for (const key of Object.keys(data)) delete data[key];
  tabs = [{ id: 10, url, active: false, index: 2, groupId: 8, status: "complete" }];
  local["fabushi.userscripts.v1"] = [{ id: "auto-confirm", enabled: true, matches: ["https://chatgpt.com/*"] }];
}
const failed = async () => ({ healthy: false, reason: "probe-timeout" });
test("responsive task script owns recovery until its exact-route heartbeat becomes stale", async () => {
  reset(); let time = Date.now();
  local["fabushi.userscripts.v1"][0].sourcePluginId = "chatgpt-auto-confirm";
  local["fabushi.userscriptRecovery.v1"] = { owner: { tabId:10, sourceURL:url,
    running:true, status:"granted", lastSeenAt:time, expiresAt:time+600000 } };
  await scanManagedTabs("responsive", { now:()=>time, probe:failed });
  time += 90000;
  await scanManagedTabs("responsive", { now:()=>time, probe:failed });
  assert.equal(events.length,0);
  assert.equal(session[WATCHDOG_KEY][10].lastHealthReason,"task-script-responsive");
  time++;
  await scanManagedTabs("stale", { now:()=>time, probe:failed });
  time+=90000;
  await scanManagedTabs("hung", { now:()=>time, probe:failed });
  assert.equal(events.filter(event=>event[0]==="Runtime.terminateExecution").length,1);
});
test("a heartbeat renewed during a failed probe cancels host recovery",async()=>{
  reset(); let time=Date.now();
  local["fabushi.userscripts.v1"][0].sourcePluginId="chatgpt-auto-confirm";
  await scanManagedTabs("start",{now:()=>time,probe:failed}); time+=90000;
  await scanManagedTabs("renewed",{now:()=>time,probe:async()=>{
    local["fabushi.userscriptRecovery.v1"]={owner:{tabId:10,sourceURL:url,running:true,status:"granted",lastSeenAt:time,expiresAt:time+300000}};
    return failed();
  }});
  assert.equal(events.length,0);
  assert.equal(session[WATCHDOG_KEY][10].unhealthySince,0);
});

test("inactive hung tab crosses origin without discard, preserving numeric identity and checkpoint", async () => {
  reset();
  const resume = url + "#fabushi-resume=saved";
  await rescueSameTab(10, url, resume);
  assert.deepEqual(events.map(event => event[0]), ["attach", "Runtime.terminateExecution", "detach", "update"]);
  await restoreRescue(10);
  assert.equal(tabs[0].id, 10); assert.equal(tabs[0].index, 2); assert.equal(tabs[0].groupId, 8);
  assert.equal(tabs[0].url, resume); assert.equal(tabs[0].active, false);
});
test("active hung tab terminates execution and crosses extension origin without changing focus", async () => {
  reset(); tabs[0].active = true;
  await rescueSameTab(10, url, url);
  assert.deepEqual(events.map(event => event[0]), ["attach", "Runtime.terminateExecution", "detach", "update"]);
  assert.match(tabs[0].url, /^chrome-extension:\/\/fabushi\/tab-rescue.html#/);
  assert.equal(tabs[0].active, true);
  assert.equal(session[RESCUE_KEY][10].recoveryURL, url);
  await restoreRescue(10);
  assert.equal(tabs[0].url, url);
});
test("user navigation after a failed-page observation is never overwritten", async () => {
  reset(); tabs[0].url = "https://example.com/";
  await assert.rejects(rescueSameTab(10, url, url), /navigated/);
  assert.equal(events.length, 0);
});
test("bootstrap discovers already-hung page without heartbeat and keeps an expired lease checkpoint", async () => {
  reset(); let time = 1_000_000;
  const resume = url + "#fabushi-resume=old-checkpoint";
  local["fabushi.userscriptRecovery.v1"] = { owner: { tabId: 10, sourceURL: url, recoveryURL: resume, expiresAt: 1 } };
  await scanManagedTabs("start", { now: () => time, probe: failed });
  assert.equal(events.length, 0);
  time += 90_000;
  await scanManagedTabs("alarm", { now: () => time, probe: failed });
  await restoreRescue(10);
  assert.equal(tabs[0].url, resume);
  assert.equal(session[WATCHDOG_KEY][10].recoveryCount, 1);
});
test("healthy shell, drafts, frozen and deliberately discarded tabs do not recover", async () => {
  for (const mode of ["healthy", "draft", "frozen", "discarded"]) {
    reset(); let time = 1_000_000;
    if (mode === "frozen" || mode === "discarded") tabs[0][mode] = true;
    const probe = mode === "healthy" ? async () => ({ healthy: true })
      : mode === "draft" ? async () => ({ protected: true }) : failed;
    await scanManagedTabs("start", { now: () => time, probe }); time += 90_000;
    await scanManagedTabs("alarm", { now: () => time, probe });
    assert.equal(events.length, 0, mode);
  }
});
test("sleep gap resets continuous failure evidence; disabled scripts and closed tabs stop monitoring", async () => {
  reset(); let time = 1_000_000;
  await scanManagedTabs("start", { now: () => time, probe: failed }); time += 600_000;
  await scanManagedTabs("wake", { now: () => time, probe: failed });
  assert.equal(events.length, 0);
  local["fabushi.userscripts.v1"][0].enabled = false;
  await scanManagedTabs("disabled", { now: () => time, probe: failed });
  assert.deepEqual(session[WATCHDOG_KEY], {});
});
test("crash loop budget survives healthy document and stops after two attempts", async () => {
  reset(); let time = Date.now();
  for (let index = 0; index < 3; index++) {
    await scanManagedTabs("alarm", { now: () => time, probe: failed }); time += 90_000;
    await scanManagedTabs("alarm", { now: () => time, probe: failed });
    await restoreRescue(10);
    await scanManagedTabs("healthy", { now: () => time, probe: async () => ({ healthy: true }) });
    time += 120_000;
  }
  assert.equal(events.filter(event => event[0] === "Runtime.terminateExecution").length, 2);
  assert.equal(session[WATCHDOG_KEY][10].recoveryCount, 2);
});
test("restored slow page waits through loading and settling before fresh failure evidence", async () => {
  reset();
  await rescueSameTab(10, url, url);
  await restoreRescue(10);
  const deadline = session[WATCHDOG_KEY][10].settleUntil;
  assert.ok(deadline > Date.now());
  events.length = 0;
  let time = deadline - 1_000, probes = 0;
  const probe = async () => { probes++; return failed(); };
  await scanManagedTabs("worker-restart", { now: () => time, probe });
  assert.equal(probes, 0);
  tabs[0].status = "loading";
  time = deadline + 600_000;
  await scanManagedTabs("slow-network", { now: () => time, probe });
  assert.equal(probes, 0);
  assert.equal(events.length, 0);
  assert.equal(session[WATCHDOG_KEY][10].unhealthySince, 0);
  tabs[0].status = "complete";
  await scanManagedTabs("loaded", { now: () => time, probe });
  time += 89_999;
  await scanManagedTabs("alarm", { now: () => time, probe });
  assert.equal(events.length, 0);
  time += 1;
  await scanManagedTabs("alarm", { now: () => time, probe });
  assert.equal(events.filter(event => event[0] === "Runtime.terminateExecution").length, 1);
});
test("loading at destructive recheck does not terminate the newly loading page", async () => {
  reset(); let time = Date.now();
  await scanManagedTabs("start", { now: () => time, probe: failed });
  time += 90_000;
  await scanManagedTabs("race", { now: () => time, probe: async () => {
    tabs[0].status = "loading";
    return failed();
  } });
  assert.equal(events.length, 0);
});
test("worker restart at restored destination consumes pending restoration without replay", async () => {
  reset();
  session[RESCUE_KEY] = { 10: { sourceURL: url, recoveryURL: url,
    transitURL: "chrome-extension://fabushi/tab-rescue.html#old", stage: "restoring" } };
  tabs[0].status = "loading";
  assert.equal(await restoreRescue(10), true);
  assert.equal(events.length, 0);
  assert.deepEqual(session[RESCUE_KEY], {});
});
test("an unresponsive probe returns within its deadline rather than blocking scan", async () => {
  reset(); const original = chrome.scripting.executeScript;
  chrome.scripting.executeScript = () => new Promise(() => {});
  try { assert.equal((await probeScriptPage(10, 10)).reason, "probe-timeout"); }
  finally { chrome.scripting.executeScript = original; }
});
test("worker eviction after persisting destination resumes unload in the same tab", async () => {
  reset();
  session[RESCUE_KEY] = { 10: { sourceURL: url, recoveryURL: url, transitURL: "chrome-extension://fabushi/tab-rescue.html#old", stage: "prepared" } };
  await restoreRescue(10);
  assert.deepEqual(events.map(event => event[0]), ["attach", "Runtime.terminateExecution", "detach", "update"]);
  await restoreRescue(10);
  assert.equal(tabs[0].id, 10);
  assert.deepEqual(session[RESCUE_KEY], {});
});
test("a draft appearing at the final probe cancels recovery", async () => {
  reset(); let time = 1_000_000;
  await scanManagedTabs("start", { now: () => time, probe: failed }); time += 90_000;
  let calls = 0;
  await scanManagedTabs("alarm", { now: () => time, probe: async () => ++calls === 1
    ? { healthy: false, reason: "blank-document" } : { protected: true, healthy: true } });
  assert.equal(events.length, 0);
});
test("unclaimed task repair validates route, task ownership and draft before same-tab transit", async () => {
  reset();
  local["fabushi.userscripts.v1"][0].sourcePluginId = "chatgpt-auto-confirm";
  const original = chrome.scripting.executeScript;
  let protectedInput = false, claimed = false;
  chrome.scripting.executeScript = async ({ func }) => [{ result: func.name === "taskRecoveryAdapter"
    ? { resumable: true, ownerTabId: "owner", currentOwner: claimed ? "owner" : "new" }
    : { healthy: true, protected: protectedInput } }];
  try {
    protectedInput = true;
    await assert.rejects(repairUnclaimedTask(10, url), /protected/);
    assert.equal(events.length, 0);
    protectedInput = false; claimed = true;
    await assert.rejects(repairUnclaimedTask(10, url), /not-unclaimed/);
    claimed = false;
    await assert.rejects(repairUnclaimedTask(10, "https://chatgpt.com/c/other"), /navigated/);
    const result = await repairUnclaimedTask(10, url);
    assert.equal(result.tabId, 10);
    assert.equal(events.some(event => event[0] === "discard"), false);
    assert.match(session[RESCUE_KEY][10].recoveryURL, /#fabushi-resume=fabushi-host-/);
    await restoreRescue(10);
    assert.equal(tabs[0].id, 10);
    assert.equal(session["fabushi.scriptTabRecoveryHistory.v1"][0].trigger, "explicit-task-repair");
  } finally { chrome.scripting.executeScript = original; }
});
