import { test } from "node:test";
import assert from "node:assert/strict";

const events = [], session = {}, local = {};
const url = "https://chatgpt.com/c/recovery-test";
let tabs = [];
let onUpdated;
const clone = value => structuredClone(value);
const storage = data => ({
  get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, clone(data[key])])),
  set: async update => Object.assign(data, clone(update)),
});
globalThis.chrome = {
  storage: { local: storage(local), session: storage(session) },
  runtime: { getURL: path => `chrome-extension://fabushi/${path}`, onMessage: { addListener() {} } },
  tabs: {
    onUpdated: { addListener(listener) { onUpdated = listener; } },
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
const { probeScriptPage, probeBlackFrame } = await import("../chrome-platform/extension/userscript-tab-health.js");
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
test("a DOM-healthy black frame requires continuous failure and a final black recheck", async () => {
  reset(); tabs[0].active = true; tabs[0].windowId = 3;
  let time = 1_000_000, black = true;
  const healthy = async () => ({ healthy: true, reason: "content-visible" });
  const visual = async () => black;
  await scanManagedTabs("first-black", { now: () => time, probe: healthy, visual });
  assert.equal(session[WATCHDOG_KEY][10].lastHealthReason, "black-frame");
  time += 89_999;
  await scanManagedTabs("still-black", { now: () => time, probe: healthy, visual });
  assert.equal(events.length, 0);
  time += 1; black = false;
  await scanManagedTabs("recovered-frame", { now: () => time, probe: healthy, visual });
  assert.equal(session[WATCHDOG_KEY][10].unhealthySince, 0);
  black = true;
  await scanManagedTabs("black-again", { now: () => time, probe: healthy, visual });
  time += 90_000;
  let calls = 0;
  await scanManagedTabs("final-frame-recovered", { now: () => time, probe: healthy,
    visual: async () => ++calls === 1 });
  assert.equal(events.length, 0);
  await scanManagedTabs("black-confirmed", { now: () => time, probe: healthy, visual });
  time += 90_000;
  await scanManagedTabs("black-confirmed-after-threshold", { now: () => time, probe: healthy, visual });
  assert.equal(events.filter(event => event[0] === "Runtime.terminateExecution").length, 1);
});
test("visual capture is inconclusive outside the focused active tab", async () => {
  reset(); tabs[0].windowId = 3;
  assert.equal(await probeBlackFrame(tabs[0]), null);
  tabs[0].active = true;
  const original = chrome.windows;
  chrome.windows = { get: async () => ({ focused: false }) };
  try { assert.equal(await probeBlackFrame(tabs[0]), null); }
  finally { chrome.windows = original; }
});
test("viewport sampling distinguishes a uniformly black frame from dark-mode content", async () => {
  reset(); tabs[0].active = true; tabs[0].windowId = 3;
  const previous = { windows: chrome.windows, capture: chrome.tabs.captureVisibleTab,
    bitmap: globalThis.createImageBitmap, canvas: globalThis.OffscreenCanvas };
  let darkPixels = 256, closed = 0;
  chrome.windows = { get: async () => ({ focused: true }) };
  chrome.tabs.captureVisibleTab = async () => "data:image/jpeg;base64,AA==";
  globalThis.createImageBitmap = async () => ({ close() { closed++; } });
  globalThis.OffscreenCanvas = class {
    getContext() { return { drawImage() {}, getImageData() {
      const data = new Uint8ClampedArray(16 * 16 * 4);
      for (let i = 0; i < 256; i++) {
        const offset = i * 4;
        data[offset] = data[offset + 1] = data[offset + 2] = i < darkPixels ? 0 : 220;
        data[offset + 3] = 255;
      }
      return { data };
    } }; }
  };
  try {
    assert.equal(await probeBlackFrame(tabs[0]), true);
    darkPixels = 240;
    assert.equal(await probeBlackFrame(tabs[0]), false);
    assert.equal(closed, 2);
  } finally {
    chrome.windows = previous.windows;
    chrome.tabs.captureVisibleTab = previous.capture;
    globalThis.createImageBitmap = previous.bitmap;
    globalThis.OffscreenCanvas = previous.canvas;
  }
});
test("protected DOM input is diagnosed but never unloaded until a fresh unprotected probe", async () => {
  reset(); tabs[0].active = true; tabs[0].windowId = 3;
  let time = 1_000_000, calls = 0;
  const visual = async () => { calls++; return true; };
  await scanManagedTabs("protected", { now: () => time,
    probe: async () => ({ healthy: true, protected: true }), visual });
  assert.equal(calls, 1);
  assert.equal(session[WATCHDOG_KEY][10].lastHealthReason, "black-frame-protected-input");
  assert.equal(session[WATCHDOG_KEY][10].status, "protected-suspect");
  time += 90_000;
  await scanManagedTabs("timeout-after-draft", { now: () => time, probe: failed, visual });
  assert.equal(events.length, 0);
  assert.equal(session[WATCHDOG_KEY][10].lastProtectedInput, true);
  await scanManagedTabs("draft-cleared", { now: () => time,
    probe: async () => ({ healthy: true, protected: false, reason: "content-visible" }), visual });
  assert.equal(events.filter(event => event[0] === "Runtime.terminateExecution").length, 1);
});
test("inconclusive capture after protected input clears suspicion only when rendered content is healthy", async () => {
  reset(); tabs[0].active = true; tabs[0].windowId = 3;
  let time = 1_000_000;
  await scanManagedTabs("protected-black", { now: () => time,
    probe: async () => ({ healthy: true, protected: true }), visual: async () => true });
  time += 90_000;
  await scanManagedTabs("healthy-dark-mode", { now: () => time,
    probe: async () => ({ healthy: true, protected: false, reason: "content-visible" }), visual: async () => false });
  assert.equal(events.length, 0);
  assert.equal(session[WATCHDOG_KEY][10].unhealthySince, 0);
  assert.equal(session[WATCHDOG_KEY][10].lastProtectedInput, false);
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

test('indefinitely loading failed renderer is recovered only after grace plus continuous failures', async()=>{
 reset(); let time=Date.now(); tabs[0].status='loading';
 await scanManagedTabs('loading',{now:()=>time,probe:failed});
 time+=120000; await scanManagedTabs('grace',{now:()=>time,probe:failed});
 assert.equal(events.length,0);
 time+=89999; await scanManagedTabs('not-yet',{now:()=>time,probe:failed}); assert.equal(events.length,0);
 time++; await scanManagedTabs('stalled',{now:()=>time,probe:failed});
 assert.equal(events.filter(e=>e[0]==='Runtime.terminateExecution').length,1);
 assert.equal(session[RESCUE_KEY][10].allowLoading,true);
});
for(const kind of ['discard','replacement','protected','moved','refused'])test(`stalled transit fallback: ${kind}`,async()=>{
 reset(); const original={update:chrome.tabs.update,discard:chrome.tabs.discard,executeScript:chrome.scripting.executeScript};
 const resume=url+'#fabushi-resume=checkpoint';
 try{
  // tabs.update accepted the navigation but its renderer never committed it.
  chrome.tabs.update=async(id,patch)=>{events.push(['update',id,patch]);};
  await rescueSameTab(10,url,resume);
  const started=session[RESCUE_KEY][10].startedAt;
  await restoreRescue(10); assert.equal(session[RESCUE_KEY][10].startedAt,started);
  session[RESCUE_KEY][10].startedAt=Date.now()-31000;
  chrome.scripting.executeScript=async()=>[{result:{healthy:kind==='protected',protected:kind==='protected'}}];
  chrome.tabs.update=original.update;
  if(kind==='moved')tabs[0].pendingUrl='https://example.com/';
  if(kind==='refused')tabs[0].active=true;
  if(kind==='replacement')chrome.tabs.discard=async id=>{events.push(['discard',id]);tabs[0].id=11;tabs[0].discarded=true;return clone(tabs[0]);};
  if(kind==='refused'){
   await assert.rejects(restoreRescue(10),/active/); await assert.rejects(restoreRescue(10),/active/);
   assert.equal(await restoreRescue(10),false); assert.equal(events.filter(e=>e[0]==='discard').length,2);
  }else{
   await restoreRescue(10);
   if(['protected','moved'].includes(kind))assert.equal(events.some(e=>e[0]==='discard'),false);
   else {assert.equal(tabs[0].url,resume); assert.equal(tabs[0].id,kind==='replacement'?11:10);assert.equal(tabs[0].index,2);assert.equal(tabs[0].groupId,8);assert.deepEqual(session[RESCUE_KEY],{});}
  }
 }finally{chrome.tabs.update=original.update;chrome.tabs.discard=original.discard;chrome.scripting.executeScript=original.executeScript;}
});

for (const active of [false, true]) test(`incognito ${active ? "active" : "inactive"} tab uses browser-owned transit and exact checkpoint`, async () => {
  reset(); Object.assign(tabs[0], { incognito: true, active });
  const resume = url + "#fabushi-resume=same-owner-round-token";
  await rescueSameTab(10, url, resume);
  assert.match(tabs[0].url, /^about:blank#fabushi-rescue=[a-f0-9-]+$/);
  assert.equal(session[RESCUE_KEY][10].transitURL, tabs[0].url);
  assert.equal(events.filter(e => e[0] === "update").length, 1);
  await restoreRescue(10);
  assert.equal(tabs[0].url, resume);
  assert.equal(tabs[0].id, 10); assert.equal(tabs[0].index, 2); assert.equal(tabs[0].groupId, 8);
  assert.equal(tabs[0].active, active);
  assert.equal(events.some(e => e[0] === "discard"), false);
  assert.deepEqual(session[RESCUE_KEY], {});
});
test("background complete event restores incognito transit without page script or ready message", async () => {
  reset(); tabs[0].incognito = true;
  await rescueSameTab(10, url, url + "#fabushi-resume=event");
  onUpdated(10, { status: "loading" });
  await new Promise(resolve => setImmediate(resolve));
  assert.match(tabs[0].url, /^about:blank#/);
  onUpdated(10, { status: "complete" });
  onUpdated(10, { status: "complete" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(tabs[0].url, url + "#fabushi-resume=event");
  assert.equal(events.filter(e => e[0] === "update").length, 2);
});
for (const transit of ["about:blank#fabushi-rescue=saved", "chrome-extension://fabushi/tab-rescue.html#legacy-blocked"]) {
  test(`worker restart restores exact persisted incognito transit: ${transit}`, async () => {
    reset(); Object.assign(tabs[0], { incognito: true, url: transit });
    session[RESCUE_KEY] = { 10: { sourceURL: url, recoveryURL: url + "#fabushi-resume=saved", transitURL: transit, stage: "prepared" } };
    await Promise.all([restoreRescue(10), restoreRescue(10)]);
    assert.equal(tabs[0].url, url + "#fabushi-resume=saved");
    assert.equal(events.filter(e => e[0] === "update").length, 1);
    assert.ok(session[WATCHDOG_KEY][10].settleUntil > Date.now());
    assert.deepEqual(session[RESCUE_KEY], {});
  });
}
for (const kind of ["current", "pending"]) test(`incognito transit respects foreign ${kind} navigation`, async () => {
  reset(); tabs[0].incognito = true;
  await rescueSameTab(10, url, url);
  if (kind === "current") tabs[0].url = "about:blank#unrelated";
  else tabs[0].pendingUrl = "https://example.com/user-navigation";
  events.length = 0;
  assert.equal(await restoreRescue(10), false);
  assert.equal(events.length, 0);
  assert.deepEqual(session[RESCUE_KEY], {});
});
test("unrecorded incognito blank document is never adopted", async () => {
  reset(); Object.assign(tabs[0], { incognito: true, url: "about:blank#fabushi-rescue=unknown" });
  onUpdated(10, { status: "complete" });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(await restoreRescue(10), false);
  assert.equal(events.length, 0);
});
