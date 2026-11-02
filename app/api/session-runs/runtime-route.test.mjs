import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const home = await mkdtemp(join(tmpdir(), "pi-web-activity-route-"));
const agent = join(home, "agent");
const selectedProject = join(home, "selected-project");
const unrelatedProject = join(home, "unrelated-project");
const sessionsDir = join(agent, "sessions", "fixture");
const bin = join(home, "bin");
const gitCalls = join(home, "git-calls");
for (const directory of [selectedProject, unrelatedProject, sessionsDir, bin]) await mkdir(directory, { recursive: true });
for (const directory of [selectedProject, unrelatedProject]) await mkdir(join(directory, ".git"));
const fakeGit = join(bin, "git");
await writeFile(fakeGit, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$PI_TEST_GIT_CALLS"\nif [ -n "$PI_TEST_GIT_GATE" ]; then printf "started\\n" > "$PI_TEST_GIT_STARTED"; while [ ! -f "$PI_TEST_GIT_GATE" ]; do /bin/sleep 0.05; done; fi\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n');
await chmod(fakeGit, 0o755);
process.env.HOME = home;
process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
process.env.PI_TEST_GIT_CALLS = gitCalls;
process.env.PI_CODING_AGENT_DIR = agent;
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "fixture-local", name: "Fixture Local" }, peers: [] });
process.env.PI_WEB_SUBPROJECTS_FILE = join(home, "subprojects.json");
process.env.PI_WEB_HIDDEN_FILE = join(home, "hidden.json");
process.env.PI_WEB_FAVORITES_FILE = join(home, "favorites.json");
process.env.PI_WEB_SESSION_CATEGORIES_FILE = join(home, "categories.json");
process.env.PI_WEB_VIEWED_FILE = join(home, "viewed.json");
process.env.PI_WEB_PROJECTS_FILE = join(home, "projects.json");
delete process.env.PI_WEB_BOUND_PORT;
await writeFile(process.env.PI_WEB_FAVORITES_FILE, JSON.stringify({ sessions: ["selected"] }));
await writeFile(process.env.PI_WEB_PROJECTS_FILE, JSON.stringify({ projects: [selectedProject, unrelatedProject].map((path) => ({ path, addedAt: "2026-01-01T00:00:00Z" })) }));

const parentPath = join(sessionsDir, "2026-01-01_parent.jsonl");
const selectedPath = join(sessionsDir, "2026-01-02_selected.jsonl");
const header = (id, cwd, parentSession) => ({ type: "session", version: 3, id, cwd, parentSession, timestamp: "2026-01-01T00:00:00.000Z" });
const message = (id) => ({ type: "message", id: `${id}-message`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "fixture" } });
await writeFile(parentPath, `${JSON.stringify(header("parent", unrelatedProject))}\n${JSON.stringify(message("parent"))}\n`);
await writeFile(selectedPath, `${JSON.stringify(header("selected", selectedProject, parentPath))}\n${JSON.stringify(message("selected"))}\n`);

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { GET } = await jiti.import("./route.ts");
const { invalidateSessionListCache, updateSessionListCachesForMove } = await jiti.import("../../../lib/session-reader.ts");
const { invalidateProjectCache } = await jiti.import("../../../lib/worktree.ts");

