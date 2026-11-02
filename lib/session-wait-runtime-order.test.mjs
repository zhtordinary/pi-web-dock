import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url), core=require('../bin/session-wait-core.cjs');
const {acquireStateWriteLock}=require('../bin/state-write-lock.cjs');
const owner={deviceId:'dev',sessionId:'owner'}, target={deviceId:'dev',sessionId:'target'};
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-runtime-order-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));core.createWait(root,'test',{id:'wait',owner,target,condition:'turn_settled',taskId:'run1',continuation:{target:owner,message:'resume'}});return root;}
function event(type){return {id:core.sha256({sessionId:'target',runId:'run1',type}),type,identity:target,taskId:'run1'};}
for(const immediateThird of [false,true]) test(`queued lifecycle keeps producer order, immediate later event=${immediateThird}`, t=>{
 const root=fixture(t),release=acquireStateWriteLock(core.stateFile(root,'test'));
 try {assert.equal(core.runtimeEvent(root,'test',event('turn_settled')).queued,true);assert.equal(core.runtimeEvent(root,'test',event('task_failed')).queued,true);}finally{release();}
 if(immediateThird) core.runtimeEvent(root,'test',{...event('progress'),message:'later'});
 else core.drainRuntimeEvents(root,'test');
 const state=core.readState(root,'test');assert.equal(state.waits.wait.status,'completed');assert.equal(Object.keys(state.outbox).length,1);
 assert.deepEqual(state.eventOrder.filter(id=>[event('turn_settled').id,event('task_failed').id].includes(id)),[event('turn_settled').id,event('task_failed').id]);
 const revision=state.revision;core.drainRuntimeEvents(root,'test');assert.equal(core.readState(root,'test').revision,revision);
});
test('runtime inbox retries parent directory durability before acknowledging persisted',t=>{
 const root=fixture(t),release=acquireStateWriteLock(core.stateFile(root,'test'));
 // Track the directory descriptors opened on root; /proc/self/fd exists only on Linux.
 const original=fs.fsyncSync,originalOpen=fs.openSync,originalClose=fs.closeSync,rootFds=new Set();let fail=true,attempts=0;
 fs.openSync=(file,...rest)=>{const fd=originalOpen(file,...rest);if(path.resolve(String(file))===root)rootFds.add(fd);return fd;};
 fs.closeSync=fd=>{rootFds.delete(fd);return originalClose(fd);};
 fs.fsyncSync=fd=>{if(rootFds.has(fd)){attempts++;if(fail)throw Object.assign(new Error('parent EIO'),{code:'EIO'});}return original(fd);};
 try {assert.throws(()=>core.runtimeEvent(root,'test',event('turn_settled')),/parent EIO/);assert.throws(()=>core.runtimeEvent(root,'test',event('turn_settled')),/parent EIO/);fail=false;assert.equal(core.runtimeEvent(root,'test',event('turn_settled')).persisted,true);assert.ok(attempts>=3);}finally{fs.fsyncSync=original;fs.openSync=originalOpen;fs.closeSync=originalClose;release();}
 core.drainRuntimeEvents(root,'test');assert.equal(core.readState(root,'test').waits.wait.status,'completed');
});

test('legacy hashed inbox is recovered with an explicit irrecoverable-order warning',t=>{
 const root=fixture(t),dir=`${core.stateFile(root,'test')}.events`;fs.mkdirSync(dir);
 const legacy=event('turn_settled');fs.writeFileSync(path.join(dir,`${core.sha256(legacy.id)}.json`),JSON.stringify(legacy));
 core.drainRuntimeEvents(root,'test');
 assert.equal(core.getStatus(root,'test').waits[0].status,'completed');
 assert.equal(core.getStatus(root,'test').runtimeInboxWarnings[0].reason,'legacy_runtime_event_order_unknown');
 assert.deepEqual(fs.readdirSync(dir),[]);
});

test('independent producer processes preserve each producer order across restart and duplicate drain',async t=>{
 const {spawn}=await import('node:child_process');
 const root=fixture(t),release=acquireStateWriteLock(core.stateFile(root,'test'));
 const modulePath=require.resolve('../bin/session-wait-core.cjs');
 const jobs=['a','b'].map(producer=>new Promise((resolve,reject)=>{
  const code=`const c=require(${JSON.stringify(modulePath)});for(let n=0;n<8;n++){const r=c.runtimeEvent(${JSON.stringify(root)},'test',{id:'${producer}-'+n,type:'progress',identity:${JSON.stringify(target)},taskId:'run1',message:'sequence '+n});if(!r.persisted)throw Error('not persisted');}`;
  const child=spawn(process.execPath,['-e',code],{stdio:['ignore','ignore','pipe']});let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(new Error(stderr)));
 }));
 try{await Promise.all(jobs);}finally{release();}
 // Fresh process is the worker restart boundary.
 const {execFileSync}=await import('node:child_process');execFileSync(process.execPath,['-e',`require(${JSON.stringify(modulePath)}).drainRuntimeEvents(${JSON.stringify(root)},'test')`]);
 const state=core.readState(root,'test');for(const producer of ['a','b'])assert.deepEqual(state.eventOrder.filter(id=>id.startsWith(producer+'-')),Array.from({length:8},(_,n)=>producer+'-'+n));
 const revision=state.revision;core.drainRuntimeEvents(root,'test');assert.equal(core.readState(root,'test').revision,revision);
});

