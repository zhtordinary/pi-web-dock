import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const history = await jiti.import("./session-history.ts");
const cache = await jiti.import("./session-read-cache.ts");
const http = await jiti.import("./session-history-http.ts");
const reader = await jiti.import("./session-reader.ts");
const stats = await jiti.import("./session-stats.ts");
const projectTree = await jiti.import("./project-tree.ts");
const revision = await jiti.import("./session-revision.ts");
const fastMode = await jiti.import("./fast-mode.ts");
const sessionControlDisplay = await jiti.import("./session-control-display.ts");
const sessionTiming = await jiti.import("./session-timing.ts");
const stamp = "2026-01-01T00:00:00.000Z";
const row = (id, parentId) => ({ type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: `question ${id}` } });
const line = value => JSON.stringify(value) + "\n";
function load(url, mocks) {
  const mod = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(readFileSync(url, "utf8"), {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(name => {
    assert.ok(name in mocks, `unexpected dependency: ${name}`);
    return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-durable-source-"));
  const path = join(root, "synthetic.jsonl");
  const header = { type: "session", version: 3, id: "synthetic", timestamp: stamp, cwd: root };
  writeFileSync(path, line(header) + line(row("old", null)));
  const old = cache.getSessionReadSnapshot(path);
  let starts = 0;
  const rpc = {
    getRpcSession: () => ({ isAlive: () => true, sessionFile: path, inner: { sessionManager: old.manager } }),
    ensureQuestionAnalysisJobsForSession: async () => { starts += 1; },
  };
  const resolveSessionPath = async () => path;
  const { loadSessionHistoryProjection } = load(new URL("./session-history-source.ts", import.meta.url), {
    "./rpc-manager": rpc,
    "./session-reader": { resolveSessionPath, resolveSessionPathReadOnly: resolveSessionPath },
    "./session-read-cache": cache,
    "./session-history": history,
  });
  t.after(() => { cache.invalidateSessionReadCache(); rmSync(root, { recursive: true, force: true }); });
  return { path, old, rpc, resolveSessionPath, loadSessionHistoryProjection, starts: () => starts, contextLeaf: null };
}

test("history window, index and search follow disk appends despite an alive stale runtime", async t => {
  const f = fixture(t);
  const get = http.createHistoryGet(f.loadSessionHistoryProjection);
  const call = async query => {
    const response = await get(new Request(`http://synthetic/history?${query}`), { params: Promise.resolve({ id: "synthetic" }) });
    assert.equal(response.status, 200);
    return response.json();
  };
  await call("mode=window");
  appendFileSync(f.path, line(row("latest", "old")));
  for (const query of ["mode=window", "mode=index", "mode=search&q=latest"]) {
    const body = await call(query);
    assert.equal(body.leafId, "latest", query);
    assert.ok(JSON.stringify(body).includes("latest"), query);
  }
  const explicit = await f.loadSessionHistoryProjection("synthetic", "old");
  assert.equal(explicit.leafId, "old", "explicit branch preview remains pinned");
  assert.equal(f.old.leafId, "old");
});

test("metadata reads the same durable leaf and never resumes jobs or starts a runtime", async t => {
  const f = fixture(t);
  appendFileSync(f.path, line(row("latest", "old")));
  const { GET } = load(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    fs: {}, path: {}, "@earendil-works/pi-coding-agent": {},
    "@/lib/session-reader": { ...reader, resolveSessionPath: f.resolveSessionPath, resolveSessionPathReadOnly: f.resolveSessionPath },
    "@/lib/session-read-cache": cache,
    "@/lib/rpc-manager": f.rpc,
    "@/lib/session-stats": stats,
    "@/lib/project-tree": projectTree,
    "@/lib/session-revision": revision,
    "@/lib/fast-mode": fastMode,
    "@/lib/session-control-display": sessionControlDisplay,
    "@/lib/session-timing.server": { loadSessionTiming: async ({ branch, entries }) => ({ branchEntries: branch.length, allEntries: entries.length }) },
    "@/lib/session-timing": sessionTiming,
    "@/lib/session-context-usage": { readSessionContextUsageFromFile: async (_path, leafId) => { f.contextLeaf = leafId; return null; } },
    ...Object.fromEntries(["session-path", "billing", "activity-events", "session-caches", "hidden-state", "favorite-state", "session-category-state", "session-archive", "session-child-tree", "subproject-state", "reader-safe-history"].map(name => [`@/lib/${name}`, {}])),
  });
  const response = await GET(new Request("http://synthetic/session?metadataOnly=1"), { params: Promise.resolve({ id: "synthetic" }) });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.leafId, "latest");
  assert.equal(body.stats.totalMessages, 2);
  assert.equal(f.contextLeaf, "latest", "metadata context usage follows the requested leaf");
  assert.deepEqual(body.timing, { branchEntries: 2, allEntries: 2 }, "metadata carries the viewed branch's timing without a runtime");
  const oldResponse = await GET(new Request("http://synthetic/session?metadataOnly=1&leafId=old"), { params: Promise.resolve({ id: "synthetic" }) });
  const oldBody = await oldResponse.json();
  assert.equal(f.contextLeaf, "old", "metadata context usage follows branch previews");
  assert.deepEqual(oldBody.timing, { branchEntries: 1, allEntries: 2 }, "branch timing also receives later entries for resume boundaries");
  assert.equal(f.starts(), 0, "GET cannot call the job-restoration startup path");
});

test("setup-only sessions without a durable file do not fall back to runtime memory", async () => {
  const { loadSessionHistoryProjection } = load(new URL("./session-history-source.ts", import.meta.url), {
    "./rpc-manager": { getRpcSession: () => ({ isAlive: () => true, inner: { sessionManager: { getEntries: () => [], getLeafId: () => null } } }) },
    "./session-reader": { resolveSessionPath: async () => null, resolveSessionPathReadOnly: async () => null },
    "./session-read-cache": cache,
    "./session-history": history,
  });
  await assert.rejects(loadSessionHistoryProjection("setup-only"), error => error.status === 404);
});
