import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sessionItemSource = source.slice(source.indexOf("function SessionItem("));

test("local unread storage follows other tabs without using filtered session lists", () => {
  const start = source.indexOf('const UNREAD_SESSIONS_STORAGE_KEY =');
  const end = source.indexOf('/**\n * Return all projects', start);
  assert.ok(start >= 0 && end > start);
  const helperSource = `${source.slice(start, end)}\nglobalThis.helpers = { loadUnreadSessionIds, watchUnreadSessionIds };`;
  const script = ts.transpileModule(helperSource, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const values = new Map();
  const localStorage = { getItem: (key) => values.get(key) ?? null };
  const listeners = new Set();
  const window = {
    localStorage,
    addEventListener: (type, listener) => { assert.equal(type, "storage"); listeners.add(listener); },
    removeEventListener: (type, listener) => { assert.equal(type, "storage"); listeners.delete(listener); },
  };
  const context = { window };
  runInNewContext(script, context);
  const changes = [];
  const stop = context.helpers.watchUnreadSessionIds((ids) => changes.push([...ids]));
  const emit = (key, area = localStorage) => { for (const listener of listeners) listener({ key, storageArea: area }); };
  const key = "pi-web:unread-session-ids";
  values.set(key, JSON.stringify(["active", "archived"]));
  emit(key);
  values.set(key, JSON.stringify(["archived"]));
  emit(key);
  values.set(key, "broken json");
  emit(key);
  values.set(key, JSON.stringify({ id: "not an array" }));
  emit(key);
  values.clear();
  emit(null);
  emit("another-key");
  emit(key, {});
  assert.deepEqual(changes, [["active", "archived"], ["archived"], [], [], []]);
  stop();
  assert.equal(listeners.size, 0);
  assert.doesNotMatch(source, /existingIds\.has\(id\)/);
  assert.match(source, /previous\.size === next\.size && \[\.\.\.previous\]\.every\(\(id\) => next\.has\(id\)\)/);
  assert.match(source, /externalUnreadUpdateRef\.current === unreadSessionIds/);
  assert.match(source, /onSessionDeleted=\{\(id\) => \{ handleSessionDeleted\(id\)/);
});

test("file-manager actions belong to Reader file menus and the file viewer", async () => {
  assert.doesNotMatch(source, /open-in-explorer|openInFileManager|FileManagerAvailability|fileManagerError|FolderOutput|toolbarControl/);
  const explorer = await readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(explorer, /toolbarControl/);
  for (const component of ["FileExplorer.tsx", "FileViewer.tsx"]) {
    const readerSource = await readFile(new URL(`./${component}`, import.meta.url), "utf8");
    assert.match(readerSource, /files\/reveal/);
    assert.match(readerSource, /files\.openInFolder/);
  }
  for (const removed of [
    "../app/api/open-in-explorer/route.ts",
    "../app/api/open-in-explorer/route.test.mjs",
    "../lib/open-in-file-manager.ts",
    "../lib/open-in-file-manager.test.mjs",
  ]) {
    await assert.rejects(access(new URL(removed, import.meta.url)), { code: "ENOENT" });
  }
});

test("context-injected sessions participate in sidebar lineage", () => {
  assert.match(source, /const parentId = lineageParentId\(s\)/);
});

test("search source labels render once and retain relative time", () => {
  const searchResult = source.slice(source.indexOf("function SearchResultItem("));
  assert.equal((searchResult.match(/searchLabels\.join/g) ?? []).length, 1);
  assert.match(searchResult, /relativeTime\(hit\.activityAt \?\? hit\.modified\)/);
});

test("context-injected sessions use the context icon without the fork glyph", () => {
  assert.match(sessionItemSource, /session\.contextSourceSessionId && \(\n/);
  assert.match(sessionItemSource, /session\.parentSessionId \|\| \(!session\.contextSourceSessionId && depth > 0\)/);
  assert.doesNotMatch(sessionItemSource, /session\.parentSessionId \|\| session\.contextSourceSessionId \|\|/);
});

test("only Shift+click bypasses session deletion confirmation", () => {
  assert.match(
    sessionItemSource,
    /const handleDeleteClick[\s\S]*?if \(e\.shiftKey\) \{\s*void performDelete\(\);\s*\} else \{\s*setConfirmDelete\(true\);/,
  );
});

test("does not register row-level session deletion shortcuts", () => {
  assert.doesNotMatch(sessionItemSource, /const handleKeyDown/);
  assert.doesNotMatch(sessionItemSource, /onKeyDown=\{handleKeyDown\}/);
  assert.doesNotMatch(sessionItemSource, /tabIndex=\{0\}/);
});

test("the shell owns running-session SSE and its bounded visible-tab fallback", () => {
  assert.match(appShell, /openReaderEventSource\(\["running"\]\)/);
  assert.doesNotMatch(appShell, /new EventSource\("\/api\/agent\/running\/events"\)/);
  assert.match(appShell, /fetch\("\/api\/agent\/running"/);
  assert.match(appShell, /RUNNING_SESSIONS_POLL_MS/);
  assert.match(appShell, /RUNNING_SESSIONS_POLL_TIMEOUT_MS/);
  assert.match(appShell, /signal: current.signal/);
  assert.match(appShell, /document\.addEventListener\("visibilitychange", onVisibilityChange\)/);
  assert.doesNotMatch(source, /fetch\("\/api\/agent\/running"/);
});

test("session visibility remains caller-controlled across reader transitions", () => {
  assert.match(source, /const sessionsOpen = controlledSessionsOpen \?\? internalSessionsOpen/);
  assert.doesNotMatch(source, /previousReaderModeRef/);
  assert.doesNotMatch(source, /if \(readerMode\) \{[\s\S]{0,180}setSessionsOpen/);
  assert.doesNotMatch(source, /setSessionsOpen\(false\)[\s\S]{0,120}setSessionsOpen\(true\)/);
});

test("raw session sidebar shares activity time and subproject visibility state", () => {
  assert.match(source, /useSharedActivityFilters/);
  assert.match(source, /session-runs\?scope=local/);
  assert.match(source, /lastActivityAt/);
  assert.match(source, /isWithinActivityTimeRange/);
  assert.match(source, /autoHideEmptySubprojects/);
  assert.match(source, /autoHiddenSubprojectIds/);
  assert.match(source, /filterSubprojectItems/);
  assert.match(source, /visibleFilteredSessions/);
});
test("coalesces sidebar activity reads without reusing completed cache", () => {
  assert.match(source, /import \{ clearSessionActivityCache, fetchSessionActivity \} from "@\/lib\/session-activity-fetch";/);
  assert.match(source, /const activityUrl = `\/api\/session-runs\?scope=local\$\{showArchived \? "&archived=1" : ""\}`;/);
  assert.match(source, /const body = await fetchSessionActivity<[\s\S]*?>\(activityUrl, \{ force: true \}\);/);
  assert.doesNotMatch(source, /const response = await fetch\(`\/api\/session-runs\?scope=local/);
});

test("the session sidebar and chat consume the same shell running-session set", () => {
  assert.match(source, /runningSessionIds: Set<string>/);
  assert.match(appShell, /runningSessionIds=\{runningSessionIds\}/);
  assert.match(appShell, /sessionRunning=\{Boolean\(selectedSession && runningSessionIds\.has\(selectedSession\.id\)\)\}/);
  assert.doesNotMatch(source, /setRunningSessionIds|onRunningSessionIdsChange/);
});

test("includes project activity counts in accessible labels", () => {
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.agentRunning"\)\} \(\$\{activity\.running\}\)`\}/,
  );
  assert.match(
    source,
    /aria-label=\{`\$\{t\("sidebar\.newSessionActivity"\)\} \(\$\{activity\.unread\}\)`\}/,
  );
});

test("does not persist an unchanged fallback title ending in whitespace", () => {
  assert.match(
    sessionItemSource,
    /const name = renameValue\.trim\(\);[\s\S]*?if \(renameValue === title \|\| name === \(session\.name \?\? ""\)\) return;/,
  );
});

test("offers the downstream context-menu hook only on a normal session row", () => {
  assert.match(sessionItemSource, /const handleContextMenu[\s\S]*?dispatchSessionRowContextMenu\(\{/);
  assert.match(
    sessionItemSource,
    /onContextMenu=\{confirmDelete \|\| renaming \? undefined : handleContextMenu\}/,
  );
});

test("manual and lifecycle refreshes bypass the server session-list cache", () => {
  assert.match(source, /force \? "\/api\/sessions\?force=1" : "\/api\/sessions"/);
  assert.match(source, /cache: "no-store"/);
  assert.match(source, /const previousShowArchivedRef = useRef\(showArchived\);/);
  assert.match(source, /const viewChanged = previousShowArchivedRef\.current !== showArchived;/);
  assert.match(source, /loadSessions\(isFirst \|\| viewChanged, !isFirst && !viewChanged\)/);
  assert.match(source, /onClick=\{handleRefreshSessions\}/);
  assert.match(source, /loadSessions\(false, true\);[\s\S]*?onBackgroundTaskDone/);
});

test("does not expose disk-backed actions for transient sessions", () => {
  assert.match(sessionItemSource, /if \(session\.transient\) return;/);
  assert.match(sessionItemSource, /\{hover\.hovered && !session\.transient && \(/);
});

test("archive action releases its busy state after a successful response", () => {
  const start = sessionItemSource.indexOf("const handleArchiveClick");
  const end = sessionItemSource.indexOf("const handleContextMenu", start);
  const archiveSource = sessionItemSource.slice(start, end);
  assert.match(
    archiveSource,
    /finally \{\s*setArchiving\(false\);\s*\}/,
  );
});

test("deleting a search result invalidates the active chat and checks the response", () => {
  const searchResultSource = source.slice(source.indexOf("function SearchResultItem("));
  assert.match(source, /<SearchResultItem[\s\S]*?onSessionDeleted=\{handleSessionDeleted\}/);
  assert.match(sessionItemSource, /const response = await fetch\([\s\S]*?assertSessionMutationOk\(response\)/);
  assert.match(searchResultSource, /await assertSessionMutationOk\(res\);[\s\S]*?onSessionDeleted\?\.\(hit\.id\)/);
});


test("Explorer visibility remains caller-controlled across reader transitions", () => {
  assert.ok(source.includes("controlledExplorerOpen?: boolean"));
  assert.ok(source.includes("const explorerOpen = controlledExplorerOpen ?? internalExplorerOpen;"));
  assert.ok(source.includes("onExplorerOpenChange?."));
  assert.doesNotMatch(source, /previousReaderModeRef/);
  assert.doesNotMatch(source, /if \(!previousReaderModeRef\.current && readerModeTransition\) setExplorerOpen\(true\);/);
  assert.doesNotMatch(source, /setExplorerOpen\(false\)/);
});

test("does not rehydrate controlled Explorer state on sidebar remount", () => {
  const start = source.indexOf("// Browser storage is unavailable during server rendering.");
  const end = source.indexOf("useEffect(() => watchUnreadSessionIds", start);
  assert.ok(start >= 0 && end > start);
  assert.match(source.slice(start, end), /if \(controlledExplorerOpen !== undefined\) return;/);
});


test("sidebar coalesces passive requests without swallowing forced freshness", () => {
  for (const [name, route] of [
    ["loadSessionActivityTimes", "/api/session-runs?scope=local"],
    ["loadSessions", "/api/sessions"],
  ]) {
    const block = source.slice(source.indexOf(`const ${name} = useCallback`), source.indexOf("  }, [", source.indexOf(`const ${name} = useCallback`)));
    assert.ok(block.includes("if (previous?.view === showArchived && !force) return previous.promise;"));
    assert.ok(block.includes("if (previous?.view === showArchived) await previous.promise;"));
    assert.ok(block.includes("currentArchiveViewRef.current !== showArchived"));
    assert.ok(block.includes(route));
  }
  assert.match(source, /const requestId = \+\+sessionLoadRequestRef\.current/);
  assert.match(source, /const requestId = \+\+activityLoadRequestRef\.current/);
  assert.match(source, /void loadSessionActivityTimes\(force\)/);
});

test("keeps session and search empty states behind their loading states", () => {
  assert.match(
    source,
    /loadSessions\(isFirst \|\| viewChanged, !isFirst && !viewChanged\)/,
  );
  assert.match(
    source,
    /!loading && !error && searchQuery\.trim\(\)\.length > 0 && !searchLoading && searchResults && visibleSearchResults\.length === 0/,
  );
});
