import test from 'node:test';
import assert from 'node:assert/strict';
import {createJiti} from 'jiti';
const {isSessionControlDisplayMessage,splitProcessRenderSegments}=await createJiti(import.meta.url).import('./process-render-segments.ts');
const assistant={role:'assistant',content:[{type:'thinking',thinking:'work'}]};
const tool={role:'toolResult',toolCallId:'read-1',toolName:'read',content:[{type:'text',text:'result'}]};

test('a final process row keeps its position before trailing tool results',()=>{
 const messages=[tool,assistant,tool];
 const segments=splitProcessRenderSegments(messages,[0,2],1,assistant);
 assert.deepEqual(segments[0].items.map(item=>item.index),[0,1,2]);
});

test('an answer separates process rows in their original order',()=>{
 const answer={role:'assistant',content:[{type:'text',text:'done'}]};
 const segments=splitProcessRenderSegments([tool,answer,tool],[0,2],1,null,answer);
 assert.deepEqual(segments,[{kind:'details',items:[{kind:'message',index:0}]},{kind:'answer',index:1,message:answer},{kind:'details',items:[{kind:'message',index:2}]}]);
});

test('collapsed process rows keep their order and count when their bodies are filled',()=>{
 const full=[assistant,tool,assistant,assistant];
 const collapsed=full.map(message=>({...message,content:[]}));
 const project=messages=>splitProcessRenderSegments(messages,[0,1,2],3,messages[3]);
 const before=project(collapsed),after=project(full);
 assert.deepEqual(before[0].items.map(item=>item.index),[0,1,2,3]);
 assert.deepEqual(after[0].items.map(item=>item.index),[0,1,2,3]);
 assert.equal(before[0].items.length,4);
 assert.equal(after[0].items.length,4);
 assert.deepEqual(after[0].items.map(item=>item.kind),['message','message','message','final']);
});

test('session-control display messages are recognized without treating arbitrary custom messages as controls',()=>{
 const initial={role:'custom',customType:'pi-web:session-control-initial-message',content:'setup',display:true};
 const peer={role:'custom',customType:'pi-web:session-peer',content:'peer',display:true,details:{source:'session-control',messageId:'m'}};
 assert.equal(isSessionControlDisplayMessage(initial),true);
 assert.equal(isSessionControlDisplayMessage(peer),true);
 assert.equal(isSessionControlDisplayMessage({role:'custom',customType:'extension',content:'other'}),false);
});

test('session control cards separate contiguous process rows without contributing a process row',()=>{
 const control={role:'custom',customType:'pi-web:session-control-initial-message',content:'setup'};
 const segments=splitProcessRenderSegments([assistant,control,tool],[0,1,2],-1);
 assert.deepEqual(segments,[{kind:'details',items:[{kind:'message',index:0}]},{kind:'session-control',index:1},{kind:'details',items:[{kind:'message',index:2}]}]);
 assert.equal(segments.filter(segment=>segment.kind==='details').flatMap(segment=>segment.items).length,2);
});
