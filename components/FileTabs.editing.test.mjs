import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const tabBar = await readFile(new URL("./TabBar.tsx", import.meta.url), "utf8");

test("switching preserves dirty drafts while keyboard replacement guards unsaved edits", () => {
  const selectStart = appShell.indexOf("const handleSelectFileTab");
  const selectEnd = appShell.indexOf("const handleCloseFileTab", selectStart);
  assert.ok(selectStart >= 0 && selectEnd > selectStart);
  const selectBlock = appShell.slice(selectStart, selectEnd);
  assert.doesNotMatch(selectBlock, /confirmDiscardFileChanges|clearFileTabDirty/);
  assert.match(appShell, /files\.unsavedChangesConfirm/);
  assert.match(appShell, /files\.closeAllUnsavedConfirm/);
  assert.match(appShell, /onDirtyChange=\{\(dirty\) => handleFileViewerDirtyChange/);
  assert.match(appShell, /initialState=\{activeFileTab\.viewerState\}/);

  const openStart = appShell.indexOf("const handleOpenFile");
  const openEnd = appShell.indexOf("const enterReaderMode", openStart);
  assert.ok(openStart >= 0 && openEnd > openStart);
  const openBlock = appShell.slice(openStart, openEnd);
  assert.match(openBlock, /options\?\.reuseActiveTab/);
  assert.match(openBlock, /confirmDiscardFileChanges/);
});

test("dirty tabs expose unsaved state", () => {
  assert.match(tabBar, /dirty\?: boolean/);
  assert.match(tabBar, /files\.unsavedChanges/);
  assert.match(tabBar, /tab\.dirty &&/);
});
