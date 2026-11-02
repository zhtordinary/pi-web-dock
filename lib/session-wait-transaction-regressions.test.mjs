import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const core = require('../bin/session-wait-core.cjs');
const owner = { deviceId: 'dev', sessionId: 'owner' };
const target = { deviceId: 'dev', sessionId: 'worker' };
function fixture(t) { const root = fs.mkdtempSync(path.join(os.tmpdir(), 'reader-wait-transaction-')); t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root; }
function plan(root) { return core.createPlan(root, 'test', { id: 'plan', owner, maxRounds: 1, nodes: [{ id: 'n', session: target, condition: 'task_completed', taskId: 'task', continuation: { message: 'fixture', target } }] }); }
function early(root, created, extra = {}) { return core.applyEvent(root, 'test', { id: 'early', type: 'task_completed', identity: target, planId: 'plan', waitId: created.wait.id, taskId: 'task', generation: 1, round: 1, success: true, resultLocation: '/fixture/result', ...extra }); }

test('terminal event is durably queued under a live lock and recovered once after restart', t => {
 const root = fixture(t); core.createWait(root, 'test', { id: 'wait', owner, target, condition: 'turn_settled' });
 const release = require('../bin/state-write-lock.cjs').acquireStateWriteLock(core.stateFile(root, 'test'));
 const event = { id: 'settled', type: 'turn_settled', identity: target };
 assert.deepEqual(core.runtimeEvent(root, 'test', event), { queued: true, persisted: true, eventId: 'settled' });
 assert.equal(core.getStatus(root, 'test').waits[0].status, 'waiting');
 release(); core.recoverState(root, 'test');
 assert.equal(core.getStatus(root, 'test').waits.length, 0); assert.equal(core.readState(root, 'test').terminalWaits.wait.status, 'completed');
 const revision = core.readState(root, 'test').revision; core.recoverState(root, 'test');
 assert.equal(core.readState(root, 'test').revision, revision);
 assert.deepEqual(fs.readdirSync(`${core.stateFile(root, 'test')}.events`), []);
});

test('early result and accepted handoff commit together with complete result payload', t => {
 const root = fixture(t), created = plan(root); assert.equal(early(root, created).pending, true);
 const outbox = core.getStatus(root, 'test').outbox[0]; const before = core.readState(root, 'test').revision;
 core.completeOutboxDelivery(root, 'test', outbox.id, 'processed');
 const state = core.readState(root, 'test'); assert.equal(state.revision, before + 1);
 assert.equal(state.plans.plan.status, 'completed'); assert.equal(state.events.early.resultLocation, '/fixture/result'); assert.equal(state.terminalWaits[created.wait.id].status, 'completed');
 assert.deepEqual(state.pendingEvents, {});
});

test('a processed peer receipt applies an early result to the exact current plan once', t => {
 const root = fixture(t), created = plan(root); assert.equal(early(root, created).pending, true);
 const item = core.getStatus(root, 'test').outbox[0];
 core.applyPeerReceipt(root, 'test', { messageId: item.messageId, outboxId: item.id, sender: target, status: 'processed', details: { pullDigest: item.capability.digest } });
 const state = core.readState(root, 'test');
 assert.equal(state.plans.plan.status, 'completed');
 assert.equal(state.events.early.outcome, 'completed');
 assert.deepEqual(state.pendingEvents, {});
 core.applyPeerReceipt(root, 'test', { messageId: item.messageId, outboxId: item.id, sender: target, status: 'processed', details: { pullDigest: item.capability.digest } });
 assert.deepEqual(core.readState(root, 'test').plans.plan.nodeResults, state.plans.plan.nodeResults);
});

