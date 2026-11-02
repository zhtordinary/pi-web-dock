import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { getDraft, setDraft, setRecalledDraft } = await jiti.import("./draft-store.ts");
function storage(t) {
  const old = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
  t.after(() => { if (old === undefined) delete globalThis.localStorage; else globalThis.localStorage = old; });
  return values;
}
const image = { data: "AAAA", mimeType: "image/png" };
test("strict recall persists the full draft and operation marker together across reload", async t => {
  const values = storage(t);
  setRecalledDraft("persisted-recall", { value: "same", images: [image], quotes: [{ id: "quote", text: "existing" }] }, "recall-A");
  const saved = JSON.parse(values.get("pi-web-draft:persisted-recall"));
  assert.equal(saved.images[0].data, "AAAA");
  assert.deepEqual(saved.recalledQueueOperations, ["recall-A"]);
  const fresh = await createJiti(import.meta.url, { interopDefault: true, moduleCache: false }).import("./draft-store.ts");
  assert.deepEqual(fresh.getDraft("persisted-recall"), saved);
  setDraft("persisted-recall", { value: "edited", images: [image] });
  assert.deepEqual(getDraft("persisted-recall").recalledQueueOperations, ["recall-A"]);
});

test("quota failure restores the input in memory without falsely claiming durable persistence", t => {
  storage(t);
  setDraft("failed-recall", { value: "current", images: [] });
  globalThis.localStorage.setItem = () => { throw new Error("quota"); };
  assert.deepEqual(setRecalledDraft("failed-recall", { value: "same\n\ncurrent", images: [image] }, "recall-A"), { durable: false });
  assert.deepEqual(getDraft("failed-recall"), { value: "same\n\ncurrent", images: [image], recalledQueueOperations: ["recall-A"] });
});

test("33 unresolved recalls retain the first marker through dirty edits, reload and draft promotion", async t => {
  storage(t);
  const key = "many-unresolved";
  setDraft(key, { value: "dirty original", images: [image] });
  for (let index = 1; index <= 33; index++) {
    const previous = getDraft(key);
    setRecalledDraft(key, { ...previous, value: `item-${index}\n${previous.value}` }, `operation-${index}`);
  }
  assert.equal(getDraft(key).recalledQueueOperations.length, 33);
  assert.ok(getDraft(key).recalledQueueOperations.includes("operation-1"));
  setDraft(key, { value: getDraft(key).value + "\nstill dirty", images: [image] });
  const fresh = await createJiti(import.meta.url, { moduleCache: false }).import("./draft-store.ts");
  assert.ok(fresh.getDraft(key).recalledQueueOperations.includes("operation-1"));
  fresh.setRecalledDraft("promoted", { value: "other draft", images: [] }, "other-operation");
  const live = fresh.getDraft(key);
  const promoted = fresh.rekeyDraft(key, "promoted", { value: live.value, images: live.images });
  assert.equal(promoted.recalledQueueOperations.length, 34);
  assert.ok(promoted.value.includes("dirty original"));
  assert.equal(promoted.images[0].data, "AAAA");
  fresh.clearDraft("promoted");
  assert.equal(fresh.getDraft("promoted"), null, "deduplication ends with the explicit draft lifecycle, not a record count");
});
