import assert from 'node:assert/strict';
import test from 'node:test';
import {readCatalogMetadata} from './catalog-metadata.ts';
const readers={hidden:()=>({sessions:['private'],projects:[],devices:[],visibleSessions:[]}),favorites:()=>({sessions:['s']}),categories:()=>({to_discuss:[],to_revise:[],completed:[]}),viewed:()=>({s:1})};
test('decorative read failures degrade visibly without discarding visibility policy',()=>{
 const state=readCatalogMetadata('d',{...readers,favorites:()=>{throw new Error('bad json')},viewed:()=>{throw new Error('unreadable')}});
 assert.deepEqual(state.hidden.sessions,['private']);assert.deepEqual(state.favorites,{sessions:[]});assert.deepEqual(state.viewed,{});
 assert.deepEqual(state.warnings.map(w=>w.domain),['favorites','viewed']);
});
test('unknown visibility is unavailable rather than an empty allow-all policy',()=>{
 const state=readCatalogMetadata('d',{...readers,hidden:()=>{throw new Error('bad json')}});
 assert.equal(state.hidden,null);assert.deepEqual(state.warnings,[{deviceId:'d',domain:'hidden',code:'metadata_unavailable'}]);
 assert.deepEqual(readCatalogMetadata('d',readers).warnings,[]);
});
