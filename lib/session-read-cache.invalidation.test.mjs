import assert from "node:assert/strict";
import { appendFileSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const { getSessionReadSnapshot, invalidateSessionReadCache } = await jiti.import("./session-read-cache.ts");
const { cacheSessionPath, getSessionListVersion, invalidateSessionListCache, invalidateSessionPathCache, updateSessionListCachesForMove } = await jiti.import("./session-reader.ts");

function syntheticFile(root, id, version = 3) {
  const path = join(root, `${id}.jsonl`);
  writeFileSync(path, [
    { type: "session", version, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    { type: "message", id: `${id}-u`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "synthetic question" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  return path;
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-read-invalidation-"));
  invalidateSessionReadCache();
  t.after(() => {
    invalidateSessionReadCache();
    invalidateSessionPathCache("read-a");
    invalidateSessionPathCache("read-b");
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}

test("list generation changes do not reopen unchanged session snapshots", (t) => {
  const root = fixture(t);
  const a = syntheticFile(root, "read-a");
  const b = syntheticFile(root, "read-b");
  const firstA = getSessionReadSnapshot(a);
  const firstB = getSessionReadSnapshot(b);
  const version = getSessionListVersion();
  for (let index = 0; index < 100; index += 1) invalidateSessionListCache();
  assert.equal(getSessionListVersion(), version + 100);
  assert.strictEqual(getSessionReadSnapshot(a), firstA);
  assert.strictEqual(getSessionReadSnapshot(b), firstB);
});

test("explicit content invalidation is path-scoped, including empty transient paths", (t) => {
  const root = fixture(t);
  const a = syntheticFile(root, "read-a");
  const b = syntheticFile(root, "read-b");
  const firstA = getSessionReadSnapshot(a);
  const firstB = getSessionReadSnapshot(b);
  invalidateSessionReadCache("");
  assert.strictEqual(getSessionReadSnapshot(a), firstA);
  invalidateSessionReadCache(a);
  assert.notStrictEqual(getSessionReadSnapshot(a), firstA);
  assert.strictEqual(getSessionReadSnapshot(b), firstB);
});

test("move and path deletion evict only old/new content identities", (t) => {
  const root = fixture(t);
  const a = syntheticFile(root, "read-a");
  const b = syntheticFile(root, "read-b");
  cacheSessionPath("read-a", a);
  cacheSessionPath("read-b", b);
  getSessionReadSnapshot(a);
  const firstB = getSessionReadSnapshot(b);
  const moved = join(root, "archived-a.jsonl");
  renameSync(a, moved);
  updateSessionListCachesForMove("read-a", a, moved, true);
  assert.equal(globalThis.__piSessionReadCache.has(a), false);
  assert.strictEqual(getSessionReadSnapshot(b), firstB);
  getSessionReadSnapshot(moved);
  invalidateSessionPathCache("read-a");
  assert.equal(globalThis.__piSessionReadCache.has(moved), false);
  assert.strictEqual(getSessionReadSnapshot(b), firstB);
});

test("same-size rewrites, appended metadata, replacement files and deletion get fresh read snapshots", (t) => {
  const root = fixture(t);
  const path = syntheticFile(root, "read-a");
  utimesSync(path, 1000, 1000);
  const first = getSessionReadSnapshot(path);
  const original = statSync(path);
  for (const start = Date.now(); Date.now() - start < 12;);
  writeFileSync(path, [
    { type: "session", version: 3, id: "read-a", timestamp: "2026-01-01T00:00:00.000Z", cwd: root },
    { type: "message", id: "read-a-u", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "different question" } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  assert.equal(statSync(path).size, original.size);
  utimesSync(path, 1000, 1000);
  const changed = getSessionReadSnapshot(path);
  assert.notStrictEqual(changed, first);
  assert.equal(changed.entries[0].message.content, "different question");
  appendFileSync(path, JSON.stringify({ type: "session_info", id: "renamed", parentId: "read-a-u", timestamp: "2026-01-01T00:00:02.000Z", name: "renamed session" }) + "\n");
  assert.equal(getSessionReadSnapshot(path).name, "renamed session");
  const replacement = syntheticFile(root, "replacement");
  renameSync(replacement, path);
  assert.equal(getSessionReadSnapshot(path).header.id, "replacement");
  rmSync(path);
  assert.throws(() => getSessionReadSnapshot(path));
  assert.equal(globalThis.__piSessionReadCache.has(path), false);
});

for (const version of [1, 2]) {
  test(`legacy v${version} files are normalized in memory without source migration`, (t) => {
    const root = fixture(t);
    const path = join(root, `legacy-v${version}.jsonl`);
    const stamp = "2026-01-01T00:00:00.000Z";
    const source = [
      { type: "session", version, id: `legacy-v${version}`, timestamp: stamp, cwd: root },
      { type: "message", timestamp: stamp, ...(version === 2 ? { id: "legacy-user", parentId: null } : {}), message: { role: "user", content: "legacy question" } },
    ].map((entry) => JSON.stringify(entry)).join("\n");
    writeFileSync(path, source);
    const before = statSync(path);
    const snapshot = getSessionReadSnapshot(path);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].message.content, "legacy question");
    assert.equal(readFileSync(path, "utf8"), source);
    assert.equal(statSync(path).size, before.size);
  });
}
