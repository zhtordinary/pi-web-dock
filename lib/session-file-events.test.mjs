import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {stripTypeScriptTypes} from 'node:module';
import {createJiti} from 'jiti';

const jiti=createJiti(import.meta.url);
const {createAgentEventStream}=await jiti.import('./agent-event-stream.ts');
const {TranscriptReader}=await jiti.import('./transcript-reader.ts');
const {createHistoryProjection,getHistoryWindow}=await jiti.import('./session-history.ts');
const hook=await readFile(new URL('../hooks/useAgentSession.ts',import.meta.url),'utf8');
const route=await readFile(new URL('../app/api/agent/[id]/events/route.ts',import.meta.url),'utf8');
const decoder=new TextDecoder();
const entry=(id,parentId,role='user')=>({type:'message',id,parentId,timestamp:'2026-10-24T00:00:00Z',message:{role,content:role==='assistant'?[{type:'text',text:id}]:id}});
async function within(promise) {
 let timer;
 try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('file event deadline exceeded')),2000);})]);}
 finally{clearTimeout(timer);}
}
async function event(reader) {
 for(;;) {
  const chunk=await within(reader.read());assert.equal(chunk.done,false);
  const text=decoder.decode(chunk.value);
  if(text.startsWith('data: '))return JSON.parse(text.slice(6));
 }
}
function routeGet(filePath,sessionId) {
 const code=stripTypeScriptTypes(route.replace(/^import .*;\r?\n/gm,'').replace(/^export /gm,''));
 return new Function('createAgentEventStream','getRpcSession','assertRpcSessionRuntimeBinding','resolveSessionPathReadOnly','subscribeWaitingUserRequests',code+'; return GET;')(
  createAgentEventStream,()=>undefined,()=>{throw new Error('a read must not bind a runtime');},async id=>{assert.equal(id,sessionId);return filePath;},()=>()=>{},
 );
}
function mountHistory(reader,sessionId,intervals) {
 const refresh=hook.indexOf('    const refresh = () => { if (document.visibilityState === "visible") void reader.reconcileTail(); };');
 const start=hook.lastIndexOf('  useEffect(() => {',refresh),end=hook.indexOf('  useEffect(() => {',refresh);
 assert.ok(start>=0&&end>start);
 let cleanup;
 new Function('useEffect','reader','session','remotePeer','viewport','sessionOpenScrollRef','scrollUserMsgToTop','scrollToBottom','window','document',stripTypeScriptTypes(hook.slice(start,end)))(
  effect=>{cleanup=effect();},reader,{id:sessionId},null,{follow:false},{current:'last-question'},()=>false,()=>{},
  {addEventListener(){},removeEventListener(){},setInterval(fn){intervals.push(fn);return intervals.length;},clearInterval(){}},
  {visibilityState:'visible',addEventListener(){},removeEventListener(){}},
 );
 return cleanup;
}
function dispatchHistory(reader,value) {
 const start=hook.indexOf('      case "history_changed":');
 assert.ok(start>=0,'the selected session must consume file-change events');
 const end=hook.indexOf('      case "',start+12);
 const code=stripTypeScriptTypes(`switch(event.type){${hook.slice(start,end)}}`);
 new Function('reader','event',code)(reader,value);
}

