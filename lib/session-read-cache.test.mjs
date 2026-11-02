import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  getSessionReadAgentContext,
  getSessionReadBranch,
  getSessionReadSnapshot,
  getSessionReadTree,
  invalidateSessionReadCache,
} = await jiti.import("./session-read-cache.ts");

function entry(id, parentId, timestamp, message) {
  return JSON.stringify({ type: "message", id, parentId, timestamp, message });
}

test("reuses one parsed snapshot and its derived read models per file version", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-read-cache-"));
  const path = join(root, "session.jsonl");
  const timestamp = "2026-01-01T00:00:00.000Z";
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "cache-test", timestamp, cwd: root }),
    entry("u1", null, timestamp, { role: "user", content: "hello" }),
    entry("a1", "u1", timestamp, { role: "assistant", content: [{ type: "text", text: "world" }] }),
  ].join("\n") + "\n");
  globalThis.__piSessionReadCache = undefined;
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(root, { recursive: true, force: true });
  });

  const first = getSessionReadSnapshot(path);
  const second = getSessionReadSnapshot(path);

  assert.strictEqual(second, first);
  assert.equal(first.entries.length, 2);
  assert.equal(first.leafId, "a1");
  assert.strictEqual(getSessionReadAgentContext(first), getSessionReadAgentContext(second));
  assert.strictEqual(getSessionReadBranch(first), getSessionReadBranch(second));
  assert.strictEqual(getSessionReadTree(first), getSessionReadTree(second));

  const originalStat = statSync(path);
  // Coarse filesystem clocks stamp writes within one tick identically; wait for
  // the next tick so the rewrite below really carries a newer ctime.
  const tick = join(root, "tick");
  const deadline = Date.now() + 2_000;
  do writeFileSync(tick, ""); while (statSync(tick).ctimeMs <= originalStat.ctimeMs && Date.now() < deadline);
  assert.ok(statSync(tick).ctimeMs > originalStat.ctimeMs, "filesystem ctime did not advance");
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "cache-test", timestamp, cwd: root }),
    entry("u1", null, timestamp, { role: "user", content: "hello" }),
    entry("a1", "u1", timestamp, { role: "assistant", content: [{ type: "text", text: "there" }] }),
  ].join("\n") + "\n");
  // Keep mtime and size unchanged: ctime must still invalidate the snapshot.
  utimesSync(path, originalStat.atime, originalStat.mtime);
  const sameSizeChanged = getSessionReadSnapshot(path);
  assert.notStrictEqual(sameSizeChanged, first);
  assert.equal(sameSizeChanged.entries[0].message.content, "hello");
  assert.equal(sameSizeChanged.entries[1].message.content[0].text, "there");

  appendFileSync(path, `${JSON.stringify({ type: "session_info", id: "info", parentId: "a1", timestamp, name: "renamed" })}\n`);
  const changed = getSessionReadSnapshot(path);
  assert.notStrictEqual(changed, first);
  assert.equal(changed.entries.length, 3);
  assert.equal(changed.name, "renamed");

  invalidateSessionReadCache();
  assert.notStrictEqual(getSessionReadSnapshot(path), changed);
});

