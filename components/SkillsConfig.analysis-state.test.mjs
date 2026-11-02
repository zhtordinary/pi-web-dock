import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";

const source = readFileSync(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
const pollMerge = source.slice(source.indexOf("export function mergeSkillAnalysisPoll"), source.indexOf("export function SkillAnalysisStatus")).replace("export ", "");
const initialGet = source.slice(source.indexOf("void fetchAnalysisJob(request).then((job) => {") + "void fetchAnalysisJob(request).then(".length, source.indexOf("    return () => {", source.indexOf("void fetchAnalysisJob(request).then((job) => {"))).trim().replace(/\);$/, "");
const fetchJob = source.slice(source.indexOf("  const fetchAnalysisJob = useCallback"), source.indexOf("  const analysisJobId"));
const body = source.slice(source.indexOf("  const failedAnalysisSkills = useMemo"), source.indexOf("  const enableParentPlugin = useCallback"));
function fixture(options = {}) {
  const original = { cwd: "/repo-a", viewScope: "project", remotePeer: "mini" };
  const identityRef = { current: original };
  const job = { id: "old-job", status: "completed", failed: 1, failures: [{ filePath: "/skills/beta/SKILL.md" }, { filePath: "/removed/SKILL.md" }] };
  const state = { job, error: null, calls: [] };
  const context = {
    Error, Set, loading: false, analyzingSkills: false, analysisJob: job, analysisJobId: job.id,
    skills: [{ filePath: "/skills/alpha/SKILL.md" }, { filePath: "/skills/beta/SKILL.md" }], pendingAnalysisSkills: [],
    panelIdentity: original, panelIdentityRef: identityRef, analysisRequestRevisionRef: { current: 0 }, analysisSubmitRef: { current: null },
    useMemo: (fn) => fn(), useCallback: (fn) => fn,
    sameSkillsPanelIdentity: (left, right) => left === right,
    capturePanelRequest: () => ({ identity: identityRef.current }),
    isCurrentPanelRequest: (request) => request.identity === identityRef.current,
    window: { confirm: () => true }, t: (key) => key,
    apiFor: (peer, endpoint) => `${peer}/${endpoint}`,
    setAnalysisJob: (value) => { state.job = typeof value === "function" ? value(state.job) : value; },
    cancelled: false, request: { identity: original }, loadSkills: () => {},
    setAnalysisStartError: (value) => { state.error = value; },
    fetch: async (url, init) => { state.calls.push({ url, body: JSON.parse(init.body) }); return { ok: true, json: async () => ({ job: { id: "retry-job" } }) }; },
    ...options,
  };
  const api = vm.runInNewContext(stripTypeScriptTypes(`${pollMerge}\n${fetchJob}\n${body}\n({ analyzeSkills, failedAnalysisSkills, fetchAnalysisJob, mergeSkillAnalysisPoll, initialGet: ${initialGet} })`), context);
  return { ...api, state, identityRef, context };
}

test("retry submits only known failed skills to the original device and project scope", async () => {
  const f = fixture();
  await f.analyzeSkills(f.failedAnalysisSkills);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.calls)), [{ url: "mini/skills/analyze", body: { cwd: "/repo-a", scope: "project", filePaths: ["/skills/beta/SKILL.md"] } }]);
  assert.equal(f.state.job.id, "retry-job");
});

test("a stale panel callback cannot submit an old target list into a new project", async () => {
  const f = fixture();
  f.identityRef.current = { cwd: "/repo-b", viewScope: "global", remotePeer: "air" };
  await f.analyzeSkills(f.failedAnalysisSkills);
  assert.equal(f.state.calls.length, 0);
  assert.equal(f.state.job.id, "old-job");
});

test("a late retry response cannot overwrite the new panel job", async () => {
  let release;
  const f = fixture({ fetch: () => new Promise((resolve) => { release = resolve; }) });
  const pending = f.analyzeSkills(f.failedAnalysisSkills);
  f.identityRef.current = { cwd: "/repo-b", viewScope: "global", remotePeer: "air" };
  f.state.job = { id: "new-panel-job" };
  release({ ok: true, json: async () => ({ job: { id: "late-old-job" } }) });
  await pending;
  assert.equal(f.state.job.id, "new-panel-job");
});

