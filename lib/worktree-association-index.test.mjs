import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { readWorktreeAssociationHints, saveWorktreeAssociationHints } = await createJiti(import.meta.url, { fsCache: false }).import("./worktree-association-index.ts");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-worktree-index-"));
  const oldCache = process.env.XDG_CACHE_HOME, oldDevice = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  process.env.XDG_CACHE_HOME = join(root, "cache");
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" } });
  t.after(() => {
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
    if (oldDevice === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
    else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = oldDevice;
    rmSync(root, { recursive: true, force: true });
  });
  const project = join(root, "repo"), linked = join(root, "linked"), path = join(root, "session.jsonl");
  mkdirSync(project); mkdirSync(linked); writeFileSync(path, "session\n");
  const sessions = [{ id: "owner", path, cwd: project, created: "2026-01-01T00:00:00.000Z" }];
  const records = [{ worktreePath: linked, sessionId: "owner", createdAt: "2026-01-02T00:00:00.000Z" }];
  const save = () => saveWorktreeAssociationHints(project, sessions, [project, linked], records);
  const read = (visible = sessions, paths = [project, linked]) => readWorktreeAssociationHints(project, visible, paths);
  return { root, project, linked, path, sessions, records, save, read };
}

test("persisted hints survive a restart but never modify the session", (t) => {
  const f = fixture(t), before = statSync(f.path);
  f.save();
  assert.deepEqual(f.read(), f.records);
  assert.deepEqual(f.read([], [f.project, f.linked]), [], "hidden or removed sessions must not be suggested");
  assert.deepEqual(f.read(f.sessions, [f.project]), [], "only currently registered worktrees are suggested");
  const after = statSync(f.path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
});

test("a shared cache keeps device identities separate", (t) => {
  const f = fixture(t);
  f.save();
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-b" } });
  assert.deepEqual(f.read(), []);
  f.save();
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "device-a" } });
  assert.deepEqual(f.read(), f.records, "another device's write must not replace the local suggestion");
});

test("partial verified updates preserve other hints, and duplicate session IDs are refused", (t) => {
  const f = fixture(t);
  f.save();
  saveWorktreeAssociationHints(f.project, f.sessions, [f.project, f.linked], [], false);
  assert.deepEqual(f.read(), f.records, "an unfinished project scan must not erase existing hints");
  assert.deepEqual(f.read([...f.sessions, { ...f.sessions[0], path: f.path + ".duplicate" }]), [], "ambiguous identities cannot choose a worktree");
  saveWorktreeAssociationHints(f.project, [...f.sessions, { ...f.sessions[0], path: f.path + ".duplicate" }], [f.project, f.linked], f.records);
  assert.deepEqual(f.read(), [], "an ambiguous session must not create a hint");
});

test("a damaged cache is rebuilt and a symlink is never overwritten", (t) => {
  const device = createHash("sha256").update("device-a").digest("hex").slice(0, 16);
  const f = fixture(t), cache = join(f.root, "cache", "pi-web-reader", `worktree-association-index-${device}.json`);
  f.save();
  writeFileSync(cache, "invalid index");
  assert.deepEqual(f.read(), []);
  f.save();
  assert.deepEqual(f.read(), f.records);
  const unrelated = join(f.root, "unrelated");
  writeFileSync(unrelated, "keep this file");
  rmSync(cache);
  try { symlinkSync(unrelated, cache); } catch (error) {
    if (["EPERM", "ENOSYS"].includes(error.code)) { t.skip("symlinks are unavailable"); return; }
    throw error;
  }
  assert.deepEqual(f.read(), []);
  f.save();
  assert.equal(readFileSync(unrelated, "utf8"), "keep this file");
});

test("a changed file is only a hint; replacement, truncation or a replaced worktree invalidates it", (t) => {
  const f = fixture(t);
  f.save();
  appendFileSync(f.path, "release\n");
  assert.deepEqual(f.read(), f.records, "appended histories can use the old association only as a provisional hint");
  writeFileSync(f.path, "x");
  assert.deepEqual(f.read(), [], "truncation cannot reuse an old hint");
  writeFileSync(f.path, "session\n"); f.save();
  writeFileSync(f.path + ".new", "session\n"); renameSync(f.path + ".new", f.path);
  assert.deepEqual(f.read(), [], "a replacement inode must be rejected");
  f.save();
  renameSync(f.linked, f.linked + ".old"); mkdirSync(f.linked);
  assert.deepEqual(f.read(), [], "a reused worktree path must not inherit a previous directory identity");
});
