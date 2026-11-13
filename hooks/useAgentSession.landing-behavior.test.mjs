import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('./useAgentSession.ts',import.meta.url),'utf8');
const tree=ts.createSourceFile('hook.ts',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TS);
let callback;
function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useLayoutEffect'&&node.arguments[0]?.getText(tree).includes('pendingScrollToUserRef.current = false'))callback=node.arguments[0];ts.forEachChild(node,visit);}visit(tree);assert.ok(callback);
function harness(preference){const writes=[];const ctx={messages:[{role:'user',content:'latest'}],streamingStore:{getState:()=>({streamingMessage:null})},pendingScrollToUserRef:{current:false},viewport:{initialized:false,resizeCount:0,resize(){this.resizeCount++;}},sessionOpenScrollRef:{current:preference},scrollUserMsgToTop(options){ctx.viewport.initialized=true;writes.push(['question',options?.follow??true]);return true;},scrollToBottom(){ctx.viewport.initialized=true;writes.push(['bottom']);}};const commit=vm.runInNewContext(ts.transpileModule(`(${callback.getText(tree)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);return {ctx,writes,commit};}
for(const preference of ['last-question','answer-bottom'])test(`cold and cached first commits synchronously land at latest: ${preference}`,()=>{const h=harness(preference);h.commit();assert.deepEqual(h.writes,[preference==='last-question'?['question',false]:['bottom']]);h.commit();assert.equal(h.writes.length,1);assert.equal(h.ctx.viewport.resizeCount,1);});
test('an empty first commit does not consume the opening preference',()=>{const h=harness('last-question');h.ctx.messages=[];h.commit();assert.equal(h.ctx.viewport.initialized,false);h.ctx.messages=[{}];h.commit();assert.deepEqual(h.writes,[['question',false]]);});
test('sending pins the newest question and remains attached without hiding the row',()=>{const h=harness('answer-bottom');h.ctx.pendingScrollToUserRef.current=true;h.commit();assert.equal(h.ctx.pendingScrollToUserRef.current,false);assert.deepEqual(h.writes,[['question',true]]);});
