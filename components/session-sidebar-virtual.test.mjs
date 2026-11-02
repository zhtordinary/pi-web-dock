import assert from "node:assert/strict";
import test from "node:test";
import { flattenBucketedSessionRows, flattenSessionTreeRows, getPinnedInteractionIds, getVirtualRowWindow } from "./session-sidebar-virtual.ts";

const node = (id, children = []) => ({ session: { id }, children });

test("flat rows preserve bucket, fork depth, and collapse semantics", () => {
  const rows = flattenBucketedSessionRows([
    { id: "project:one", label: "One", items: [], value: { id: "one" } },
  ], () => [node("root", [node("child")])]);
  assert.deepEqual(rows.map((row) => [row.kind, row.id, row.kind === "session" ? row.depth : row.collapsed]), [
    ["bucket", "project:one", false],
    ["session", "root", 0],
    ["session", "child", 1],
  ]);
  const collapsed = flattenSessionTreeRows([node("root", [node("child")])], new Set(["root"]));
  assert.deepEqual(collapsed.map((row) => row.id), ["root"]);
});

test("virtual window bounds mounting and pins selected interaction rows", () => {
  const rows = flattenSessionTreeRows(Array.from({ length: 100 }, (_, index) => node(`s-${index}`)));
  const window = getVirtualRowWindow(rows, 54 * 50, 54 * 4, 1, new Set(["s-2"]));
  assert.ok(window.indices.length < rows.length);
  assert.ok(window.indices.includes(2));
  assert.equal(window.totalHeight, 100 * 54);
});

test("large lists keep first, middle, and tail windows bounded with a fixed pin budget", () => {
  const rows = flattenSessionTreeRows(Array.from({ length: 10_000 }, (_, index) => node(`s-${index}`)));
  const active = getPinnedInteractionIds(Array.from({ length: 20 }, (_, index) => `s-${index}`));
  assert.equal(active.size, 8);
  for (const scrollTop of [0, 54 * 4_999, 54 * 9_999]) {
    const window = getVirtualRowWindow(rows, scrollTop, 54 * 6, 2, active);
    assert.ok(window.indices.length <= 6 + 4 + 2 + 8);
    assert.ok(window.indices.every((index) => index >= 0 && index < rows.length));
  }
});

test("collapsed fork descendants disappear while offsets remain deterministic", () => {
  const rows = flattenSessionTreeRows([
    node("root", [node("child", [node("grandchild")])]),
    node("sibling"),
  ], new Set(["root"]));
  const window = getVirtualRowWindow(rows, 0, 54 * 4, 0);
  assert.deepEqual(rows.map((row) => row.id), ["root", "sibling"]);
  assert.equal(window.totalHeight, 2 * 54);
  assert.deepEqual(window.indices, [0, 1]);
});
