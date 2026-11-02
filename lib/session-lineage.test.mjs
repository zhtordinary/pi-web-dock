import assert from "node:assert/strict";
import test from "node:test";

let mod;
try {
  const { createJiti } = await import("jiti");
  mod = await createJiti(import.meta.url).import("./session-lineage.ts");
} catch {
  mod = await import("./session-lineage.ts");
}

const { lineageParentId, relatedSessionIds, resolveNearestLineageAncestor, resolveNearestLineageAncestorAsync } = mod;

function session(id, relation = {}) {
  return { id, ...relation };
}

test("relatedSessionIds groups fork and context-injected descendants transitively", () => {
  const sessions = [
    session("root"),
    session("fork", { parentSessionId: "root" }),
    session("injected", { contextSourceSessionId: "root" }),
    session("grandchild", { parentSessionId: "fork" }),
    session("unrelated"),
  ];

  assert.equal(lineageParentId(sessions[1]), "root");
  assert.equal(lineageParentId(sessions[2]), "root");
  assert.deepEqual(relatedSessionIds(sessions, "injected"), ["root", "fork", "injected", "grandchild"]);
  assert.deepEqual(relatedSessionIds(sessions, "root"), ["root", "fork", "injected", "grandchild"]);
  assert.deepEqual(relatedSessionIds(sessions, "unrelated"), ["unrelated"]);
});

test("relatedSessionIds terminates on cyclic relation metadata", () => {
  const sessions = [
    session("a", { parentSessionId: "b" }),
    session("b", { parentSessionId: "a" }),
    session("child", { parentSessionId: "a" }),
  ];

  assert.deepEqual(relatedSessionIds(sessions, "a"), ["a", "b", "child"]);
});

test("resolveNearestLineageAncestor resolves nearest ancestor in available set", () => {
  const parentMap = new Map([
    ["child", "middle"],
    ["middle", "parent"],
    ["parent", "root"],
  ]);
  const lookup = (id) => parentMap.get(id);

  // Directly available parent
  assert.equal(
    resolveNearestLineageAncestor("middle", lookup, (id) => id === "middle"),
    "middle",
  );

  // Intermediate node is missing; resolves to grandparent
  assert.equal(
    resolveNearestLineageAncestor("middle", lookup, (id) => id === "parent"),
    "parent",
  );

  // Middle and parent missing; resolves to root
  assert.equal(
    resolveNearestLineageAncestor("middle", lookup, (id) => id === "root"),
    "root",
  );

  // No ancestor available
  assert.equal(
    resolveNearestLineageAncestor("middle", lookup, (id) => id === "unrelated"),
    undefined,
  );

  // Cycle guard terminates safely
  const cyclicMap = new Map([
    ["x", "y"],
    ["y", "x"],
  ]);
  assert.equal(
    resolveNearestLineageAncestor("x", (id) => cyclicMap.get(id), (id) => id === "z"),
    undefined,
  );
});

test("resolveNearestLineageAncestorAsync resolves nearest ancestor with async lookup", async () => {
  const parentMap = new Map([
    ["child", "middle"],
    ["middle", "parent"],
    ["parent", "root"],
  ]);
  const asyncLookup = async (id) => {
    await Promise.resolve();
    return parentMap.get(id);
  };

  assert.equal(
    await resolveNearestLineageAncestorAsync("middle", asyncLookup, (id) => id === "root"),
    "root",
  );

  assert.equal(
    await resolveNearestLineageAncestorAsync("middle", asyncLookup, (id) => id === "parent"),
    "parent",
  );

  assert.equal(
    await resolveNearestLineageAncestorAsync("middle", asyncLookup, (id) => id === "not_found"),
    undefined,
  );
});
