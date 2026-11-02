import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import ts from 'typescript';
const source=readFileSync(new URL('./ChatWindow.tsx',import.meta.url),'utf8');const tree=ts.createSourceFile('view.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX);let callback;
function visit(node){if(ts.isCallExpression(node)&&node.expression.getText(tree)==='useEffect'&&node.arguments[0]?.getText(tree).includes('new IntersectionObserver'))callback=node.arguments[0];ts.forEachChild(node,visit);}visit(tree);assert.ok(callback);
test('only geometrically intersecting sentinels request adjacent history, with no wheel/key/touch interception',()=>{
 const top={},bottom={},observed=[],calls=[];let intersect,disconnected=false;
 const ctx={scrollContainerRef:{current:{}},transcript:{loaded:true},topSentinelRef:{current:top},bottomSentinelRef:{current:bottom},hasEarlierMessages:true,atLiveTail:false,historyLoading:false,CHAT_HISTORY_PRELOAD_DISTANCE:320,reader:{previousPage:()=>calls.push('before'),nextPage:()=>calls.push('after')},IntersectionObserver:class{constructor(fn){intersect=fn;}observe(target){observed.push(target);}disconnect(){disconnected=true;}}};
 const effect=vm.runInNewContext(ts.transpileModule(`(${callback.getText(tree)})`,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText,ctx);const cleanup=effect();assert.deepEqual(observed,[top,bottom]);intersect([{target:top,isIntersecting:false}]);assert.deepEqual(calls,[]);intersect([{target:top,isIntersecting:true},{target:bottom,isIntersecting:true}]);assert.deepEqual(calls,['before','after']);cleanup();assert.equal(disconnected,true);
});