test('a processed peer receipt does not consume an early result while the plan is paused', t => {
 const root = fixture(t), created = plan(root); assert.equal(early(root, created).pending, true);
 const item = core.getStatus(root, 'test').outbox[0]; core.transitionWait(root, 'test', created.wait.id, 'pause');
 core.applyPeerReceipt(root, 'test', { messageId: item.messageId, outboxId: item.id, sender: target, status: 'processed', details: { pullDigest: item.capability.digest } });
 const state = core.readState(root, 'test'); assert.equal(state.plans.plan.status, 'paused'); assert.ok(state.pendingEvents.early); assert.equal(state.waits[created.wait.id].status, 'paused');
 core.transitionWait(root, 'test', created.wait.id, 'resume'); const resumed = core.readState(root, 'test'); assert.equal(resumed.plans.plan.status, 'waiting'); assert.ok(resumed.pendingEvents.early);
 core.applyPeerReceipt(root, 'test', { messageId: item.messageId, outboxId: item.id, sender: target, status: 'processed', details: { pullDigest: item.capability.digest } });
 const repeated = core.readState(root, 'test'); assert.equal(repeated.plans.plan.status, 'waiting'); assert.deepEqual(repeated.pendingEvents, resumed.pendingEvents); assert.deepEqual(repeated.plans.plan.nodeResults, resumed.plans.plan.nodeResults); assert.deepEqual(Object.keys(repeated.outbox), Object.keys(resumed.outbox));
});

test('a pull wake binds the original owner rather than the addressed worker', t => {
 const source = fixture(t), receiver = fixture(t), created = plan(source);
 const item = core.getStatus(source, 'test').outbox[0];
 core.recordPullReceipt(receiver, 'test', { pullMessageId: 'pull', peerId: 'dev', itemId: item.id, sourceMessageId: item.messageId, itemDigest: item.capability.digest, itemCapability: item.capability });
 const binding = Object.values(core.readState(receiver, 'test').remoteBindings)[0];
 assert.equal(binding.waitId, created.wait.id);
 assert.deepEqual(binding.owner, owner);
 assert.deepEqual(binding.target, target);
});

test('invalid early results are durably rejected without poisoning a later valid handoff', t => {
 const root = fixture(t), created = plan(root);
 const rejected=early(root, created, { success: false, id:'bad' });
 assert.equal(rejected.rejected,true);assert.match(rejected.reason,/success=true/);
 assert.equal(core.readState(root,'test').events.bad.outcome,'rejected_invalid_result');
 assert.equal(early(root,created,{id:'good'}).pending,true);
 const item=core.getStatus(root,'test').outbox[0];core.completeOutboxDelivery(root,'test',item.id,'processed');
 const state=core.readState(root,'test');assert.equal(state.plans.plan.status,'completed');assert.deepEqual(state.pendingEvents,{});
});

test('legacy poisoned pending results are isolated while valid result and handoff commit together', t => {
 const root=fixture(t),created=plan(root);early(root,created,{id:'good'});
 core.withTransaction(root,'test',state=>{state.pendingEvents={bad:{...state.pendingEvents.good,id:'bad',success:false},...state.pendingEvents};});
 const item=core.getStatus(root,'test').outbox[0];core.completeOutboxDelivery(root,'test',item.id,'processed');
 const state=core.readState(root,'test');assert.equal(state.plans.plan.status,'completed');assert.equal(state.events.bad.outcome,'rejected_invalid_result');assert.deepEqual(state.pendingEvents,{});
});

test('native settled event creates a result for each authorized matching remote observer', t => {
 const root = fixture(t);
 core.withTransaction(root, 'test', state => {
  state.instanceId = 'dev'; state.peers.remote = { sessions: ['owner'] };
  state.remoteBindings.binding = { id: 'binding', condition: 'turn_settled', waitId: 'remote-wait', owner: { deviceId: 'remote', sessionId: 'owner' }, target, taskId: 'run' };
 });
 const event = { id: 'native', type: 'turn_settled', identity: target, taskId: 'run' };
 core.runtimeEvent(root, 'test', event); core.runtimeEvent(root, 'test', event);
 const outbox = core.getStatus(root, 'test').outbox; assert.equal(outbox.length, 1);
 assert.equal(outbox[0].operation, 'report_result'); assert.equal(outbox[0].recipient.deviceId, 'remote');
 assert.equal(outbox[0].resultEvent.waitId, 'remote-wait');
 core.runtimeEvent(root, 'test', { ...event, id: 'wrong-run', taskId: 'new-run' });
 assert.equal(core.getStatus(root, 'test').outbox.length, 1);
});

