import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";
import { BranchNavigation } from "../lib/branch-navigation.ts";

const jiti = createJiti(import.meta.url, { fsCache: false });
const { TranscriptReader } = await jiti.import("../lib/transcript-reader.ts");
const { createHistoryProjection, readHistoryPage } = await jiti.import("../lib/session-history.ts");
const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const between = (start, end) => {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
};
const callbacks = between("  const loadContext = useCallback", "  const recoverBranchPosition")
  + between("  const navigateBranch = useCallback", "  const handleNavigate = useCallback");
const timestamp = "2026-10-27T00:00:00.000Z";
const message = (id, parentId, role) => ({
  type: "message", id, parentId, timestamp,
  message: role === "assistant"
    ? { role, content: [{ type: "text", text: id }], model: "test", provider: "test" }
    : { role, content: id },
});

async function fixture({ rejectBranchHistory = false } = {}) {
  const entries = [message("q1", null, "user"), message("a1", "q1", "assistant"),
    message("q2", "a1", "user"), message("a2", "q2", "assistant")];
  let runtimeLeaf = "a2";
  const branch = new BranchNavigation();
  branch.reset("local:s");
  branch.observeRuntime(runtimeLeaf);
  const reader = new TranscriptReader({ sessionId: "s", peer: null }, async (scope, request) => {
    if (rejectBranchHistory && scope.leafId === "a1") throw new Error("history unavailable");
    return readHistoryPage(createHistoryProjection(entries, {
      sessionId: "s", leafId: scope.leafId, currentLeafId: entries.at(-1).id,
    }), request);
  });
  await reader.reset();
  const context = {
    useCallback: fn => fn, URLSearchParams, AbortSignal, encodeURIComponent, reader,
    branchRef: { current: branch }, branchScopeRef: { current: "local:s" },
    sessionIdRef: { current: "s" }, remotePeerRef: { current: null },
    sessionHookMountedRef: { current: true }, sessionLoadGenerationRef: { current: 0 },
    sessionViewValidationPendingRef: { current: true },
    apiPath: path => path,
    fetch: async () => ({ ok: true, status: 200, json: async () => ({
      sessionId: "s", context: { messages: [], entryIds: [] }, tree: [],
    }) }),
    clearLoadedSessionView() {}, setQuestionAnalysisJobs() {}, setQuestionDraftViews() {},
    setData() {}, setActiveLeafId() {}, setError() {}, dispatch() {}, console,
    recoverBranchPosition: async () => false,
    sendAgentCommandR: async (_sid, command) => {
      assert.equal(command.type, "navigate_tree");
      runtimeLeaf = command.targetId;
      return { cancelled: false, leafId: runtimeLeaf };
    },
  };
  vm.runInNewContext(stripTypeScriptTypes(`${callbacks}\nglobalThis.navigateBranch = navigateBranch;`), context);
  return { context, branch, reader, entries, runtimeLeaf: () => runtimeLeaf };
}

test("repeating a fork at the current runtime leaf never reloads the file's unrelated tail", async t => {
  const f = await fixture();
  t.after(() => f.reader.dispose());
  assert.equal(await f.context.navigateBranch("s", "a1"), true);
  assert.equal(f.reader.getState().physicalScope.leafId, "a1");
  assert.equal(await f.context.navigateBranch("s", "a1"), true);
  assert.equal(f.runtimeLeaf(), "a1");
  assert.equal(f.reader.getState().physicalScope.leafId, "a1");
  assert.deepEqual(f.reader.getState().transcript.entryIds, ["q1", "a1"]);
  assert.equal(f.branch.state.phase, "current");
});

test("a failed branch history read cannot acknowledge the fork as writable", async t => {
  const f = await fixture({ rejectBranchHistory: true });
  t.after(() => f.reader.dispose());
  assert.equal(await f.context.navigateBranch("s", "a1"), false);
  assert.equal(f.branch.state.phase, "unknown");
  assert.equal(f.context.sessionViewValidationPendingRef.current, true);
});

test("a persisted new message can follow the selected branch without dropping its loaded history", async t => {
  const f = await fixture();
  t.after(() => f.reader.dispose());
  assert.equal(await f.context.navigateBranch("s", "a1"), true);
  f.entries.push(message("new-q", "a1", "user"));
  f.reader.followPersistedTail();
  await f.reader.reconcileTail();
  assert.equal(f.reader.getState().physicalScope.leafId, "new-q");
  assert.deepEqual(f.reader.getState().transcript.entryIds, ["q1", "a1", "new-q"]);
});
