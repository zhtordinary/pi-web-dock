import assert from "node:assert/strict";
import test from "node:test";
import { matchesSessionStorageScope, sessionStorageScopeFor } from "./session-storage-scope.ts";

test("storage scopes are mutually exclusive", () => {
  const plain = { favorite: false, hidden: false };
  assert.equal(matchesSessionStorageScope("normal", { ...plain }), true);
  assert.equal(matchesSessionStorageScope("to_revise", { ...plain, category: "to_revise" }), true);
  assert.equal(matchesSessionStorageScope("favorites", { ...plain, favorite: true }), true);
  assert.equal(matchesSessionStorageScope("hidden", { ...plain, hidden: true }), true);

  for (const membership of [
    { favorite: true, hidden: false, category: undefined },
    { favorite: false, hidden: true, category: undefined },
    { favorite: false, hidden: false, category: "to_revise" },
  ]) {
    assert.equal(matchesSessionStorageScope("normal", membership), false);
  }
  assert.equal(matchesSessionStorageScope("to_revise", { favorite: true, hidden: false, category: "to_revise" }), false);
  assert.equal(matchesSessionStorageScope("favorites", { favorite: true, hidden: true }), false);

  for (const [membership, expected] of [
    [{ favorite: false, hidden: false }, "normal"],
    [{ favorite: false, hidden: false, category: "to_revise" }, "to_revise"],
    [{ favorite: true, hidden: false, category: "to_revise" }, "favorites"],
    [{ favorite: true, hidden: true, category: "completed" }, "hidden"],
  ]) {
    assert.equal(sessionStorageScopeFor(membership), expected);
    assert.equal(
      ["normal", "hidden", "favorites", "to_discuss", "to_revise", "completed"]
        .filter((scope) => matchesSessionStorageScope(scope, membership)).length,
      1,
    );
  }
});
