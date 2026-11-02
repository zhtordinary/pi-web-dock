import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import ts from "typescript";

const directory = await mkdtemp(path.join(os.tmpdir(), "reader-project-visibility-"));
process.env.PI_WEB_HIDDEN_FILE = path.join(directory, "hidden.json");
process.env.PI_WEB_FAVORITES_FILE = path.join(directory, "favorites.json");
process.env.PI_WEB_SESSION_CATEGORIES_FILE = path.join(directory, "categories.json");
const hidden = await import("../../../lib/hidden-state.ts");
const { projectIdentityKey } = await import("../../../lib/project-identity.ts");
const favorites = await import("../../../lib/favorite-state.ts");
const categories = await import("../../../lib/session-category-state.ts");
const { sessionStorageScopeFor } = await import("../../../lib/session-storage-scope.ts");

function compile(source, dependencies) {
  const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const loaded = { exports: {} };
  new Function("require", "module", "exports", output)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), name);
    return dependencies[name];
  }, loaded, loaded.exports);
  return loaded.exports;
}
let scans = 0;
let activeSessions = [];
let archivedSessions = [];
let runtimeSessions = [];
let failScan = false;
const scanOptions = [];
const { POST, DELETE } = compile(await readFile(new URL("./route.ts", import.meta.url), "utf8"), {
  "next/server": { NextResponse: { json: Response.json } },
  "@/lib/hidden-state": hidden,
  "@/lib/favorite-state": favorites,
  "@/lib/session-category-state": categories,
  "@/lib/session-reader": {
    listAllSessions: async (options) => { scans += 1; scanOptions.push(options); if (failScan) throw new Error("scan failed"); return activeSessions; },
    listArchivedSessions: async (options) => { scans += 1; scanOptions.push(options); return archivedSessions; },
    attachSessionProjectInfo: async (sessions) => sessions,
  },
  "@/lib/rpc-manager": { getRpcSessionInfos: () => runtimeSessions },
  "@/lib/project-identity": { projectIdentityKey },
});
const filters = compile(await readFile(new URL("../../../lib/hidden-filter.ts", import.meta.url), "utf8"), {
  "./hidden-state": hidden,
  "./activity-peers": { localDeviceIdentity: () => ({ id: "local" }), readActivityConfig: () => ({}) },
});
const request = (kind, id) => new Request("http://localhost/api/hidden", {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id }),
});
const restore = (id) => DELETE(new Request(
  "http://localhost/api/hidden?kind=project&id=" + encodeURIComponent(id), { method: "DELETE" },
));

test.beforeEach(async () => {
  scans = 0;
  activeSessions = [];
  archivedSessions = [];
  runtimeSessions = [];
  failScan = false;
  scanOptions.length = 0;
  await Promise.all([process.env.PI_WEB_HIDDEN_FILE, process.env.PI_WEB_FAVORITES_FILE, process.env.PI_WEB_SESSION_CATEGORIES_FILE].map(file => rm(file, { force: true })));
});
test.after(() => rm(directory, { recursive: true, force: true }));

test("restoring a project restores all its sessions while preserving favorites and categories", async () => {
  favorites.setFavorite("favorite", true);
  categories.setSessionCategory("discuss", "to_discuss");
  categories.setSessionCategory("revise", "to_revise");
  categories.setSessionCategory("done", "completed");
  hidden.setHidden("session", "private", true);
  const files = [process.env.PI_WEB_FAVORITES_FILE, process.env.PI_WEB_SESSION_CATEGORIES_FILE];
  const before = await Promise.all(files.map(file => readFile(file, "utf8")));
  const items = ["ordinary", "favorite", "discuss", "revise", "done", "private"].map(id => ({ id, cwd: "/project" }));
  activeSessions = items;
  assert.equal((await POST(request("project", "/project"))).status, 200);
  assert.deepEqual(filters.filterHiddenSessions(items), []);
  assert.deepEqual(filters.selectHiddenSessions(items), items);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, "utf8"))), before);
  assert.equal(scans, 0, "project visibility does not enumerate or rewrite child sessions");

  assert.equal((await restore("/project")).status, 200);
  assert.deepEqual(filters.filterHiddenSessions(items), items);
  assert.deepEqual(filters.selectHiddenSessions(items), []);
  assert.equal(scans, 2);
  assert.deepEqual(scanOptions, [{ readOnly: true }, { readOnly: true }]);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, "utf8"))), before);
  assert.equal(sessionStorageScopeFor({ hidden: false, favorite: favorites.isFavorite("favorite") }), "favorites");
  assert.equal(categories.sessionCategory("discuss"), "to_discuss");
  assert.equal(categories.sessionCategory("revise"), "to_revise");
  assert.equal(categories.sessionCategory("done"), "completed");
  assert.deepEqual(hidden.readHiddenState().projects, []);
});

