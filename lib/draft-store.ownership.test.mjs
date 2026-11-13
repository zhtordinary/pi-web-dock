import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const store = await createJiti(import.meta.url, { moduleCache: false }).import("./draft-store.ts");

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
}

test("session drafts and queue recovery are isolated by peer and separate from legacy keys", t => {
  const original = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  t.after(() => { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; });
  const id = "same/#?%:session";
  const local = store.sessionDraftKey(id);
  const peerA = store.sessionDraftKey(id, "peer-a");
  const peerB = store.sessionDraftKey(id, "peer-b");
  const historyA = store.historyDraftKey(id, "peer-a");
  const namedLocal = store.sessionDraftKey(id, "local");
  const legacyCollision = store.draftKeyIdentity(peerA);
  store.setDraft(legacyCollision, { value: "legacy id resembling a scoped storage key", images: [] });
  store.setDraft(id, { value: "unowned legacy draft", images: [] });
  assert.equal(store.getDraft(local), null);
  assert.equal(store.getDraft(peerA), null);
  store.setDraft(local, { value: "local", images: [] });
  store.setDraft(peerA, { value: "peer A", images: [] });
  store.setDraft(peerB, { value: "peer B", images: [] });
  store.setDraft(namedLocal, { value: "device called local", images: [] });
  assert.equal(store.getDraft(local).value, "local");
  assert.equal(store.getDraft(store.sessionDraftKey(id, "peer-a")).value, "peer A");
  assert.equal(store.getDraft(peerB).value, "peer B");
  assert.equal(store.getDraft(namedLocal).value, "device called local");
  assert.equal(store.getDraft(id).value, "unowned legacy draft");
  assert.equal(store.getDraft(legacyCollision).value, "legacy id resembling a scoped storage key");
  assert.deepEqual(store.setRecalledDraft(peerA, { value: "peer A recalled", images: [] }, "op"), { durable: true });
  assert.equal(store.isRecalledDraftDurable(peerA, "op"), true);
  assert.equal(store.isRecalledDraftDurable(peerB, "op"), false);
  assert.equal(store.isRecalledDraftDurable(id, "op"), false);
  store.setDraft(historyA, { value: "", images: [], historyEdit: { entryId: "historic" } });
  store.clearDraft(peerA);
  assert.equal(store.getDraft(historyA).historyEdit.entryId, "historic", "clearing input must not erase an unacknowledged edit");
  store.setRecalledDraft(historyA, { value: "recalled", images: [] }, "history-op");
  assert.equal(store.getDraft(historyA).historyEdit.entryId, "historic");
  assert.equal(JSON.parse(localStorage.getItem(store.draftKeyIdentity(historyA))).historyEdit.entryId, "historic");
  for (const key of [id, legacyCollision, local, peerA, peerB, namedLocal, historyA]) store.clearDraft(key);
});

test("promotion moves only the provisional draft and never an unowned legacy session draft", t => {
  const original = globalThis.localStorage;
  globalThis.localStorage = memoryStorage();
  t.after(() => { if (original === undefined) delete globalThis.localStorage; else globalThis.localStorage = original; });
  const sid = "promoted-session";
  const provisional = "new:peer-a:project";
  const target = store.sessionDraftKey(sid, "peer-a");
  store.setDraft(sid, { value: "ambiguous legacy", images: [] });
  store.setDraft(provisional, { value: "current draft", images: [] });
  assert.equal(store.rekeyDraft(provisional, target).value, "current draft");
  assert.equal(store.getDraft(provisional), null);
  assert.equal(store.getDraft(target).value, "current draft");
  assert.equal(store.getDraft(sid).value, "ambiguous legacy");
  assert.equal(store.sameDraftKey(target, store.sessionDraftKey(sid, "peer-a")), true);
  assert.equal(store.sameDraftKey(target, store.sessionDraftKey(sid, "peer-b")), false);
  for (const key of [sid, provisional, target]) store.clearDraft(key);
});
