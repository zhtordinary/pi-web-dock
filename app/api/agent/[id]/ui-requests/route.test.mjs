import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import ts from 'typescript';
const source=readFileSync(new URL('./route.ts',import.meta.url),'utf8');
function fixture(live) {
 let checks=0;
 const fixtureModule={exports:{}};
 const createReaderStreamWriter=(controller,diagnostic,onOverflow,onEnqueueError)=>{let startup=true;const frames=[];const enqueue=text=>{if((controller.desiredSize??0)<=0){diagnostic.droppedEvents++;onOverflow();return false}try{controller.enqueue(new TextEncoder().encode(text));diagnostic.connectedAt??=Date.now();diagnostic.lastWriteAt=Date.now();diagnostic.queuedBytes=Math.max(0,256*1024-(controller.desiredSize??256*1024));return true}catch{onEnqueueError();return false}};return {write:text=>startup?(frames.push(text),true):enqueue(text),flush:()=>{startup=false;const text=frames.splice(0).join('');return !text||enqueue(text)}}};
 const deps={'@/lib/rpc-manager':{getRpcSession:()=>live,assertRpcSessionRuntimeBinding:async()=>{checks++}},'@/lib/request-security':{isApiRequestAllowed:()=>true},'@/lib/reader-event-stream':{createReaderStreamWriter,registerReaderStreamCloser:()=>()=>{},READER_STREAM_HIGH_WATER_MARK_BYTES:256*1024}};
 new Function('require','module','exports',ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText)(name=>{assert.ok(name in deps);return deps[name]},fixtureModule,fixtureModule.exports);
 return {get:(suffix='',signal)=>fixtureModule.exports.GET(new Request('http://localhost/api/agent/B/ui-requests'+suffix,{signal}),{params:Promise.resolve({id:'B'})}),checks:()=>checks};
}
test('absent/restarted runtime has no pending promises and reads never restore it',async()=>{
 const f=fixture();const body=await (await f.get()).json();assert.equal(body.runtimeStatus,'not_live');assert.equal(body.runtimeGeneration,null);assert.deepEqual(body.requests,[]);assert.equal(body.previousRequests,'invalidated');assert.equal(f.checks(),0);
 const stream=await (await f.get('?stream=1')).text();assert.match(stream,/event: ui_requests/);assert.match(stream,/not_live/);
});
test('SSE replays full snapshot, publishes changes without polling and removes listener on disconnect',async()=>{
 let listener,removed=0;
 let snapshot={runtimeStatus:'live',runtimeGeneration:'generation-1',revision:1,requests:[{id:'request1',title:'x'.repeat(40000),method:'input'}]};
 const live={isAlive:()=>true,isShuttingDown:()=>false,getPendingUiRequestsSnapshot:()=>snapshot,subscribeUiRequests:fn=>{listener=fn;fn(snapshot);return()=>{removed++;listener=null}}};
 const f=fixture(live);const response=await f.get('?stream=1');const reader=response.body.getReader();
 const first=new TextDecoder().decode((await reader.read()).value);assert.ok(first.includes('x'.repeat(40000)));
 snapshot={...snapshot,revision:2,requests:[]};listener(snapshot);
 const second=new TextDecoder().decode((await reader.read()).value);assert.match(second,/"revision":2/);assert.match(second,/"requests":\[\]/);
 await reader.cancel();assert.equal(removed,1);assert.equal(listener,null);
 assert.deepEqual((await (await f.get()).json()).requests,[]);
});
