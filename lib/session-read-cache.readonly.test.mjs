import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { getSessionReadSnapshot, invalidateSessionReadCache } = await jiti.import("./session-read-cache.ts");
const timestamp = "2026-10-18T00:00:00.000Z";

for (const version of [1, 3]) {
  test(`v${version} read snapshots neither repair a missing newline nor persist SDK migration`, (t) => {
    const root = mkdtempSync(join(tmpdir(), "reader-history-readonly-"));
    t.after(() => { invalidateSessionReadCache(); rmSync(root, { recursive: true, force: true }); });
    const path = join(root, "session.jsonl");
    const entry = { type: "message", timestamp, message: { role: "user", content: "中文🙂 question" } };
    if (version === 3) Object.assign(entry, { id: "q", parentId: null });
    const raw = [JSON.stringify({ type: "session", version, id: `readonly-v${version}`, timestamp, cwd: root }), JSON.stringify(entry)].join("\n");
    writeFileSync(path, raw);
    const before = statSync(path);
    const snapshot = getSessionReadSnapshot(path);
    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].message.content, "中文🙂 question");
    assert.equal(readFileSync(path, "utf8"), raw);
    const after = statSync(path);
    assert.equal(after.size, before.size);
    assert.equal(after.mtimeMs, before.mtimeMs);
    assert.equal(after.ctimeMs, before.ctimeMs);
    assert.strictEqual(getSessionReadSnapshot(path), snapshot);
  });
}

test("ten thousand persisted messages behind a metadata offshoot resolve without recursive traversal", (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-history-deep-source-"));
  t.after(() => { invalidateSessionReadCache(); rmSync(root, { recursive: true, force: true }); });
  const path = join(root, "session.jsonl");
  const rows = [JSON.stringify({ type: "session", version: 3, id: "deep-source", timestamp, cwd: root })];
  for (let index = 0; index < 10_000; index += 1) {
    rows.push(JSON.stringify({
      type: "message", id: `e${index}`, parentId: index === 0 ? null : `e${index - 1}`,
      timestamp: new Date(Date.parse(timestamp) + index * 1000).toISOString(),
      message: { role: "user", content: `question ${index}` },
    }));
  }
  rows.push(JSON.stringify({ type: "custom", id: "offshoot", parentId: "e0", timestamp, customType: "plan-mode-state", data: {} }));
  writeFileSync(path, `${rows.join("\n")}\n`);
  const snapshot = getSessionReadSnapshot(path);
  assert.equal(snapshot.leafId, "e9999");
  assert.equal(snapshot.entries.length, 10_001);
});
