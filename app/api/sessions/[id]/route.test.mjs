import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("live session rename uses RPC write admission", () => {
  assert.match(routeSource, /live\.send\(\{ type: "set_session_name"/);
  assert.match(routeSource, /SessionManager\.open\(filePath\)/);
});

test("a cold session rename takes the same physical ownership a runtime does", () => {
  // Writing a transcript without the runtime lock lets a starting Reader
  // append a different leaf, so one of the two names is silently lost.
  assert.match(routeSource, /acquireSessionRuntimeOwnership\(filePath\)/);
  assert.match(routeSource, /ownership\.release\(\)/);
  assert.match(routeSource, /code === "session_runtime_owned"/);
  assert.match(routeSource, /status: 409/);
  // Imported lazily so a metadata-only GET never loads runtime machinery.
  assert.doesNotMatch(routeSource, /^import .*session-runtime-ownership/m);
  assert.match(routeSource, /await import\("@\/lib\/session-runtime-ownership"\)/);
});

test("an empty name is rejected on both rename paths", () => {
  assert.match(routeSource, /const trimmedName = name\.trim\(\)/);
  assert.match(routeSource, /Session name cannot be empty/);
  assert.match(routeSource, /name: trimmedName/);
});

test("a shutting-down runtime is awaited before the rename falls back to disk", () => {
  assert.match(routeSource, /live\.isShuttingDown\?\.\(\)\) await live\.waitUntilDisposed\?\.\(\)/);
});

test("session detail projects Reader context source without treating it as a fork", () => {
  assert.match(routeSource, /parentSessionId,/);
  assert.match(routeSource, /contextSourceSessionId: \(header as unknown as ReaderSessionHeader \| null\)\?\.contextSourceSessionId/);
});

test("delete refuses direct lifecycle mutation of a persisted subagent", () => {
  assert.match(routeSource, /resolvePiSubagentBundleRoot\(filePath, getPiSessionRoots\(\)\)/);
  assert.match(routeSource, /session_child_lifecycle_requires_parent/);
  assert.match(routeSource, /delete the parent session instead/);
});

test("delete moves the complete session bundle into TokenMonitor deleted_sessions", () => {
  assert.match(routeSource, /movePiSessionToDeleted\(persistedPath, reparentedChildren\)/);
  assert.match(routeSource, /setTokenMonitorDeletedFlag\(deletedPath, true\)/);
  assert.doesNotMatch(routeSource, /deletePiSessionTree\(filePath, reparentedChildren\)/);
  assert.doesNotMatch(routeSource, /writeFileSync/);
  assert.match(routeSource, /originalContent: content/);
  assert.match(routeSource, /nextContent: lines\.join/);
});


test("session deletion writes its assignment cleanup locally", () => {
  assert.match(routeSource, /mutateSessionAssignment/);
  assert.match(routeSource, /assignSession\(projectKey, sessionId, subprojectId\)/);
  assert.match(routeSource, /unassignSession\(sessionId, projectKey\)/);
});
