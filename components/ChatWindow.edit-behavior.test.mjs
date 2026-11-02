import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import {createJiti} from 'jiti';
const jiti=createJiti(import.meta.url);
const {readHistoryEditMessage}=await jiti.import('../lib/history-edit-message.ts');
const {createHistoryProjection,readHistoryContent}=await jiti.import('../lib/session-history.ts');
const source=readFileSync(new URL('./ChatWindow.tsx',import.meta.url),'utf8');
const tree=ts.createSourceFile('ChatWindow.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);
function callback(name,context){
  function find(node){if(ts.isVariableDeclaration(node)&&node.name.getText(tree)===name)return node.initializer.arguments[0];return ts.forEachChild(node,find);}
  const node=find(tree);assert.ok(node);
  return vm.runInNewContext(ts.transpileModule(`(${node.getText(tree)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,context);
}
function harness({accept=true,readError=false}={}){
  const original={role:'user',content:[{type:'text',text:'expanded text'},{type:'image',data:'aW1hZ2U=',mimeType:'image/png'}]};
  const input=' /original **command** '+ 'argument '.repeat(6000);
  const projection=createHistoryProjection([{type:'message',id:'u',parentId:null,timestamp:'2026-10-19T00:00:00Z',message:original},{type:'custom',id:'meta',parentId:'u',timestamp:'2026-10-19T00:00:00Z',customType:'pi-web:display-input',data:{targetEntryId:'u',input}}],{sessionId:'s'});
  const scope={sessionId:'s',peer:null,leafId:'meta'};
  const state={physicalScope:projection,requestedScope:scope,window:{current:{}}};
  const calls=[];let restored;
  const context={readHistoryEditMessage,AbortController,historyEditBusyRef:{current:false},historyEditAbortRef:{current:null},historyNavigationRef:{current:0},
    historyControllerRef:{current:{getState:()=>state}},
    fetchSessionHistory:async(_scope,options)=>{calls.push(['read',options.surface,options.offset]);if(readError)throw Error('disk read failed');return readHistoryContent(projection,options);},
    chatInputRef:{current:{replaceMessage:message=>{calls.push(['composer']);if(accept)restored=message;return accept;}}},
    addNotice:notice=>calls.push(['notice',notice.message]),
    handleCreateSideBranch:(...args)=>calls.push(['branch',...args]),
    handleSessionEditContent:(message,id,root)=>{const ok=context.chatInputRef.current.replaceMessage(message);if(ok)calls.push(['edit',id,root]);return ok;},
    setActiveSideTabId:id=>calls.push(['tab',id]),
  };
  return {context,calls,original,input,state,get restored(){return restored},edit:callback('handleEditContent',context)};
}
test('subsequent image edit reads complete source/input before composer acceptance and branch effects',async()=>{
  const h=harness();await h.edit({role:'user',content:'bounded preview'},'u',false,{sideBranchAnchor:'assistant-before'});
  assert.equal(h.restored.content[0].text,h.input);assert.deepEqual(h.restored.content[1],h.original.content[1]);
  assert.ok(h.calls.filter(c=>c[0]==='read'&&c[1]==='input').length>1);
  const composer=h.calls.findIndex(c=>c[0]==='composer'),branch=h.calls.findIndex(c=>c[0]==='branch');assert.ok(composer>0&&branch>composer);
  assert.equal(h.calls[branch][1],'assistant-before');assert.equal(h.calls[branch][3],'u');assert.equal(h.context.historyNavigationRef.current,0);
});
test('failed read, rejected composer and stale runtime cannot mutate branch or overwrite draft',async()=>{
  for(const options of [{readError:true},{accept:false}]){const h=harness(options);await h.edit({role:'user',content:'preview'},'u',false,{sideBranchAnchor:'a'});assert.equal(h.restored,undefined);assert.equal(h.calls.some(c=>['branch','tab','edit'].includes(c[0])),false);}
  const h=harness();const read=h.context.fetchSessionHistory;h.context.fetchSessionHistory=async(...args)=>{const page=await read(...args);h.context.historyEditBusyRef.current=true;return page;};await h.edit({role:'user',content:'preview'},'u',false,{sideBranchAnchor:'a'});assert.equal(h.restored,undefined);assert.equal(h.calls.some(c=>c[0]==='branch'),false);
});
test('rewrite and command transforms apply to full authoritative input with original images',async()=>{
  for(const intent of [{text:'rewritten question'},{transformInput:input=>input.replace('/original','/skill')}]){const h=harness();await h.edit({role:'user',content:'preview'},'u',false,intent);assert.equal(h.restored.content[0].text,intent.text??h.input.replace('/original','/skill'));assert.deepEqual(h.restored.content[1],h.original.content[1]);}
});

test('keeps sending and in-page fork controls blocked while a fork is pending or running', () => {
  assert.match(source, /const \[sideBranchPending, setSideBranchPending\] = useState\(false\)/);
  assert.match(source, /statePending=\{sessionStatePending \|\| sideBranchPending\}/);
  assert.match(source, /if \(!await handleLeafChange\(targetAnchor, beforeEntryId\)\)/);
  assert.match(source, /if \(await handleCreateSideBranch\(intent\.sideBranchAnchor[\s\S]*=== false\) return;/);
  assert.match(source, /onStartSideBranch=\{sessionBusy \|\| sideBranchPending \? undefined : handleCreateSideBranch\}/);
});
