import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {FilterAuthorityCursor} from '../lib/filter-authority.ts';
const source=fs.readFileSync(new URL('./SessionActivityPanel.tsx',import.meta.url),'utf8');
const start=source.indexOf('function normalizeActivityFilterScope<'),end=source.indexOf('\nfunction subscribeSharedFilters(',start);
const compiled=ts.transpileModule(source.slice(start,end),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const defaults={device:'all',archiveView:'active',project:[],status:'all',sort:'recent',days:'7',group:'none'};
function store(){const exports={};vm.runInNewContext(compiled,{exports,FilterAuthorityCursor,globalThis:{crypto:{randomUUID:()=>Math.random().toString()}},window:{localStorage:{getItem:()=>null,setItem:()=>{}},sessionStorage:{getItem:()=>null}},readState:()=>({...defaults}),ACTIVITY_TIME_RANGE_VALUES:new Set(['7','30'])});return exports;}
const plain=x=>JSON.parse(JSON.stringify(x));
test('child broadcasts exact user intent, preserving newer unrelated owner fields',()=>{
 const owner=store(),child=store();owner.updateSharedFilters({days:'7'});
 child.applyRemoteSharedFilters(owner.readSharedRevision(),owner.readSharedFilters(),owner.readSharedOwnerEpoch(),true);
 let intent;child.subscribeSharedFiltersBroadcast(patch=>intent=patch);
 owner.updateSharedFilters({days:'30'}); // Downstream snapshot deliberately delayed.
 child.updateSharedFilters({sort:'asked'});
 assert.deepEqual(plain(intent),{sort:'asked'});
 owner.updateSharedFilters(intent);
 assert.equal(owner.readSharedFilters().days,'30');assert.equal(owner.readSharedFilters().sort,'asked');
 child.applyRemoteSharedFilters(owner.readSharedRevision(),owner.readSharedFilters(),owner.readSharedOwnerEpoch());
 assert.deepEqual(plain(child.readSharedFilters()),plain(owner.readSharedFilters()));
});
test('normalization runs at owner on current fields, while consecutive intents stay partial',()=>{
 const owner=store(),child=store();child.applyRemoteSharedFilters(0,owner.readSharedFilters(),owner.readSharedOwnerEpoch(),true);
 const pending=[];child.subscribeSharedFiltersBroadcast(patch=>pending.push(patch));
 owner.updateSharedFilters({group:'device',days:'30'});
 child.updateSharedFilters({device:'remote'});child.updateSharedFilters({sort:'status'});
 for(const patch of pending)owner.updateSharedFilters(patch);
 assert.equal(owner.readSharedFilters().device,'remote');assert.equal(owner.readSharedFilters().group,'project');assert.equal(owner.readSharedFilters().days,'30');assert.equal(owner.readSharedFilters().sort,'status');
 assert.deepEqual(plain(pending),[{device:'remote'},{sort:'status'}]);
});
test('initial zero and owner reload synchronize epoch without broadcasting storage snapshots',()=>{
 const child=store();let broadcasts=0;child.subscribeSharedFiltersBroadcast(()=>broadcasts++);
 child.applyRemoteSharedFilters(0,{...defaults,days:'30'},'old',true);
 assert.equal(child.readSharedFilters().days,'30');assert.equal(child.readSharedOwnerEpoch(),'old');
 child.applyRemoteSharedFilters(0,{...defaults,sort:'asked'},'new',true);
 child.applyRemoteSharedFilters(1,{...defaults,days:'30'},'old',true);
 assert.equal(child.readSharedOwnerEpoch(),'new');assert.equal(child.readSharedFilters().sort,'asked');assert.equal(broadcasts,0);
 const reloaded=store();reloaded.applyRemoteSharedFilters(0,child.readSharedFilters(),child.readSharedOwnerEpoch(),true);
 assert.deepEqual(plain(reloaded.readSharedFilters()),plain(child.readSharedFilters()));
});

const shell=fs.readFileSync(new URL('./AppShell.tsx',import.meta.url),'utf8');
function callbackSource(name,end){const start=shell.indexOf(`    const ${name} =`,shell.indexOf('const filterLinkModeRef'));return ts.transpileModule(shell.slice(start,shell.indexOf(end,start))+`; globalThis.extracted = ${name};`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;}
function link(embedded,filters){
 const sent=[],peer={postMessage:data=>sent.push(data)},linkMode={current:'pending'},pending={current:{}};
 const context={...filters,embeddedReaderMode:embedded,embeddedReaderUrl:'http://fixture.invalid',embeddedIframeRef:{current:{contentWindow:peer}},window:{parent:peer,location:{search:''}},router:{replace:()=>{}},URLSearchParams,filterLinkModeRef:linkMode,pendingFilterIntentRef:pending,EMBEDDED_FILTERS_CHANGED_EVENT:'pi-web:filters-changed',EMBEDDED_REQUEST_FILTERS_EVENT:'pi-web:request-filters'};
 vm.createContext(context);
 vm.runInContext(callbackSource('syncArchiveViewToUrl','    if (!embeddedReaderMode) syncArchiveViewToUrl();'),context);const broadcast=context.extracted;
 vm.runInContext(callbackSource('handleFiltersMessage','    window.addEventListener("message", handleFiltersMessage);'),context);const receive=data=>context.extracted({source:peer,data});
 filters.subscribeSharedFiltersBroadcast(broadcast);return {sent,linkMode,pending,receive};
}
test('actual shell handlers flush pre-ready partial edits after protocol handshake',()=>{
 const owner=store(),child=store(),outer=link(false,owner),inner=link(true,child);
 child.updateSharedFilters({sort:'asked'});assert.equal(inner.sent.length,0);
 owner.updateSharedFilters({days:'30'});
 outer.receive({type:'pi-web:request-filters',filterProtocol:2});inner.receive(outer.sent.shift());
 assert.equal(inner.sent.length,1);assert.deepEqual(plain(inner.sent[0].intent),{sort:'asked'});
 outer.receive(inner.sent.shift());assert.equal(owner.readSharedFilters().days,'30');assert.equal(owner.readSharedFilters().sort,'asked');
 inner.receive(outer.sent.shift());assert.deepEqual(plain(child.readSharedFilters()),plain(owner.readSharedFilters()));
});
test('actual mixed-version handlers retain local filters and stop snapshots in both directions',()=>{
 const owner=store(),outer=link(false,owner);
 outer.receive({type:'pi-web:request-filters'});assert.equal(outer.linkMode.current,'local');
 owner.updateSharedFilters({days:'30'});assert.equal(outer.sent.length,0);
 outer.receive({type:'pi-web:filters-changed',filters:{...defaults,days:'7'},rev:12});assert.equal(owner.readSharedFilters().days,'30');
 const child=store(),inner=link(true,child);child.updateSharedFilters({sort:'asked'});
 inner.receive({type:'pi-web:filters-changed',filters:defaults,rev:12});assert.equal(inner.linkMode.current,'local');
 child.updateSharedFilters({days:'30'});assert.equal(child.readSharedFilters().sort,'asked');assert.equal(child.readSharedFilters().days,'30');assert.equal(inner.sent.length,0);
});

test('filter sync fallback stays silent in the shell',()=>{
 assert.doesNotMatch(shell,/filterSyncLocalOnly|setFilterSyncLocalOnly|activity\.filtersLocalOnly/);
 assert.match(shell,/filterLinkModeRef\.current = "local"/);
});
