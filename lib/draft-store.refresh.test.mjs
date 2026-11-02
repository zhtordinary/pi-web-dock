import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const { clearDraft, hasMemoryDraftContent, setDraft } = await createJiti(import.meta.url, { moduleCache: false }).import("./draft-store.ts");

test("memory-only drafts remain refresh risks even when browser storage fails", t => {
  const previous = globalThis.localStorage;
  globalThis.localStorage = {
    getItem: () => null,
    setItem: () => { throw new Error("quota"); },
    removeItem() {},
  };
  t.after(() => {
    clearDraft("other-session");
    if (previous === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = previous;
  });

  assert.equal(hasMemoryDraftContent(), false);
  setDraft("other-session", { value: "", images: [], autoCompactionEnabled: true });
  assert.equal(hasMemoryDraftContent(), false);
  for (const draft of [
    { value: " ", images: [] },
    { value: "", images: [{ data: "AAAA", mimeType: "image/png" }] },
    { value: "", images: [], quotes: [{ id: "q", text: "quote" }] },
  ]) {
    setDraft("other-session", draft);
    assert.equal(hasMemoryDraftContent(), true);
    clearDraft("other-session");
    assert.equal(hasMemoryDraftContent(), false);
  }
});
