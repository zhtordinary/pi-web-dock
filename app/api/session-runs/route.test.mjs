import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";
import { isHiddenInState } from "../../../lib/hidden-state.ts";
import { readCatalogMetadata } from "../../../lib/catalog-metadata.ts";
import { filterSessionsByCategory, sessionCategoryFromState } from "../../../lib/session-category-state.ts";
import { isSessionStorageCategory, sessionStorageScopeFor } from "../../../lib/session-storage-scope.ts";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const chatWindowSource = await readFile(new URL("../../../components/ChatWindow.tsx", import.meta.url), "utf8");
const stopRouteSource = await readFile(new URL("../sessions/[id]/stop/route.ts", import.meta.url), "utf8");
const activityStart = source.indexOf("function sessionActivity(");
const activityEnd = source.indexOf("const archivedAncestorParentCache", activityStart);
const start = source.indexOf("async function buildLocalResponse(");
const end = source.indexOf("// Peers are fetched on demand", start);
assert.ok(activityStart >= 0 && activityEnd > activityStart && start >= 0 && end > start, "activity response implementation must be present");
const code = ts.transpileModule(`${source.slice(activityStart, activityEnd)}\n${source.slice(start, end)}\nglobalThis.build = buildLocalResponse;\nglobalThis.project = sessionActivity;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ initialFavorites = ["a"], finalFavorites = initialFavorites, initialReadError = false, finalReadError = false, hidden = [], hiddenProjects = [], visibleSessions = [], hiddenReadError = false, categories = { to_discuss: [], to_revise: [], completed: [] }, parents = {}, running = [], waiting = [], retrying = [], knownProjects = [], unstableList = false } = {}) {
  const sessions = ["a", "b", "c"].map((id) => ({ id, path: `/fixture/${id}`, cwd: "/project", modified: "2026-01-01T00:00:00Z", ...(parents[id] ? { parentSessionId: parents[id] } : {}) }));
  const reads = [], subagentInputs = [], restoredInputs = [], listCalls = [], supplementaryProjects = [], knownProjectReads = [];
  let observations = 0, favoriteReads = 0, listVersion = 0;
  const list = async (archived, options) => {
    const projectIds = options.projectSessionIds && Array.from(options.projectSessionIds);
    listCalls.push({ archived, force: options.force, readOnly: options.readOnly, projectIds });
    return sessions.map((session) => ({ ...session, projectKey: !projectIds || projectIds.includes(session.id) ? "project" : `unresolved:${session.id}` }));
  };
  const ctx = {
    readConfig: () => ({}), localDevice: () => ({ id: "local" }),
    listAllSessions: (options) => list(false, options), listArchivedSessions: (options) => list(true, options), getSessionListVersion: () => listVersion,
    attachSessionProjectInfo: async (items) => {
      supplementaryProjects.push(Array.from(items, (item) => item.id));
      return items.map((item) => ({ ...item, projectKey: "project", isGit: true }));
    },
    applySubprojectAssignments: (items) => items.map((item) => ({ ...item, subprojectId: item.projectKey === "project" ? "subproject" : undefined })),
    lineageParentId: (session) => session.parentSessionId,
    resolveNearestLineageAncestorAsync: async () => undefined, getStoredParentSessionId: async () => undefined,
    readFavoriteState: () => {
      favoriteReads += 1;
      if ((favoriteReads === 1 && initialReadError) || (favoriteReads > 1 && finalReadError)) throw new Error("unreadable favorites");
      return { sessions: favoriteReads === 1 ? initialFavorites : finalFavorites };
    },
    sessionMetadata: async (session) => { reads.push(session.id); return { modelName: `model-${session.id}` }; },
    readSiblingExecution: async () => { observations += 1; if (unstableList) listVersion += 1; return { execution: {}, complete: true }; },
    readCatalogMetadata,
    readHiddenState: () => {
      if (hiddenReadError) throw new Error("unreadable hidden state");
      return { sessions: hidden, projects: hiddenProjects, devices: [], visibleSessions };
    },
    readSessionCategoryState: () => categories, readViewedState: () => ({}),
    sessionCategoryFromState, filterSessionsByCategory,
    restorePersistedQuestionAnalysisJobs: (items) => { restoredInputs.push(Array.from(items, (item) => item.id)); },
    getSessionRunRecords: () => [], getRunningRpcSessionIds: () => running,
    getWaitingForUserRpcSessionIds: () => waiting, getWaitingForUserRequests: () => [],
    getSubagentActivityForSessions: (items) => { subagentInputs.push(Array.from(items, (item) => item.id)); return new Map(); },
    getRpcSession: (id) => running.includes(id) || retrying.includes(id) ? {
      isStreaming: running.includes(id), isPromptRunning: running.includes(id),
      getExecutionState: () => ({ active: true, parentActive: false, retrying: retrying.includes(id), unattended: false, backgroundRunIds: [], queuedCount: 1 }),
      getUnattendedConfigured: () => false, getSchedulerState: () => retrying.includes(id) ? { active: true } : null,
      isRetryInFlight: () => false, isUserPromptActive: () => running.includes(id),
    } : undefined,
    getPersistedUnattendedState: () => null,
    projectSessionRuns: (records, sessionId, active) => ({
      runs: records.filter((record) => record.sessionId === sessionId).sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 8),
      currentActivity: { active, runId: active ? records.find((record) => record.sessionId === sessionId && record.status === "running")?.runId ?? null : null },
    }), shouldShowRetryingStatus: (signals) => signals.schedulerActive && !signals.userPromptActive,
    JUST_COMPLETED_MS: 300_000,
    sessionStorageScopeFor, isHiddenInState, isSessionStorageCategory,
    listKnownProjects: () => knownProjects.map((path) => ({ path, addedAt: "2026-01-01T00:00:00Z" })),
    peekProject: (path) => { knownProjectReads.push(path); return { isGit: false }; }, projectIdentityKey: (value) => value,
    getProjectIdentity: (value) => ({ key: "project", label: value }), listSubprojects: () => [], listSubprojectSortSettings: () => [],
  };
  vm.runInNewContext(code, ctx);
  return { build: ctx.build, project: ctx.project, reads, subagentInputs, restoredInputs, listCalls, supplementaryProjects, knownProjectReads, running, waiting, retrying, get observations() { return observations; } };
}

function projectedItem(f, {
  status = "completed",
  completedAgeMs = 60_000,
  subagentActivity,
  relationStatus,
  nowMs = Date.parse("2026-01-01T00:10:00.000Z"),
  records = "run",
} = {}) {
  const session = {
    id: "parent",
    path: "/fixture/parent",
    cwd: "/project",
    modified: "2026-01-01T00:00:00.000Z",
    messages: [{ role: "assistant", stopReason: "stop" }],
    ...(relationStatus ? { relation: { kind: "subagent", status: relationStatus } } : {}),
  };
  const completedAt = new Date(nowMs - completedAgeMs).toISOString();
  const run = { runId: "parent-run", sessionId: session.id, cwd: session.cwd, startedAt: "2026-01-01T00:00:00.000Z", updatedAt: completedAt, completedAt, status };
  const item = f.project(
    session,
    { id: "local", name: "Local" },
    records === "run" ? [run] : records,
    new Set(f.running),
    new Set(f.waiting),
    new Map(),
    subagentActivity,
    nowMs,
    new Set(),
    new Map(),
    { hasErrorTail: false },
  );
  return { item, run, session };
}

test("a completed parent run remains completed when child stop evidence arrives before or after it", () => {
  const f = fixture();
  const parent = projectedItem(f);
  assert.equal(parent.session.messages.at(-1)?.role, "assistant");
  assert.equal(parent.session.messages.at(-1)?.stopReason, "stop");
  const parentCompletedAt = Date.parse("2026-01-01T00:09:00.000Z");
  for (const terminalAt of [parentCompletedAt - 1_000, parentCompletedAt + 1_000]) {
    const { item, run } = projectedItem(f, {
      subagentActivity: { active: false, terminalState: "stopped", terminalAt },
    });
    assert.equal(item.status, "just_completed");
    assert.deepEqual(item.latestRun, run);
    assert.deepEqual(item.runs, [run]);
    assert.equal(item.subagentTerminalState, "stopped");
    assert.equal(item.subagentTerminalAt, terminalAt);
  }
  const stale = projectedItem(f, {
    completedAgeMs: 5 * 60 * 1000 + 1,
    subagentActivity: { active: false, terminalState: "stopped", terminalAt: parentCompletedAt + 1_000 },
  });
  assert.equal(stale.item.status, "idle");
  assert.equal(stale.item.latestRun.runId, "parent-run");
});

test("parent terminal outcomes stay authoritative while child abort relations remain additional facts", () => {
  const f = fixture();
  for (const status of ["aborted", "failed"]) {
    assert.equal(projectedItem(f, { status }).item.status, status);
  }
  for (const relationStatus of ["aborted", "interrupted"]) {
    const { item } = projectedItem(f, { relationStatus });
    assert.equal(item.status, "just_completed");
    assert.equal(item.latestRun.status, "completed");
  }
});

test("child terminal status is projected only when the session has no parent run", () => {
  const f = fixture();
  const stopped = projectedItem(f, {
    records: [],
    subagentActivity: { active: false, terminalState: "stopped", terminalAt: Date.parse("2026-01-01T00:09:00.000Z") },
  });
  assert.equal(stopped.item.status, "aborted");
  assert.equal(stopped.item.subagentTerminalState, "stopped");
  for (const relationStatus of ["aborted", "interrupted"]) {
    assert.equal(projectedItem(f, { records: [], relationStatus }).item.status, "aborted");
  }
});

test("terminal child observations override stale active relation statuses", () => {
  const f = fixture();
  for (const relationStatus of ["starting", "queued", "running"]) {
    const completed = projectedItem(f, {
      records: [],
      relationStatus,
      subagentActivity: { active: false, terminalState: "completed", terminalAt: Date.parse("2026-01-01T00:09:00.000Z") },
    });
    assert.equal(completed.item.status, "just_completed", relationStatus);
    assert.equal(completed.item.currentActivity.active, false, relationStatus);

    const stopped = projectedItem(f, {
      records: [],
      relationStatus,
      subagentActivity: { active: false, terminalState: "stopped", terminalAt: Date.parse("2026-01-01T00:09:00.000Z") },
    });
    assert.equal(stopped.item.status, "aborted", relationStatus);
    assert.equal(stopped.item.currentActivity.active, false, relationStatus);
  }
});

test("current activity, waiting user, and retrying outrank completed history", () => {
  assert.equal(projectedItem(fixture({ running: ["parent"] })).item.status, "running");
  assert.equal(projectedItem(fixture({ waiting: ["parent"] })).item.status, "waiting_user");
  assert.equal(projectedItem(fixture({ retrying: ["parent"] })).item.status, "retrying");
});

test("the ChatWindow Stop handler reaches the same session stop route and runtime", async () => {
  const stopRouteTree = ts.createSourceFile("stop-route.ts", stopRouteSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let postDeclaration;
  const findPost = (node) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === "POST") postDeclaration = node;
    if (!postDeclaration) ts.forEachChild(node, findPost);
  };
  findPost(stopRouteTree);
  assert.ok(postDeclaration, "the real session stop route must expose POST");
  const stopRouteCode = ts.transpileModule(`${postDeclaration.getText(stopRouteTree).replace(/^export\s+/, "")}\nglobalThis.__stopPost = POST;`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sessionId = "same-stop-session";
  const trace = [];
  const routeContext = {
    NextResponse: { json: (body, options = {}) => ({ ok: (options.status ?? 200) < 400, status: options.status ?? 200, json: async () => body }) },
    getRpcSession: (id) => {
      assert.equal(id, sessionId);
      return {
        isAlive: () => true,
        stopAllExecution: async () => {
          trace.push({ phase: "stopAllExecution", sessionId: id, submissionId: "old-submission" });
          return { stopped: true, state: { queuedCount: 2 }, errors: [] };
        },
      };
    },
    resolveSessionPathReadOnly: async () => null,
    getSessionBackgroundRunIds: () => [],
    controlSiblingSession: async (id, operation) => {
      trace.push({ phase: "paired-stop", sessionId: id, operation });
      return { stopped: true, queuedCount: 0, errors: [] };
    },
    hasJsonContentType: () => true,
    isApiRequestAllowed: () => true,
    URL,
  };
  vm.runInNewContext(stopRouteCode, routeContext);
  const stopPost = routeContext.__stopPost;
  const chatTree = ts.createSourceFile("ChatWindow.tsx", chatWindowSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let abortCallback;
  const findAbort = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(chatTree) === "handleAbortSession") {
      const initializer = node.initializer;
      abortCallback = ts.isCallExpression(initializer) ? initializer.arguments[0] : initializer;
    }
    if (!abortCallback) ts.forEachChild(node, findAbort);
  };
  findAbort(chatTree);
  assert.ok(abortCallback, "ChatWindow must expose the user Stop handler");
  const ui = [];
  const chatCode = ts.transpileModule(`(${abortCallback.getText(chatTree)})`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const handleStop = vm.runInNewContext(chatCode, {
    sessionIdForAbnormal: sessionId,
    stoppingExecution: false,
    executionScopeRef: { current: `local:${sessionId}` },
    remotePeer: null,
    stopAutoRetry: () => ui.push("stopAutoRetry"),
    setStoppingExecution: (value) => ui.push(["stopping", value]),
    apiPathForPeer: (_peer, path) => `/${path}`,
    fetch: async (url, options) => {
      const endpoint = new URL(url, "http://reader.test");
      const match = endpoint.pathname.match(/\/sessions\/([^/]+)\/stop$/);
      assert.ok(match, `unexpected stop endpoint: ${endpoint.pathname}`);
      assert.equal(options.method, "POST");
      assert.equal(options.headers["Content-Type"], "application/json");
      assert.equal(options.body, "{}");
      const id = decodeURIComponent(match[1]);
      trace.push({ phase: "stop-request", sessionId: id });
      return stopPost({ url: endpoint.href }, { params: Promise.resolve({ id }) });
    },
    latestUserMessageKey: "old-submission",
    abnormalUserMessageKeyRef: { current: null },
    setAbnormalRun: (value) => ui.push(["abnormal", value]),
    setExecution: (value) => ui.push(["execution", value]),
    setActivityActive: (value) => ui.push(["activity", value]),
    clearSessionActivityCache: (url) => ui.push(["clear-cache", url]),
    activityUrl: "/api/session-runs",
    addNotice: (notice) => ui.push(["notice", notice]),
    t: (key) => key,
    URL,
    encodeURIComponent,
  });
  await handleStop();
  assert.deepEqual(trace, [
    { phase: "stop-request", sessionId },
    { phase: "stopAllExecution", sessionId, submissionId: "old-submission" },
    { phase: "paired-stop", sessionId, operation: "stop" },
  ]);
  assert.ok(ui.some((entry) => entry[0] === "abnormal" && entry[1] === true));
  const notice = ui.find((entry) => entry[0] === "notice");
  assert.equal(notice?.[1]?.type, "warning", "a retained queue is reported as a warning, not a stop failure");
});

test("favorites activity reads histories only for candidates that can be returned", async () => {
  const f = fixture({ initialFavorites: ["a", "b"], hidden: ["b"] });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.reads, ["a", "b"]);
  assert.deepEqual(f.listCalls[0].projectIds, ["a", "b"]);
  assert.deepEqual(Array.from(result.sessions, (item) => item.session.id), ["a"]);
  assert.equal(result.sessions[0].modelName, "model-a");
  assert.equal(f.observations, 1);
});

test("favorites retain nonfavorite lineage, live state, and all-session background observation", async () => {
  const f = fixture({ initialFavorites: ["a"], parents: { a: "b" }, running: ["a", "c"], hidden: ["b"] });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.reads, ["a"]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].session.id, "a");
  assert.equal(result.sessions[0].session.parentSessionId, "b", "nonfavorite parent remains the lineage parent");
  assert.deepEqual(f.listCalls[0].projectIds, ["a"]);
  assert.equal(result.sessions[0].status, "running");
  assert.equal(result.sessions[0].execution.queuedCount, 1);
  assert.deepEqual(f.subagentInputs, [["a", "b", "c"]]);
  assert.deepEqual(f.restoredInputs, [["a", "b", "c"]]);
});

test("an empty favorites view does not read unrelated histories", async () => {
  const f = fixture({ initialFavorites: [] });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.reads, []);
  assert.deepEqual(f.listCalls[0].projectIds, []);
  assert.equal(result.sessions.length, 0);
});

test("a newly favorited session during observation is enriched before the runtime cut", async () => {
  const f = fixture({ initialFavorites: ["a"], finalFavorites: ["b"], knownProjects: ["project", "other"] });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.reads, ["a", "b"]);
  assert.deepEqual(f.listCalls[0].projectIds, ["a"]);
  assert.deepEqual(f.supplementaryProjects, [["b"]]);
  assert.deepEqual(Array.from(result.sessions, (item) => item.session.id), ["b"]);
  assert.equal(result.sessions[0].session.projectKey, "project");
  assert.equal(result.sessions[0].session.subprojectId, "subproject");
  assert.equal(result.sessions[0].modelName, "model-b");
  assert.deepEqual(f.knownProjectReads, ["project"]);
  assert.deepEqual(Array.from(result.knownProjects, (item) => item.path), ["project"]);
  assert.equal(f.observations, 2);
});

test("a failed initial favorites read starts with no projects and enriches the later catalog snapshot", async () => {
  const f = fixture({ initialReadError: true, finalFavorites: ["a"] });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.listCalls[0].projectIds, []);
  assert.deepEqual(f.supplementaryProjects, [["a"]]);
  assert.deepEqual(f.reads, ["a"]);
  assert.deepEqual(Array.from(result.sessions, (item) => item.session.id), ["a"]);
  assert.equal(result.sessions[0].session.projectKey, "project");
  assert.equal(result.metadataWarnings.length, 0);
});

test("unavailable favorite or hidden metadata preserves the catalog's fail-closed behavior", async () => {
  for (const options of [{ initialReadError: true, finalReadError: true }, { hiddenReadError: true }]) {
    const f = fixture(options);
    const result = await f.build(false, "favorites");
    assert.equal(result.sessions.length, 0);
    assert.equal(result.metadataWarnings[0].code, "metadata_unavailable");
    assert.equal(result.metadataWarnings[0].domain, options.hiddenReadError ? "hidden" : "favorites");
  }
});

test("favorite visibility honors hidden projects and explicit visible-session exceptions", async () => {
  const f = fixture({ initialFavorites: ["a", "b"], hiddenProjects: ["project"], visibleSessions: ["a"], categories: { to_discuss: ["a"], to_revise: [], completed: [] } });
  const result = await f.build(false, "favorites");
  assert.deepEqual(f.reads, ["a", "b"]);
  assert.deepEqual(Array.from(result.sessions, (item) => item.session.id), ["a"]);
  assert.equal(result.sessions[0].favorite, true);
  assert.equal(result.sessions[0].projectHidden, true);
  assert.equal(result.sessions[0].category, undefined, "favorites keep their existing precedence over categories");
});

test("selected projects work for active and archived read-only lists", async () => {
  for (const archived of [false, true]) {
    const f = fixture();
    await f.build(archived, "favorites", true, true);
    assert.deepEqual(f.listCalls, [{ archived, force: true, readOnly: true, projectIds: ["a"] }]);
  }
});

test("known projects are filtered by visibility and scope before Git inspection", async () => {
  for (const [scope, options, expected] of [
    ["favorites", {}, ["project"]],
    ["local", { hiddenProjects: ["other"] }, ["project"]],
    ["hidden", { hiddenProjects: ["other"] }, ["other"]],
    ["to_discuss", { initialFavorites: [], categories: { to_discuss: ["a"], to_revise: [], completed: [] } }, ["project"]],
    ["favorites", { hiddenReadError: true }, []],
  ]) {
    const f = fixture({ ...options, knownProjects: ["project", "other"] });
    const result = await f.build(false, scope);
    assert.deepEqual(f.knownProjectReads, expected, scope);
    assert.deepEqual(Array.from(result.knownProjects, (item) => item.path), expected, scope);
  }
});

test("a continually changing session list stops retrying instead of returning stale rows", async () => {
  const f = fixture({ unstableList: true });
  await assert.rejects(f.build(false, "favorites"), /Session activity changed while loading; retry/);
  assert.equal(f.observations, 3);
});

test("other scopes and completion view keep full metadata enrichment", async () => {
  for (const [scope, completion] of [["local", false], ["hidden", false], ["favorites", true]]) {
    const f = fixture();
    await f.build(false, scope, false, false, completion);
    assert.deepEqual(f.reads, ["a", "b", "c"], `${scope}:${completion}`);
    assert.equal(f.listCalls[0].projectIds, undefined, `${scope}:${completion}`);
  }
});
