import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const {acquireStateWriteLock}=require('../bin/state-write-lock.cjs');
function fixture(t) { const root=fs.mkdtempSync(path.join(os.tmpdir(),'reader-kernel-lock-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root; }
test('nested writer is rejected promptly and released after exceptions', t=>{
 const file=path.join(fixture(t),'state.json');const release=acquireStateWriteLock(file);
 try {
  assert.throws(()=>acquireStateWriteLock(file),{code:'ELOCKED'});
  // A waiting writer on the holder's own thread would wait on itself.
  const started=Date.now();assert.throws(()=>acquireStateWriteLock(file,5_000),{code:'ELOCKED'});
  assert.ok(Date.now()-started<1_000);
 }finally{release();}
 acquireStateWriteLock(file)();
});
test('a waiting writer acquires after another process releases its lock', async t=>{
 const root=fixture(t),file=path.join(root,'state.json'),worker=path.join(root,'holder.cjs');
 fs.writeFileSync(worker,`const {acquireStateWriteLock}=require(${JSON.stringify(require.resolve('../bin/state-write-lock.cjs'))});const release=acquireStateWriteLock(${JSON.stringify(file)});process.send('locked');process.once('message',()=>setTimeout(()=>{release();process.disconnect();},100));`);
 const child=fork(worker,[],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{try{child.kill('SIGKILL')}catch{}});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)});
 assert.throws(()=>acquireStateWriteLock(file),{code:'ELOCKED'});
 const started=Date.now();child.send('release');acquireStateWriteLock(file,5_000)();
 assert.ok(Date.now()-started>=100);
});
test('nonexistent files reached through parent aliases share a lock', t=>{
 const root=fixture(t);fs.mkdirSync(path.join(root,'physical'));fs.symlinkSync(path.join(root,'physical'),path.join(root,'alias'));
 const release=acquireStateWriteLock(path.join(root,'physical','new.json'));
 try {assert.throws(()=>acquireStateWriteLock(path.join(root,'alias','new.json')),{code:'ELOCKED'});}finally{release();}
});
test('paused writer cannot be evicted by time and process death releases its lock', async t=>{
 const root=fixture(t),file=path.join(root,'state.json'),worker=path.join(root,'holder.cjs');
 fs.writeFileSync(worker,`const {acquireStateWriteLock}=require(${JSON.stringify(require.resolve('../bin/state-write-lock.cjs'))});acquireStateWriteLock(${JSON.stringify(file)});process.send('locked');setInterval(()=>{},1000);`);
 const child=fork(worker,[],{stdio:['ignore','ignore','pipe','ipc']});t.after(()=>{try{child.kill('SIGKILL')}catch{}});
 await new Promise((resolve,reject)=>{child.once('message',resolve);child.once('error',reject)});
 child.kill('SIGSTOP');fs.utimesSync(`${file}.writer.sqlite`,new Date(0),new Date(0));
 assert.throws(()=>acquireStateWriteLock(file),{code:'ELOCKED'});
 const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGKILL');await exited;
 acquireStateWriteLock(file)();
});


test('managed symlinks share their physical lock and hard links fail closed', t=>{
 const root=fixture(t),file=path.join(root,'state.json');fs.writeFileSync(file,'{}');
 const alias=path.join(root,'alias.json');fs.symlinkSync(file,alias);
 const release=acquireStateWriteLock(alias);
 try { assert.throws(()=>acquireStateWriteLock(file),{code:'ELOCKED'}); } finally { release(); }
 fs.unlinkSync(alias);fs.linkSync(file,alias);
 assert.throws(()=>acquireStateWriteLock(alias),{code:'ESTATEALIAS'});
 assert.equal(fs.readFileSync(file,'utf8'),'{}');
});

test('managed symlink remains intact after a transactional atomic write', async t=>{
 const {withStateFileTransaction}=await import('./state-file-transaction.ts');
 const {writePrivateFileAtomicSync}=await import('./atomic-file.ts');
 const root=fixture(t),file=path.join(root,'state.json'),alias=path.join(root,'managed.json');
 fs.writeFileSync(file,'old');fs.symlinkSync(file,alias);
 withStateFileTransaction(alias,()=>writePrivateFileAtomicSync(alias,'new'));
 assert.equal(fs.lstatSync(alias).isSymbolicLink(),true);
 assert.equal(fs.readFileSync(file,'utf8'),'new');
 const release=acquireStateWriteLock(file);
 try {assert.throws(()=>withStateFileTransaction(alias,()=>{}),{code:'ELOCKED'});} finally {release();}
});

test('legacy locks are checked at both literal and physical state paths', async t=>{
 const {withStateFileTransaction}=await import('./state-file-transaction.ts');
 const root=fixture(t),file=path.join(root,'state.json'),alias=path.join(root,'managed.json');
 fs.writeFileSync(file,'{}');fs.symlinkSync(file,alias);

 fs.writeFileSync(`${file}.lock`,'legacy physical lock');
 assert.throws(()=>withStateFileTransaction(alias,()=>{}),{code:'ELOCKED'});
 fs.unlinkSync(`${file}.lock`);

 fs.writeFileSync(`${alias}.lock`,'legacy alias lock');
 assert.throws(()=>withStateFileTransaction(alias,()=>{}),{code:'ELOCKED'});
 fs.unlinkSync(`${alias}.lock`);
 fs.symlinkSync(path.join(root,'missing-target'),`${file}.lock`);
 assert.throws(()=>withStateFileTransaction(alias,()=>{}),{code:'ELOCKED'});
});
