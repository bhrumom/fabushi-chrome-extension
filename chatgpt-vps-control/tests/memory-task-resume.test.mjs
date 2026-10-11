import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {webcrypto} from 'node:crypto';
const base=new URL('../chrome-platform/extension/',import.meta.url).href;
const {memoryRecoveryTarget,taskRecoveryAdapter}=await import(base+'userscript-task-recovery.js');
let moduleIndex=0;
async function requestTabMemoryCleanup(...args){
 const mockChrome=globalThis.chrome;delete globalThis.chrome;
 const runner=await import(base+'userscript-runner.js?test='+moduleIndex++);
 globalThis.chrome=mockChrome;
 return runner.requestTabMemoryCleanup(...args);
}
const route='https://chatgpt.com/c/original';
const task={id:'task',ownerTabId:'owner',state:'generating',round:27,phase:'work',url:route,token:'original-send',attempted:true,attachments:[{id:'attachment'}]};
const stored={tasks:[task],tabControls:{owner:{autoResume:true}}};
function mock({active=false,checkpoint={resumable:true,ownerTabId:'owner',taskId:'task',currentOwner:'owner'},moved=false}={}){
 const calls=[];let reads=0;
 const records={'fabushi.userscripts.v1':[{id:'chatgpt-auto-confirm',sourcePluginId:'chatgpt-auto-confirm',enabled:true}], 'fabushi.chatgpt-auto-confirm.update-checked-at':Date.now()};
 globalThis.chrome={storage:{local:{get:async()=>records,set:async()=>{}},session:{get:async()=>({}),set:async value=>calls.push(['persist',value])}},scripting:{executeScript:async()=>[{result:checkpoint}]},tabs:{get:async()=>({id:17,active,url:moved&&reads++>0?'https://chatgpt.com/c/changed':route}),discard:async()=>{calls.push(['discard',17]);return {id:18};},update:async(id,opts)=>{calls.push(['update',id,opts.url]);},reload:async id=>calls.push(['reload',id])}};
 return calls;
}
const request={pluginId:'chatgpt-auto-confirm',scriptId:'chatgpt-auto-confirm',payload:{capability:'tab-memory-discard',resumeAfterDiscard:true,safeToDiscard:true,userInitiated:true,pressure:'high'}};
test('inactive discard carries owner ticket even after sessionStorage and numeric tab identity disappear',async()=>{
 const calls=mock();const result=await requestTabMemoryCleanup(request,{tab:{id:17}});
 assert.equal(result.reloaded,true);assert.equal(result.tabId,18);
 const destination=calls.find(c=>c[0]==='update')[2];assert.match(destination,/#fabushi-resume=fabushi-host-/);
 const storage=new Map([['fabushi-workbench-v2',JSON.stringify(stored)]]);const before=storage.get('fabushi-workbench-v2');
 const prepared=vm.runInNewContext(`(${taskRecoveryAdapter.toString()})({prepare:true})`,{location:new URL(destination),URL,URLSearchParams,Date,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},sessionStorage:{getItem:()=>null}});
 assert.equal(prepared.prepared,true);assert.equal(prepared.ownerTabId,'owner');assert.equal(prepared.round,27);
 assert.equal(storage.get('fabushi-workbench-v2'),before,'task, attachments, send identity and controls unchanged');
 const token=new URL(destination).hash.slice('#fabushi-resume='.length);
 assert.equal(JSON.parse(storage.get('fabushi-workspace-recovery-v1:'+token)).ownerTabId,'owner');
});
test('active task defers automatic discard without creating a task tab',async()=>{
 const calls=mock({active:true});const result=await requestTabMemoryCleanup(request,{tab:{id:17}});
 assert.equal(result.reason,'active-tab');assert.equal(calls.length,0);
});
test('missing checkpoint defers destruction',async()=>{
 const calls=mock({checkpoint:{resumable:false}});const result=await requestTabMemoryCleanup(request,{tab:{id:17}});
 assert.equal(result.reason,'task-checkpoint-unavailable');assert.equal(calls.length,0);
});
test('route change while probing defers destruction',async()=>{
 const calls=mock({moved:true});const result=await requestTabMemoryCleanup(request,{tab:{id:17}});
 assert.equal(result.reason,'tab-navigated');assert.equal(calls.length,0);
});
test('different current workspace cannot recycle another owner',()=>{
 assert.equal(memoryRecoveryTarget({url:route},{url:route},{resumable:true,ownerTabId:'owner',taskId:'task',currentOwner:'other'}).ok,false);
});
test('paused and ambiguous workspaces cannot produce a recovery ticket',()=>{
 for(const snapshot of [
  {...stored,tabControls:{owner:{autoResume:false}}},
  {...stored,tasks:[task,{...task,id:'second',ownerTabId:'second-owner'}]},
 ]){
  const storage=new Map([['fabushi-workbench-v2',JSON.stringify(snapshot)]]);
  const prepared=vm.runInNewContext(`(${taskRecoveryAdapter.toString()})({prepare:true})`,{location:new URL(route+'#fabushi-resume=fabushi-host-00000000-0000-4000-8000-000000000000'),URL,URLSearchParams,Date,localStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value)},sessionStorage:{getItem:()=>null}});
  assert.equal(prepared.resumable,false);assert.equal(storage.size,1);
 }
});
