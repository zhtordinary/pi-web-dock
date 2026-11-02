import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { stripTypeScriptTypes } from 'node:module';
const source = fs.readFileSync(new URL('./useAgentSession.ts', import.meta.url), 'utf8');
const ref = current => ({ current });
function context() {
 return { useCallback: fn => fn, sessionHookMountedRef: ref(true), sessionIdRef: ref('session'),
  queuedDraftProjectionRef: ref({ generation: 0 }), promptRunIdRef: ref(1), stateRunRevisionRef: ref(1), currentAgentRunIdRef: ref('run-A'),
  branchScopeRef: ref('scope'), remotePeerRef: ref(null), agentRunningRef: ref(true), bashRunningRef: ref(false), activeToolIdsRef: ref(new Set()), toolEventRevisionRef: ref(0),
  isCompacting: false, streamState: { isStreaming: false }, localCompactionPendingRef: ref(false), setIsCompacting: () => {},
  rpcPromptPendingRef: ref(true), sdkAgentActiveRef: ref(true), optimisticUserMessageKeyRef: ref('draft'), optimisticUserMessageRef: ref({ text: 'draft' }),
  AbortController, window: { setTimeout, clearTimeout }, apiPath: x => x, loadSession: async () => {}, refreshSessionCost: async () => {}, syncQueuedDrafts: () => {}, syncQueuedDraftResponse: () => {},
  notifyPromptStage: () => {}, scheduleEventStreamClose: () => {}, settleUiStage: () => { throw Error('stale UI settled'); } };
}
function callback(name, endMarker, ctx) {
 const start = source.indexOf(`  const ${name} =`), end = source.indexOf(endMarker, start);
 assert.ok(start >= 0 && end > start);
 vm.runInNewContext(stripTypeScriptTypes(source.slice(start, end) + `\nglobalThis.callback = ${name};`), ctx);
 return ctx.callback;
}
test('slow idle reconciliation cannot settle an externally started newer run', async () => {
 const ctx = context(); let resolve; ctx.fetch = () => new Promise(r => { resolve = r; }); let finishes = 0; ctx.finishPromptWithoutStream = () => { finishes++; };
 const run = callback('reconcileAgentState', '\n  // Keep a bounded foreground', ctx)('session');
 // An external agent_start does not increment the local prompt counter.
 ctx.stateRunRevisionRef.current++; ctx.currentAgentRunIdRef.current = 'run-B';
 resolve({ ok: true, json: async () => ({ running: false, state: { isStreaming: false } }) }); await run;
 assert.equal(finishes, 0); assert.equal(ctx.rpcPromptPendingRef.current, true);
});
test('finish suspended during history reload cannot clear a newer external run or draft', async () => {
 const ctx = context(); let release; ctx.loadSession = () => new Promise(r => { release = r; });
 const run = callback('finishPromptWithoutStream', '\n  // 非流式命令', ctx)('session', 1);
 ctx.stateRunRevisionRef.current++; ctx.currentAgentRunIdRef.current = 'run-B'; release(); await run;
 assert.equal(ctx.sdkAgentActiveRef.current, true); assert.equal(ctx.optimisticUserMessageKeyRef.current, 'draft');
});
test('same session ID on another peer cannot consume a late state response', async () => {
 const ctx = context(); let resolve; ctx.fetch = () => new Promise(r => { resolve = r; }); let finishes = 0; ctx.finishPromptWithoutStream = () => finishes++;
 const run = callback('reconcileAgentState', '\n  // Keep a bounded foreground', ctx)('session'); ctx.remotePeerRef.current = 'peer-B';
 resolve({ ok: true, json: async () => ({ running: false }) }); await run; assert.equal(finishes, 0);
});
