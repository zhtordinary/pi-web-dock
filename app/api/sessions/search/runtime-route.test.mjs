import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const routeSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const fixtureHome = await mkdtemp(join(tmpdir(), "pi-web-search-route-home-"));
const agentDir = join(fixtureHome, ".pi");
const sessionsDir = join(agentDir, "sessions", "fixture-project");
const projectDir = join(fixtureHome, "project");
process.env.HOME = fixtureHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({
  device: { id: "fixture-local", name: "Fixture Local" },
  peers: [{ id: "offline-peer", name: "Offline Peer", url: "http://offline.fixture.invalid" }],
});
process.env.PI_WEB_SUBPROJECTS_FILE = join(fixtureHome, "subprojects.json");
process.env.PI_WEB_HIDDEN_FILE = join(fixtureHome, "hidden.json");
process.env.PI_WEB_FAVORITES_FILE = join(fixtureHome, "favorites.json");
process.env.PI_WEB_SESSION_CATEGORIES_FILE = join(fixtureHome, "session-categories.json");
await mkdir(sessionsDir, { recursive: true });
await mkdir(projectDir, { recursive: true });

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { GET } = await jiti.import("./route.ts");
const { invalidateSessionListCache } = await jiti.import("../../../../lib/session-reader.ts");
const { resetSessionCategoryStateForTests, setSessionCategory } = await jiti.import("../../../../lib/session-category-state.ts");
const { sessionSearchResultMatchesFilter } = await jiti.import("../../../../lib/types.ts");

async function writeSession({ id, name, body, modified = "2026-10-01T00:00:00.000Z" }) {
  const filePath = join(sessionsDir, `${id}.jsonl`);
  const header = { type: "session", version: 3, id, timestamp: modified, cwd: projectDir };
  const info = { type: "session_info", id: `${id}-info`, parentId: null, timestamp: modified, name };
  const message = { type: "message", id: `${id}-message`, parentId: null, timestamp: modified, message: { role: "user", content: body } };
  await writeFile(filePath, `${JSON.stringify(header)}\n${JSON.stringify(info)}\n${JSON.stringify(message)}\n`);
}

async function search(q, extra = "") {
  invalidateSessionListCache();
  const response = await GET(new Request(`http://localhost/api/sessions/search?q=${encodeURIComponent(q)}&scope=local&local=1${extra}`));
  assert.equal(response.status, 200);
  return (await response.json()).sessions;
}

await writeSession({ id: "dual-session-001", name: "dual-session-001 title", body: "dual-session-001 body" });
await writeSession({ id: "id-only-001", name: "unrelated title", body: "unrelated body" });
await writeSession({ id: "title-only-001", name: "needle-title", body: "body without that term" });
await writeSession({ id: "cap-term-target-001", name: "cap-term title", body: "cap-term body" });
for (let index = 0; index < 55; index += 1) {
  await writeSession({ id: `cap-body-${index}`, name: `cap body ${index}`, body: "cap-term" });
}

test("GET merges ID, title, and body sources for one session", async () => {
  const [hit] = await search("dual-session-001");
  assert.ok(hit);
  assert.equal(hit.id, "dual-session-001");
  assert.equal(hit.idMatch, true);
  assert.ok(hit.contentMatchCount > 0);
  assert.ok((hit.titleMatchCount ?? 0) > 0);
  assert.ok(hit.matchCount >= hit.contentMatchCount + (hit.titleMatchCount ?? 0));
  assert.ok(hit.snippets.some((snippet) => snippet.includes("title:")));
  assert.equal(sessionSearchResultMatchesFilter(hit, "all"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "content"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "title"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "id"), true);
});

test("GET keeps ID-only and title-only sources distinct", async () => {
  const [idOnly] = await search("id-only-001");
  assert.ok(idOnly);
  assert.equal(idOnly.idMatch, true);
  assert.equal(idOnly.matchCount, 0);
  assert.equal(idOnly.contentMatchCount, 0);
  assert.equal(idOnly.titleMatchCount, 0);
  assert.equal(sessionSearchResultMatchesFilter(idOnly, "id"), true);
  assert.equal(sessionSearchResultMatchesFilter(idOnly, "title"), false);

  const [titleOnly] = await search("needle-title");
  assert.ok(titleOnly);
  assert.equal(titleOnly.idMatch, false);
  assert.equal(titleOnly.contentMatchCount, 0);
  assert.ok((titleOnly.titleMatchCount ?? 0) > 0);
  assert.equal(sessionSearchResultMatchesFilter(titleOnly, "title"), true);
  assert.equal(sessionSearchResultMatchesFilter(titleOnly, "content"), false);
});

test("catalog ID priority survives a same-query fifty-result cap with bounded file scans", async () => {
  let active = 0;
  let peak = 0;
  globalThis.__piSearchScanFlight = (delta) => {
    active += delta;
    peak = Math.max(peak, active);
  };
  let results;
  try {
    results = await search("cap-term");
  } finally {
    delete globalThis.__piSearchScanFlight;
  }
  assert.equal(peak <= 8, true, `scan pool peak=${peak}`);
  assert.equal(results.length, 50);
  const target = results.find((hit) => hit.id === "cap-term-target-001");
  assert.ok(target);
  assert.equal(target.idMatch, true);
  assert.ok(target.contentMatchCount > 0);
  assert.ok((target.titleMatchCount ?? 0) > 0);
});

test("local search excludes categorized sessions while category and favorite scopes retain them", async () => {
  setSessionCategory("title-only-001", "to_discuss");
  const normal = await search("needle-title");
  assert.equal(normal.some((hit) => hit.id === "title-only-001"), false);

  const categoryResponse = await GET(new Request("http://localhost/api/sessions/search?q=needle-title&scope=to_discuss&local=1"));
  assert.equal(categoryResponse.status, 200);
  assert.equal((await categoryResponse.json()).sessions.some((hit) => hit.id === "title-only-001"), true);

  const favoriteModule = await jiti.import("../../../../lib/favorite-state.ts");
  favoriteModule.setFavorite("title-only-001", true);
  resetSessionCategoryStateForTests();
  const favoriteResponse = await GET(new Request("http://localhost/api/sessions/search?q=needle-title&scope=favorites&local=1"));
  assert.equal(favoriteResponse.status, 200);
  assert.equal((await favoriteResponse.json()).sessions.some((hit) => hit.id === "title-only-001"), true);
});

test("aggregate GET keeps local identity when a configured peer is offline", async (t) => {
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    throw new Error("offline fixture");
  };
  t.after(() => { globalThis.fetch = previousFetch; });
  invalidateSessionListCache();
  const response = await GET(new Request("http://localhost/api/sessions/search?q=dual&scope=all"));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(body.sessions.some((hit) => hit.device?.id === "fixture-local"));
  assert.equal(calls.length, 1);
  assert.match(calls[0], /offline\.fixture\.invalid/);
});

test.after(async () => {
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piArchivedListCache = undefined;
  globalThis.__piArchivedListPromise = undefined;
  await rm(fixtureHome, { recursive: true, force: true });
});

// Keep one source-contract guard for the persisted-time behavior while runtime tests exercise GET itself.
test("search activity time remains persisted-session based", () => {
  assert.match(routeSource, /function searchActivityTime\(session: SessionInfo\): string \{\s*return session\.modified;\s*\}/);
});
