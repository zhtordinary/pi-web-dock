import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { listSessionsIncremental, resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");
const { listAllSessions, invalidateSessionListCache } = await jiti.import("./session-reader.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const line = (entry) => JSON.stringify(entry) + "\n";
const message = (id, role, content, time = timestamp) => ({
  type: "message", id, parentId: null, timestamp: time, message: { role, content },
});

function fixture(t) {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const root = fs.mkdtempSync(join(tmpdir(), "pi-web-scanner-"));
  const dir = join(root, "sessions", "project");
  fs.mkdirSync(dir, { recursive: true });
  process.env.PI_CODING_AGENT_DIR = root;
  resetSessionScanIndexForTests();
  invalidateSessionListCache();
  t.after(() => {
    resetSessionScanIndexForTests();
    invalidateSessionListCache();
    globalThis.__piSessionPathCache = undefined;
    globalThis.__piPathToSessionIdCache = undefined;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function write(id, entries = [], extraHeader = {}) {
    const path = join(dir, `${id}.jsonl`);
    fs.writeFileSync(path, line({ type: "session", version: 3, id, cwd: root, timestamp, ...extraHeader }) + entries.map(line).join(""));
    return path;
  }
  return { root, dir, write, indexPath: join(root, "pi-web-session-index.json") };
}

async function sdkMetadata() {
  return (await SessionManager.listAll()).map((session) => {
    const info = { ...session };
    delete info.allMessagesText;
    return info;
  });
}

test("matches SDK metadata and tie ordering across cache hits, mutations, and restarts", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [
    message("a1", "user", [{ type: "image", data: "ignored", mimeType: "image/png" }, { type: "text", text: "first" }, { type: "text", text: "request" }]),
    message("a2", "assistant", [{ type: "text", text: "answer" }]),
    message("a3", "toolResult", [{ type: "text", text: "output" }], "2026-01-03T00:00:00.000Z"),
    { type: "custom", data: "x".repeat(256 * 1024) },
  ]);
  const b = write("b", [message("b1", "user", "forked request")], { parentSession: a, contextSourceSessionId: "source-session" });
  const c = write("c");
  const opened = [];
  const createReadStream = fs.createReadStream;
  t.mock.method(fs, "createReadStream", (path, ...args) => {
    opened.push(path);
    return createReadStream(path, ...args);
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  async function check(label, expectedReads) {
    const expected = await sdkMetadata();
    opened.length = 0;
    const actual = await listSessionsIncremental();
    assert.deepEqual(actual.map(({ contextSourceSessionId: _contextSourceSessionId, ...session }) => session), expected, label);
    assert.deepEqual([...opened].sort(), [...expectedReads].sort(), `${label}: scanned files`);
  }

  await check("cold", [a, b, c]);
  assert.equal((await listSessionsIncremental()).find((session) => session.id === "b")?.contextSourceSessionId, "source-session");
  assert.equal((await listAllSessions({ force: true })).find((session) => session.id === "b")?.contextSourceSessionId, "source-session");
  await check("warm", []);
  if (process.platform !== "win32") assert.equal(fs.statSync(indexPath).mode & 0o777, 0o600);
  resetSessionScanIndexForTests();
  await check("persisted cache", []);

  fs.appendFileSync(a, line({ type: "session_info", name: "  Renamed  " }));
  await check("rename preserves equal-time order", [a]);
  fs.appendFileSync(a, line({ type: "session_info", name: " " }));
  await check("explicit name clear", [a]);
  fs.appendFileSync(b, line(message("b2", "assistant", "new activity", "2026-01-02T00:00:00.000Z")));
  await check("append", [b]);
  write("a", [message("replacement", "user", "rewritten")]);
  await check("whole-file rewrite", [a]);
  const d = write("d", [message("d1", "user", "new session")]);
  fs.rmSync(c);
  await check("create and delete", [d]);

  resetSessionScanIndexForTests();
  fs.appendFileSync(a, line({ type: "session_info", name: "changed while stopped" }));
  fs.rmSync(b);
  await check("restart revalidates changed and deleted files", [a]);
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  assert.deepEqual(Object.keys(persisted.entries).sort(), [a, d].sort());
});

test("discards malformed persisted entries and rebuilds the list from valid session files", async (t) => {
  const { write, indexPath } = fixture(t);
  const a = write("a", [message("a1", "user", "healthy")]);
  write("b", [message("b1", "user", "also healthy")]);
  const expected = await listSessionsIncremental();
  const pristine = fs.readFileSync(indexPath, "utf8");
  const corruptions = [
    ["missing fingerprint", (entry) => { delete entry.fp; }],
    ["null fingerprint", (entry) => { entry.fp = null; }],
    ["string size", (entry) => { entry.fp.size = String(entry.fp.size); }],
    ["negative size", (entry) => { entry.fp.size = -1; }],
    ["invalid mtime", (entry) => { entry.fp.mtimeMs = null; }],
    ["missing metadata", (entry) => { delete entry.info; }],
    ["mismatched path", (entry) => { entry.info.path = "/elsewhere/session.jsonl"; }],
    ["invalid id", (entry) => { entry.info.id = null; }],
    ["invalid cwd", (entry) => { entry.info.cwd = []; }],
    ["invalid first message", (entry) => { entry.info.firstMessage = 1; }],
    ["invalid name", (entry) => { entry.info.name = {}; }],
    ["invalid parent", (entry) => { entry.info.parentSessionPath = []; }],
    ["invalid count", (entry) => { entry.info.messageCount = -1; }],
    ["invalid created", (entry) => { entry.info.created = "not a date"; }],
    ["invalid modified", (entry) => { entry.info.modified = "not a date"; }],
    ["null date", (entry) => { entry.info.created = null; }],
  ];
  for (const [label, corrupt] of corruptions) {
    const index = JSON.parse(pristine);
    corrupt(index.entries[a]);
    fs.writeFileSync(indexPath, JSON.stringify(index));
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, label);
    const sessions = await listAllSessions({ force: true });
    assert.deepEqual(sessions.map((s) => s.id), expected.map((s) => s.id), label);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, `${label}: repaired cache survives restart`);
  }
  for (const source of ["{", "null", '{"version":2,"entries":{}}', '{"version":1,"entries":[]}', '{"version":1,"entries":{"broken":null}}']) {
    fs.writeFileSync(indexPath, source);
    resetSessionScanIndexForTests();
    assert.deepEqual(await listSessionsIncremental(), expected, source);
  }
});

test("invalidates pre-lineage scanner indexes before serving cached metadata", async (t) => {
  const { write, indexPath } = fixture(t);
  const sessionPath = write("context", [message("c1", "user", "context")], { contextSourceSessionId: "source-session" });
  await listSessionsIncremental();
  const stale = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  delete stale.entries[sessionPath].info.contextSourceSessionId;
  stale.version = 1;
  fs.writeFileSync(indexPath, JSON.stringify(stale));
  resetSessionScanIndexForTests();
  const [session] = await listSessionsIncremental();
  assert.equal(session.contextSourceSessionId, "source-session");
});

test("clears a hot-reloaded v1 global scanner map before using the v2 lineage index", async (t) => {
  const { write, indexPath } = fixture(t);
  const sessionPath = write("context", [message("c1", "user", "context")], { contextSourceSessionId: "source-session" });
  await listSessionsIncremental();
  const persisted = JSON.parse(fs.readFileSync(indexPath, "utf8"));
  const staleInfo = { ...persisted.entries[sessionPath].info, firstMessage: "stale", contextSourceSessionId: undefined };
  const staleEntry = { ...persisted.entries[sessionPath], info: staleInfo };
  fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: { [sessionPath]: staleEntry } }));
  globalThis.__piWebScanIndex = new Map([[sessionPath, staleEntry]]);
  globalThis.__piWebScanIndexLoaded = true;
  globalThis.__piWebScanIndexFormatVersion = 1;

  const [session] = await listSessionsIncremental();
  assert.equal(session.contextSourceSessionId, "source-session");
  assert.equal(session.firstMessage, "context");
  assert.equal(globalThis.__piWebScanIndexFormatVersion, 2);
});

