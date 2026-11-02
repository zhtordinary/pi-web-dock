import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const listRoute = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const detailRoute = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const contextRoute = await readFile(new URL("./[id]/context/route.ts", import.meta.url), "utf8");
const stateRoute = await readFile(new URL("./[id]/state/route.ts", import.meta.url), "utf8");
const stateRoot = await mkdtemp(join(tmpdir(), "reader-runtime-route-state-"));
process.env.PI_WEB_HIDDEN_FILE = join(stateRoot, "hidden.json");
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = stateRoot;
test.after(async () => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await rm(stateRoot, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET: getSessionDetail } = await jiti.import("./[id]/route.ts");
const { GET: getSessionState } = await jiti.import("./[id]/state/route.ts");
const { DELETE: deleteSession } = await jiti.import("./[id]/route.ts");
const { cacheSessionPath, invalidateSessionListCache, invalidateSessionPathCache } = await jiti.import("../../../lib/session-reader.ts");
const { getRunningRpcSessionIds } = await jiti.import("../../../lib/rpc-manager.ts");
const { getProjectIdentity } = await jiti.import("../../../lib/project-identity.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");

test("deleting an unpersisted session shuts down its runtime and invalidates caches", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-empty-"));
  const sessionDir = join(stateRoot, "sessions", "runtime");
  await mkdir(sessionDir, { recursive: true });
  const previousRegistry = globalThis.__piSessions;
  const ids = [];
  globalThis.__piSessions = new Map();
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    for (const id of ids) invalidateSessionPathCache(id);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  for (const persistOnShutdown of [false, true]) {
    const manager = SessionManager.create(dir, sessionDir);
    const id = manager.getSessionId();
    const filePath = manager.getSessionFile();
    ids.push(id);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
    let shutdownCalled = false;
    const childPath = join(sessionDir, `child-${id}.jsonl`);
    if (persistOnShutdown) {
      await writeFile(childPath, `${JSON.stringify({ type: "session", parentSession: filePath })}\n`);
    }
    globalThis.__piSessions.set(id, {
      isAlive: () => true,
      isRunning: () => !shutdownCalled,
      cwd: dir,
      sessionFile: filePath,
      sessionId: id,
      inner: { sessionManager: manager },
      shutdown: async () => {
        shutdownCalled = true;
        if (persistOnShutdown) await writeFile(filePath, JSON.stringify(manager.getHeader()));
        globalThis.__piSessions.delete(id);
      },
    });
    assert.ok(getRunningRpcSessionIds().includes(id));
    const response = await deleteSession(
      new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
      { params: Promise.resolve({ id }) },
    );

    const responseBody = await response.json();
    assert.equal(response.status, 200);
    assert.equal(responseBody.ok, true);
    assert.equal(responseBody.deleted, true);
    assert.equal(shutdownCalled, true);
    assert.equal(globalThis.__piSessions.has(id), false);
    assert.equal(globalThis.__piSessionPathCache.has(id), false);
    assert.equal([...globalThis.__piPathToSessionIdCache.values()].includes(id), false);
    assert.equal(getRunningRpcSessionIds().includes(id), false);
    await assert.rejects(readFile(filePath), { code: "ENOENT" });
    if (persistOnShutdown) {
      assert.equal(typeof responseBody.path, "string");
      assert.match(responseBody.path, /[\\/]deleted_sessions[\\/]/);
      await readFile(responseBody.path);
      const childHeader = await readFile(childPath, "utf8");
      assert.doesNotMatch(childHeader, new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      await rm(childPath, { force: true });
    } else {
      assert.equal(responseBody.path, undefined);
    }
  }
});

test("project-hidden live sessions can be deleted before first persistence", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-hidden-runtime-"));
  const previousRegistry = globalThis.__piSessions;
  const previousHiddenState = await readFile(process.env.PI_WEB_HIDDEN_FILE, "utf8").catch(() => null);
  const manager = SessionManager.create(dir, dir);
  const id = manager.getSessionId();
  const filePath = manager.getSessionFile();
  let shutdownCalled = false;
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    cwd: dir,
    sessionFile: filePath,
    sessionId: id,
    inner: { sessionManager: manager },
    shutdown: async () => { shutdownCalled = true; },
  }]]);
  await writeFile(process.env.PI_WEB_HIDDEN_FILE, JSON.stringify({
    sessions: [],
    projects: [getProjectIdentity(dir).key],
    devices: [],
    visibleSessions: [],
  }));
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousHiddenState === null) await rm(process.env.PI_WEB_HIDDEN_FILE, {force:true});
    else await writeFile(process.env.PI_WEB_HIDDEN_FILE, previousHiddenState);
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${id}`, { method: "DELETE" }),
    { params: Promise.resolve({ id }) },
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, deleted: true });
  assert.equal(shutdownCalled, true);
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});

test("session listing merges live registry snapshots and honors force refresh", () => {
  assert.match(listRoute, /searchParams\.get\("force"\) === "1"/);
  assert.match(listRoute, /listAllSessions\(\{ force \}\)/);
  assert.match(listRoute, /attachSessionProjectInfo\(getRpcSessionInfos\(\)\)/);
  assert.match(listRoute, /mergeSessionLists\(persistedSessions, runtimeSessions\)/);
  assert.match(listRoute, /"Cache-Control": "no-store"/);
});

test("detail reads require durable JSONL while the legacy context route keeps its live contract", () => {
  const detailGet = detailRoute.slice(detailRoute.indexOf("export async function GET"), detailRoute.indexOf("export async function PATCH"));
  assert.match(detailGet, /resolveSessionPathReadOnly\(id\)/);
  assert.match(detailGet, /getSessionReadSnapshot\(resolvedPath\)/);
  assert.doesNotMatch(detailGet, /getRpcSession|ensureQuestionAnalysisJobsForSession|startRpcSession/);
  const liveLookup = contextRoute.indexOf("getRpcSession(id)");
  const pathLookup = contextRoute.indexOf("resolveSessionPath(id)");
  assert.ok(liveLookup >= 0);
  assert.ok(pathLookup > liveLookup);
  assert.match(contextRoute, /liveRpc\?\.inner\.sessionManager \?\? (?:readSnapshot!\.manager|SessionManager\.open)/);
});

test("live agent state is available before the session file is persisted", () => {
  const liveLookup = stateRoute.indexOf("getRpcSession(id)");
  const liveRead = stateRoute.indexOf("const live = await liveState()");
  const pathLookup = stateRoute.indexOf("resolveSessionPathReadOnly(id)");
  assert.ok(liveLookup >= 0 && liveRead > liveLookup);
  assert.ok(pathLookup > liveRead);
  assert.match(stateRoute, /if \(!rpc\?\.isAlive\(\)\) return null/);
  assert.match(stateRoute, /if \(live\) return live/);
  assert.doesNotMatch(stateRoute, /startRpcSession|SessionManager\.open/);
});

test("setup-only detail returns 404 without losing the live state route", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const id = "live-route-test";
  const timestamp = "2026-08-12T01:02:03.000Z";
  const sessionManager = {
    getHeader: () => ({ type: "session", id, cwd: "/tmp", timestamp }),
    getEntries: () => [],
    getLeafId: () => null,
    getTree: () => [],
    getSessionName: () => undefined,
    getSessionFile: () => `/tmp/pi-web-live-route-not-persisted-${process.pid}.jsonl`,
  };
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => true,
    inner: { sessionManager },
    sessionFile: sessionManager.getSessionFile(),
    sessionId: id,
    cwd: "/tmp",
    send: async () => ({ isStreaming: true }),
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
  });

  const routeContext = { params: Promise.resolve({ id }) };
  const detailResponse = await getSessionDetail(
    new Request(`http://localhost/api/sessions/${id}`),
    routeContext,
  );
  const stateResponse = await getSessionState(
    new Request(`http://localhost/api/sessions/${id}/state`),
    routeContext,
  );
  const detail = await detailResponse.json();

  assert.equal(detailResponse.status, 404);
  assert.deepEqual(detail, { error: "Session not found" });
  assert.equal(stateResponse.status, 200);
  assert.deepEqual(await stateResponse.json(), {
    running: true,
    source: "live",
    state: { isStreaming: true },
  });
});

