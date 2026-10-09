import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const root = new URL('../chrome-platform/extension/', import.meta.url);
test('canonical local import replaces managed copy and retains host identity',async()=>{
  const core=await readFile(new URL('userscript-core.js',root),'utf8');
  const {normalizeUserScript,publicUserScript}=await import('data:text/javascript,'+encodeURIComponent(core));
  const source='// ==UserScript==\n// @name ChatGPT 自动确认 · Fabushi\n// @namespace https://fabushi.ombhrum.com/userscripts/chatgpt-auto-confirm\n// @version 2.10.39\n// @match https://chatgpt.com/*\n// ==/UserScript==\n';
  let records=[normalizeUserScript(source,{sourcePluginId:'chatgpt-auto-confirm'})];
  const runner=await readFile(new URL('userscript-runner.js',root),'utf8');
  const a=runner.indexOf('export async function installUserScript');
  const b=runner.indexOf('async function callInstalledPlugin',a);
  const context=vm.createContext({normalizeUserScript,publicUserScript,BUNDLED_PLUGIN_ID:'chatgpt-auto-confirm',BUNDLED_STATE_KEY:'bundled',readRecords:async()=>records,writeRecords:async r=>{records=r;},registerUserScript:async()=>{},chrome:{storage:{local:{set:async()=>{}}},tabs:{query:async()=>[]}}});
  vm.runInContext(runner.slice(a,b).replace('export async','async')+'globalThis.install=installUserScript;',context);
  await context.install({source});
  assert.equal(records.length,1);
  assert.equal(records[0].sourcePluginId,'chatgpt-auto-confirm');
  assert.equal(records[0].version,'2.10.39');
});
async function backgroundFixture() {
  const calls=[]; const listeners={}; let enabled=true;
  const tabs=[{id:1,url:'https://chatgpt.com/c/background',active:false},{id:2,url:'https://chatgpt.com/c/front',active:true},{id:3,url:'https://chatgpt.com/c/discarded',discarded:true},{id:4,url:'https://example.org/',active:false}];
  const event=name=>({addListener:fn=>{listeners[name]=fn;}});
  const core=await readFile(new URL('userscript-core.js',root),'utf8');
  const {userScriptMatches}=await import('data:text/javascript,'+encodeURIComponent(core));
  const context=vm.createContext({setTimeout,console,userScriptMatches,chrome:{
    storage:{local:{get:async()=>({'fabushi.userscripts.v1':[{sourcePluginId:'chatgpt-auto-confirm',enabled,matches:['https://chatgpt.com/*']}]})}},
    tabs:{query:async()=>tabs,sendMessage:async(id,message,options)=>{calls.push({id,message,options});}},
    runtime:{onMessage:event('message'),onStartup:event('startup'),onInstalled:event('installed')},
    alarms:{create:async(name,options)=>{calls.push({name,options});},onAlarm:event('alarm')}
  }});
  const source=await readFile(new URL('userscript-background-wake.js',root),'utf8');
  vm.runInContext(source.replace(/^import.*\n/, '').replace('export async function','async function')+'\nglobalThis.wake = wakeBackgroundTabs;',context);
  return {calls,listeners,context,disable:()=>{enabled=false;}};
}
test('host alarm wakes only enabled inactive live ChatGPT tabs without focus change',async()=>{
  const f=await backgroundFixture();
  await f.context.wake();
  assert.equal(f.calls.filter(c=>c.id).length,1);
  assert.equal(f.calls.find(c=>c.id).id,1);
  assert.equal(f.calls.find(c=>c.id).options.frameId,0);
  assert.equal(f.calls[0].options.periodInMinutes,0.5);
  f.disable(); await f.context.wake();
  assert.equal(f.calls.filter(c=>c.id).length,1);
});
test('host clock validates top-frame origin and bounded delay then replies independently',async()=>{
  const f=await backgroundFixture();
  const sender={tab:{id:1},frameId:0,url:'https://chatgpt.com/c/test'};
  const reply=await new Promise(resolve=>assert.equal(f.listeners.message({type:'fabushi.userscript.clock',delayMs:5},sender,resolve),true));
  assert.equal(reply.ok,true);
  for(const [delayMs,url,frameId] of [[20001,sender.url,0],[-1,sender.url,0],[0,'https://example.org/',0],[0,sender.url,1]]) {
    let reply;
    assert.equal(f.listeners.message({type:'fabushi.userscript.clock',delayMs},{...sender,url,frameId},r=>{reply=r;}),false);
    assert.equal(reply.ok,false);
  }
});
test('same-tab memory recovery discards before reload and reports reload failure',async()=>{
  const runner=await readFile(new URL('userscript-runner.js',root),'utf8');
  const a=runner.indexOf('function pruneMemoryDiscardCooldowns');
  const b=runner.indexOf('if (typeof chrome',a);
  const policySource=await readFile(new URL('userscript-memory-policy.js',root),'utf8');
  const {validateMemoryRequest,MEMORY_DISCARD_COOLDOWN_MS}=await import('data:text/javascript,'+encodeURIComponent(policySource));
  const calls=[]; let active=false;let failReload=false;let replacement=null;let storedLeases;let failMigration=false;
  const context=vm.createContext({console:{warn:()=>{}},validateMemoryRequest,MEMORY_DISCARD_COOLDOWN_MS,MEMORY_PLUGIN_ID:'chatgpt-auto-confirm',memoryDiscardedAt:new Map(),readRecords:async()=>[{id:'test',sourcePluginId:'chatgpt-auto-confirm',enabled:true}],chrome:{storage:{session:{get:async()=>({}),set:async()=>{}},local:{get:async()=>{if(failMigration)throw Error('storage');return {'fabushi.userscriptRecovery.v1':{owner:{tabId:9}}};},set:async value=>{storedLeases=value;}}},tabs:{get:async id=>({id,url:'https://chatgpt.com/c/test',active}),discard:async id=>{calls.push(['discard',id]);return replacement ? {id:replacement} : undefined;},reload:async id=>{calls.push(['reload',id]);if(failReload)throw Error('reload');}}}});
  vm.runInContext(runner.slice(a,b)+'globalThis.request = requestTabMemoryCleanup;',context);
  const message={pluginId:'chatgpt-auto-confirm',scriptId:'test',payload:{capability:'tab-memory-discard-resume',pressure:'high',usedBytes:2*1024**3,safeToDiscard:true,resumeAfterDiscard:true}};
  const result=await context.request(message,{tab:{id:7}});
  assert.equal(result.reloaded,true);
  assert.deepEqual(calls,[['discard',7],['reload',7]]);
  assert.equal((await context.request(message,{tab:{id:7}})).reason,'cooldown');
  active=true;
  assert.equal((await context.request(message,{tab:{id:8}})).reason,'active-tab');
  active=false;failReload=true;
  const failure=await context.request(message,{tab:{id:8}});
  assert.equal(failure.reason,'reload-failed');
  assert.equal(failure.discarded,true);
  failReload=false;replacement=99;
  const replaced=await context.request(message,{tab:{id:9}});
  assert.equal(replaced.tabId,99);
  assert.equal(replaced.originalTabId,9);
  assert.deepEqual(calls.slice(-2),[['discard',9],['reload',99]]);
  assert.equal(storedLeases['fabushi.userscriptRecovery.v1'].owner.tabId,99);
  assert.equal((await context.request(message,{tab:{id:99}})).reason,'cooldown');
  failMigration=true;replacement=100;
  assert.equal((await context.request(message,{tab:{id:10}})).reloaded,true);
  assert.deepEqual(calls.slice(-2),[['discard',10],['reload',100]]);
});
test('legacy recovery cannot race a host memory discard into a replacement tab',async()=>{
  const recovery=await readFile(new URL('userscript-recovery.js',root),'utf8');
  const a=recovery.indexOf('async function scanRecoveryRecords');
  const b=recovery.indexOf('async function ensureRecoveryAlarm',a);
  let recovered=0;
  const now=Date.now();
  const context=vm.createContext({scanPromise:null,HEARTBEAT_STALE_MS:1000,Date,readRecords:async()=>({owner:{tabId:7,lastSeenAt:now-2000,expiresAt:now+100000,status:'granted'}}),writeRecords:async()=>{},syncKeepAwake:async()=>{},keepAwakeNeeded:()=>true,isCrashURL:()=>false,isCrashTitle:()=>false,recoverRecord:async()=>{recovered++;},chrome:{tabs:{get:async()=>({id:7,discarded:true})},storage:{session:{get:async()=>({'fabushi.userscript.memory-discard:7':now})}}}});
  vm.runInContext(recovery.slice(a,b)+'globalThis.scan = scanRecoveryRecords;',context);
  await context.scan();
  assert.equal(recovered,0);
});