test("retains SDK handling of partial lines, activity timestamps, and empty sessions", async (t) => {
  const { dir, write } = fixture(t);
  const a = write("a", [
    message("a1", "assistant", "not the first user message"),
    message("a2", "user", []),
    { ...message("a3", "user", "user message"), message: { role: "user", content: "user message", timestamp: Date.parse("2026-01-04T00:00:00.000Z") } },
  ]);
  fs.appendFileSync(a, '{"unfinished":');
  const b = write("b");
  fs.writeFileSync(b, "\nnot json\n" + fs.readFileSync(b, "utf8"));
  fs.writeFileSync(join(dir, "invalid.jsonl"), line(message("invalid", "user", "no header")));
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});

test("defers changed-file details to a later scan", async (t) => {
  const { write } = fixture(t);
  const sessionPath = write("deferred", [
    message("d1", "user", "deferred request"),
    message("d2", "assistant", "deferred answer"),
  ]);

  // A summary listing reads only the header and stat, so the transcript-derived
  // fields stay empty and the row is marked as pending.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary.length, 1);
  assert.equal(summary[0].path, sessionPath);
  assert.equal(summary[0].detailsPending, true);
  assert.equal(summary[0].messageCount, 0);
  assert.equal(summary[0].firstMessage, "");
  assert.equal(summary[0].id, "deferred");
  assert.equal(summary[0].cwd, process.env.PI_CODING_AGENT_DIR);

  // The normal listing still hydrates the exact details.
  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].detailsPending, undefined);
  assert.equal(detailed[0].messageCount, 2);
  assert.equal(detailed[0].firstMessage, "deferred request");
});

