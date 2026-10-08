import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { canonicalTaskScript, taskRecoveryAdapter } from "../chrome-platform/extension/userscript-task-recovery.js";
const token = "fabushi-host-00000000-0000-0000-0000-000000000000";
function setup(tasks, controls = {}) {
  const data = new Map([["fabushi-workbench-v2", JSON.stringify({ tasks, tabControls: controls, selectedByTab: { old: "task" } })]]);
  const session = new Map([["fabushi-workbench-tab-session-v1", "new-workspace"]]);
  const adapter = vm.runInNewContext(`(${taskRecoveryAdapter.toString()})`, {
    location: new URL("https://chatgpt.com/c/exact#fabushi-resume=" + token), URL, URLSearchParams, Date,
    localStorage: { getItem: key => data.get(key) || null, setItem: (key, value) => data.set(key, value) },
    sessionStorage: { getItem: key => session.get(key) || null },
  });
  return { adapter, data };
}
const task = { id: "task", ownerTabId: "old", url: "https://chatgpt.com/c/exact", state: "waiting", phase: "review", round: 81, token: "original-send", attempted: true, attachments: [{ id: "file" }] };
test("fresh host reload ticket resumes exact-route running workspace without altering phase/round/token/attachments", () => {
  const { adapter, data } = setup([task]);
  const original = data.get("fabushi-workbench-v2");
  const result = adapter({ prepare: true });
  assert.equal(result.prepared, true); assert.equal(result.ownerTabId, "old"); assert.equal(result.taskId, "task");
  assert.equal(result.round, 81); assert.equal(result.phase, "review");
  assert.equal(data.get("fabushi-workbench-v2"), original);
  assert.equal(JSON.parse(data.get("fabushi-workspace-recovery-v1:" + token)).ownerTabId, "old");
});
test("task owner ambiguity and paused/done/cancelled intent never resume", () => {
  for (const state of ["paused", "done", "cancelled"]) {
    const { adapter } = setup([{ ...task, state }]); assert.equal(adapter({ prepare: true }).resumable, false);
  }
  const { adapter } = setup([task, { ...task, id: "other", ownerTabId: "other" }]);
  assert.equal(adapter({ prepare: true }).reason, "ambiguous-task-owner");
  assert.equal(setup([task], { old: { autoResume: false } }).adapter({ prepare: true }).resumable, false);
});
test("unrelated conversation cannot take task; old heartbeat still yields fresh explicit ticket", () => {
  assert.equal(setup([{ ...task, url: "https://chatgpt.com/c/other" }]).adapter({ prepare: true }).resumable, false);
  const { adapter, data } = setup([task]);
  data.set("fabushi-workspace-heartbeat-v1:old", JSON.stringify({ at: 1, running: true, autoResume: true }));
  adapter({ prepare: true });
  assert.ok(JSON.parse(data.get("fabushi-workspace-recovery-v1:" + token)).at > 1);
});
test("canonical imports receive adapter even when older installer omitted plugin ID", () => {
  assert.equal(canonicalTaskScript({ name: "ChatGPT 自动确认 · Fabushi", namespace: "https://fabushi.ombhrum.com/userscripts/chatgpt-auto-confirm" }), true);
  assert.equal(canonicalTaskScript({ name: "ChatGPT 自动确认 · Fabushi", namespace: "other" }), false);
});
