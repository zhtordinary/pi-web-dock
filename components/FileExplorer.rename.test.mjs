import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { captureRenameTarget, isRenameRequestCurrent, migrateRenamedPath } = await createJiti(import.meta.url)
  .import("./file-explorer-rename-state.ts");
const explorer = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const section = await readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");

test("file tree context menu exposes distinct file and folder rename actions", () => {
  assert.match(explorer, /onRequestRename/);
  assert.match(explorer, /files\.renameFolder/);
  assert.match(explorer, /files\.renameFile/);
  assert.match(explorer, /method: "PATCH"/);
  assert.match(explorer, /setTreeRefreshKey\(\(key\) => key \+ 1\)/);
});

test("rename keeps nested open tabs and the shared explorer callback in sync", () => {
  assert.match(explorer, /onPathRenamedRef\.current\?\.\(renameTarget\.path, nextPath, renameTarget\.isDir, renameTarget\.peer/);
  assert.match(section, /onPathRenamed\?:/);
  assert.match(section, /onPathRenamed=\{onPathRenamed\}/);
  assert.match(appShell, /handleExplorerPathRenamed/);
  assert.match(appShell, /tabPath\.startsWith\(`\$\{oldNormalized\}\/`\)/);
});

test("rename captures the workspace target and invalidates stale completion", () => {
  const confirmStart = explorer.indexOf("const handleRenameConfirm = useCallback");
  const confirmEnd = explorer.indexOf("const handleRenameCancel", confirmStart);
  assert.ok(confirmStart >= 0 && confirmEnd > confirmStart, "rename confirmation handler is present");
  const confirm = explorer.slice(confirmStart, confirmEnd);
  assert.match(confirm, /const renameTarget = captureRenameTarget\(cwd, remotePeer, pendingRename\.fullPath, pendingRename\.isDir\);/);
  assert.match(confirm, /renamePath\(renameTarget\.path, nextName, renameTarget\.peer\)/);
  assert.match(confirm, /isRenameRequestCurrent\(renameTarget, currentWorkspaceRef\.current, requestId, renameRequestRef\.current\)/);
  assert.match(explorer, /setPendingRename\(null\);[\s\S]*?setRenameValue\(""\);[\s\S]*?setRenameBusy\(false\);/);
});

test("in-flight rename completion is ignored after a workspace and peer switch", async () => {
  const target = captureRenameTarget("/workspace-a", "peer-a", "/workspace-a/old", true);
  let workspace = { cwd: target.cwd, peer: target.peer };
  let currentRequestId = 1;
  const requestId = currentRequestId;
  let resolveRename;
  const renameResult = new Promise((resolve) => {
    resolveRename = resolve;
  });
  let migratedPaths = [target.path, `${target.path}/note.md`, "/workspace-b/old/note.md"];
  const beforeSwitch = [...migratedPaths];
  let callbackPeer;
  let completionApplied = false;

  const completion = renameResult.then((nextPath) => {
    if (!isRenameRequestCurrent(target, workspace, requestId, currentRequestId)) return;
    migratedPaths = migratedPaths.map((value) => migrateRenamedPath(value, target, nextPath));
    callbackPeer = target.peer;
    completionApplied = true;
  });

  workspace = { cwd: "/workspace-b", peer: "peer-b" };
  currentRequestId += 1;
  resolveRename("/workspace-a/new");
  await completion;

  assert.deepEqual(migratedPaths, beforeSwitch);
  assert.equal(callbackPeer, undefined);
  assert.equal(completionApplied, false);
});