test('queued receipt observations never claim execution and remain pollable until processed', async () => {
 const source = fs.readFileSync(new URL('../bin/session-wait-worker.cjs', import.meta.url), 'utf8');
 let status = 'queued', claims = 0, queries = 0; const item = { id: 'o', messageId: 'm', recipient: { deviceId: 'remote' }, capability: { operation: 'observe_wait', digest: 'digest' }, get status() { return status; } };
 const fake = { ...core, getStatus: () => ({ outbox: [item] }), readState: () => ({ peers: { remote: {} } }), resolveConfiguredPeerUrl: () => 'https://fixture.invalid', createSignedEnvelope: x => x,
  claimOutboxForDelivery: () => { claims++; status = 'in_flight'; return { claimed: true, claimId: 'claim', capability: item.capability }; },
  completeOutboxDelivery: (_r, _c, _id, next) => { status = next; } };
 const context = { module: { exports: {} }, exports: {}, process, console, URL, AbortSignal, setTimeout,
  require: id => id === './session-wait-core.cjs' ? fake : id === './session-wait-lock.cjs' ? {} : id === 'node:fs' ? { ...fs, readFileSync: () => 'fixture-key' } : require(id),
  fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: ++queries < 3 ? 'queued' : 'processed' }) }) };
 vm.runInNewContext(source.replace(/^#!.*\n/, '').replace(/main\(\)\.catch\([\s\S]*$/, 'module.exports = { deliverPendingOutbox };'), context);
 const options = { stateRoot: '/fixture', channel: 'test', mode: 'push', privateKeyFile: '/fixture/key', senderDeviceId: 'dev', senderSessionId: 'owner', peerUrl: 'https://fixture.invalid', allowedPeerUrls: ['https://fixture.invalid'] };
 for (let i = 0; i < 3; i++) await context.module.exports.deliverPendingOutbox(options);
 assert.equal(queries, 3); assert.equal(claims, 0); assert.equal(status, 'processed');
});

test('remote native observers consume only their declared condition once', t => {
 const root = fixture(t);
 core.withTransaction(root, 'test', state => {
  state.instanceId='dev'; state.peers.remote={sessions:['owner']};
  for (const condition of ['turn_settled','task_completed','acceptance_passed']) state.remoteBindings[condition]={id:condition,condition,waitId:condition,owner:{deviceId:'remote',sessionId:'owner'},target};
 });
 for (let i=0;i<3;i++) core.runtimeEvent(root,'test',{id:`native-${i}`,type:'turn_settled',identity:target,taskId:`run-${i}`});
 const state=core.readState(root,'test');
 assert.equal(Object.keys(state.outbox).length,1);
 assert.ok(state.remoteBindings.turn_settled.consumedAt);
 assert.equal(state.remoteBindings.task_completed.consumedAt,undefined);
 assert.equal(state.remoteBindings.acceptance_passed.consumedAt,undefined);
});

test('remote observation carries its condition through capability and inbox registration', t => {
 const a=fixture(t),b=fixture(t),remoteTarget={deviceId:'remote',sessionId:'worker'};
 core.createWait(a,'test',{id:'remote-observer',owner,target:remoteTarget,condition:'turn_settled',dispatchObserve:true});
 const item=core.getStatus(a,'test').outbox[0],payload=core.verifyOutboxCapability(item).payload;
 assert.equal(payload.condition,'turn_settled');
 core.withTransaction(b,'test',state=>{state.instanceId='remote';state.peers.dev={sessions:['owner']}});
 core.acceptInbox(b,'test',{messageId:item.messageId,sender:owner,recipient:remoteTarget,operation:'observe_wait',body:payload});
 core.runtimeEvent(b,'test',{id:'first-run',type:'turn_settled',identity:remoteTarget});
 core.runtimeEvent(b,'test',{id:'later-run',type:'turn_settled',identity:remoteTarget});
 const results=core.getStatus(b,'test').outbox;
 assert.equal(results.length,1);assert.equal(results[0].resultEvent.waitId,'remote-observer');
});
test('legacy bindings without condition advertise required re-registration instead of guessing',t=>{
 const root=fixture(t);core.withTransaction(root,'test',state=>{state.remoteBindings.old={id:'old',waitId:'w',target,owner};});
 assert.deepEqual(core.getStatus(root,'test').bindingWarnings,[{bindingId:'old',waitId:'w',reason:'condition_required',nextAction:'reregister_observation_with_explicit_condition'}]);
});

