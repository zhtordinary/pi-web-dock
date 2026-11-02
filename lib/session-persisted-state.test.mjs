import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readdir, readFile, writeFile, stat, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { readPersistedSessionState } = await jiti.import("./session-persisted-state.ts");
const { readSessionAutoCompaction, SESSION_AUTO_COMPACTION_TYPE } = await jiti.import("./session-auto-compaction.ts");
const entry = (value, id = "choice", version = 1) => ({ type: "custom", customType: SESSION_AUTO_COMPACTION_TYPE, id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", data: { version, autoCompactionEnabled: value } });
const header = { type: "session", version: 2, id: "frozen-session", cwd: "/missing/historical-tree", timestamp: "2026-01-01T00:00:00.000Z" };
async function fixture(t, rows) {
  const root = await mkdtemp(join(tmpdir(), "reader-persisted-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, "session.jsonl");
  await writeFile(file, rows.map(row => typeof row === "string" ? row : JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
  return file;
}
function identity(stat) { return [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeMs, stat.ctimeMs]; }
for (const enabled of [true, false]) {
  test(`read-only session returns persisted ${enabled} even with a missing cwd and an unrelated extension entry`, async t => {
    const file = await fixture(t, [header, { type: "custom", customType: "other-extension", id: "other", data: { worktree: "/missing/tree" } }, entry(enabled)]);
    const bytes = await readFile(file); const before = identity(await stat(file));
    assert.deepEqual(await readPersistedSessionState(file, header.id), { autoCompactionEnabled: enabled });
    assert.deepEqual(await readFile(file), bytes); assert.deepEqual(identity(await stat(file)), before);
  });
}
test("malformed latest value, future versions, truncation and duplicate conflicts are unknown without rewriting", async t => {
  const cases = [ [entry("false")], [entry(false), entry(true, "newer", 2)], [entry(true, "same"), entry(false, "same")], ["{broken"], [entry(false), "{\"type\":\"custom\""]];
  for (const rows of cases) {
    const file = await fixture(t, [header, ...rows]); const bytes = await readFile(file); const before = identity(await stat(file));
    await assert.rejects(readPersistedSessionState(file, header.id));
    assert.deepEqual(await readFile(file), bytes); assert.deepEqual(identity(await stat(file)), before);
  }
  const empty = await fixture(t, []); await writeFile(empty, "");
  await assert.rejects(readPersistedSessionState(empty, header.id)); assert.equal((await stat(empty)).size, 0);
});
test("session identity and symlink rejection do not mutate or create session files", async t => {
  const file = await fixture(t, [header, entry(false)]); const bytes = await readFile(file);
  await assert.rejects(readPersistedSessionState(file, "another-session"), /identity/);
  const link = file + ".link"; await symlink(file, link);
  await assert.rejects(readPersistedSessionState(link, header.id));
  await assert.rejects(readPersistedSessionState(file + ".absent", header.id));
  assert.deepEqual(await readFile(file), bytes);
});
test("latest explicit metadata wins across branches but custom messages and global-like fields never supply defaults", () => {
  assert.equal(readSessionAutoCompaction([entry(true, "first"), { ...entry(false, "second"), parentId: null }]), false);
  assert.equal(readSessionAutoCompaction([{ ...entry(true), type: "custom_message" }, { autoCompactionEnabled: true }]), undefined);
  assert.throws(() => readSessionAutoCompaction([entry(true), entry(false, "newer", 99)]), /Invalid/);
  assert.throws(() => readSessionAutoCompaction([entry(false), entry(false)]), /Conflicting/);
});
test("a large unrelated context message cannot leak into the compact persisted response", async t => {
  const file = await fixture(t, [header, { type: "message", id: "giant", message: { role: "user", content: "x".repeat(3_000_000) } }, entry(false)]);
  const result = await readPersistedSessionState(file, header.id);
  assert.deepEqual(Object.keys(result), ["autoCompactionEnabled"]);
  assert.ok(JSON.stringify(result).length < 100);
});

async function inheritedFixture(t, { global, project, trusted = false, marker } = {}) {
  const file = await fixture(t, []);
  const root = join(file, "..");
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(join(cwd, ".pi"), { recursive: true });
  await mkdir(agentDir);
  for (const [path, value] of [[join(agentDir, "settings.json"), global], [join(cwd, ".pi", "settings.json"), project]]) {
    if (value !== undefined) await writeFile(path, typeof value === "string" ? value : JSON.stringify(value));
  }
  if (trusted) {
    const { ProjectTrustStore } = await import("@earendil-works/pi-coding-agent");
    new ProjectTrustStore(agentDir).set(cwd, true);
  }
  await writeFile(file, [JSON.stringify({ ...header, cwd }), ...(marker === undefined ? [] : [JSON.stringify(entry(marker))])].join("\n") + "\n");
  return { file, cwd, agentDir, read: () => readPersistedSessionState(file, header.id, agentDir) };
}

for (const [name, options, expected] of [
  ["SDK default without creating settings", {}, true],
  ["global disabled", { global: { compaction: { enabled: false } } }, false],
  ["trusted project disabled overrides global enabled", { global: { compaction: { enabled: true } }, project: { compaction: { enabled: false } }, trusted: true }, false],
  ["trusted project enabled overrides global disabled", { global: { compaction: { enabled: false } }, project: { compaction: { enabled: true } }, trusted: true }, true],
  ["untrusted project cannot override global", { global: { compaction: { enabled: false } }, project: { compaction: { enabled: true } } }, false],
  ["untrusted malformed project is not read", { global: { compaction: { enabled: false } }, project: "{broken" }, false],
]) {
  test(`markerless cold session resolves ${name} without mutating any file`, async t => {
    const f = await inheritedFixture(t, options);
    const bytes = await readFile(f.file); const before = identity(await stat(f.file));
    const settingsBefore = await readdir(f.agentDir);
    assert.deepEqual(await f.read(), { autoCompactionEnabled: expected, autoCompactionSource: "inherited" });
    assert.deepEqual(await readFile(f.file), bytes);
    assert.deepEqual(identity(await stat(f.file)), before);
    assert.deepEqual(await readdir(f.agentDir), settingsBefore);
  });
}

for (const marker of [true, false]) {
  test(`explicit ${marker} remains authoritative even when inherited settings cannot be read`, async t => {
    const f = await inheritedFixture(t, { marker, global: "{broken", project: "{broken", trusted: true });
    assert.deepEqual(await f.read(), { autoCompactionEnabled: marker });
  });
}

test("markerless inheritance does not convert corrupt settings into a successful default", async t => {
  for (const value of ["{broken", "[]", { compaction: { enabled: "false" } }, { compaction: false }]) {
    for (const scope of ["global", "project"]) {
      const f = await inheritedFixture(t, { [scope]: value, trusted: true });
      await assert.rejects(f.read());
    }
  }
});

test("markerless session requires its recorded cwd, not the Reader installation cwd", async t => {
  const f = await inheritedFixture(t, { global: { compaction: { enabled: false } } });
  for (const cwd of [undefined, "relative/project", 123]) {
    await writeFile(f.file, JSON.stringify({ ...header, cwd }) + "\n");
    await assert.rejects(f.read(), /cwd/i);
  }
});
