import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
const core = createRequire(import.meta.url)("../bin/session-wait-core.cjs");
const owner = { deviceId: "fixture", sessionId: "owner" };
const target = { deviceId: "fixture", sessionId: "target" };

test("recovery compacts 50,000 legacy observations without losing control facts or references", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wait-history-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  core.createWait(root, "reader", { id: "active", owner, target, condition: "task_completed" });
  const state = core.readState(root, "reader");
  for (let i = 0; i < 50_000; i++) {
    const id = `stream-${i}`;
    state.events[id] = { id, type: "runtime_event", identity: target, summary: "message_update", padding: "x".repeat(500) };
    state.eventOrder.push(id);
  }
  state.waits.active.lastEventId = "stream-0";
  state.receipts.keep = { eventId: "stream-1", status: "processed" };
  state.events.control = { id: "control", type: "task_completed", identity: target, outcome: "completed", result: { eventId: "stream-2" } };
  state.eventOrder.unshift("control");
  state.events.orphan = { id: "orphan", type: "runtime_event" };
  const controlKeys = ["waits", "plans", "pendingEvents", "inbox", "outbox", "receipts", "externalTasks", "peers", "pullReceipts", "remoteBindings"];
  const preserved = Object.fromEntries(controlKeys.map(key => [key, structuredClone(state[key])]));
  core.atomicWriteJson(core.stateFile(root, "reader"), state);
  const before = statSync(core.stateFile(root, "reader")).size;
  core.recoverState(root, "reader");
  const restored = core.readState(root, "reader");
  assert.deepEqual(Object.fromEntries(controlKeys.map(key => [key, restored[key]])), preserved);
  assert.equal(Object.values(restored.events).filter(event => event.type === "runtime_event").length, 259);
  assert.ok(restored.events["stream-0"] && restored.events["stream-1"]);
  assert.equal(restored.events.orphan, undefined);
  assert.equal(core.applyEvent(root, "reader", { id: "control", type: "task_completed", identity: target }).duplicate, true);
  const after = statSync(core.stateFile(root, "reader")).size;
  assert.ok(after < before / 100);
  const revision = core.readState(root, "reader").revision;
  core.recoverState(root, "reader");
  assert.equal(core.readState(root, "reader").revision, revision, "idempotent recovery does not rewrite");
  t.diagnostic(JSON.stringify({ legacyEvents: 50_000, beforeBytes: before, afterBytes: after }));
});

test("all transaction append paths bound observations and retain semantic dedup past 20,000 records", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wait-history-paths-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  core.createWait(root, "reader", { id: "active", owner, target, condition: "task_completed" });
  const state = core.readState(root, "reader");
  for (let i = 0; i < 20_010; i++) {
    const id = `control-${i}`;
    state.events[id] = { id, type: "task_completed", identity: target };
    state.eventOrder.push(id);
  }
  for (let i = 0; i < 300; i++) {
    const id = `stream-${i}`;
    state.events[id] = { id, type: "runtime_event", identity: target };
    state.eventOrder.push(id);
  }
  core.atomicWriteJson(core.stateFile(root, "reader"), state);
  core.applyEvent(root, "reader", { id: "stream-extra", type: "runtime_event", identity: target });
  core.transitionWait(root, "reader", "active", "pause");
  assert.equal(core.applyEvent(root, "reader", { id: "control-0", type: "task_completed", identity: target }).duplicate, true);
  const restored = core.readState(root, "reader");
  assert.equal(Object.values(restored.events).filter(event => event.type === "runtime_event").length, 256);
  assert.equal(restored.waits.active.status, "paused");
});

test("completed and cancelled waits leave the visible ledger after delivery settles", (t) => {
  const root = mkdtempSync(join(tmpdir(), "wait-history-cleanup-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const completed = core.createWait(root, "reader", { id: "completed", owner, target, condition: "task_completed" });
  core.applyEvent(root, "reader", { id: "completed-event", type: "task_completed", identity: target, waitId: completed.id, success: true, resultLocation: "/fixture/result" });
  let state = core.readState(root, "reader");
  assert.equal(state.waits[completed.id], undefined);
  assert.equal(state.terminalWaits[completed.id].status, "completed");
  assert.equal(core.applyEvent(root, "reader", { id: "late-completed", type: "task_completed", identity: target, waitId: completed.id, success: true, resultLocation: "/fixture/result" }).reason, "wait_completed");

  const continuation = core.createWait(root, "reader", { id: "continuation", owner, target, condition: "task_completed", continuation: { target: owner, message: "resume" } });
  core.applyEvent(root, "reader", { id: "continuation-event", type: "task_completed", identity: target, waitId: continuation.id, success: true, resultLocation: "/fixture/result" });
  state = core.readState(root, "reader");
  assert.equal(state.waits[continuation.id].status, "completed");
  const outbox = Object.values(state.outbox).find(item => item.waitId === continuation.id);
  core.claimOutbox(root, "reader", outbox.id, "processed");
  assert.equal(core.readState(root, "reader").waits[continuation.id], undefined);

  const failed = core.createWait(root, "reader", { id: "failed", owner, target, condition: "task_completed" });
  core.applyEvent(root, "reader", { id: "failed-event", type: "task_failed", identity: target, waitId: failed.id, reason: "fixture failure" });
  assert.equal(core.readState(root, "reader").waits[failed.id].status, "failed");

  const cancelled = core.createWait(root, "reader", { id: "cancelled", owner, target, condition: "task_completed" });
  core.transitionWait(root, "reader", cancelled.id, "cancel");
  state = core.readState(root, "reader");
  assert.equal(state.waits[cancelled.id], undefined);
  assert.equal(state.terminalWaits[cancelled.id].status, "cancelled");

  const legacy = core.createWait(root, "reader", { id: "legacy", owner, target, condition: "task_completed" });
  state = core.readState(root, "reader"); state.waits[legacy.id].status = "completed"; core.atomicWriteJson(core.stateFile(root, "reader"), state);
  core.recoverState(root, "reader");
  assert.equal(core.readState(root, "reader").waits[legacy.id], undefined);
  assert.equal(core.readState(root, "reader").terminalWaits[legacy.id].status, "completed");
});
