import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";

// Use the production pure projection helpers; only persisted state is mocked.
const { filterSessionsByCategory, sessionCategoryFromState } = await createJiti(import.meta.url)
  .import("../../../../lib/session-category-state.ts");
const { isSessionStorageCategory, sessionStorageScopeFor } = await createJiti(import.meta.url)
  .import("../../../../lib/session-storage-scope.ts");
import {readCatalogMetadata} from "../../../../lib/catalog-metadata.ts";
import {projectSessionRuns} from "../../../../lib/session-run-projection.ts";
const { isHiddenInState } = await createJiti(import.meta.url).import("../../../../lib/hidden-state.ts");

const base = new URL("../../session-runs/route.ts", import.meta.url);
const source = await readFile(base, "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;

function fixture({ versioned = false, failedMetadata, withProject = false, sessions = [], hiddenSessions = [], hiddenProjects = [], favoriteSessions = [], peerSessions = [], categories = { to_discuss: [], to_revise: [], completed: [] }, siblingExecution = { execution: {}, complete: true } } = {}) {
  let runtimeSeq = 0;
  let restores = 0;
  const listOptions = [];
  const fetches = [];
  let peerSafe = true;
  let peerCompletionView = true;
  const emptyState = () => ({ sessions: [], projects: [], devices: [], visibleSessions: [] });
  const dependencies = {
    "@/lib/catalog-metadata": {readCatalogMetadata},
    "@/lib/session-channel-control": { readSiblingExecution: async () => siblingExecution },
    "node:crypto": {createHash: () => ({update(){return this},digest(){return "fixture"}})},
    "@/lib/activity-events": {activityCursor: () => ({bootId:"fixture",seq:runtimeSeq})},
    "node:fs": { existsSync: () => false }, "node:os": { hostname: () => "local" },
    "node:path": { join: (...parts) => parts.join("/") },
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/session-run-projection": {projectSessionRuns},
    "@/lib/activity-peers": { readActivityConfig: () => ({device:{id:"local"},peers:[{id:"peer",name:"peer",url:"http://peer"}]}), localDeviceIdentity: () => ({id:"local",name:"local",online:true}), configuredPeerList: config => config.peers },
    "@/lib/session-reader": {
      listAllSessions: async (options) => { listOptions.push(options); if (versioned) { await Promise.resolve(); runtimeSeq = 3; } return sessions; },
      listArchivedSessions: async (options) => { listOptions.push(options); if (versioned) { await Promise.resolve(); runtimeSeq = 3; } return sessions; },
      getSessionListVersion: () => 0,
      resolveSessionPath: async () => undefined,
      readSessionHeader: () => null,
      resolveSessionIdByPath: async () => undefined,
    },
    "@/lib/session-lineage": {
      lineageParentId: () => undefined,
      resolveNearestLineageAncestorAsync: async () => undefined,
    },
    "@/lib/rpc-manager": { restorePersistedQuestionAnalysisJobs: () => { restores += 1; },
      getRpcSession: () => undefined, getRunningRpcSessionIds: () => [], getWaitingForUserRpcSessionIds: () => [], getWaitingForUserRequests: () => [] },
    "@/lib/project-identity": {projectIdentityKey:p=>p, getProjectIdentity:p=>({key:p,label:p})}, "@/lib/worktree": { peekProject: () => ({ isGit: false }) }, "@/lib/known-projects": { listKnownProjects: () => withProject ? [{path:"/private",addedAt:"fixture"}] : [] },
    "@/lib/session-activity": { getSessionRunRecords: () => [], getPersistedUnattendedState: () => undefined }, "@/lib/session-activity-status": { shouldShowRetryingStatus: () => false },
    "@/lib/subagent-activity": { getSubagentActivityForSessions: () => new Map() },
    "@/lib/hidden-state": { isHiddenInState, readHiddenState: () => {if(failedMetadata === "hidden")throw new Error("corrupt hidden");return {...emptyState(), sessions: hiddenSessions, projects: hiddenProjects}} }, "@/lib/favorite-state": { readFavoriteState: () => {if(failedMetadata === "favorites")throw new Error("corrupt favorites");return {...emptyState(), sessions: favoriteSessions}} },
    "@/lib/viewed-state": { readViewedState: () => ({}) },
    "@/lib/subproject-state": { applySubprojectAssignments: (sessions) => sessions, listSubprojects: () => [], listSubprojectSortSettings: () => [] },
    "@/lib/session-category-state": { filterSessionsByCategory, sessionCategoryFromState, readSessionCategoryState: () => categories },
    "@/lib/session-storage-scope": { isSessionStorageCategory, sessionStorageScopeFor },
    "@/lib/session-recap": {}, "@/lib/user-question": {}, "@/lib/perf": { startServerPerf: () => null }, "@/lib/session-caches": { readSessionMetadata: () => ({ fetchedAt: Date.now() }) },
  };
  const fixtureModule = { exports: {} };
  const fakeFetch = async (url) => {
    fetches.push(url);
    if (versioned) runtimeSeq = 99;
    return Response.json({ schemaVersion: 1, sessions: peerSessions, ...(new URL(url).searchParams.get("view") === "completion" && peerCompletionView ? { view: "completion" } : {}), ...(versioned ? { device: {id: "peer"}, snapshotVersions: {peer: {runtime: {bootId:"peer-boot",seq:7},domains:{catalog:"peer-catalog"}}} } : {}), ...(peerSafe ? { observation: {
      schemaVersion: 1, readOnly: true, runtimeStartAttempted: false, writeSideEffects: false,
    } } : {}) });
  };
  const fakeProcess = { env: { PI_WEB_SESSION_ACTIVITY_CONFIG: JSON.stringify({ device: { id: "local" }, peers: [{ id: "peer", name: "peer", url: "http://peer" }] }) } };
  new Function("require", "module", "exports", "fetch", "process", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  }, fixtureModule, fixtureModule.exports, fakeFetch, fakeProcess);
  return { GET: fixtureModule.exports.GET, restores: () => restores, fetches, listOptions, unsafePeer: () => { peerSafe = false; }, legacyCompletionPeer: () => { peerCompletionView = false; } };
}