test("branch-derived reads follow the resolved leaf, not a metadata-only offshoot", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-read-stale-leaf-"));
  const path = join(root, "session.jsonl");
  const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const custom = (id, parentId, minute, customType = "plan-mode-state") =>
    JSON.stringify({ type: "custom", customType, id, parentId, timestamp: at(minute), data: {} });
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "stale-leaf", timestamp: at(0), cwd: root }),
    entry("u1", null, at(1), { role: "user", content: "first question" }),
    entry("a1", "u1", at(2), { role: "assistant", content: [{ type: "text", text: "first answer" }] }),
    // Fork right after the shared prefix: the main line continues below, while
    // a stale writer keeps appending metadata under the abandoned offshoot.
    custom("main1", "a1", 3),
    custom("side1", "a1", 4),
    entry("u2", "main1", at(5), { role: "user", content: "latest question" }),
    entry("a2", "u2", at(6), { role: "assistant", content: [{ type: "text", text: "latest answer" }] }),
    custom("recap2", "a2", 7, "session-recap-title:result"),
    custom("side2", "side1", 8),
    custom("side3", "side2", 9),
  ].join("\n") + "\n");
  globalThis.__piSessionReadCache = undefined;
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = getSessionReadSnapshot(path);
  // The physical last line belongs to the metadata-only offshoot.
  assert.equal(snapshot.entries.at(-1).id, "side3");
  assert.equal(snapshot.leafId, "recap2", "the branch carrying real conversation wins");

  const branchIds = getSessionReadBranch(snapshot).map((item) => item.id);
  assert.deepEqual(branchIds, ["u1", "a1", "main1", "u2", "a2", "recap2"]);

  // Agent context comes from the same leaf, so it must not answer from the
  // metadata-only offshoot either.
  const contextUsers = getSessionReadAgentContext(snapshot).messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.deepEqual(contextUsers, ["first question", "latest question"]);
});

test("quick-ask side threads never lend their questions to the session's main branch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-read-quick-ask-"));
  const path = join(root, "session.jsonl");
  const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const custom = (id, parentId, minute, customType) =>
    JSON.stringify({ type: "custom", customType, id, parentId, timestamp: at(minute), data: {} });
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "quick-ask", timestamp: at(0), cwd: root }),
    entry("u1", null, at(1), { role: "user", content: "root question" }),
    entry("a1", "u1", at(2), { role: "assistant", content: [{ type: "text", text: "root answer" }] }),
    custom("base", "a1", 3, "plan-mode-state"),
    entry("u2", "base", at(4), { role: "user", content: "main line question" }),
    entry("a2", "u2", at(5), { role: "assistant", content: [{ type: "text", text: "main answer" }] }),
    // Side-ask threads are appended beside the main line; the newest one is the
    // file's physical last line but never the conversation's current branch.
    custom("thread", "base", 6, "quick_ask"),
    custom("thread2", "thread", 7, "quick_ask"),
  ].join("\n") + "\n");
  globalThis.__piSessionReadCache = undefined;
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = getSessionReadSnapshot(path);
  assert.equal(snapshot.entries.at(-1).id, "thread2");
  assert.equal(snapshot.leafId, "a2", "a quick-ask thread must not steal the main branch");
  assert.deepEqual(getSessionReadBranch(snapshot).map((item) => item.id), ["u1", "a1", "base", "u2", "a2"]);
  const contextUsers = getSessionReadAgentContext(snapshot).messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.deepEqual(contextUsers, ["root question", "main line question"]);
});

test("keeps the latest conversation branch when its leaf is a metadata entry", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-read-current-metadata-"));
  const path = join(root, "session.jsonl");
  const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const sessionInfo = (id, parentId, minute) =>
    JSON.stringify({ type: "session_info", id, parentId, timestamp: at(minute), name: "current" });
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "current-metadata", timestamp: at(0), cwd: root }),
    entry("u1", null, at(1), { role: "user", content: "root question" }),
    entry("a1", "u1", at(2), { role: "assistant", content: [{ type: "text", text: "root answer" }] }),
    entry("oldQ", "a1", at(3), { role: "user", content: "older branch" }),
    entry("oldA", "oldQ", at(4), { role: "assistant", content: [{ type: "text", text: "older answer" }] }),
    entry("newQ", "a1", at(5), { role: "user", content: "current branch" }),
    entry("newA", "newQ", at(6), { role: "assistant", content: [{ type: "text", text: "current answer" }] }),
    sessionInfo("currentInfo", "newA", 7),
  ].join("\n") + "\n");
  globalThis.__piSessionReadCache = undefined;
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = getSessionReadSnapshot(path);
  assert.equal(snapshot.entries.at(-1).id, "currentInfo");
  assert.equal(snapshot.leafId, "currentInfo", "metadata appended to the latest conversation branch must not switch to an older sibling");
  assert.deepEqual(getSessionReadBranch(snapshot).map((item) => item.id), ["u1", "a1", "newQ", "newA", "currentInfo"]);
});

