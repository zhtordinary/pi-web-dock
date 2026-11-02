import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const jiti=createJiti(import.meta.url);
const {TranscriptReader}=await jiti.import('./transcript-reader.ts');
const {HistoryTransportError}=await jiti.import('./session-history-controller.ts');
const cache=await jiti.import('./session-view-cache.ts');
const scope={sessionId:'s',peer:null};
const item=(i,text=`message ${i}`)=>({entryId:`e${i}`,orderKey:[i,1,i],role:'user',contentState:'full',process:false,toolCallCount:0,messageIndex:i,sourceType:'message',turnAnchor:null,message:{role:'user',content:text},deferred:[]});
const placeholder=i=>({...item(i),role:'assistant',message:null,contentState:'placeholder',process:true});
const page=(items,extra={})=>({kind:'window',sessionId:'s',leafId:'leaf',revision:'r1',items,processSummaries:[],before:null,after:null,coverage:{start:true,end:true},totalMessages:100,firstUserEntryId:'e0',lastUserEntryId:'e99',nodeCount:100,nodeOffset:0,...extra});
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve};};
function reader(fetcher){cache.clearHistoryViewCache();return new TranscriptReader(scope,fetcher);}
test('file changes arriving during a stale HTTP read coalesce one follow-up instead of being lost',async()=>{
 const stale=deferred();let calls=0;
 const r=reader(async()=>{calls++;return calls===1?page([item(0)]):calls===2?stale.promise:page([item(1)]);});
 await r.reset();
 const reading=r.reconcileTail();
 const changed=r.reconcileTail(),burst=r.reconcileTail();
 stale.resolve(page([]));
 await Promise.all([reading,changed,burst]);
 assert.equal(calls,3);
 assert.deepEqual(r.getState().transcript.entryIds,['e0','e1']);
});