test('crash after domain commit before inbox removal replays idempotently in original order',async t=>{
 const root=fixture(t),release=acquireStateWriteLock(core.stateFile(root,'test'));
 try{core.runtimeEvent(root,'test',event('turn_settled'));core.runtimeEvent(root,'test',event('task_failed'));}finally{release();}
 const {spawnSync}=await import('node:child_process');
 const code=`const fs=require('node:fs'),c=require(${JSON.stringify(require.resolve('../bin/session-wait-core.cjs'))});const unlink=fs.renameSync;fs.renameSync=(a,b)=>{unlink(a,b);if(b===${JSON.stringify(core.stateFile(root,'test'))})process.kill(process.pid,'SIGKILL')};c.drainRuntimeEvents(${JSON.stringify(root)},'test');`;
 const killed=spawnSync(process.execPath,['-e',code]);assert.equal(killed.signal,'SIGKILL');
 core.drainRuntimeEvents(root,'test');const state=core.readState(root,'test');assert.equal(state.waits.wait.status,'completed');assert.equal(Object.keys(state.outbox).length,1);
 assert.equal(state.eventOrder.filter(id=>id===event('turn_settled').id).length,1);
});

test('paused consumer mutex cannot block durable terminal ingress',t=>{
 const root=fixture(t),release=acquireStateWriteLock(`${core.stateFile(root,'test')}.events-drain`);
 try{const start=Date.now();assert.equal(core.runtimeEvent(root,'test',event('turn_settled')).queued,true);assert.ok(Date.now()-start<1000);}finally{release();}
 core.recoverState(root,'test');assert.equal(core.getStatus(root,'test').waits[0].status,'completed');
});

test('already published events from another producer precede a new immediate event',async t=>{
 const {execFileSync}=await import('node:child_process');const root=fixture(t);
 const release=acquireStateWriteLock(`${core.stateFile(root,'test')}.events-drain`);
 try{execFileSync(process.execPath,['-e',`require(${JSON.stringify(require.resolve('../bin/session-wait-core.cjs'))}).runtimeEvent(${JSON.stringify(root)},'test',${JSON.stringify(event('turn_settled'))})`]);}finally{release();}
 core.runtimeEvent(root,'test',event('task_failed'));
 assert.equal(core.getStatus(root,'test').waits[0].status,'completed');assert.equal(core.getStatus(root,'test').outbox.length,1);
});

test('SIGSTOP paused drainer does not prevent another process publishing',async t=>{
 const {spawn,execFileSync}=await import('node:child_process');const root=fixture(t),modulePath=require.resolve('../bin/session-wait-core.cjs');
 const release=acquireStateWriteLock(core.stateFile(root,'test'));try{core.runtimeEvent(root,'test',event('turn_settled'));}finally{release();}
 const code=`const fs=require('node:fs'),c=require(${JSON.stringify(modulePath)});const rename=fs.renameSync;let paused=false;fs.renameSync=(a,b)=>{if(!paused&&b===${JSON.stringify(core.stateFile(root,'test'))}){paused=true;process.stdout.write('paused\\n');process.kill(process.pid,'SIGSTOP');}rename(a,b)};c.drainRuntimeEvents(${JSON.stringify(root)},'test');`;
 const child=spawn(process.execPath,['-e',code],{stdio:['ignore','pipe','pipe']});t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);child.once('exit',()=>reject(new Error('drainer exited before pause')));});
 const result=JSON.parse(execFileSync(process.execPath,['-e',`const c=require(${JSON.stringify(modulePath)});console.log(JSON.stringify(c.runtimeEvent(${JSON.stringify(root)},'test',${JSON.stringify(event('task_failed'))})))`],{encoding:'utf8',timeout:2000}));
 assert.equal(result.persisted,true);assert.equal(result.queued,true);
 const done=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGCONT');await done;
 core.drainRuntimeEvents(root,'test');assert.equal(core.getStatus(root,'test').waits[0].status,'completed');assert.equal(core.getStatus(root,'test').outbox.length,1);
});

test('replay during import cannot resurrect an old publication dependency and create a cycle',t=>{
 const root=fixture(t),A={...event('progress'),id:'A'},B={...event('progress'),id:'B'};
 const release=acquireStateWriteLock(`${core.stateFile(root,'test')}.events-drain`);try{core.runtimeEvent(root,'test',A);}finally{release();}
 const unlink=fs.unlinkSync;let interleaved=false;
 fs.unlinkSync=file=>{
  if(!interleaved&&path.basename(file).startsWith(core.sha256('A')+'.')){
   interleaved=true;assert.equal(core.runtimeEvent(root,'test',B).queued,true);
  }
  return unlink(file);
 };
 try{core.drainRuntimeEvents(root,'test');}finally{fs.unlinkSync=unlink;}
 assert.equal(interleaved,true,'test must publish B before removing the old A publication');
 assert.ok(core.readState(root,'test').events.B,'publication during a drain snapshot must be consumed by the same drain');
 core.runtimeEvent(root,'test',A);core.drainRuntimeEvents(root,'test');
 const state=core.readState(root,'test');assert.ok(state.events.A);assert.ok(state.events.B);
 assert.equal(state.eventOrder.filter(id=>id==='A').length,1);assert.equal(state.eventOrder.filter(id=>id==='B').length,1);
 assert.deepEqual(fs.readdirSync(`${core.stateFile(root,'test')}.events`),[]);
});
