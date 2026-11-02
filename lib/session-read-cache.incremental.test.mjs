import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const { getSessionReadSnapshot: read, getSessionReadBranch, getSessionReadAgentContext, invalidateSessionReadCache } = await jiti.import("./session-read-cache.ts");
const { SessionManager } = await import("@earendil-works/pi-coding-agent");
const timestamp = "2026-01-01T00:00:00.000Z";
const row = (id, parentId, content = id) => ({ type: "message", id, parentId, timestamp, message: { role: "user", content } });
const line = value => JSON.stringify(value) + "\n";
function fixture(t, version = 3) {
  const root = fs.mkdtempSync(join(tmpdir(), "reader-incremental-"));
  const path = join(root, "session.jsonl");
  const header = { type: "session", version, id: "synthetic", timestamp, cwd: root };
  fs.writeFileSync(path, line(header) + line(row("q", null)));
  invalidateSessionReadCache();
  t.after(() => { invalidateSessionReadCache(); fs.rmSync(root, { recursive: true, force: true }); });
  return { root, path, header };
}

test("SDK persists the first user synchronously, not only the first assistant", t => {
  const { root } = fixture(t);
  const manager = SessionManager.create(root, root);
  manager.appendModelChange("synthetic", "model");
  assert.equal(fs.existsSync(manager.getSessionFile()), false, "setup alone is transient");
  const user = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  assert.ok(fs.readFileSync(manager.getSessionFile(), "utf8").includes(user));
  const info = manager.appendSessionInfo("renamed");
  assert.ok(fs.readFileSync(manager.getSessionFile(), "utf8").includes(info));
});

test("append reuses parsed prefix entries but leaves prior snapshots and derived branches immutable", t => {
  const { path } = fixture(t);
  const first = read(path);
  const branch = getSessionReadBranch(first);
  fs.appendFileSync(path, line(row("next", "q")));
  const next = read(path);
  assert.strictEqual(next.entries[0], first.entries[0], "the committed prefix must not be JSON-parsed again");
  assert.notStrictEqual(next, first);
  assert.deepEqual(first.entries.map(e => e.id), ["q"]);
  assert.strictEqual(getSessionReadBranch(first), branch);
  assert.deepEqual(getSessionReadBranch(next).map(e => e.id), ["q", "next"]);
});

test("same-inode rewrite plus growth cannot masquerade as an append", t => {
  const { path } = fixture(t);
  const first = read(path);
  const original = fs.readFileSync(path, "utf8");
  fs.writeFileSync(path, original.replace('"content":"q"', '"content":"x"') + line(row("next", "q")));
  assert.equal(fs.statSync(path).ino, first.fileIno);
  const next = read(path);
  assert.equal(next.entries[0].message.content, "x");
  assert.notStrictEqual(next.entries[0], first.entries[0]);
});

test("truncation and atomic replacement discard offsets and prior parsed records", t => {
  const { path, header } = fixture(t);
  read(path);
  fs.writeFileSync(path, line(header));
  assert.deepEqual(read(path).entries, []);
  fs.writeFileSync(path + ".replacement", line(header) + line(row("other", null)));
  fs.renameSync(path + ".replacement", path);
  assert.deepEqual(read(path).entries.map(e => e.id), ["other"]);
});

test("partial UTF8 tail, malformed complete rows and valid unterminated rows are recovered once", t => {
  const { path } = fixture(t);
  const prefix = read(path);
  const bytes = Buffer.from(line(row("utf8", "q", "中文🙂")));
  const split = bytes.indexOf(Buffer.from("🙂")) + 2;
  fs.appendFileSync(path, bytes.subarray(0, split));
  const incomplete = read(path);
  assert.deepEqual(incomplete.entries.map(e => e.id), ["q"]);
  fs.appendFileSync(path, bytes.subarray(split, bytes.length - 1));
  const unterminated = read(path);
  assert.deepEqual(unterminated.entries.map(e => e.id), ["q", "utf8"]);
  assert.equal(unterminated.entries[1].message.content, "中文🙂");
  fs.appendFileSync(path, "\n{broken row}\n" + line(row("last", "utf8")));
  const complete = read(path);
  assert.deepEqual(complete.entries.map(e => e.id), ["q", "utf8", "last"]);
  assert.strictEqual(complete.entries[0], prefix.entries[0]);
  assert.deepEqual(unterminated.entries.map(e => e.id), ["q", "utf8"]);
});

test("append preserves explicit branch and compaction context semantics", t => {
  const { path } = fixture(t);
  const first = read(path);
  fs.appendFileSync(path, line(row("other", "q")) + line(row("kept", "q")) + line({
    type: "compaction", id: "compact", parentId: "kept", timestamp,
    summary: "summary", firstKeptEntryId: "kept", tokensBefore: 100,
  }));
  const next = read(path);
  assert.strictEqual(next.entries[0], first.entries[0]);
  assert.deepEqual(getSessionReadBranch(next).map(e => e.id), ["q", "kept", "compact"]);
  assert.deepEqual(next.manager.getBranch("other").map(e => e.id), ["q", "other"]);
  const context = getSessionReadAgentContext(next);
  assert.ok(context.messages.some(m => m.role === "compactionSummary"));
  assert.ok(context.messages.some(m => m.role === "user" && m.content === "kept"));
  assert.ok(!context.messages.some(m => m.role === "user" && m.content === "other"));
});

for (const version of [1, 2]) {
  test(`legacy v${version} append is normalized without persisting migration`, t => {
    const { path, header } = fixture(t, version);
    const user = version === 1 ? { type: "message", timestamp, message: { role: "user", content: "legacy" } } : row("q", null);
    fs.writeFileSync(path, line(header) + line(user));
    read(path);
    fs.appendFileSync(path, line(version === 1 ? user : row("next", "q")));
    const bytes = fs.readFileSync(path);
    const before = fs.statSync(path);
    assert.equal(read(path).entries.length, 2);
    assert.deepEqual(fs.readFileSync(path), bytes);
    assert.equal(fs.statSync(path).ctimeMs, before.ctimeMs);
  });
}
