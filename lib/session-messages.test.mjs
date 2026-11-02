import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { deliverSessionMessage, readSessionMessage, resolveSessionReplyMessageId, sessionMessageStatus } from "./session-messages.ts";
import { SESSION_PEER_CUSTOM_TYPE } from "./session-peer-message.ts";

const identity = sessionId => ({ deviceId: "test-device", deviceName: "Test", sessionId, sessionFile: `/tmp/${sessionId}.jsonl`, title: sessionId, project: "/project" });
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-messages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sent = [];
  return { root, sent, sender: identity("author"), recipient: "worker", callId: "call-1", body: "Please verify the patch", kind: "request", send: async text => { sent.push(text); } };
}

test("identity, routing, transport receipt and durable reply form one thread", async t => {
  const input = fixture(t);
  const receipt = await deliverSessionMessage(input);
  assert.equal(receipt.transport, "accepted");
  assert.equal(receipt.responseRequired, true);
  assert.equal(input.sent[0].customType, SESSION_PEER_CUSTOM_TYPE);
  assert.match(input.sent[0].content, /Agent peer request/);
  assert.match(input.sent[0].content, new RegExp(`replyRef=${receipt.messageId}`));
  assert.match(input.sent[0].content, new RegExp(input.body));
  assert.equal(input.sent[0].details.uiContent, input.body);
  assert.equal(input.sent[0].details.sender.deviceId, "test-device");
  assert.equal(input.sent[0].details.replyTo, "author");
  assert.equal(input.sent[0].details.responseRequired, true);
  const original = readSessionMessage(input.root, receipt.messageId, "worker");
  assert.equal(original.replyTo, "author");
  assert.equal(sessionMessageStatus(input.root, receipt.messageId, "author").replies.length, 0);
  for (const [i, status] of ["accepted", "blocked", "completed"].entries()) {
    await deliverSessionMessage({ ...input, sender: identity("worker"), recipient: "author", callId: `reply-${i}`, kind: "reply", inReplyTo: receipt.messageId, workStatus: status, body: `Evidence: ${status}` });
  }
  const state = sessionMessageStatus(input.root, receipt.messageId, "author");
  assert.deepEqual(state.replies.map(r => r.workStatus), ["accepted", "blocked", "completed"]);
  assert.equal(input.sent.at(-1).customType, SESSION_PEER_CUSTOM_TYPE);
  assert.match(input.sent.at(-1).content, /Agent peer reply/);
  assert.match(input.sent.at(-1).content, new RegExp(`inReplyTo=${receipt.messageId}`));
  assert.match(input.sent.at(-1).content, /workStatus=completed/);
  assert.match(input.sent.at(-1).content, /Evidence: completed/);
  assert.equal(input.sent.at(-1).details.uiContent, "Evidence: completed");
  assert.equal(input.sent.at(-1).details.responseRequired, false);
});

test("persists the native operation so accepted follow_up messages can be retracted", async t => {
  const input = fixture(t);
  const receipt = await deliverSessionMessage({ ...input, operation: "follow_up" });
  assert.equal(receipt.operation, "follow_up");
  assert.equal(readSessionMessage(input.root, receipt.messageId, "worker").operation, "follow_up");
  assert.equal(input.sent[0].details.operation, "follow_up");
  const duplicate = await deliverSessionMessage({ ...input, operation: "follow_up" });
  assert.equal(duplicate.operation, "follow_up");
});

test("empty replyTo defaults to the sender and legacy empty routes remain replyable", async t => {
  const input = fixture(t);
  const original = await deliverSessionMessage({ ...input, replyTo: "" });
  assert.equal(readSessionMessage(input.root, original.messageId, "worker").replyTo, "author");

  const path = join(input.root, `${original.messageId}.json`);
  const legacy = JSON.parse(readFileSync(path, "utf8"));
  legacy.replyTo = "";
  writeFileSync(path, JSON.stringify(legacy));
  const reply = await deliverSessionMessage({ ...input, sender: identity("worker"), recipient: "author", callId: "legacy-reply", kind: "reply", inReplyTo: original.messageId, workStatus: "completed", body: "Confirmed sender fallback" });
  assert.equal(reply.target, "author");
  assert.equal(sessionMessageStatus(input.root, original.messageId, "author").replies[0].workStatus, "completed");
});

test("tool retry does not redeliver; changed payload under same identity fails", async t => {
  const input = fixture(t);
  const first = await deliverSessionMessage(input);
  const again = await deliverSessionMessage(input);
  assert.equal(again.messageId, first.messageId);
  assert.equal(again.duplicate, true);
  assert.equal(input.sent.length, 1);
  await assert.rejects(deliverSessionMessage({ ...input, body: "different" }), /different message/);
});