test("favorites GET preserves lineage without resolving unrelated session or known-project Git", async () => {
  invalidateSessionListCache();
  const response = await GET(new Request("http://localhost/api/session-runs?scope=favorites&local=1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sessions.map((item) => item.session.id), ["selected"]);
  assert.equal(body.sessions[0].session.parentSessionId, "parent");
  assert.deepEqual(body.knownProjects.map((item) => item.path), [selectedProject]);
  const calls = (await readFile(gitCalls, "utf8")).trim().split("\n");
  assert.ok(calls.includes(selectedProject));
  assert.equal(calls.includes(unrelatedProject), false);
});

test("archived favorites use the same bounded project resolution", async () => {
  const archivedDir = join(agent, "archived_sessions", "fixture");
  await mkdir(archivedDir, { recursive: true });
  const parent = join(archivedDir, "2026-01-01_archived-parent.jsonl");
  const selected = join(archivedDir, "2026-01-02_archived-selected.jsonl");
  await writeFile(parent, `${JSON.stringify(header("archived-parent", unrelatedProject))}\n${JSON.stringify(message("archived-parent"))}\n`);
  await writeFile(selected, `${JSON.stringify(header("archived-selected", selectedProject, parent))}\n${JSON.stringify(message("archived-selected"))}\n`);
  await writeFile(process.env.PI_WEB_FAVORITES_FILE, JSON.stringify({ sessions: ["selected", "archived-selected"] }));
  invalidateSessionListCache();
  const response = await GET(new Request("http://localhost/api/session-runs?scope=favorites&local=1&archived=1"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.sessions.map((item) => item.session.id), ["archived-selected"]);
  assert.equal(body.sessions[0].session.parentSessionId, "archived-parent");
  assert.equal((await readFile(gitCalls, "utf8")).trim().split("\n").includes(unrelatedProject), false);
});

async function checkMoveDuringFavoriteEnrichment(t, archivedBefore) {
  const id = archivedBefore ? "race-restore" : "race-archive";
  const archivedDir = join(agent, "archived_sessions", "fixture");
  await mkdir(archivedDir, { recursive: true });
  const active = join(sessionsDir, `2026-01-03_${id}.jsonl`);
  const archived = join(archivedDir, `2026-01-03_${id}.jsonl`);
  const source = archivedBefore ? archived : active;
  const destination = archivedBefore ? active : archived;
  await writeFile(source, `${JSON.stringify(header(id, selectedProject))}\n${JSON.stringify(message(id))}\n`);
  await writeFile(process.env.PI_WEB_FAVORITES_FILE, JSON.stringify({ sessions: [] }));
  invalidateSessionListCache();
  invalidateProjectCache();

  const previousFetch = globalThis.fetch;
  const previousPort = process.env.PI_WEB_BOUND_PORT;
  const gate = join(home, `${id}-git-release`);
  const started = join(home, `${id}-git-started`);
  process.env.PI_TEST_GIT_GATE = gate;
  process.env.PI_TEST_GIT_STARTED = started;
  process.env.PI_WEB_BOUND_PORT = "30142";
  let releaseSibling;
  let markSibling;
  let siblingCalls = 0;
  const siblingReached = new Promise((resolve) => { markSibling = resolve; });
  const siblingGate = new Promise((resolve) => { releaseSibling = resolve; });
  globalThis.fetch = async () => {
    siblingCalls += 1;
    if (siblingCalls === 1) { markSibling(); await siblingGate; }
    return new Response(JSON.stringify({ protocol: 1, execution: {}, runningSessionIds: [] }), { status: 200 });
  };
  let request;
  t.after(async () => {
    releaseSibling();
    await writeFile(gate, "release\n");
    await request?.catch(() => {});
    globalThis.fetch = previousFetch;
    if (previousPort === undefined) delete process.env.PI_WEB_BOUND_PORT; else process.env.PI_WEB_BOUND_PORT = previousPort;
    delete process.env.PI_TEST_GIT_GATE;
    delete process.env.PI_TEST_GIT_STARTED;
  });
  request = GET(new Request(`http://localhost/api/session-runs?scope=favorites&local=1${archivedBefore ? "&archived=1" : ""}`));
  await siblingReached;
  await writeFile(process.env.PI_WEB_FAVORITES_FILE, JSON.stringify({ sessions: [id] }));
  releaseSibling();
  for (let attempt = 0; attempt < 100 && !existsSync(started); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(started), true, "new favorite project lookup must be in flight");
  await rename(source, destination);
  updateSessionListCachesForMove(id, source, destination, !archivedBefore);
  await writeFile(gate, "release\n");
  const response = await request;
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.sessions.some((item) => item.session.id === id), false);
}

test("a session archived during new-favorite enrichment is not returned as active", async (t) => {
  await checkMoveDuringFavoriteEnrichment(t, false);
});

test("a session restored during new-favorite enrichment is not returned as archived", async (t) => {
  await checkMoveDuringFavoriteEnrichment(t, true);
});

test.after(async () => {
  await rm(home, { recursive: true, force: true });
});