test("detail ignores an alive old leaf and follows durable appends unless a branch is explicit", async t => {
  const dir = await mkdtemp(join(tmpdir(), "reader-detail-durable-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousRegistry = globalThis.__piSessions;
  const sessionId = "detail-durable";
  const sessionDir = join(dir, "sessions", "project");
  const path = join(sessionDir, `2026-01-01_${sessionId}.jsonl`);
  const timestamp = "2026-01-01T00:00:00.000Z";
  const header = { type: "session", version: 3, id: sessionId, timestamp, cwd: dir };
  const entry = (id, parentId) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content: id } });
  const old = entry("old", null);
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(sessionDir, { recursive: true });
  await writeFile(path, [header, old].map(value => JSON.stringify(value)).join("\n") + "\n");
  const manager = SessionManager.inMemory(dir, undefined, [header, old]);
  globalThis.__piSessions = new Map([[sessionId, {
    isAlive: () => true, inner: { sessionManager: manager }, sessionFile: path, sessionId, cwd: dir,
  }]]);
  t.after(async () => {
    globalThis.__piSessions = previousRegistry;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });
  const read = async query => {
    const response = await getSessionDetail(new Request(`http://localhost/api/sessions/${sessionId}?metadataOnly=1&${query}`), { params: Promise.resolve({ id: sessionId }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  assert.equal((await read("")).leafId, "old");
  await appendFile(path, JSON.stringify(entry("latest", "old")) + "\n");
  const latest = await read("");
  assert.equal(latest.leafId, "latest");
  assert.equal(latest.stats.totalMessages, 2);
  assert.equal((await read("leafId=old")).leafId, "old");
  assert.equal(manager.getLeafId(), "old", "reading cannot navigate or recreate the live manager");
});

test("deletes a session when its parent file is already missing", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-delete-missing-parent-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const sessionId = "delete-missing-parent";
  const projectDir = join(dir, "sessions", "project");
  const filePath = join(projectDir, `2026-01-01_${sessionId}.jsonl`);
  const missingParent = join(projectDir, "missing-parent.jsonl");
  process.env.PI_CODING_AGENT_DIR = dir;
  await mkdir(projectDir, { recursive: true });
  await writeFile(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: sessionId,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession: missingParent,
  })}\n`);
  cacheSessionPath(sessionId, filePath);
  invalidateSessionListCache();
  t.after(async () => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    invalidateSessionPathCache(sessionId);
    invalidateSessionListCache();
    await rm(dir, { recursive: true, force: true });
  });

  const response = await deleteSession(
    new Request(`http://localhost/api/sessions/${sessionId}`, { method: "DELETE" }),
    { params: Promise.resolve({ id: sessionId }) },
  );

  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.deleted, true);
  assert.match(body.path, /[\\/]deleted_sessions[\\/]/);
  await readFile(body.path);
  await assert.rejects(readFile(filePath), { code: "ENOENT" });
});