function acceptancePlan(root) {
 return core.createPlan(root, 'test', { id: 'plan', owner, maxRounds: 1, nodes: [{ id: 'n', session: target, condition: 'acceptance_passed', taskId: 'task', continuation: { message: 'fixture', target }, acceptance: { criterion: 'expected', digest: 'digest' } }] });
}
function acceptanceEvent(created, id, acceptance = { criterion: 'expected', digest: 'digest' }) {
 return { id, type: 'acceptance_passed', identity: target, planId: 'plan', waitId: created.wait.id, taskId: 'task', generation: 1, round: 1, success: true, acceptance };
}
for (const field of ['criterion', 'digest']) test(`early ${field} mismatch is rejected before good acceptance and duplicate handoff`, t => {
 const root = fixture(t), created = acceptancePlan(root);
 const bad = acceptanceEvent(created, 'bad', { criterion: 'expected', digest: 'digest', [field]: 'wrong' });
 const rejected = core.applyEvent(root, 'test', bad);
 assert.equal(rejected.rejected, true); assert.match(rejected.reason, /pre-approved plan node/);
 assert.equal(core.applyEvent(root, 'test', acceptanceEvent(created, 'good')).pending, true);
 const item = core.getStatus(root, 'test').outbox[0]; core.completeOutboxDelivery(root, 'test', item.id, 'processed');
 const before = core.readState(root, 'test'); core.completeOutboxDelivery(root, 'test', item.id, 'processed');
 const state = core.readState(root, 'test'); assert.equal(state.plans.plan.status, 'completed'); assert.deepEqual(state.pendingEvents, {});
 assert.equal(state.events.bad.outcome, 'rejected_invalid_result'); assert.deepEqual(state.plans.plan.nodeResults, before.plans.plan.nodeResults); assert.deepEqual(Object.keys(state.outbox), Object.keys(before.outbox)); assert.deepEqual(state.waits, before.waits);
});
test('persisted semantic poison and direct rejection share validation without blocking good replay', t => {
 const root = fixture(t), created = acceptancePlan(root), bad = acceptanceEvent(created, 'bad', { criterion: 'wrong', digest: 'digest' });
 core.applyEvent(root, 'test', acceptanceEvent(created, 'good'));
 core.withTransaction(root, 'test', state => { state.pendingEvents = { bad, ...state.pendingEvents }; });
 const item = core.getStatus(root, 'test').outbox[0]; core.completeOutboxDelivery(root, 'test', item.id, 'processed');
 const replay = core.readState(root, 'test'); assert.equal(replay.plans.plan.status, 'completed'); assert.deepEqual(replay.pendingEvents, {});
 const directRoot = fixture(t), directPlan = acceptancePlan(directRoot), directItem = core.getStatus(directRoot, 'test').outbox[0];
 core.completeOutboxDelivery(directRoot, 'test', directItem.id, 'processed');
 const direct = core.applyEvent(directRoot, 'test', acceptanceEvent(directPlan, 'bad', bad.acceptance));
 assert.equal(direct.rejected, true); assert.equal(direct.event.outcome, replay.events.bad.outcome); assert.equal(direct.reason, replay.events.bad.reason);
 assert.equal(core.readState(directRoot, 'test').plans.plan.status, 'waiting');
 assert.equal(core.applyEvent(directRoot, 'test', acceptanceEvent(directPlan, 'good')).accepted, true);
});
test('storage failure still rolls back handoff, semantic rejection and valid replay together', t => {
 const root = fixture(t), created = acceptancePlan(root), bad = acceptanceEvent(created, 'bad', { criterion: 'expected', digest: 'wrong' });
 core.applyEvent(root, 'test', acceptanceEvent(created, 'good'));
 core.withTransaction(root, 'test', state => { state.pendingEvents = { bad, ...state.pendingEvents }; });
 const item = core.getStatus(root, 'test').outbox[0], before = fs.readFileSync(core.stateFile(root, 'test'), 'utf8');
 const original = fs.renameSync; let injected = false;
 fs.renameSync = (from, to) => { if (to === core.stateFile(root, 'test')) { injected = true; throw Object.assign(new Error('fixture disk failure'), { code: 'EIO' }); } return original(from, to); };
 try { assert.throws(() => core.completeOutboxDelivery(root, 'test', item.id, 'processed'), /fixture disk failure/); }
 finally { fs.renameSync = original; }
 assert.equal(injected, true); assert.equal(fs.readFileSync(core.stateFile(root, 'test'), 'utf8'), before);
 core.completeOutboxDelivery(root, 'test', item.id, 'processed'); assert.equal(core.readState(root, 'test').plans.plan.status, 'completed');
});
