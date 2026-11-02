import assert from "node:assert/strict";
import fs from "node:fs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { fsCache: false });
const sdk = await import("@earendil-works/pi-coding-agent");
const { createHistoryProjection, getHistoryWindow } = await jiti.import("./session-history.ts");
const source = fs.readFileSync(new URL("./session-read-cache.ts", import.meta.url), "utf8");
const stamp = "2026-01-01T00:00:00.000Z";
const row = (id, parentId, content = id) => JSON.stringify({ type: "message", id, parentId, timestamp: stamp, message: { role: "user", content } }) + "\n";
function fixture(t, onRead) {
  const root = fs.mkdtempSync(join(tmpdir(), "reader-concurrent-source-"));
  const path = join(root, "session.jsonl");
  const header = JSON.stringify({ type: "session", version: 3, id: "synthetic", timestamp: stamp, cwd: root }) + "\n";
  fs.writeFileSync(path, header + row("old", null));
  const mod = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)(name => name === "node:fs" ? { ...fs, readSync: (...args) => {
    const count = fs.readSync(...args);
    if (count) onRead?.(path, header);
    return count;
  } } : name === "@earendil-works/pi-coding-agent" ? sdk : require(name), mod, mod.exports);
  mod.exports.invalidateSessionReadCache();
  t.after(() => { mod.exports.invalidateSessionReadCache(); fs.rmSync(root, { recursive: true, force: true }); });
  return { path, header, ...mod.exports };
}

test("path replacement during a read retries against the new descriptor and never caches mixed versions", t => {
  let replaced = false;
  const f = fixture(t, (path, header) => {
    if (replaced) return;
    replaced = true;
    fs.writeFileSync(path + ".new", header + row("new", null));
    fs.renameSync(path + ".new", path);
  });
  const snapshot = f.getSessionReadSnapshot(f.path);
  assert.deepEqual(snapshot.entries.map(e => e.id), ["new"]);
  assert.equal(snapshot.fileIno, fs.statSync(f.path).ino);
  assert.strictEqual(f.getSessionReadSnapshot(f.path), snapshot);
});

for (const warm of [false, true]) {
  test(`${warm ? "warm" : "cold"} prefix reads finish during continuous append and after retrieves the new rows`, t => {
    let appending = false;
    let appended = 0;
    const f = fixture(t, path => {
      if (!appending) return;
      const parent = appended === 0 ? "old" : `r${appended}`;
      fs.appendFileSync(path, row(`r${++appended}`, parent));
    });
    // Multiple blocks prove that neither parsing nor validation chases the
    // growing EOF, and that snapshot metadata describes only consumed bytes.
    fs.writeFileSync(f.path, f.header + row("old", null, "x".repeat(150_000)));
    const first = warm ? f.getSessionReadSnapshot(f.path) : undefined;
    if (warm) fs.appendFileSync(f.path, "\n");
    const size = fs.statSync(f.path).size;
    const initial = fs.readFileSync(f.path);
    appending = true;
    const snapshot = f.getSessionReadSnapshot(f.path);
    appending = false;
    assert.ok(appended >= 3 && appended <= 7, "fixed-prefix parse/verify must finish without retrying on append");
    assert.equal(snapshot.fileSize, size);
    assert.deepEqual(snapshot.entries.map(e => e.id), ["old"]);
    const cached = globalThis.__piSessionReadCache.get(f.path);
    assert.equal(cached.parsed.offset, size);
    assert.equal(cached.parsed.completeRecords, 2);
    const hash = createHash("sha256").update(initial).digest("hex");
    assert.equal(cached.parsed.prefixSha256, hash);
    assert.equal(cached.parsed.consumedSha256, hash);
    assert.ok(fs.statSync(f.path).size > snapshot.fileSize);
    assert.deepEqual(fs.readFileSync(f.path).subarray(0, size), initial);
    if (first) assert.strictEqual(snapshot.entries[0], first.entries[0]);
    const next = f.getSessionReadSnapshot(f.path);
    const projection = createHistoryProjection(next.entries, { sessionId: "synthetic", currentLeafId: next.leafId });
    const page = getHistoryWindow(projection, { after: "old", turns: 50 });
    assert.deepEqual(page.items.map(item => item.entryId), Array.from({ length: appended }, (_, index) => `r${index + 1}`));
    assert.equal(page.coverage.end, true);
    assert.strictEqual(next.entries[0], snapshot.entries[0]);
    assert.strictEqual(f.getSessionReadSnapshot(f.path), next);
  });
}