test("sessions created later inherit the persisted project hide, including checkout paths with a projectRoot", async () => {
  assert.equal((await POST(request("project", "/project"))).status, 200);
  globalThis.__piHiddenStateCache = undefined;
  const createdLater = [
    { id: "new", cwd: "/project" },
    { id: "checkout-new", cwd: "/project/.worktrees/task", projectRoot: "/project" },
  ];
  assert.deepEqual(filters.filterHiddenSessions(createdLater), []);
  assert.deepEqual(filters.selectHiddenSessions(createdLater), createdLater);
  assert.deepEqual(hidden.readHiddenState().sessions, [], "new sessions inherit; no snapshot or per-session stamping is needed");
  assert.equal(hidden.isHiddenInState({ sessions: [], projects: [], devices: [], visibleSessions: [] }, "other-device", "new", "/project"), false);
  assert.equal((await restore("/project")).status, 200);
  assert.deepEqual(filters.filterHiddenSessions(createdLater), createdLater);
});

test("restoring one project retains device hiding and other projects", async () => {
  hidden.setHidden("device", "local", true);
  hidden.setHidden("project", "/other", true);
  await POST(request("project", "/project"));
  assert.equal((await restore("/project")).status, 200);
  assert.deepEqual(hidden.readHiddenState().projects, ["/other"]);
  assert.equal(hidden.isHidden("local", "new", "/project"), true);
});

test("restore clears active, archived and live-only child hides but retains unrelated projects", async () => {
  activeSessions = [{ id: "active", cwd: "/project", subprojectId: "subproject" }];
  archivedSessions = [{ id: "archived", cwd: "/project", archived: true }];
  runtimeSessions = [{ id: "live", cwd: "/project/.worktrees/task", projectRoot: "/project", transient: true }];
  hidden.setHidden("project", "/project", true);
  hidden.setHidden("project", "/other", true);
  for (const id of ["active", "archived", "live", "unrelated"]) hidden.setHidden("session", id, true);
  assert.equal((await restore("/project")).status, 200);
  assert.deepEqual(hidden.readHiddenState().sessions, ["unrelated"]);
  assert.deepEqual(hidden.readHiddenState().projects, ["/other"]);
  assert.equal(archivedSessions[0].archived, true);
  assert.equal(runtimeSessions[0].transient, true);
  assert.deepEqual(filters.selectHiddenSessions([...activeSessions, ...archivedSessions, ...runtimeSessions]), []);
});

test("scan failure leaves the project and all child hides unchanged", async () => {
  hidden.setHidden("project", "/project", true);
  hidden.setHidden("session", "private", true);
  const before = hidden.readHiddenState();
  failScan = true;
  assert.equal((await restore("/project")).status, 500);
  assert.deepEqual(hidden.readHiddenState(), before);
});

test("invalid hide and restore requests leave state unchanged", async () => {
  hidden.setHidden("project", "/project", true);
  const before = hidden.readHiddenState();
  assert.equal((await POST(request("invalid", "/project"))).status, 400);
  assert.equal((await POST(request("project", " "))).status, 400);
  assert.equal((await DELETE(new Request("http://localhost/api/hidden?kind=project"))).status, 400);
  assert.deepEqual(hidden.readHiddenState(), before);
});
