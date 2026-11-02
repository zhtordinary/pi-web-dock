import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");
const id = (deviceId, sessionId) => ({ deviceId, sessionId, sessionFile: `/fixture/${deviceId}/${sessionId}.jsonl` });
function fixture(t) { const root = mkdtempSync(join(tmpdir(), "session-wait-parent-r1-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("ordinary wait completion emits an owner continuation outbox", (t) => {
  const root = fixture(t); const owner = id("dev", "A"); const target = id("dev", "B");
  const wait = core.createWait(root, "r1", { id: "ordinary", owner, target, condition: "task_completed", taskId: "task-1", continuation: { operation: "resume_prior_work", target: owner, authorizedScope: ["resume_prior_work"], message: "continue approved work" } });
  const result = core.applyEvent(root, "r1", { id: "task-1-complete", type: "task_completed", identity: target, waitId: wait.id, taskId: "task-1", success: true, resultLocation: "/fixture/result.json" });
  assert.equal(result.accepted, true);
  assert.equal(result.state.outbox.length, 1);
  assert.equal(result.state.outbox[0].recipient.sessionId, owner.sessionId);
});

test("runtime event without waitId matches a persisted subscription", (t) => {
  const root = fixture(t); const owner = id("dev", "A"); const target = id("dev", "B");
  const wait = core.createWait(root, "r1", { id: "runtime-sub", owner, target, condition: "turn_settled" });
  const result = core.runtimeEvent(root, "r1", { id: "runtime-settled", type: "turn_settled", identity: target, runId: "run-1" });
  assert.equal(result.accepted, true);
  assert.equal(core.getStatus(root, "r1").waits.find((candidate) => candidate.id === wait.id), undefined); assert.equal(core.readState(root, "r1").terminalWaits[wait.id].status, "completed");
});

test("pull-only scope cannot wake a receiver", (t) => {
  const root = fixture(t); const keys = core.generatePeerKeyPair(); const sender = id("sender", "S");
  const envelope = core.createSignedEnvelope({ channel: "r1", sender, recipient: "receiver", operation: "wake", scope: ["pull_messages"], body: { authorizedScope: ["resume_prior_work"] } }, keys.privateKey);
  const result = core.acceptPeerEnvelope(root, "r1", envelope, { publicKeys: { [sender.deviceId]: keys.publicKey }, recipient: "receiver" });
  assert.equal(result.accepted, false);
  assert.equal(result.reason, "scope_denied");
});
