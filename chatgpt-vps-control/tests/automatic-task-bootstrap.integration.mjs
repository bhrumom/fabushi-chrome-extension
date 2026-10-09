import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {taskRecoveryAdapter,memoryRecoveryTarget} from '../chrome-platform/extension/userscript-task-recovery.js';
const sourceDir=process.env.FABUSHI_RECOVERY_USERSCRIPT_DIR;
assert.ok(sourceDir,'Set FABUSHI_RECOVERY_USERSCRIPT_DIR to the pinned standalone checkout');
const {JSDOM}=createRequire(resolve(sourceDir,'package.json'))('jsdom');
const source=await readFile(resolve(sourceDir,'chatgpt-auto-confirm.user.js'),'utf8');
const route='https://chatgpt.com/c/automatic-recovery';
test('real standalone bootstrap automatically reclaims and supervises the original turn after session identity loss',async()=>{
 const target=memoryRecoveryTarget({url:route},{url:route},{resumable:true,ownerTabId:'original-owner',taskId:'original-task',currentOwner:'original-owner'});
 const dom=new JSDOM('<body><article data-message-author-role="user"><p>original goal [Fabushi:original-send]</p></article><article data-message-author-role="assistant"><p>Working on original goal</p></article><form><textarea id="prompt-textarea"></textarea><button aria-label="Stop generating">Stop</button><button aria-label="Send prompt">Send</button></form></body>',{url:target.url,runScripts:'outside-only'});
 const w=dom.window;let sends=0;
 w.document.querySelector('[aria-label="Send prompt"]').onclick=()=>sends++;
 w.HTMLElement.prototype.getClientRects=function(){return this.hidden?[]:[{}];};
 w.SVGElement.prototype.getClientRects=function(){return this.hidden?[]:[{}];};
 const held=new Set();
 w.navigator.locks={query:async()=>({held:[...held].map(name=>({name}))}),request:async(name,options,callback)=>{callback ||= options;if(held.has(name))return callback(null);held.add(name);try{return await callback({name});}finally{held.delete(name);}}};
 const task={id:'original-task',ownerTabId:'original-owner',goal:'original goal',mode:'goal',state:'waiting',phase:'work',round:27,url:route,token:'original-send',attempted:false,sentAt:Date.now()-1000,attachments:[{id:'original-attachment',name:'saved.txt',size:1}],messages:[],updatedAt:Date.now()};
 w.localStorage.setItem('fabushi-workbench-v2',JSON.stringify({tasks:[task],autoResume:true,selected:task.id,selectedByTab:{'original-owner':task.id},tabControls:{'original-owner':{autoResume:true}}}));
 assert.equal(w.sessionStorage.length,0);
 try{
  const prepared=w.eval(`(${taskRecoveryAdapter.toString()})({prepare:true})`);
  assert.equal(prepared.prepared,true);
  await w.eval(source.replace('  mount();','  window.recoveryTest={owner:()=>tabId,tasks:tabTasks,running:()=>running,scans:()=>measurements.scans};\n  mount();'));
  const deadline=Date.now()+4000;
  while(Date.now()<deadline && (!w.recoveryTest?.running() || !w.recoveryTest?.scans() || w.recoveryTest?.tasks()[0]?.state!=='generating'))await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(w.recoveryTest.owner(),'original-owner');
  assert.equal(w.recoveryTest.running(),true,'runner starts without Start/Restore calls');
  assert.ok(w.recoveryTest.scans()>0,'supervisor actually inspected the resumed task');
  const resumed=w.recoveryTest.tasks()[0];
  assert.equal(resumed.id,task.id);assert.equal(resumed.round,27);assert.equal(resumed.phase,'work');assert.equal(resumed.token,'original-send');
  assert.equal(resumed.url,route);assert.equal(resumed.attachments[0].id,'original-attachment');assert.equal(resumed.state,'generating');
  assert.equal(sends,0,'already sent turn is not submitted again');
  assert.equal(w.location.hash,'','ticket consumed after successful owner bootstrap');
 }finally{await w.__FABUSHI_AUTO_CONFIRM_INSTANCE__?.shutdown();dom.window.close();}
});
