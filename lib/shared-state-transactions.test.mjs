import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fork } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-shared-state-'));
const file = path.join(root, 'hidden.json'); process.env.PI_WEB_HIDDEN_FILE = file;
const hidden = await import('./hidden-state.ts');
const { subscribeActivityEvents } = await import('./activity-events.ts');
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

test('external commit invalidates cached read and is retained by the next writer', () => {
 hidden.readHiddenState(); fs.writeFileSync(file, JSON.stringify({ sessions: ['external'] }));
 hidden.setHidden('session', 'local', true);
 assert.deepEqual(hidden.readHiddenState().sessions, ['external', 'local']);
});
test('failed persistent commit throws without publishing success or poisoning reads', () => {
 const before = fs.readFileSync(file, 'utf8'); fs.unlinkSync(file); fs.mkdirSync(file);
 let notifications = 0; const stop = subscribeActivityEvents(() => notifications++);
 try { assert.throws(() => hidden.setHidden('session', 'failed', true)); assert.equal(notifications, 0); }
 finally { stop(); fs.rmdirSync(file); fs.writeFileSync(file, before); }
 assert.equal(hidden.readHiddenState().sessions.includes('failed'), false);
});
test('two independent primed processes wait out a held lock and preserve both commits', async () => {
 fs.writeFileSync(file, JSON.stringify({ sessions: [] }));
 const worker = path.join(root, 'worker.mjs');
 fs.writeFileSync(worker, `const h = await import(${JSON.stringify(new URL('./hidden-state.ts', import.meta.url).href)});
 h.readHiddenState(); process.send('ready'); process.on('message', id => {
  h.setHidden('session', id, true); process.send('done'); process.disconnect();
 });`);
 const children = ['A', 'B'].map(id => ({ id, child: fork(worker, [], { env: { ...process.env, PI_WEB_HIDDEN_FILE: file }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] }) }));
 try {
  await Promise.all(children.map(({ child }) => new Promise((resolve, reject) => { child.once('error', reject); child.once('message', resolve); })));
  const { acquireStateWriteLock } = await import('../bin/state-write-lock.cjs');
  const release = acquireStateWriteLock(file);
  const done = children.map(({ id, child }) => new Promise((resolve, reject) => { child.once('message', () => resolve()); child.once('exit', code => { if (code) reject(new Error(`worker exit ${code}`)); }); child.send(id); }));
  await delay(150); release();
  await Promise.all(done);
  assert.deepEqual(hidden.readHiddenState().sessions.sort(), ['A', 'B']);
 } finally { for (const { child } of children) if (child.connected) child.disconnect(); }
});

test('malformed hidden data is withheld for display and never replaced by a fallback mutation',async()=>{
 const before='{ "sessions": ["private-session"';fs.writeFileSync(file,before);
 const {readCatalogMetadata}=await import('./catalog-metadata.ts');
 const readers={hidden:hidden.readHiddenState,favorites:()=>({sessions:[]}),categories:()=>({to_discuss:[],to_revise:[],completed:[]}),viewed:()=>({})};
 const metadata=readCatalogMetadata('fixture-device',readers);
 assert.equal(metadata.hidden,null);assert.deepEqual(metadata.warnings,[{deviceId:'fixture-device',domain:'hidden',code:'metadata_unavailable'}]);
 let notifications=0;const stop=subscribeActivityEvents(()=>notifications++);
 try{assert.throws(()=>hidden.setHidden('session','new',true));assert.equal(notifications,0);assert.equal(fs.readFileSync(file,'utf8'),before);}
 finally{stop();fs.writeFileSync(file,JSON.stringify({sessions:['private-session']}));}
 assert.deepEqual(readCatalogMetadata('fixture-device',readers).hidden.sessions,['private-session']);
 assert.deepEqual(readCatalogMetadata('fixture-device',readers).warnings,[]);
});

test('permission failure is never treated as a missing hidden file',async t=>{
 const {syncBuiltinESMExports}=await import('node:module');
 const {readCatalogMetadata}=await import('./catalog-metadata.ts');
 fs.writeFileSync(file,JSON.stringify({sessions:['private-session']}));
 const read=fs.readFileSync,exists=fs.existsSync;
 t.mock.method(fs,'existsSync',target=>target===file?false:exists(target));
 t.mock.method(fs,'readFileSync',(target,...rest)=>{if(target===file)throw Object.assign(new Error('permission denied'),{code:'EACCES'});return read(target,...rest)});
 syncBuiltinESMExports();
 try{
  assert.throws(()=>hidden.readHiddenState(),{code:'EACCES'});
  const metadata=readCatalogMetadata('fixture-device',{hidden:hidden.readHiddenState,favorites:()=>({sessions:[]}),categories:()=>({to_discuss:[],to_revise:[],completed:[]}),viewed:()=>({})});
  assert.equal(metadata.hidden,null);assert.equal(metadata.warnings[0].domain,'hidden');
 }finally{t.mock.restoreAll();syncBuiltinESMExports();}
 assert.deepEqual(hidden.readHiddenState().sessions,['private-session']);
});
