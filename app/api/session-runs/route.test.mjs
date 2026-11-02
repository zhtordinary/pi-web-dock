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
const activityStart = source.indexOf("function sessionActivity(");
const activityEnd = source.indexOf("const archivedAncestorParentCache", activityStart);
const start = source.indexOf("async function buildLocalResponse(");
const end = source.indexOf("// Peers are fetched on demand", start);
assert.ok(activityStart >= 0 && activityEnd > activityStart && start >= 0 && end > start, "activity response implementation must be present");
const code = ts.transpileModule(`${source.slice(activityStart, activityEnd)}\n${source.slice(start, end)}\nglobalThis.build = buildLocalResponse;`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture({ initialFavorites = ["a"], finalFavorites = initialFavorites, initialReadError = false, finalReadError = false, hidden = [], hiddenProjects = [], visibleSessions = [], hiddenReadError = false, categories = { to_discuss: [], to_revise: [], completed: [] }, parents = {}, running = [], knownProjects = [], unstableList = false } = {}) {
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
    getWaitingForUserRpcSessionIds: () => [], getWaitingForUserRequests: () => [],
    getSubagentActivityForSessions: (items) => { subagentInputs.push(Array.from(items, (item) => item.id)); return new Map(); },
    getRpcSession: (id) => running.includes(id) ? {
      isStreaming: true, isPromptRunning: true, getExecutionState: () => ({ active: true, queuedCount: 1 }),
      getUnattendedConfigured: () => false, getSchedulerState: () => null, isRetryInFlight: () => false, isUserPromptActive: () => true,
    } : undefined,
    getPersistedUnattendedState: () => null,
    projectSessionRuns: () => ({ runs: [], currentActivity: null }), shouldShowRetryingStatus: () => false,
    JUST_COMPLETED_MS: 300_000,
    sessionStorageScopeFor, isHiddenInState, isSessionStorageCategory,
    listKnownProjects: () => knownProjects.map((path) => ({ path, addedAt: "2026-01-01T00:00:00Z" })),
    peekProject: (path) => { knownProjectReads.push(path); return { isGit: false }; }, projectIdentityKey: (value) => value,
    getProjectIdentity: (value) => ({ key: "project", label: value }), listSubprojects: () => [], listSubprojectSortSettings: () => [],
  };
  vm.runInNewContext(code, ctx);
  return { build: ctx.build, reads, subagentInputs, restoredInputs, listCalls, supplementaryProjects, knownProjectReads, get observations() { return observations; } };
}

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
