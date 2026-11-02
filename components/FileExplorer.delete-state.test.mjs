import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const requestSource = source.slice(source.indexOf("  const handleRequestDelete = useCallback"), source.indexOf("  const handleRequestRename = useCallback"));
const deleteSource = source.slice(source.indexOf("  const handleDeleteConfirm = useCallback"), source.indexOf("  const deleteConfirmation: FileDeleteConfirmation"));

function harness() {
  const effects = [];
  const ctx = {
    useCallback: (fn) => fn, Error, cwd: "/repo", remotePeer: "mini",
    currentWorkspaceRef: { current: { cwd: "/repo", peer: "mini" } },
    pendingDelete: null, deleteRequestRef: { current: null },
    busy: false, error: null, refreshCount: 0,
    setPendingDelete: (target) => { ctx.pendingDelete = target; effects.push(["pending", target?.fullPath ?? null]); },
    setDeleteBusy: (busy) => { ctx.busy = busy; effects.push(["busy", busy]); },
    setDeleteError: (error) => { ctx.error = error; effects.push(["error", error]); },
    setTreeRefreshKey: (update) => { ctx.refreshCount = update(ctx.refreshCount); },
    movePathToTrash: async (path, peer) => { effects.push(["trash", path, peer]); },
    effects,
  };
  vm.runInNewContext(stripTypeScriptTypes(requestSource + deleteSource
    + "\nglobalThis.request = handleRequestDelete; globalThis.confirm = handleDeleteConfirm; globalThis.cancel = handleDeleteCancel;"), ctx);
  return ctx;
}
const node = { name: "notes", fullPath: "/repo/notes", isDir: true, size: 0 };

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

test("requesting or cancelling inline trash never deletes; confirmation uses the captured path and peer", async () => {
  const ctx = harness();
  ctx.request(node);
  assert.equal(ctx.effects.some(([kind]) => kind === "trash"), false);
  ctx.cancel();
  assert.equal(ctx.pendingDelete, null);
  assert.equal(ctx.effects.some(([kind]) => kind === "trash"), false);
  ctx.request(node);
  await ctx.confirm();
  assert.deepEqual(ctx.effects.filter(([kind]) => kind === "trash"), [["trash", "/repo/notes", "mini"]]);
  assert.equal(ctx.pendingDelete, null);
  assert.equal(ctx.busy, false);
  assert.equal(ctx.refreshCount, 1);
});

test("a double confirmation sends one request and failure stays at the original row for retry", async () => {
  const ctx = harness();
  const flight = deferred();
  let calls = 0;
  ctx.movePathToTrash = () => { calls += 1; return flight.promise; };
  ctx.request(node);
  const pending = ctx.confirm();
  await ctx.confirm();
  ctx.cancel();
  ctx.request({ ...node, fullPath: "/repo/other" });
  assert.equal(calls, 1);
  assert.equal(ctx.pendingDelete.fullPath, node.fullPath);
  assert.equal(ctx.busy, true);
  flight.reject(new Error("Access denied"));
  await pending;
  assert.equal(ctx.error, "Access denied");
  assert.equal(ctx.pendingDelete.fullPath, node.fullPath);
  assert.equal(ctx.busy, false);
  assert.equal(ctx.refreshCount, 0);
  ctx.movePathToTrash = async () => { calls += 1; };
  await ctx.confirm();
  assert.equal(calls, 2);
  assert.equal(ctx.pendingDelete, null);
  assert.equal(ctx.refreshCount, 1);
});

test("workspace switches reject old requests before trash begins", async () => {
  const ctx = harness();
  ctx.request(node);
  ctx.currentWorkspaceRef.current = { cwd: "/other", peer: "air" };
  await ctx.confirm();
  ctx.request({ ...node, fullPath: "/other/new" });
  assert.equal(ctx.effects.some(([kind]) => kind === "trash"), false);
  assert.equal(ctx.pendingDelete.fullPath, node.fullPath, "stale request callbacks cannot replace the target");
});

test("late trash success or failure cannot clear the new workspace confirmation", async () => {
  for (const succeeds of [true, false]) {
    const ctx = harness();
    const flight = deferred();
    ctx.movePathToTrash = () => flight.promise;
    ctx.request(node);
    const pending = ctx.confirm();
    const newTarget = { ...node, cwd: "/other", peer: "air", fullPath: "/other/new" };
    ctx.currentWorkspaceRef.current = { cwd: "/other", peer: "air" };
    ctx.deleteRequestRef.current = newTarget;
    ctx.pendingDelete = newTarget;
    ctx.error = "new error";
    const count = ctx.effects.length;
    if (succeeds) flight.resolve(); else flight.reject(new Error("old error"));
    await pending;
    assert.equal(ctx.effects.length, count);
    assert.equal(ctx.pendingDelete, newTarget);
    assert.equal(ctx.error, "new error");
    assert.equal(ctx.deleteRequestRef.current, newTarget);
    assert.equal(ctx.refreshCount, 0);
  }
  assert.match(source, /deleteRequestRef\.current = null;\s*setPendingDelete\(null\);\s*setDeleteError\(null\);\s*setDeleteBusy\(false\);/);
});
