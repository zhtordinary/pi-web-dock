import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fauxProvider, fauxAssistantMessage, fauxText } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const environment = await createSealedPublicInputEnvironment("queue-identity");
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: true });
const { AgentSessionWrapper, subscribeRunningSessions, getRunningRpcSessionIds } = await jiti.import("./rpc-manager.ts");
test.after(() => environment.restore());

async function fixture(t) {
  const faux = fauxProvider({ models: [{ id: "queue-test" }] });
  const modelRuntime = await ModelRuntime.create({ authPath: join(environment.agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  const resourceLoader = new DefaultResourceLoader({ cwd: environment.root, agentDir: environment.agentDir, settingsManager, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: environment.root, agentDir: environment.agentDir, modelRuntime, model: faux.getModel("queue-test"), sessionManager: SessionManager.inMemory(environment.root), settingsManager, resourceLoader });
  let mcpCalls=0;
  const wrapper = new AgentSessionWrapper(session, undefined, undefined, {mcpHost:{prepareForPrompt:async()=>{mcpCalls++},dispose:()=>{}}});
  // Pricing is unrelated to queue identity; no model run or network is needed.
  wrapper.estimateSystemPromptCost = async () => undefined;
  wrapper.start();
  const events = [];
  wrapper.onEvent(event => { if (event.type === "queue_update") events.push(event); });
  t.after(() => wrapper.destroy());
  return { session, wrapper, events, faux, mcpCalls:()=>mcpCalls };
}

// A prompt RPC acknowledges after preflight; the run settles asynchronously.
async function waitForIdle(wrapper) {
  const deadline = Date.now() + 5000;
  while (wrapper.isRunning() && Date.now() < deadline) await new Promise(r => setTimeout(r, 5));
}

test("actual SDK persists peer custom entry and never forges a user message",async t=>{
 const {session,wrapper,faux,mcpCalls}=await fixture(t);
 wrapper.extensionUiAbortController.abort(new Error("previous Stop"));
 faux.setResponses([()=>fauxAssistantMessage([fauxText("offline fixture reply")])]);
 const envelope={version:1,id:"b".repeat(64),createdAt:new Date().toISOString(),sender:{deviceId:"fixture",deviceName:"Fixture",sessionId:"sender",sessionFile:null,title:null,project:environment.root},recipient:wrapper.sessionId,replyTo:"sender",kind:"request",responseRequired:true,body:"peer task",transport:"pending"};
 const result=await wrapper.send({type:"peer_message",delivery:"prompt",envelope});
 assert.equal(result.accepted,true);
 assert.equal(mcpCalls(),1);assert.equal(wrapper.extensionUiAbortController.signal.aborted,false);
 const deadline=Date.now()+5000;while(session.isStreaming && Date.now()<deadline) await new Promise(r=>setTimeout(r,5));
 const entries=session.sessionManager.getEntries();
 const peer=entries.find(e=>e.type==="custom_message"&&e.customType==="pi-web:session-peer");
 assert.ok(peer);assert.equal(peer.details.messageId,envelope.id);assert.equal(peer.details.replyTo,"sender");
 assert.equal(entries.some(e=>e.type==="message"&&e.message.role==="user"),false);
 assert.equal(faux.state.callCount,1);
});

test("Stop during peer MCP preparation withdraws input before persistence or a model call",async t=>{
 const {session,wrapper,faux}=await fixture(t);
 let waiting;const entered=new Promise(resolve=>waiting=resolve);
 wrapper.mcpHost={dispose:()=>{},prepareForPrompt:signal=>new Promise(resolve=>{waiting();signal.addEventListener('abort',()=>resolve(),{once:true});})};
 const envelope={version:1,id:'c'.repeat(64),createdAt:new Date().toISOString(),sender:{deviceId:'d',deviceName:'D',sessionId:'sender',sessionFile:null,title:null,project:environment.root},recipient:wrapper.sessionId,replyTo:'sender',kind:'request',responseRequired:true,body:'peer task',transport:'pending'};
 const submission=wrapper.send({type:'peer_message',delivery:'prompt',envelope});
 const rejection=assert.rejects(submission,/stopped|cancel/i);
 await entered;await wrapper.send({type:'abort'});await rejection;
 assert.equal(faux.state.callCount,0);assert.equal(session.sessionManager.getEntries().some(e=>e.customType==='pi-web:session-peer'),false);
 assert.equal(wrapper.pendingPromptCount,0);
});

test("prompt broadcasts both admission and final idle state", async t => {
 const {wrapper, faux}=await fixture(t);
 const sessions=globalThis.__piSessions ??= new Map();
 assert.equal(sessions.has(wrapper.sessionId),false);
 sessions.set(wrapper.sessionId,wrapper);
 const snapshots=[];
 const unsubscribe=subscribeRunningSessions(ids=>snapshots.push(new Set(ids)));
 let release;
 try {
  let admit;
  const preparing=new Promise(resolve=>admit=resolve);
  const gate=new Promise(resolve=>release=resolve);
  const original=wrapper.syncModelConfigIfStale.bind(wrapper);
  wrapper.syncModelConfigIfStale=async()=>{admit();await gate;await original()};
  faux.setResponses([()=>fauxAssistantMessage([fauxText('finished')])]);
  const submission=wrapper.send({type:'prompt',message:'ordinary'});
  await preparing;
  const activeDuringAdmission=wrapper.isRunning();
  const admissionWasBroadcast=snapshots.at(-1)?.has(wrapper.sessionId);
  release();
  await submission;
  await waitForIdle(wrapper);
  assert.equal(wrapper.isRunning(),false);
  assert.equal(getRunningRpcSessionIds().includes(wrapper.sessionId),false);
  assert.equal(snapshots.at(-1)?.has(wrapper.sessionId),false,'the final admission release must broadcast idle');
  assert.equal(activeDuringAdmission,true,'preparation is live work');
  assert.equal(admissionWasBroadcast,true,'admission must be broadcast before the model begins');
 } finally {
  release?.();
  unsubscribe();
  sessions.delete(wrapper.sessionId);
 }
});

test("queued admission remains running until every admitted input is released", async t => {
 const {wrapper}=await fixture(t);
 const sessions=globalThis.__piSessions ??= new Map();
 assert.equal(sessions.has(wrapper.sessionId),false);
 sessions.set(wrapper.sessionId,wrapper);
 const snapshots=[];
 const unsubscribe=subscribeRunningSessions(ids=>snapshots.push(new Set(ids)));
 try {
  const first=await wrapper.acquirePromptAdmission();
  const waiting=wrapper.acquirePromptAdmission();
  const runningWithTwo=wrapper.isRunning();
  first();
  const second=await waiting;
  const runningWithOne=wrapper.isRunning();
  const afterFirst=snapshots.at(-1)?.has(wrapper.sessionId);
  second();
  assert.equal(runningWithTwo,true);
  assert.equal(runningWithOne,true);
  assert.equal(afterFirst,true,'releasing one input must not publish idle while another waits');
  assert.equal(wrapper.isRunning(),false);
  assert.equal(snapshots.at(-1)?.has(wrapper.sessionId),false);
 } finally {
  unsubscribe();
  sessions.delete(wrapper.sessionId);
 }
});

test("peer and ordinary idle inputs refresh model and host through the same preparation",async t=>{
 const {wrapper,session,faux,mcpCalls}=await fixture(t);let models=0,hosts=0;
 const model=wrapper.syncModelConfigIfStale.bind(wrapper),host=wrapper.refreshRemoteClaudeHostBinding.bind(wrapper);
 wrapper.syncModelConfigIfStale=async()=>{models++;return model()};wrapper.refreshRemoteClaudeHostBinding=async()=>{hosts++;return host()};
 faux.setResponses([()=>fauxAssistantMessage([fauxText('first')]),()=>fauxAssistantMessage([fauxText('second')])]);
 const envelope={version:1,id:'d'.repeat(64),createdAt:new Date().toISOString(),sender:{deviceId:'d',deviceName:'D',sessionId:'sender',sessionFile:null,title:null,project:environment.root},recipient:wrapper.sessionId,replyTo:'sender',kind:'request',responseRequired:true,body:'peer task',transport:'pending'};
 await wrapper.send({type:'peer_message',delivery:'prompt',envelope});
 const deadline=Date.now()+5000;while((session.isStreaming||wrapper.pendingPromptCount) && Date.now()<deadline)await new Promise(r=>setTimeout(r,5));
 assert.equal(models,1);assert.equal(hosts,1);assert.equal(mcpCalls(),1);
 await wrapper.send({type:'prompt',message:'ordinary'});
 await waitForIdle(wrapper);
 assert.equal(models,2);assert.equal(hosts,2);assert.equal(mcpCalls(),2);
});

for (const type of ['peer_message','prompt']) for (const stage of ['syncModelConfigIfStale','refreshRemoteClaudeHostBinding']) {
 test(`Stop during ${stage} withdraws ${type} before MCP, persistence and generation`,async t=>{
  const {wrapper,session,faux,mcpCalls}=await fixture(t);
  let enter,release;const entered=new Promise(r=>enter=r),gate=new Promise(r=>release=r);
  wrapper[stage]=async()=>{enter();await gate};
  const envelope={version:1,id:'e'.repeat(64),createdAt:new Date().toISOString(),sender:{deviceId:'d',deviceName:'D',sessionId:'sender',sessionFile:null,title:null,project:environment.root},recipient:wrapper.sessionId,replyTo:'sender',kind:'request',responseRequired:true,body:'peer task',transport:'pending'};
  const submission=wrapper.send(type==='prompt'?{type,message:'ordinary'}:{type,delivery:'prompt',envelope});
  const rejection=assert.rejects(submission,/stopped|cancel/i);
  await entered;await wrapper.send({type:'abort'});release();await rejection;
  assert.equal(faux.state.callCount,0);assert.equal(mcpCalls(),0);assert.equal(wrapper.pendingPromptCount,0);
  assert.equal(session.sessionManager.getEntries().some(e=>e.customType==='pi-web:session-peer'||(e.type==='message'&&e.message.role==='user')),false);
 });
}

for (const firstType of ['peer_message', 'prompt']) for (const secondType of ['peer_message', 'prompt', 'steer', 'follow_up']) {
 test(`Stop withdraws ${secondType} submitted behind ${firstType}; a fresh submission still works`, async t => {
  const {wrapper, faux, mcpCalls} = await fixture(t);
  let enter, release;
  const entered = new Promise(r => enter = r), gate = new Promise(r => release = r);
  let calls = 0;
  wrapper.syncModelConfigIfStale = async () => { if (++calls === 1) { enter(); await gate; } };
  const envelope = {version:1,id:'f'.repeat(64),createdAt:new Date().toISOString(),sender:{deviceId:'d',deviceName:'D',sessionId:'sender',sessionFile:null,title:null,project:environment.root},recipient:wrapper.sessionId,replyTo:'sender',kind:'request',responseRequired:true,body:'peer task',transport:'pending'};
  const first = assert.rejects(wrapper.send(firstType === 'prompt' ? {type:'prompt',message:'first pending'} : {type:'peer_message',delivery:'prompt',envelope}), /stopped|cancel/i);
  await entered;
  const second = assert.rejects(wrapper.send(secondType === 'peer_message' ? {type:secondType,delivery:'prompt',envelope:{...envelope,id:'a'.repeat(64)}} : {type:secondType,message:'queued before Stop'}), /stopped|cancel/i);
  await wrapper.send({type:'abort'}); release(); await Promise.all([first, second]);
  assert.equal(faux.state.callCount, 0); assert.equal(mcpCalls(), 0);
  assert.equal(wrapper.promptAdmissionCount, 0);
  faux.setResponses([()=>fauxAssistantMessage([fauxText('new submission')])]);
  await wrapper.send({type:'prompt',message:'submitted after Stop'});
  await waitForIdle(wrapper);
  assert.equal(faux.state.callCount, 1);
 });
}

test('Stop withdraws input waiting for extension binding before admission', async t => {
 const {wrapper, faux} = await fixture(t);
 let enter, release; const entered = new Promise(r=>enter=r), gate = new Promise(r=>release=r);
 wrapper.shouldWaitForExtensions = type => type === 'prompt';
 wrapper.waitForExtensionsBound = async () => { enter(); await gate; };
 const rejected = assert.rejects(wrapper.send({type:'prompt',message:'waiting for extensions'}), /stopped|cancel/i);
 await entered; await wrapper.send({type:'abort'}); release(); await rejected;
 assert.equal(faux.state.callCount, 0); assert.equal(wrapper.promptAdmissionCount, 0);
});