test("a prefix completed during reading keeps its original EOF hash and newline checkpoint", t => {
  let completed = false;
  const f = fixture(t, path => {
    if (completed) return;
    completed = true;
    fs.appendFileSync(path, "\n" + row("tail", "old"));
  });
  fs.writeFileSync(f.path, f.header + row("old", null).trimEnd());
  const initial = fs.readFileSync(f.path);
  const snapshot = f.getSessionReadSnapshot(f.path);
  assert.equal(snapshot.fileSize, initial.length);
  assert.deepEqual(snapshot.entries.map(e => e.id), ["old"]);
  const parsed = globalThis.__piSessionReadCache.get(f.path).parsed;
  assert.equal(parsed.offset, Buffer.byteLength(f.header));
  assert.equal(parsed.completeRecords, 1);
  assert.equal(parsed.prefixSha256, createHash("sha256").update(f.header).digest("hex"));
  assert.equal(parsed.consumedSha256, createHash("sha256").update(initial).digest("hex"));
  assert.deepEqual(f.getSessionReadSnapshot(f.path).entries.map(e => e.id), ["old", "tail"]);
});

test("path replacement during prefix verification cannot publish the unlinked file", t => {
  let reads = 0;
  const f = fixture(t, (path, header) => {
    reads++;
    if (reads === 1) fs.appendFileSync(path, row("tail", "old"));
    if (reads === 2) {
      fs.writeFileSync(path + ".new", header + row("new", null));
      fs.renameSync(path + ".new", path);
    }
  });
  const snapshot = f.getSessionReadSnapshot(f.path);
  assert.deepEqual(snapshot.entries.map(e => e.id), ["new"]);
  assert.equal(snapshot.fileIno, fs.statSync(f.path).ino);
});

test("same-inode prefix rewrite plus append during reading is retried instead of publishing old bytes", t => {
  let changed = false;
  const f = fixture(t, (path, header) => {
    if (changed) return;
    changed = true;
    fs.writeFileSync(path, header + row("new", null) + row("tail", "new"));
  });
  const inode = fs.statSync(f.path).ino;
  const snapshot = f.getSessionReadSnapshot(f.path);
  assert.equal(snapshot.fileIno, inode);
  assert.deepEqual(snapshot.entries.map(e => e.id), ["new", "tail"]);
  assert.equal(snapshot.fileSize, fs.statSync(f.path).size);
});

test("continuous prefix rewrites still fail without publishing an unverified snapshot", t => {
  let version = 0;
  const f = fixture(t, (path, header) => {
    fs.writeFileSync(path, header + row(`v${++version}`, null, "rewrite".repeat(version)) + row("tail", `v${version}`));
  });
  assert.throws(() => f.getSessionReadSnapshot(f.path), /changed repeatedly/);
  assert.equal(globalThis.__piSessionReadCache.has(f.path), false);
});

test("truncation during reading discards the consumed old prefix", t => {
  let truncated = false;
  const f = fixture(t, (path, header) => {
    if (truncated) return;
    truncated = true;
    fs.writeFileSync(path, header);
  });
  const snapshot = f.getSessionReadSnapshot(f.path);
  assert.deepEqual(snapshot.entries, []);
  assert.equal(snapshot.fileSize, Buffer.byteLength(f.header));
});

test("long UTF8 rows spanning read blocks and an invalidated unterminated row never duplicate entries", t => {
  const f = fixture(t);
  const first = f.getSessionReadSnapshot(f.path);
  const text = "中文🙂".repeat(30_000);
  fs.appendFileSync(f.path, row("long", "old", text).trimEnd());
  const withTail = f.getSessionReadSnapshot(f.path);
  assert.equal(withTail.entries.at(-1).message.content, text);
  assert.strictEqual(withTail.entries[0], first.entries[0]);
  fs.appendFileSync(f.path, "garbage\n" + row("valid", "old"));
  const recovered = f.getSessionReadSnapshot(f.path);
  assert.deepEqual(recovered.entries.map(e => e.id), ["old", "valid"]);
  assert.equal(withTail.entries.at(-1).id, "long");
});
