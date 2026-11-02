import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {fetchSessionHistory}=await createJiti(import.meta.url).import('./session-history-controller.ts');
test('transport serializes turns, inclusive range and explicit root without inventing a revision',async t=>{
 const urls=[];t.mock.method(globalThis,'fetch',async url=>{urls.push(String(url));return {ok:true,json:async()=>({kind:'window',items:[]})};});
 const signal=new AbortController().signal;
 await fetchSessionHistory({sessionId:'s',peer:null},{mode:'window',turns:10,before:'old'},signal);
 await fetchSessionHistory({sessionId:'s',peer:null,leafId:null},{mode:'window',from:'a',to:'z',after:'m'},signal);
 const a=new URL(urls[0],'http://test'),b=new URL(urls[1],'http://test');assert.equal(a.searchParams.get('turns'),'10');assert.equal(a.searchParams.has('revision'),false);assert.equal(a.searchParams.has('leafId'),false);assert.equal(b.searchParams.get('from'),'a');assert.equal(b.searchParams.get('to'),'z');assert.equal(b.searchParams.get('leafId'),'');
});
test('history requests bound stalled transport and preserve caller cancellation',async t=>{
 const deadline=new AbortController(),caller=new AbortController();
 const timeouts=[];t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return deadline.signal;});
 let signal;
 t.mock.method(globalThis,'fetch',async(_url,options)=>{signal=options.signal;return {ok:true,json:async()=>({kind:'window',items:[]})};});
 await fetchSessionHistory({sessionId:'s',peer:null},{mode:'window'},caller.signal);
 assert.deepEqual(timeouts,[15000]);assert.notEqual(signal,caller.signal);
 deadline.abort(new DOMException('Timed out','TimeoutError'));
 assert.equal(signal.aborted,true);assert.equal(signal.reason.name,'TimeoutError');assert.equal(caller.signal.aborted,false);
 const fresh=new AbortController();t.mock.method(AbortSignal,'timeout',()=>fresh.signal);
 await fetchSessionHistory({sessionId:'s',peer:null},{mode:'index'},caller.signal);
 caller.abort();assert.equal(signal.aborted,true);assert.equal(fresh.signal.aborted,false);
});
test('remote inline media URLs are rebound only for own history endpoints',async t=>{
 const image=url=>({type:'image',source:{type:'url',url}});
 t.mock.method(globalThis,'fetch',async()=>({ok:true,json:async()=>({kind:'window',items:[{entryId:'u',orderKey:[0,1,0],role:'user',contentState:'full',message:{role:'user',content:[image('/api/sessions/s/history?mode=image'),image('https://external/image')]}},{entryId:'p',orderKey:[1,1,1],role:'assistant',contentState:'placeholder',message:null}]})}));
 const page=await fetchSessionHistory({sessionId:'s',peer:'peer'},{mode:'window'},new AbortController().signal);
 assert.match(page.items[0].message.content[0].source.url,/\/api\/remote\/sessions/);assert.equal(page.items[0].message.content[1].source.url,'https://external/image');
});
