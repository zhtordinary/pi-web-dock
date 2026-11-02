import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
import {createJiti} from 'jiti';
const {TranscriptReader}=await createJiti(import.meta.url).import('../lib/transcript-reader.ts');
const source=readFileSync(new URL('./ChatMinimap.tsx',import.meta.url),'utf8');const tree=ts.createSourceFile('mini.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function actual(name,ctx){let callback;function visit(node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===name)callback=node.initializer.arguments[0];ts.forEachChild(node,visit);}visit(tree);assert.ok(callback);return vm.runInNewContext(ts.transpileModule(`(${callback.getText(tree)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);}
const body={kind:'window',sessionId:'s',leafId:'leaf',revision:'r',items:[{entryId:'target',messageIndex:500,message:{role:'user',content:'target'},deferred:[]}],processSummaries:[],before:'target',after:'target',coverage:{start:false,end:false}};
for(const changed of [false,true])test(`unknown ordinal resolves its exact entry and rejects stale scope: ${changed}`,async()=>{
 const calls=[];let resolve;const reader=new TranscriptReader({sessionId:'s',peer:null},async(scope,request)=>{calls.push(request);return request.mode==='index'?new Promise(r=>resolve=r):body;});
 const pending=[];const ctx={scopeKey:'s',MINIMAP_ANCHOR_OFFSET:12,scrollContainer:{current:{}},pendingNavigationRef:{current:null},onReadHistory(){},lockActiveNode(){},onNavigateEntry:reader.goToEntry,onLoadNodePage:index=>pending.push(reader.goToNodeIndex(index)),onScrollToEntry(){}};
 actual('scrollToNode',ctx)({index:0,nodeIndex:500,entryId:'',kind:'turn',targetTurn:{scrollTop:null}},'auto');
 if(changed)reader.setScope({sessionId:'other',peer:'remote'});
 resolve({kind:'index',sessionId:'s',leafId:'leaf',revision:'r',nodes:[{entryId:'target',nodeIndex:500}],offset:500,total:1000});await Promise.all(pending);
 assert.deepEqual(calls.map(q=>q.mode),changed?['index']:['index','window']);if(!changed)assert.equal(calls[1].around,'target');reader.dispose();
});
test('mounted question, answer and heading use the same viewport owner without fetching bodies',()=>{
 const calls=[];const element={isConnected:true,getBoundingClientRect:()=>({top:200}),querySelectorAll:()=>({item:()=>element})};
 const ctx={scopeKey:'s',MINIMAP_ANCHOR_OFFSET:12,pendingNavigationRef:{current:null},activeNodeLockRef:{current:null},onReadHistory:()=>calls.push('detach'),lockActiveNode(){},onNavigateEntry:()=>calls.push('fetch'),onLoadNodePage:()=>calls.push('fetch'),onScrollToEntry:(target,offset)=>calls.push([target,offset]),onScrollToBottom:()=>calls.push('latest'),elementForEntry:()=>element,scrollContainer:{current:{scrollTop:0,getBoundingClientRect:()=>({top:100})}}};
 const node={index:0,nodeIndex:0,entryId:'loaded',kind:'turn',targetTurn:{scrollTop:200,assistantPreviews:[{element}]}};
 for(const name of ['scrollToNode','scrollToAssistant','scrollToHeading']){calls.length=0;actual(name,ctx)(node,0,0);assert.deepEqual(calls,['detach',[element,12]]);}
 calls.length=0;actual('scrollToBottom',ctx)();assert.deepEqual(calls,['latest']);
});