test("transport failure keeps real results and reports a separate request error", async () => {
  const f = fixture({ fetch: async () => { throw new Error("network unavailable"); } });
  await f.analyzeSkills(f.failedAnalysisSkills);
  assert.equal(f.state.job.id, "old-job");
  assert.equal(f.state.job.failed, 1);
  assert.equal(f.state.error, "network unavailable");
});


test("a late initial GET cannot replace a new POST job or clear it with null", async () => {
  const f = fixture();
  await f.analyzeSkills(f.failedAnalysisSkills);
  f.initialGet({ id: "old-get-job", completed: 0 });
  assert.equal(f.state.job.id, "retry-job");
  f.initialGet(null);
  assert.equal(f.state.job.id, "retry-job");
});

test("overlapping polls cannot replace a newer job, reduce completed progress, or reopen a terminal job", () => {
  const { mergeSkillAnalysisPoll } = fixture();
  const current = { id: "b", status: "completed", completed: 3 };
  assert.equal(mergeSkillAnalysisPoll(current, { id: "a", status: "running", completed: 0 }, "a"), current);
  assert.equal(mergeSkillAnalysisPoll(current, { id: "b", status: "running", completed: 3 }, "b"), current);
  assert.equal(mergeSkillAnalysisPoll(current, { id: "b", status: "completed", completed: 2 }, "b"), current);
  const next = { id: "c", status: "running", completed: 0 };
  assert.equal(mergeSkillAnalysisPoll(current, next, "b"), next);
});


test("a slow POST response cannot roll back progress already observed by polling", async () => {
  let release;
  const f = fixture({ fetch: () => new Promise((resolve) => { release = resolve; }) });
  const pending = f.analyzeSkills(f.failedAnalysisSkills);
  f.state.job = { id: "retry-job", status: "running", completed: 2 };
  release({ ok: true, json: async () => ({ job: { id: "retry-job", status: "running", completed: 0 } }) });
  await pending;
  assert.equal(f.state.job.completed, 2);
});


test("an initial GET arriving while the first POST is pending cannot capture tracking of the new job", async () => {
  let releaseGet, releasePost;
  const f = fixture({ analysisJob: null, analysisJobId: undefined, fetch: (_url, init) => new Promise((resolve) => { if (init.method === "POST") releasePost = resolve; else releaseGet = resolve; }) });
  f.state.job = null;
  const get = f.fetchAnalysisJob();
  const post = f.analyzeSkills([f.context.skills[1]]);
  releaseGet({ ok: true, json: async () => ({ job: { id: "old-a", completed: 1 } }) });
  f.initialGet(await get);
  assert.equal(f.state.job, null);
  releasePost({ ok: true, json: async () => ({ job: { id: "new-b", status: "running", completed: 0 } }) });
  await post;
  assert.equal(f.state.job.id, "new-b");
});

test("one in-flight start prevents duplicate model work and releases for a later explicit retry", async () => {
  const replies = [];
  const f = fixture({ fetch: () => new Promise((resolve) => replies.push(resolve)) });
  const first = f.analyzeSkills(f.failedAnalysisSkills);
  await f.analyzeSkills(f.failedAnalysisSkills);
  assert.equal(replies.length, 1);
  replies[0]({ ok: true, json: async () => ({ job: { id: "newer", status: "completed", completed: 1 } }) });
  await first;
  assert.equal(f.state.job.id, "newer");
  const retry = f.analyzeSkills(f.failedAnalysisSkills);
  assert.equal(replies.length, 2);
  replies[1]({ ok: true, json: async () => ({ job: { id: "retry", status: "completed", completed: 1 } }) });
  await retry;
  assert.equal(f.state.job.id, "retry");
});
