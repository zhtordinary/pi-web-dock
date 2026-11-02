import assert from 'node:assert/strict';
import test from 'node:test';
import { createJiti } from 'jiti';
const jiti = createJiti(import.meta.url);
const { createHistoryProjection, getHistoryWindow, readHistoryContent, parseHistoryRequest } = await jiti.import('./session-history.ts');
const { createHistoryGet, createHistoryImageGet } = await jiti.import('./session-history-http.ts');
const { readHistoryEditMessage } = await jiti.import('./history-edit-message.ts');
const timestamp = '2026-10-19T00:00:00Z';
function fixture() {
  const original = { role: 'user', content: [{type:'text',text:'expanded first'}, {type:'image',data:'aW1hZ2U=',mimeType:'image/png'}, {type:'text',text:'expanded second'}] };
  const input = ' /template **original** ' + 'argument '.repeat(6000) + '\n ';
  const projection = createHistoryProjection([
    {type:'message',id:'u',parentId:null,timestamp,message:original},
    {type:'custom',id:'display',parentId:'u',timestamp,customType:'pi-web:display-input',data:{targetEntryId:'u',input}},
  ], {sessionId:'s'});
  return { original, input, projection };
}
test('template display preserves media indices while source remains original and input remains complete', async () => {
  const { original, input, projection } = fixture();
  const item = getHistoryWindow(projection).items[0];
  assert.equal(item.message.content[1].type, 'image');
  assert.deepEqual(item.deferred, []);
  assert.equal(item.message.content[0].text, input, "ordinary long template input is displayed completely without field segments");
  const source = readHistoryContent(projection,{entryId:'u',surface:'source',path:''});
  assert.deepEqual(JSON.parse(source.text),original);
  const get = createHistoryGet(async () => projection);
  const restored = await readHistoryEditMessage({...projection,entryId:'u'},async options => {
    const url=new URL('http://reader/api/sessions/s/history');
    url.searchParams.set('mode','content');
    for(const [key,value] of Object.entries(options)) if(value!==undefined) url.searchParams.set(key,String(value));
    const response=await get(new Request(url),{params:Promise.resolve({id:'s'})});
    assert.equal(response.status,200);
    return response.json();
  },()=>true);
  assert.equal(restored.content[0].text,input);
  assert.deepEqual(restored.content[1],original.content[1]);
  const imageGet=createHistoryImageGet(async()=>projection);
  const image=await imageGet(new Request('http://reader/api/sessions/s/history/images/u?blockIndex=1'),{params:Promise.resolve({id:'s',entryId:'u'})});
  assert.equal(image.status,200);
  assert.equal(await image.text(),'image');
});
test('input surface rejects pointers, block indices, non-user messages, and image endpoint use', async()=>{
  const {projection}=fixture();
  for(const query of ['mode=content&entryId=u&surface=input&path=/content','mode=content&entryId=u&surface=input&blockIndex=0']) assert.throws(()=>parseHistoryRequest(new URLSearchParams(query)));
  const get=createHistoryImageGet(async()=>projection);
  assert.equal((await get(new Request('http://reader/image?surface=input'),{params:Promise.resolve({id:'s',entryId:'u'})})).status,400);
});