test("owner-scoped project hiding includes newly discovered sessions and distinguishes individual hides", async () => {
  const sessions = [
    { id: "new", cwd: "/private" },
    { id: "independent", cwd: "/other" },
    { id: "public", cwd: "/public" },
  ].map(session => ({ ...session, path: "/fixture/" + session.id + ".jsonl", modified: "2026-10-24T00:00:00Z" }));
  const f = fixture({ sessions, withProject: true, hiddenProjects: ["/private"], hiddenSessions: ["independent"] });
  const hidden = await (await f.GET(new Request("http://localhost/api/session-runs?scope=hidden&local=1&observeOnly=1"))).json();
  assert.deepEqual(hidden.sessions.map(item => item.session.id).sort(), ["independent", "new"]);
  assert.equal(hidden.sessions.find(item => item.session.id === "new").projectHidden, true);
  assert.equal(hidden.sessions.find(item => item.session.id === "independent").projectHidden, false);
  assert.equal(hidden.knownProjects[0].hidden, true);
  const visible = await (await f.GET(new Request("http://localhost/api/session-runs?scope=local&observeOnly=1"))).json();
  assert.deepEqual(visible.sessions.map(item => item.session.id), ["public"]);
  assert.deepEqual(visible.knownProjects, []);
});

test("observe-only catalog suppresses pending analysis restoration locally and at peers", async () => {
  const f = fixture();
  const response = await f.GET(new Request("http://localhost/api/session-runs?observeOnly=1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.ok(Array.isArray(body.devices));
  assert.ok(Array.isArray(body.sessions));
  assert.equal(f.restores(), 0);
  assert.equal(f.listOptions[0].readOnly, true);
  assert.equal(body.observation.readOnly, true);
  assert.equal(body.devices.find((d) => d.id === "peer").online, true);
  assert.match(f.fetches[0], /\/api\/reader\/session-catalog\?/);
  // Normal UI requests preserve the existing restoration behavior and cannot
  // reuse an observe-only peer response from the cache.
  const activityResponse = await f.GET(new Request("http://localhost/api/session-runs"));
  assert.equal(activityResponse.status, 200);
  assert.equal(f.restores(), 1);
  assert.equal(f.listOptions[1].readOnly, undefined);
  assert.equal(f.fetches.length, 2);
  assert.match(f.fetches[1], /\/api\/session-runs\?/);
});

test("legacy peer contract is incomplete and never retried through the unsafe route", async () => {
  const f = fixture(); f.unsafePeer();
  const response = await f.GET(new Request("http://localhost/api/session-runs?observeOnly=1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.schemaVersion, 1);
  assert.ok(Array.isArray(body.devices));
  assert.ok(Array.isArray(body.sessions));
  assert.equal(body.devices.find((d) => d.id === "peer").online, false);
  assert.equal(f.fetches.length, 1);
  assert.equal(f.restores(), 0);
});
test("incomplete sibling execution keeps the catalog available and reports the unknown boundary", async () => {
  const f = fixture({ siblingExecution: { execution: {}, complete: false } });
  const response = await f.GET(new Request("http://localhost/api/session-runs?scope=local&observeOnly=1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.metadataWarnings, [{ deviceId: "local", domain: "execution", code: "execution_observation_incomplete" }]);
});

test("safe route forces observe-only and applies the existing request security policy", async () => {
  const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  const code = ts.transpileModule(routeSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const fixtureModule = { exports: {} }; let readUrl;
  new Function("require", "module", "exports", code)((name) => ({
    "next/server": { NextResponse: { json: (...args) => Response.json(...args) } },
    "@/lib/request-security": { isApiRequestAllowed: (request) => request.headers.get("host") === "localhost" },
    "@/app/api/session-runs/route": { GET: (request) => { readUrl = request.url; return Response.json({}); } },
  })[name], fixtureModule, fixtureModule.exports);
  assert.equal(fixtureModule.exports.GET(new Request("http://localhost/api/reader/session-catalog")).status, 403);
  assert.equal(readUrl, undefined);
  fixtureModule.exports.GET(new Request("http://localhost/api/reader/session-catalog?observeOnly=0", { headers: { host: "localhost" } }));
  assert.equal(new URL(readUrl).searchParams.get("observeOnly"), "1");
});


test("catalog does not compute or advertise unconsumed cross-domain snapshot hashes", async () => {
  const f = fixture({versioned:true});
  const body = await (await f.GET(new Request("http://localhost/api/session-runs?observeOnly=1"))).json();
  assert.equal(body.snapshotVersions,undefined);
  assert.deepEqual(body.metadataWarnings,[]);
});


test("catalog remains available with visible decorative errors but withholds projects when visibility is unknown", async () => {
 for(const failedMetadata of [undefined,"favorites","hidden"]){
  const f=fixture({failedMetadata,withProject:true});
  const response=await f.GET(new Request("http://localhost/api/session-runs?scope=local&observeOnly=1"));
  assert.equal(response.status,200);
  const body=await response.json();
  assert.equal(body.knownProjects.length,failedMetadata === "hidden" ? 0 : 1);
  assert.equal(body.metadataWarnings.length,failedMetadata ? 1 : 0);
  if(failedMetadata)assert.equal(body.metadataWarnings[0].domain,failedMetadata);
 }
});

test("real catalog route applies one category priority to overlapping persisted assignments", async () => {
  const sessions = ["overlap-discuss", "overlap-revise", "done", "ordinary"].map(id => ({
    id, path: `/fixture/${id}.jsonl`, cwd: "/fixture", modified: "2026-10-19T00:00:00.000Z",
  }));
  const categories = {
    to_discuss: ["overlap-discuss"],
    to_revise: ["overlap-discuss", "overlap-revise"],
    completed: ["overlap-discuss", "overlap-revise", "done"],
  };
  const f = fixture({ sessions, categories });
  const observed = [];
  for (const [scope, expectedId] of [["to_discuss", "overlap-discuss"], ["to_revise", "overlap-revise"], ["completed", "done"], ["local", "ordinary"]]) {
    const response = await f.GET(new Request(`http://localhost/api/session-runs?scope=${scope}&observeOnly=1`));
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.deepEqual(body.sessions.map(item => item.session.id), [expectedId], `${scope} must retain its canonical category`);
    assert.equal(body.sessions[0].category, scope === "local" ? undefined : scope);
    observed.push(...body.sessions.map(item => item.session.id));
  }
  assert.deepEqual(observed.sort(), sessions.map(session => session.id).sort(), "every session appears exactly once across the category scopes");
  assert.deepEqual(categories.to_discuss, ["overlap-discuss"], "read-only projection must not rewrite the persisted overlap");
  assert.equal(f.restores(), 0);
});


test("completion view observes all storage categories without changing sidebar ownership or restoring jobs", async () => {
  const sessions = ["ordinary", "hidden", "favorite", "discuss", "revise", "done"].map(id => ({
    id, path: `/fixture/${id}.jsonl`, cwd: "/fixture", modified: "2026-10-23T00:00:00Z",
  }));
  const f = fixture({ sessions, hiddenSessions: ["hidden"], favoriteSessions: ["favorite"],
    categories: { to_discuss: ["discuss"], to_revise: ["revise"], completed: ["done"] } });
  const completion = await (await f.GET(new Request("http://localhost/api/session-runs?scope=local&view=completion"))).json();
  assert.equal(completion.view, "completion");
  assert.equal(completion.observation.readOnly, true);
  assert.equal(f.listOptions[0].readOnly, true);
  assert.equal(f.restores(), 0);
  assert.deepEqual(completion.sessions.map(item => item.session.id).sort(), sessions.map(session => session.id).sort());
  for (const [scope, expected] of [["local", "ordinary"], ["hidden", "hidden"], ["favorites", "favorite"],
    ["to_discuss", "discuss"], ["to_revise", "revise"], ["completed", "done"]]) {
    const body = await (await f.GET(new Request(`http://localhost/api/session-runs?scope=${scope}&local=1&observeOnly=1`))).json();
    assert.equal(body.view, undefined);
    assert.deepEqual(body.sessions.map(item => item.session.id), [expected]);
  }
  assert.equal(f.restores(), 0);
});

test("completion view forwards its read-only proof to peers and refuses older incomplete projections", async () => {
  const peerItem = { session: { id: "remote-hidden" }, lastActivityAt: "2026-10-23T00:00:00Z" };
  const f = fixture({ peerSessions: [peerItem] });
  const response = await (await f.GET(new Request("http://localhost/api/session-runs?scope=all&view=completion"))).json();
  assert.equal(response.view, "completion");
  assert.equal(response.sessions[0].device.id, "peer");
  assert.equal(response.devices.find(device => device.id === "peer").online, true);
  assert.match(f.fetches[0], /\/api\/reader\/session-catalog\?scope=local/);
  assert.match(f.fetches[0], /view=completion/);
  assert.equal(f.restores(), 0);
  f.legacyCompletionPeer();
  const legacy = await (await f.GET(new Request("http://localhost/api/session-runs?scope=all&view=completion&refresh=1"))).json();
  assert.equal(legacy.devices.find(device => device.id === "peer").online, false);
  assert.deepEqual(legacy.sessions, []);
  assert.equal(f.fetches.length, 2, "no fallback to a mutating or category-filtered route");
});
