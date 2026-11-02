import test from 'node:test';
import assert from 'node:assert/strict';
import { createJiti } from 'jiti';
const { emptyTranscript, mergeTranscriptPage, appendPersisted, newestPersistedEntryId } = await createJiti(import.meta.url).import('./transcript-store.ts');
const message = text => ({ role: 'user', content: text });
const item = (i) => ({ entryId: `e${i}`, orderKey: [i,1,i], role: 'user', messageIndex: i, message: message(`question ${i}`), contentState: 'full', process: false, toolCallCount: 0, deferred: [], sourceType: 'message', turnAnchor: null });
const page = (start, end, extra = {}) => ({ kind:'window',sessionId:'s',leafId:`e${end}`,revision:`r${end}`,items:Array.from({length:end-start+1},(_,i)=>item(start+i)),processSummaries:[], before:start ? `e${start}`:null,after:null,coverage:{start:start===0,end:true},totalMessages:end+1,firstUserEntryId:'e0',lastUserEntryId:`e${end}`,nodeCount:end+1,nodeOffset:0,...extra });
test('empty and duplicate HTTP merges retain the original transcript object', () => {
 const original=mergeTranscriptPage(emptyTranscript(),page(0,2),'reset');
 const duplicate=JSON.parse(JSON.stringify(page(0,2)));
 assert.equal(mergeTranscriptPage(original,duplicate,'append'),original);
 const empty=page(0,2,{items:[],before:'e2',nodeOffset:2});
 assert.equal(mergeTranscriptPage(original,empty,'append'),original);
 assert.equal(mergeTranscriptPage(original,empty,'reconcile'),original);
});

test('prepend keeps every loaded row across more than three pages and changing revisions', () => {
  let state = mergeTranscriptPage(emptyTranscript(),page(100,109),'reset');
  for(let n=90;n>=0;n-=10) state=mergeTranscriptPage(state,page(n,n+9),'prepend');
  assert.equal(state.messages.length,110);
  assert.deepEqual(state.entryIds,Array.from({length:110},(_,i)=>`e${i}`));
});
test('optimistic delivery is replaced in place and later persistence is idempotent', () => {
  let state=mergeTranscriptPage(emptyTranscript(),page(0,2),'reset');
  state=appendPersisted(state,message('new'),'',{clientMessageId:'sent'});
  state=mergeTranscriptPage(state,page(3,3,{items:[{...item(3),clientMessageId:'sent',message:message('new')}]}),'append');
  state=appendPersisted(state,message('new'),'e3',{orderKey:[3,1,3],clientMessageId:'sent'});
  assert.deepEqual(state.entryIds,['e0','e1','e2','e3']);
  assert.equal(state.messages.at(-1).content,'new');
});
test('a detached interval cannot receive live messages', () => {
  const state=mergeTranscriptPage(emptyTranscript(),page(10,19,{after:'e19',coverage:{start:false,end:false}}),'reset');
  assert.equal(appendPersisted(state,message('live'),'e99'),state);
});
test('placeholder process rows advance HTTP coverage without losing their question', () => {
  let state=mergeTranscriptPage(emptyTranscript(),page(0,0),'reset');
  state=mergeTranscriptPage(state,page(1,100,{items:Array.from({length:100},(_,n)=>({...item(n+1),role:'toolResult',message:null,contentState:'placeholder',process:true}))}),'append');
  assert.equal(newestPersistedEntryId(state),'e100');
  assert.deepEqual(state.entryIds,Array.from({length:101},(_,n)=>`e${n}`));
  assert.equal(state.items.size,101);
});
test('expanding a process replaces a shared final-answer entry without duplicating it', () => {
  let state=mergeTranscriptPage(emptyTranscript(),page(0,2,{processSummaries:[{firstEntryId:'e1',lastEntryId:'e2',firstMessageIndex:1,lastMessageIndex:2,messageCount:2,toolCallCount:1,toolNames:['bash'],turnAnchor:null}]}),'reset');
  state=mergeTranscriptPage(state,page(1,2),'expand');
  assert.deepEqual(state.entryIds,['e0','e1','e2']);
  assert.equal(state.items.size,3);
});
test('a collapsed reread cannot discard an expanded answer inside a longer process range',()=>{
 const full={...item(1),message:{role:'assistant',content:[{type:'thinking',thinking:'retained process'},{type:'text',text:'answer'}]}};
 const result={...item(2),message:{role:'toolResult',toolCallId:'call',content:[{type:'text',text:'result'}]}};
 let state=mergeTranscriptPage(emptyTranscript(),page(0,2,{items:[item(0),full,result]}),'reset');
 state=mergeTranscriptPage(state,page(0,2,{items:[item(0),{...full,contentState:'answer',message:{...full.message,content:[{type:'text',text:'answer'}]}}],processSummaries:[{firstEntryId:'e1',lastEntryId:'e2',firstMessageIndex:1,lastMessageIndex:2,messageCount:2,toolCallCount:1,toolNames:['read'],turnAnchor:null}]}),'append');
 assert.deepEqual(state.items.get('e1').message,full.message);
 assert.deepEqual(state.messages[state.entryIds.indexOf('e1')],full.message);
});
test('live content is complete rather than a bounded overlay, including encoded images',()=>{
 const image={type:'image',source:{type:'base64',media_type:'image/png',data:'ABCD'.repeat(100000)}};
 let state=emptyTranscript();for(let i=0;i<100;i++)state=appendPersisted(state,message(`row ${i}`),`e${i}`);
 state=appendPersisted(state,{role:'user',content:[{type:'text',text:'正文'.repeat(100000)},image]},'large');
 assert.equal(state.messages.length,101);assert.equal(state.messages.at(-1).content[0].text.length,200000);assert.deepEqual(state.messages.at(-1).content[1],image);
});
test('distinct persisted IDs with identical timestamps and roles never overwrite each other',()=>{
 let state=emptyTranscript();
 state=appendPersisted(state,{role:'assistant',timestamp:1,content:[{type:'text',text:'first'}]},'first');
 state=appendPersisted(state,{role:'assistant',timestamp:1,content:[{type:'text',text:'second'}]},'second');
 assert.deepEqual(state.entryIds,['first','second']);
 assert.deepEqual(state.messages.map(message=>message.content[0].text),['first','second']);
});