test('all body requests omit revision and omitted leaf follows file appends',async()=>{
 const calls=[];let n=0;const r=reader(async(s,q)=>{calls.push([s,q]);return page([item(n++)],{revision:`r${n}`,leafId:`leaf${n}`});});
 await r.reconcileTail();await r.reconcileTail();assert.deepEqual(r.getState().transcript.entryIds,['e0','e1']);
 assert.equal(calls[1][1].after,'e0');for(const [s,q]of calls){assert.equal(s.leafId,undefined);assert.equal(q.revision,undefined);}
});
test('prepend retains all pages and append changes do not invalidate visible rows',async()=>{
 let n=10;const r=reader(async()=>page([item(n--)],{before:n<0?null:`e${n+1}`,revision:`r${n}`}));
 await r.reconcileTail();for(let i=0;i<10;i++)await r.previousPage();
 assert.deepEqual(r.getState().transcript.entryIds,Array.from({length:11},(_,i)=>`e${i}`));
});
test('a reset is atomic and late peer responses cannot publish',async()=>{
 const old=deferred();const r=reader(async()=>old.promise);const pending=r.reconcileTail();
 r.setScope({sessionId:'other',peer:'remote'});old.resolve(page([item(0)]));await pending;
 assert.equal(r.getState().transcript.messages.length,0);
});
test('window and index have independent cancellation channels',async()=>{
 const body=deferred(),index=deferred();const signals=[];const r=reader(async(s,q,signal)=>{signals.push(signal);return q.mode==='index'?index.promise:body.promise;});
 const a=r.reconcileTail(),b=r.loadIndex();assert.equal(signals[0].aborted,false);
 index.resolve({kind:'index',sessionId:'s',leafId:'leaf',revision:'r1',nodes:[],total:0,totalMessages:0,offset:0,before:null,after:null});await b;
 body.resolve(page([item(0)]));await a;assert.equal(r.getState().transcript.messages.length,1);
});
test('retry restores a failed minimap index as well as a missing tail answer',async()=>{
 let indexCalls=0,windowCalls=0;
 const answer={...item(1),role:'assistant',message:{role:'assistant',content:[{type:'text',text:'finished drawing'}]}};
 const r=reader(async(_scope,q)=>{
  if(q.mode==='window')return page(++windowCalls===1?[item(0)]:[answer],{nodeCount:1});
  if(++indexCalls===1)throw new Error('Connection reset');
  return {kind:'index',sessionId:'s',leafId:'leaf',revision:'r1',nodes:[{entryId:'e0',nodeIndex:0,orderKey:[0,1,0]}],total:1,offset:0,after:null};
 });
 await r.reconcileTail();await r.loadFullIndex();
 assert.match(r.getState().error.message,/Connection reset/);
 assert.equal(r.getState().index.pages.length,0);
 await r.retry();
 assert.deepEqual(r.getState().transcript.entryIds,['e0','e1']);
 assert.equal(r.getState().index.pages[0]?.nodes[0].entryId,'e0');
 assert.equal(r.getState().error,null);
});
test('retry continues a failed forward page without replacing the visible interval',async()=>{
 let fail=true;
 const r=reader(async(_scope,q)=>{if(q.mode==='index')return {kind:'index',sessionId:'s',leafId:'leaf',revision:'r1',nodes:[],offset:0,after:null};if(!q.after)return page([item(0)],{after:'e0'});if(fail)throw new Error('Offline');return page([item(1)]);});
 await r.reset('e0');await r.nextPage();fail=false;await r.retry();
 assert.deepEqual(r.getState().transcript.entryIds,['e0','e1']);assert.equal(r.getState().transcript.after,null);assert.equal(r.getState().error,null);
});
test('index 409 retries its own version without clearing transcript',async()=>{
 let indexCalls=0;const r=reader(async(s,q)=>{if(q.mode==='window')return page([item(0)]);if(++indexCalls===1)throw new HistoryTransportError('changed',{status:409,kind:'http',message:'changed',retryable:true});return {kind:'index',sessionId:'s',leafId:'leaf',revision:'new',nodes:[],total:0,offset:0};});
 await r.reconcileTail();await r.loadIndex({cursor:'old'});assert.equal(r.getState().transcript.entryIds[0],'e0');assert.equal(indexCalls,2);
});
test('one process expansion transparently reads all range pages and removes the summary only on completion',async()=>{
 const summary={firstEntryId:'e1',lastEntryId:'e3',firstMessageIndex:1,lastMessageIndex:3,messageCount:3,toolCallCount:2,toolNames:['bash'],turnAnchor:null};const requests=[];
 const r=reader(async(s,q)=>{requests.push(q);if(!q.from)return page([item(0),placeholder(1),placeholder(2),placeholder(3)]);return q.after?page([item(3)]):page([item(1),item(2)],{after:'e2'});});
 await r.reconcileTail();await r.expandProcess(summary);
 assert.deepEqual(r.getState().transcript.entryIds,['e0','e1','e2','e3']);assert.ok([...r.getState().transcript.items.values()].every(row=>row.contentState==='full'));
 assert.equal(requests[2].from,'e1');assert.equal(requests[2].to,'e3');assert.equal(requests[2].after,'e2');
});
test('a 57-row process retains its first 50 bodies on failure and clears the error after retry',async()=>{
 let fail=true;
 const full=i=>({...placeholder(i),contentState:'full',message:{role:'assistant',content:[{type:'text',text:`process ${i}`}]}});
 const r=reader(async(_scope,q)=>{
  if(!q.from)return page([item(0),...Array.from({length:57},(_,i)=>placeholder(i+1))]);
  if(!q.after)return page(Array.from({length:50},(_,i)=>full(i+1)),{after:'e50'});
  if(fail)throw new Error('Network offline');
  return page(Array.from({length:7},(_,i)=>full(i+51)));
 });
 await r.reconcileTail();
 const range={firstEntryId:'e1',lastEntryId:'e57'};
 assert.equal(await r.expandProcess(range),null);
 assert.match(r.getState().error.message,/Network offline/);
 assert.equal([...r.getState().transcript.items.values()].filter(row=>row.contentState==='placeholder').length,7);
 assert.equal(r.getState().transcript.messages.length,58);
 fail=false;
 await r.expandProcess(range);
 assert.equal(r.getState().error,null);
 assert.equal(r.getState().phase,'ready');
 assert.equal(r.getState().transcript.messages.length,58);
 assert.equal(new Set(r.getState().transcript.entryIds).size,58);
 assert.ok([...r.getState().transcript.items.values()].every(row=>row.contentState==='full'));
});
test('an incomplete process response fails explicitly instead of leaving permanent placeholders',async()=>{
 let complete=false;
 const full=i=>({...placeholder(i),contentState:'full',message:{role:'assistant',content:[]}});
 const r=reader(async(_scope,q)=>!q.from?page([item(0),placeholder(1),placeholder(2)]):page(complete?[full(1),full(2)]:[full(1)]));
 await r.reconcileTail();
 const range={firstEntryId:'e1',lastEntryId:'e2'};
 assert.equal(await r.expandProcess(range),null);
 assert.match(r.getState().error.message,/Process content was not fully loaded/);
 assert.equal(r.getState().transcript.items.get('e2').contentState,'placeholder');
 complete=true;
 await r.expandProcess(range);
 assert.equal(r.getState().error,null);
 assert.equal(r.getState().transcript.items.get('e2').contentState,'full');
});
test('an oversized message is parsed once only after every transparent UTF-16 continuation',async()=>{
 const message={role:'user',content:'长正文🙂'.repeat(50000)};const json=JSON.stringify(message);let contentCalls=0;
 const r=reader(async(s,q)=>{if(q.mode==='window')return page([{...item(0),message:{role:'user',content:''},deferred:[{path:'',format:'json',totalChars:json.length,previewChars:0}]}]);contentCalls++;const end=Math.min(json.length,q.offset+32000);return {kind:'content',sessionId:'s',leafId:'leaf',revision:`r${contentCalls}`,entryId:'e0',surface:'message',path:'',format:'json',offset:q.offset,totalChars:json.length,text:json.slice(q.offset,end),nextOffset:end===json.length?null:end,previousOffset:null};});
 const observed=[];r.subscribe(()=>observed.push(r.getState().transcript.messages));await r.reconcileTail();
 assert.ok(contentCalls>1);assert.deepEqual(r.getState().transcript.messages,[message]);assert.ok(observed.every(rows=>!rows.length||rows[0].content===message.content));
});
test('corrupt continuation fails without publishing a placeholder or deleting existing content',async()=>{
 let loaded=false;const r=reader(async(s,q)=>{if(q.mode==='content')return {kind:'content',sessionId:'s',leafId:'leaf',revision:'r',entryId:'e1',surface:'message',path:'',format:'json',offset:0,totalChars:50,text:'{',nextOffset:0};if(!loaded){loaded=true;return page([item(0)]);}return page([{...item(1),deferred:[{path:''}]}]);});
 await r.reconcileTail();await r.reconcileTail();assert.deepEqual(r.getState().transcript.entryIds,['e0']);assert.match(r.getState().error.message,/continuation/);
});
test('newest cursor includes placeholder tool output',async()=>{
 const requests=[];let n=0;const summary={firstEntryId:'e1',lastEntryId:'e99',firstMessageIndex:1,lastMessageIndex:99,messageCount:99,toolCallCount:49,toolNames:[],turnAnchor:null};
 const r=reader(async(s,q)=>{requests.push(q);return ++n===1?page([item(0),placeholder(1),placeholder(99)]):page([]);});await r.reconcileTail();await r.reconcileTail();assert.equal(requests[1].after,'e99');
});
test('settle-style reconciliation retains optimistic and completed rows while its request is pending',async()=>{
 const wait=deferred();let first=true;const r=reader(async()=>{if(first){first=false;return page([item(0)]);}return wait.promise;});await r.reconcileTail();r.append({role:'user',content:'sent'},'e1');r.append({role:'assistant',content:[]},'e2');const pending=r.reconcileTail();assert.deepEqual(r.getState().transcript.entryIds,['e0','e1','e2']);wait.resolve(page([]));await pending;assert.deepEqual(r.getState().transcript.entryIds,['e0','e1','e2']);
});
test('cached first frame does not need metadata or pin the old physical leaf',async()=>{
 const r=reader(async()=>page([item(0)],{leafId:'old'}));await r.reconcileTail();r.dispose();const wait=deferred();const next=new TranscriptReader(scope,async()=>wait.promise);assert.deepEqual(next.getState().transcript.entryIds,['e0']);assert.equal(next.getState().requestedScope.leafId,undefined);const pending=next.reconcileTail();wait.resolve(page([item(1)],{leafId:'new',revision:'r2'}));await pending;assert.deepEqual(next.getState().transcript.entryIds,['e0','e1']);next.dispose();
});
test('remote jumps keep live output out until the interval reconnects to the tail',async()=>{
 const r=reader(async(s,q)=>q.after?page([item(2)]):page([item(1)],{after:'e1',coverage:{start:false,end:false}}));await r.reset('e1');r.append({role:'user',content:'new'},'live');assert.deepEqual(r.getState().transcript.entryIds,['e1']);await r.nextPage();r.append({role:'user',content:'new'},'live');assert.deepEqual(r.getState().transcript.entryIds,['e1','e2','live']);
});
test('a hidden navigation target expands its process automatically',async()=>{
 const summary={firstEntryId:'e1',lastEntryId:'e3',firstMessageIndex:1,lastMessageIndex:3,messageCount:3,toolCallCount:1,toolNames:[],turnAnchor:null};const r=reader(async(s,q)=>q.from?page([item(1),item(2),item(3)]):page([item(0),placeholder(1),placeholder(2),placeholder(3)]));await r.goToEntry('e2');assert.ok(r.getState().transcript.entryIds.includes('e2'));
});
test('a pending latest reset cannot erase messages delivered while its snapshot was in flight',async()=>{
 const wait=deferred();const r=reader(async()=>wait.promise);
 const pending=r.reset();r.append({role:'user',content:'sent during read'},'sent');r.append({role:'assistant',content:[{type:'text',text:'live answer'}]},'answer');
 const frames=[];r.subscribe(()=>frames.push([...r.getState().transcript.entryIds]));
 wait.resolve(page([item(0)]));await pending;
 assert.deepEqual(r.getState().transcript.entryIds,['e0','sent','answer']);assert.ok(frames.every(ids=>ids.includes('sent')&&ids.includes('answer')));
});
test('draft promotion keeps its optimistic first message through delayed first history and authoritative delivery',async()=>{
 cache.clearHistoryViewCache();const wait=deferred();const r=new TranscriptReader(null,async()=>wait.promise);
 r.append({role:'user',content:'first prompt'},'',{clientMessageId:'draft-first'});r.setScope(scope,true);
 const frames=[];r.subscribe(()=>frames.push(r.getState().transcript.messages.filter(message=>message.role==='user'&&message.content==='first prompt').length));
 const pending=r.reconcileTail();assert.equal(r.getState().transcript.messages[0].content,'first prompt');
 wait.resolve(page([{...item(1,'first prompt'),clientMessageId:'draft-first'}]));await pending;
 r.append({role:'user',content:'first prompt'},'e1',{orderKey:[1,1,1],clientMessageId:'draft-first'});
 assert.deepEqual(r.getState().transcript.entryIds,['e1']);assert.ok(frames.every(count=>count===1));
});
test('unseen persisted entries are counted once without adding bodies to a distant interval',async()=>{
 const r=reader(async()=>page([item(0)],{after:'e0'}));await r.reset('e0');r.recordUnseenEntry('new');r.recordUnseenEntry('new');r.recordUnseenEntry('e0');
 assert.equal(r.getState().unseenEntryIds.size,1);assert.deepEqual(r.getState().transcript.entryIds,['e0']);
 r.setScope({sessionId:'other',peer:null});assert.equal(r.getState().unseenEntryIds.size,0);
});
test('a deferred final answer reads its complete answer surface without hydrating folded thinking',async()=>{
 const answer={role:'assistant',content:[{type:'text',text:'full answer'.repeat(20000)}],stopReason:'stop'};const text=JSON.stringify(answer);const requests=[];
 const r=reader(async(s,q)=>{requests.push(q);if(q.mode==='window')return page([{...item(0),role:'assistant',message:{role:'assistant',content:[]},deferred:[{path:'',format:'json',surface:'answer'}]}]);return {kind:'content',sessionId:'s',leafId:'leaf',revision:'r',entryId:'e0',surface:'answer',path:'',format:'json',offset:0,totalChars:text.length,text,nextOffset:null};});
 await r.reconcileTail();assert.deepEqual(r.getState().transcript.messages,[answer]);assert.equal(requests[1].surface,'answer');assert.equal(requests.some(q=>q.surface==='message'),false);
});
test('promotion permission cannot carry an existing session transcript across peer or branch changes',async()=>{
 const r=reader(async()=>page([item(0)]));await r.reconcileTail();r.setScope({sessionId:'s',peer:'other'},true);assert.equal(r.getState().transcript.messages.length,0);
 r.append({role:'user',content:'remote'});r.setScope({sessionId:'s',peer:'other',leafId:null},true);assert.equal(r.getState().transcript.messages.length,0);
});