test("among real conversation branches, the timeline-latest one is the current branch", (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-read-latest-branch-"));
  const path = join(root, "session.jsonl");
  const at = (minute) => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  const custom = (id, parentId, minute, customType) =>
    JSON.stringify({ type: "custom", customType, id, parentId, timestamp: at(minute), data: {} });
  writeFileSync(path, [
    JSON.stringify({ type: "session", version: 3, id: "latest-branch", timestamp: at(0), cwd: root }),
    entry("u1", null, at(1), { role: "user", content: "root question" }),
    entry("a1", "u1", at(2), { role: "assistant", content: [{ type: "text", text: "root answer" }] }),
    // An older abandoned branch is written first...
    entry("oldQ", "a1", at(3), { role: "user", content: "abandoned question" }),
    entry("oldA", "oldQ", at(4), { role: "assistant", content: [{ type: "text", text: "abandoned answer" }] }),
    // ...then the branch the session actually continued on.
    entry("newQ", "a1", at(5), { role: "user", content: "current question" }),
    entry("newA", "newQ", at(6), { role: "assistant", content: [{ type: "text", text: "current answer" }] }),
    // A stale writer keeps appending metadata to the abandoned branch, making
    // it both the file's physical last line and the earliest-written sibling.
    custom("stale1", "oldA", 7, "plan-mode-state"),
    custom("stale2", "stale1", 8, "plan-mode-state"),
  ].join("\n") + "\n");
  globalThis.__piSessionReadCache = undefined;
  t.after(() => {
    invalidateSessionReadCache();
    rmSync(root, { recursive: true, force: true });
  });

  const snapshot = getSessionReadSnapshot(path);
  assert.equal(snapshot.entries.at(-1).id, "stale2");
  assert.equal(snapshot.leafId, "newA", "the latest conversation branch wins, not the first written sibling");
  assert.deepEqual(getSessionReadBranch(snapshot).map((item) => item.id), ["u1", "a1", "newQ", "newA"]);
  const contextUsers = getSessionReadAgentContext(snapshot).messages
    .filter((message) => message.role === "user")
    .map((message) => (typeof message.content === "string" ? message.content : ""));
  assert.deepEqual(contextUsers, ["root question", "current question"]);
});


test("an unknown dialogue timestamp cannot outrank a known conversation when resolving a metadata offshoot", t => {
  const root = mkdtempSync(join(tmpdir(), "reader-known-conversation-time-"));
  const file = join(root, "session.jsonl");
  const at = minute => `2026-01-01T00:${String(minute).padStart(2, "0")}:00.000Z`;
  writeFileSync(file, [
    JSON.stringify({ type: "session", version: 3, id: "known-dialogue", timestamp: at(0), cwd: root }),
    entry("u1", null, at(1), { role: "user", content: "root" }),
    entry("a1", "u1", at(2), { role: "assistant", content: [{ type: "text", text: "root answer" }] }),
    entry("unknown", "a1", "not-a-time", { role: "user", content: "unknown timestamp branch" }),
    entry("known", "a1", at(5), { role: "user", content: "known timestamp branch" }),
    JSON.stringify({ type: "custom", id: "metadata", parentId: "a1", timestamp: at(6), customType: "plan-mode-state", data: {} }),
  ].join("\n") + "\n");
  t.after(() => { invalidateSessionReadCache(file); rmSync(root, { recursive: true, force: true }); });
  const snapshot = getSessionReadSnapshot(file);
  assert.ok(snapshot.entries.some(value => value.id === "unknown"));
  assert.equal(snapshot.leafId, "known");
});