test('an external process appends through the read-only SSE route and the page catches up without interval requests',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'reader-file-follow-')),file=path.join(root,'session.jsonl'),sessionId='file-follow';
 await writeFile(file,[entry('q0',null),entry('a0','q0','assistant')].map(value=>JSON.stringify(value)).join('\n')+'\n');
 const abort=new AbortController(),calls=[],intervals=[];
 const reader=new TranscriptReader(null,async(_scope,query)=>{
  calls.push(query);
  const entries=(await readFile(file,'utf8')).trim().split('\n').map(line=>JSON.parse(line));
  return getHistoryWindow(createHistoryProjection(entries,{sessionId}),query);
 });
 let sse,cleanup;
 t.after(async()=>{abort.abort();cleanup?.();await sse?.cancel();await rm(root,{recursive:true,force:true});});
 const response=await routeGet(file,sessionId)(new Request('http://localhost/events',{signal:abort.signal}),{params:Promise.resolve({id:sessionId})});
 assert.equal(response.status,200);
 sse=response.body.getReader();
 assert.deepEqual(await event(sse),{type:'connected',sessionId,isStreaming:false,isPromptRunning:false,runtimeAvailable:false,pendingExtensionUiIds:[]});
 cleanup=mountHistory(reader,sessionId,intervals);
 await reader.reconcileTail();
 assert.deepEqual(reader.getState().transcript.entryIds,['q0','a0']);
 const initialCalls=calls.length;
 let stop;
 const arrived=new Promise(resolve=>{stop=reader.subscribe(()=>{if(reader.getState().transcript.entryIds.includes('a1'))resolve();});});
 t.after(()=>stop?.());
 const appended=[entry('q1','a0'),entry('a1','q1','assistant')].map(value=>JSON.stringify(value)+'\n');
 execFileSync(process.execPath,['-e',"const fs=require('node:fs'); for(const line of JSON.parse(process.argv[2]))fs.appendFileSync(process.argv[1],line);",file,JSON.stringify(appended)]);
 const change=await event(sse);
 assert.equal(change.type,'history_changed');
 dispatchHistory(reader,change);
 await within(arrived);
 assert.deepEqual(reader.getState().transcript.entryIds,['q0','a0','q1','a1']);
 assert.equal(intervals.length,0,'a selected idle page installs no history poll');
 assert.equal(calls.length,initialCalls+1,'one file-change burst produces one catch-up');
});

test('unknown history ends the readiness handshake instead of leaving a reconnect loop',async()=>{
 const response=await routeGet(null,'missing-file')(new Request('http://localhost/events'),{params:Promise.resolve({id:'missing-file'})});
 const reader=response.body.getReader();
 assert.equal((await event(reader)).type,'startup_error');
 assert.equal((await within(reader.read())).done,true);
});

test('two observers share file change delivery and one disconnect does not end the other',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'reader-file-share-')),file=path.join(root,'session.jsonl');
 await writeFile(file,JSON.stringify(entry('q0',null))+'\n');
 const aborts=[new AbortController(),new AbortController()];
 const readers=aborts.map(abort=>createAgentEventStream(new Request('http://localhost/events',{signal:abort.signal}),'shared-file',Promise.resolve(null),file).getReader());
 t.after(async()=>{for(const abort of aborts)abort.abort();await Promise.all(readers.map(reader=>reader.cancel()));await rm(root,{recursive:true,force:true});});
 for(const reader of readers)assert.equal((await event(reader)).runtimeAvailable,false);
 execFileSync(process.execPath,['-e',"require('node:fs').appendFileSync(process.argv[1],process.argv[2]);",file,JSON.stringify(entry('q1','q0'))+'\n']);
 for(const reader of readers)assert.equal((await event(reader)).type,'history_changed');
 await readers[0].cancel();
 execFileSync(process.execPath,['-e',"require('node:fs').appendFileSync(process.argv[1],process.argv[2]);",file,JSON.stringify(entry('q2','q1'))+'\n']);
 assert.equal((await event(readers[1])).type,'history_changed');
 execFileSync(process.execPath,['-e',"const fs=require('node:fs'),file=process.argv[1];fs.writeFileSync(file+'.tmp',fs.readFileSync(file));fs.renameSync(file+'.tmp',file);",file]);
 assert.equal((await event(readers[1])).type,'history_changed');
 execFileSync(process.execPath,['-e',"require('node:fs').appendFileSync(process.argv[1],process.argv[2]);",file,JSON.stringify(entry('q3','q2'))+'\n']);
 assert.equal((await event(readers[1])).type,'history_changed');
});

test('a draft file created by another process is observed without creating directories in the reader',async t=>{
 const root=await mkdtemp(path.join(tmpdir(),'reader-file-draft-')),file=path.join(root,'project','nested','session.jsonl');
 const abort=new AbortController();
 const reader=createAgentEventStream(new Request('http://localhost/events',{signal:abort.signal}),'draft-file',Promise.resolve({isStreaming:false,streamingMessage:null,onEvent(){return ()=>{};}}),file).getReader();
 t.after(async()=>{abort.abort();await reader.cancel();await rm(root,{recursive:true,force:true});});
 assert.equal((await event(reader)).type,'connected');
 execFileSync(process.execPath,['-e',"const fs=require('node:fs'),p=require('node:path');fs.mkdirSync(p.dirname(process.argv[1]),{recursive:true});fs.appendFileSync(process.argv[1],process.argv[2]);",file,JSON.stringify(entry('q0',null))+'\n']);
 assert.equal((await event(reader)).type,'history_changed');
});
