import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const recovery = source.slice(source.indexOf("export async function ensureQuestionAnalysisJobsForSession"), source.indexOf("function promptTemplateInvocation"));
function fixture() {
  const starts = [], restored = [];
  const entries = new Map([["/pending", [{ status: "pending" }]], ["/running", [{ status: "running" }]], ["/completed", [{ status: "completed" }]], ["/empty", []]]);
  const compiled = ts.transpileModule(recovery, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  const live = new Map();
  new Function("require", "exports", "getRpcSession", "existsSync", "latestQuestionAnalysisJobs", "isResumableQuestionAnalysisJob", "getSessionReadSnapshot", "startRpcSession", compiled)(
    name => { assert.equal(name, "./session-reader"); return { listSessionSummaries: async () => [...entries.keys()].map(path => ({ id: path.slice(1), path })) }; },
    mod.exports, id => live.get(id), () => true, rows => rows, job => job.status === "pending", path => ({ entries: entries.get(path) }),
    async (id, file) => { starts.push([id, file]); },
  );
  return { ...mod.exports, starts, restored, entries, live };
}
test("process startup restores only persisted pending work once, never running/completed/unrelated sessions", async () => {
  const f = fixture(); await Promise.all([f.initializeQuestionAnalysisRuntime(), f.initializeQuestionAnalysisRuntime()]);
  assert.deepEqual(f.starts, [["pending", "/pending"]]); await f.initializeQuestionAnalysisRuntime(); assert.equal(f.starts.length, 1);
});
test("all legacy GET recovery helpers stay live-only and leave pending durable work untouched", async () => {
  const f = fixture(); const before = structuredClone([...f.entries]);
  await f.ensureQuestionAnalysisJobsForSession("pending", "/pending");
  await f.restorePersistedQuestionAnalysisJobs([{ id: "pending", path: "/pending" }]);
  assert.deepEqual(f.starts, []); assert.deepEqual([...f.entries], before);
  f.live.set("pending", { isAlive: () => true, inner: { sessionManager: { getEntries: () => f.entries.get("/pending") } }, restoreQuestionAnalysisJobs: jobs => f.restored.push(jobs) });
  await f.ensureQuestionAnalysisJobsForSession("pending"); assert.equal(f.restored.length, 1); assert.deepEqual(f.starts, []);
});
test("Node process instrumentation owns startup recovery; explicit runtime initialization restores its own pending jobs", async () => {
  const instrumentation = await readFile(new URL("../instrumentation-node.ts", import.meta.url), "utf8");
  assert.match(instrumentation, /initializeQuestionAnalysisRuntime\(\)/);
  const startup = source.slice(source.indexOf("export async function startRpcSession"));
  assert.match(startup, /wrapper\.restoreQuestionAnalysisJobs\(latestQuestionAnalysisJobs\(startupEntries\)\.filter\(isResumableQuestionAnalysisJob\)\)/);
  assert.ok(startup.indexOf("acquireSessionRuntimeOwnership(sessionFile)") < startup.indexOf("SessionManager.open(sessionFile"));
  assert.ok(startup.indexOf("acquireSessionRuntimeOwnership(sessionFile)") < startup.indexOf("createAgentSessionFromServices("));
});