test("same body under a different call identity is a distinct native custom message", async t => {
  const input = fixture(t);
  const first = await deliverSessionMessage(input);
  const second = await deliverSessionMessage({ ...input, callId: "call-2" });
  assert.notEqual(second.messageId, first.messageId);
  assert.equal(input.sent.length, 2);
  assert.deepEqual(input.sent.map((message) => message.details.uiContent), [input.body, input.body]);
  assert.notEqual(input.sent[0].details.messageId, input.sent[1].details.messageId);
});

test("a model-visible replyRef resolves the sole pending request without hidden test-side injection", async t => {
  const input = fixture(t);
  const first = await deliverSessionMessage(input);
  assert.equal(resolveSessionReplyMessageId(input.root, "worker"), first.messageId);
  assert.equal(resolveSessionReplyMessageId(input.root, "worker", first.messageId.slice(0, 12)), first.messageId);
  await deliverSessionMessage({ ...input, sender: identity("worker"), recipient: "author", callId: "reply-with-ref", kind: "reply", inReplyTo: first.messageId, workStatus: "completed", body: "done" });
  assert.throws(() => resolveSessionReplyMessageId(input.root, "worker"), /no pending request/);
});

test("unknown external outcome is durable and cannot silently retry", async t => {
  const input = fixture(t);
  let calls = 0;
  input.send = async () => { calls++; throw new Error("timeout"); };
  const result = await deliverSessionMessage(input);
  assert.equal(result.transport, "unknown");
  assert.equal(result.accepted, false);
  assert.equal((await deliverSessionMessage(input)).transport, "unknown");
  assert.equal(calls, 1);
});

test("malformed transport receipts remain unknown and preserve raw evidence", async t => {
  for (const rawReceipt of ["{}", "null"]) {
    const input = fixture(t);
    const id = createHash("sha256").update(input.sender.sessionId + "\0" + input.callId).digest("hex");
    const path = join(input.root, `${id}.json`);
    input.send = async () => { writeFileSync(path, rawReceipt); };
    const result = await deliverSessionMessage(input);
    assert.equal(result.transport, "unknown");
    assert.equal(result.accepted, false);
    assert.equal(readFileSync(path, "utf8"), rawReceipt);
  }
});

test("third-party reply route and recipient-only access prevent forged replies", async t => {
  const input = fixture(t);
  const result = await deliverSessionMessage({ ...input, replyTo: "supervisor" });
  assert.equal(readSessionMessage(input.root, result.messageId, "supervisor").replyTo, "supervisor");
  assert.throws(() => readSessionMessage(input.root, result.messageId, "outsider"), /not addressed/);
  const reply = { ...input, callId: "reply", sender: identity("worker"), recipient: "supervisor", kind: "reply", inReplyTo: result.messageId, workStatus: "completed" };
  await assert.rejects(deliverSessionMessage({ ...reply, sender: identity("supervisor") }), /self|original recipient/);
  await assert.rejects(deliverSessionMessage({ ...reply, recipient: "author" }), /return route/);
  const sent = await deliverSessionMessage(reply);
  assert.equal(sent.target, "supervisor");
  assert.match(input.sent.at(-1).content, new RegExp(`inReplyTo=${result.messageId}`));
  assert.match(input.sent.at(-1).content, /workStatus=completed/);
  assert.equal(input.sent.at(-1).details.uiContent, input.body);
  await assert.rejects(deliverSessionMessage({ ...reply, sender: identity("supervisor"), recipient: "worker", callId: "loop", inReplyTo: sent.messageId }), /original recipient/);
});

test("info defaults to no reply; invalid fields and path traversal fail before send", async t => {
  const input = fixture(t);
  const result = await deliverSessionMessage({ ...input, kind: "info" });
  assert.equal(result.responseRequired, false);
  await assert.rejects(deliverSessionMessage({ ...input, callId: "bad", body: " " }), /1..20000/);
  await assert.rejects(deliverSessionMessage({ ...input, callId: "bad", workStatus: "completed" }), /only valid for reply/);
  assert.throws(() => readSessionMessage(input.root, "../../secret", "author"), /invalid messageId/);
  await assert.rejects(deliverSessionMessage({ ...input, callId: "bad", sender: identity("worker"), recipient: "author", kind: "reply", inReplyTo: result.messageId, workStatus: "accepted" }), /response-required/);
  assert.equal(input.sent.length, 1);
});