test("a summary listing does not downgrade an already-scanned file", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);

  const detailed = await listSessionsIncremental();
  assert.equal(detailed[0].messageCount, 1);

  // The cached entry is complete, so the summary listing serves it as-is. The
  // scan index is persisted across restarts, so this is the common path: a
  // first paint should not blank details it is already holding.
  const summary = await listSessionsIncremental({ deferDetails: true });
  assert.equal(summary[0].detailsPending, undefined);
  assert.equal(summary[0].messageCount, 1);
  assert.equal(summary[0].firstMessage, "cached request");
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);
});

test("a summary listing defers only the files the index has not scanned", async (t) => {
  const { write } = fixture(t);
  write("cached", [message("c1", "user", "cached request")]);
  assert.equal((await listSessionsIncremental())[0].messageCount, 1);

  // A file the index has never seen has no details to reuse, so it is the one
  // row that comes back pending — the point of the summary mode.
  write("fresh", [message("f1", "user", "fresh request")]);
  const summary = await listSessionsIncremental({ deferDetails: true });
  const byId = Object.fromEntries(summary.map((row) => [row.id, row]));
  assert.equal(byId.cached.detailsPending, undefined);
  assert.equal(byId.cached.messageCount, 1);
  assert.equal(byId.fresh.detailsPending, true);
  assert.equal(byId.fresh.messageCount, 0);
});

test("discovers sessions through project directory symlinks", { skip: process.platform === "win32" }, async (t) => {
  const { root, dir, write } = fixture(t);
  write("a", [message("a1", "user", "linked")]);
  const external = join(root, "external-project");
  fs.renameSync(dir, external);
  fs.symlinkSync(external, dir, "dir");
  assert.deepEqual(await listSessionsIncremental(), await sdkMetadata());
});


test("scans archived session roots with the same incremental index", async (t) => {
  const { root } = fixture(t);
  const archiveDir = join(root, "archived-sessions", "project");
  fs.mkdirSync(archiveDir, { recursive: true });
  const archivePath = join(archiveDir, "archived.jsonl");
  fs.writeFileSync(archivePath, [
    { type: "session", version: 3, id: "archived", cwd: root, timestamp },
    message("u1", "user", "archived request"),
    message("a1", "assistant", "archived answer"),
  ].map(line).join(""));

  const first = await listSessionsIncremental({ sessionsDir: join(root, "archived-sessions") });
  assert.equal(first.length, 1);
  assert.equal(first[0].id, "archived");
  assert.equal(first[0].messageCount, 2);
  assert.equal(first[0].firstMessage, "archived request");

  const second = await listSessionsIncremental({ sessionsDir: join(root, "archived-sessions") });
  assert.deepEqual(second, first);

  fs.appendFileSync(archivePath, line(message("u2", "user", "follow-up", "2026-01-02T00:00:00.000Z")));
  const refreshed = await listSessionsIncremental({ sessionsDir: join(root, "archived-sessions") });
  assert.equal(refreshed[0].messageCount, 3);
  assert.equal(refreshed[0].modified.toISOString(), "2026-01-02T00:00:00.000Z");
});

test("observe-only cold and changed scans neither persist nor poison the shared index", async (t) => {
  const { write, indexPath } = fixture(t);
  const path = write("observe", [message("o1", "user", "pending analysis is data only")]);
  const first = await listSessionsIncremental({ readOnly: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(first[0].messageCount, 1);
  assert.equal(fs.existsSync(indexPath), false);
  assert.equal(globalThis.__piWebScanIndex.size, 0);
  await listSessionsIncremental();
  await new Promise((resolve) => setImmediate(resolve));
  const before = fs.readFileSync(indexPath);
  fs.appendFileSync(path, line(message("o2", "assistant", "new output")));
  assert.equal((await listSessionsIncremental({ readOnly: true }))[0].messageCount, 2);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fs.readFileSync(indexPath), before);
  assert.equal([...globalThis.__piWebScanIndex.values()][0].info.messageCount, 1);
});
