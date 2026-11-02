import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {TranscriptReader}=await jiti.import('./transcript-reader.ts');
const {TranscriptViewport}=await jiti.import('./transcript-viewport.ts');
const {createHistoryProjection,getHistoryWindow}=await jiti.import('./session-history.ts');
const {clearHistoryViewCache}=await jiti.import('./session-view-cache.ts');
const timestamp='2026-10-23T00:00:00.000Z';
const entry=(id,parentId,role='user')=>({type:'message',id,parentId,timestamp,message:role==='user'?{role,content:id}:{role,content:[{type:'text',text:id}],stopReason:'stop'}});
function fixture(turns=3){clearHistoryViewCache();const entries=[];for(let n=0;n<turns;n++){entries.push(entry(`q${n}`,entries.at(-1)?.id??null));entries.push(entry(`a${n}`,`q${n}`,'assistant'));}const requests=[];const r=new TranscriptReader({sessionId:'compaction',peer:null},async(scope,request)=>{requests.push(request);return getHistoryWindow(createHistoryProjection(entries,{sessionId:'compaction'}),request);});return {r,entries,requests,compact(firstKeptEntryId){entries.push({type:'compaction',id:'new-card',parentId:entries.at(-1).id,timestamp,firstKeptEntryId,summary:'new summary',tokensBefore:100});}};}
function viewportFor(r){let rows=[],scrollTop=0;const container={clientHeight:200,scrollHeight:0,get scrollTop(){return scrollTop;},getBoundingClientRect:()=>({top:0}),querySelectorAll:()=>rows,scrollTo({top}){scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));}};r.subscribe(()=>{rows=r.getState().transcript.entryIds.map((id,i)=>({dataset:{entryId:id},isConnected:true,getBoundingClientRect:()=>({top:i*100-scrollTop,bottom:(i+1)*100-scrollTop})}));container.scrollHeight=rows.length*100;});const viewport=new TranscriptViewport(()=>container,()=>{});r.setCommit(publish=>viewport.commit(publish));return {viewport,container,row:id=>rows.find(row=>row.dataset.entryId===id)};}
for(const follow of [false,true])test(`compaction inserted inside the loaded interval preserves rows and viewport: follow=${follow}`,async()=>{
 const h=fixture();const v=viewportFor(h.r);await h.r.reconcileTail();if(follow)v.viewport.scrollToBottom();else v.viewport.scrollToEntry(v.row('q1'),0);
 const anchor=follow?'q2':'q1',offset=v.row(anchor).getBoundingClientRect().top;
 h.compact('q1');await h.r.reconcileTail({reconcileLoaded:true});
 assert.deepEqual(h.r.getState().transcript.entryIds,['q0','a0','new-card','q1','a1','q2','a2']);
 assert.equal(v.row(anchor).getBoundingClientRect().top,offset);assert.equal(h.r.getState().transcript.items.get('q1').messageIndex,3);
 if(follow)assert.equal(v.container.scrollTop,v.container.scrollHeight-v.container.clientHeight);
 await h.r.reconcileTail({reconcileLoaded:true});assert.equal(h.r.getState().transcript.entryIds.filter(id=>id==='new-card').length,1);
});
test('compaction outside the loaded interval does not read or reveal unread history',async()=>{
 const h=fixture(20);await h.r.reconcileTail();const first=h.r.getState().transcript.entryIds[0];assert.equal(first,'q10');h.requests.length=0;
 h.compact('q2');await h.r.reconcileTail({reconcileLoaded:true});
 assert.equal(h.r.getState().transcript.entryIds[0],first);assert.equal(h.r.getState().transcript.entryIds.includes('new-card'),false);
 assert.ok(h.requests.every(q=>!q.before));assert.ok(h.requests.every(q=>q.around===undefined||q.around===first));
 assert.equal(h.r.getState().transcript.items.get(first).messageIndex,21);
});
test('focus-style after reconciliation detects a file-only compaction insert without local SSE and does not reread it again',async()=>{
 const h=fixture();await h.r.reconcileTail();h.requests.length=0;h.compact('q1');
 await h.r.reconcileTail();assert.equal(h.r.getState().transcript.entryIds.filter(id=>id==='new-card').length,1);assert.ok(h.requests.some(q=>q.around==='q0'));
 h.requests.length=0;await h.r.reconcileTail();assert.equal(h.requests.length,1);assert.equal(h.requests[0].around,undefined);
});
test('file-only compaction before the loaded interval never reads its unread prefix',async()=>{
 const h=fixture(20);await h.r.reconcileTail();h.requests.length=0;h.compact('q2');await h.r.reconcileTail();
 assert.equal(h.r.getState().transcript.entryIds[0],'q10');assert.ok(!h.r.getState().transcript.entryIds.includes('new-card'));assert.ok(h.requests.every(q=>!q.before&&(!q.around||q.around==='q10')));
});
