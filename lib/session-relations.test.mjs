import assert from "node:assert/strict";
import test from "node:test";
import { isActiveRelation, mergeSessionRelationSnapshots, sessionRelationGroups } from "./session-relations.ts";
const identity = (sessionId, deviceId = "mini") => ({ sessionId, deviceId, title: `会话 ${sessionId}` });
const source = { deviceId: "mini", deviceName: "Mac mini", local: true, online: true };
const wait = (id, owner, target, patch = {}) => ({ id, owner, target, condition: "task_completed", status: "waiting", source, ...patch });

test("one A-to-B/C/D ledger projects outgoing in A and incoming in each target", () => {
  const rows = [wait("ab", identity("A"), identity("B", "debian")), wait("ac", identity("A"), identity("C")), wait("ad", identity("A"), identity("D", "air"))];
  const outgoing = sessionRelationGroups(rows, identity("A")); assert.equal(outgoing.length, 3); assert.ok(outgoing.every(row => row.direction === "outgoing"));
  for (const [target, device] of [["B", "debian"], ["C", "mini"], ["D", "air"]]) {
    const incoming = sessionRelationGroups(rows, identity(target, device)); assert.equal(incoming.length, 1); assert.equal(incoming[0].direction, "incoming"); assert.equal(incoming[0].peer.sessionId, "A");
  }
  assert.deepEqual(sessionRelationGroups(rows, identity("unrelated")), []);
  assert.deepEqual(sessionRelationGroups(rows, identity("B", "mini")), [], "same session id on another device is not this session");
});

test("multiple waits group by peer while reciprocal directions and duplicate IDs on other ledgers remain distinct", () => {
  const rows = [wait("one", identity("A"), identity("B")), wait("two", identity("A"), identity("B"), { condition: "ui_request" }), wait("back", identity("B"), identity("A"))];
  const groups = sessionRelationGroups([...rows, rows[0]], identity("A")); assert.equal(groups.length, 2); assert.equal(groups[0].waits.length, 2); assert.equal(groups[1].direction, "incoming");
  const otherSource = { ...source, deviceId: "debian", local: false };
  assert.equal(sessionRelationGroups([rows[0], { ...rows[0], source: otherSource }], identity("A"))[0].waits.length, 2);
});

test("finished waits disappear only after pending continuation delivery is resolved", () => {
  const row = wait("one", identity("A"), identity("B"));
  for (const status of ["waiting", "paused", "blocked", "failed"]) assert.equal(isActiveRelation({ ...row, status }), true);
  for (const status of ["completed", "cancelled"]) assert.equal(isActiveRelation({ ...row, status }), false);
  assert.equal(isActiveRelation({ ...row, status: "completed", continuationStatus: "unknown" }), true);
  assert.equal(isActiveRelation({ ...row, status: "completed", continuationStatus: "pending" }), true);
  assert.equal(isActiveRelation({ ...row, status: "cancelled", continuationStatus: "pending" }), false);
});

test("offline sources keep last-known relationships as unconfirmed, then recover without duplicates", () => {
  const initial = { waits: [wait("ab", identity("A"), identity("B"))], sources: [source] };
  const offline = mergeSessionRelationSnapshots(initial, { waits: [], sources: [{ ...source, online: false }] });
  assert.equal(offline.waits.length, 1); assert.equal(offline.waits[0].stale, true); assert.equal(offline.waits[0].source.online, false);
  const recovered = mergeSessionRelationSnapshots(offline, initial); assert.equal(recovered.waits.length, 1); assert.equal(recovered.waits[0].stale, undefined);
  assert.equal(mergeSessionRelationSnapshots(initial, { waits: [], sources: [source] }).waits.length, 0, "online authoritative empty removes the relationship");
  assert.equal(mergeSessionRelationSnapshots(null, { waits: [], sources: [source] }).waits.length, 0);
});
