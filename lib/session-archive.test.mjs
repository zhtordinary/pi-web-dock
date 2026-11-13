import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("moves parent-owned child session tree and rewrites nested parent links", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { movePiSessionFile, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const projectDir = "project-a";
    const parent = join(sessionsDir, projectDir, "parent.jsonl");
    const childRoot = join(sessionsDir, projectDir, "parent");
    const child = join(childRoot, "run-1", "run-0", "session.jsonl");
    const nestedChild = join(childRoot, "run-1", "run-0", "session", "run-2", "run-0", "session.jsonl");
    const artifacts = join(sessionsDir, projectDir, "subagent-artifacts", "other-run.jsonl");
    const archivedParent = join(archivedSessionsDir, projectDir, "parent.jsonl");
    const archivedChildRoot = join(archivedSessionsDir, projectDir, "parent");
    const archivedChild = join(archivedChildRoot, "run-1", "run-0", "session.jsonl");
    const archivedNestedChild = join(archivedChildRoot, "run-1", "run-0", "session", "run-2", "run-0", "session.jsonl");

    mkdirSync(join(sessionsDir, projectDir), { recursive: true });
    mkdirSync(dirname(child), { recursive: true });
    mkdirSync(dirname(nestedChild), { recursive: true });
    mkdirSync(dirname(artifacts), { recursive: true });
    writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent" }) + "\n");
    writeFileSync(child, JSON.stringify({ type: "session", version: 3, id: "child", parentSession: parent }) + "\nchild\n");
    writeFileSync(nestedChild, JSON.stringify({ type: "session", version: 3, id: "nested", parentSession: child }) + "\nnested\n");
    writeFileSync(artifacts, "shared artifact\n");

    assert.equal(movePiSessionFile(parent, true), archivedParent);
    assert.equal(readFileSync(archivedChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "child", parentSession: archivedParent }));
    assert.equal(readFileSync(archivedNestedChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "nested", parentSession: archivedChild }));
    assert.equal(readFileSync(artifacts, "utf8"), "shared artifact\n");
    assert.equal(movePiSessionFile(archivedParent, false), parent);
    assert.equal(readFileSync(child, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "child", parentSession: parent }));
    assert.equal(readFileSync(nestedChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "nested", parentSession: child }));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reconciles disjoint child trees after a legacy child-only archive", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-split-tree-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { movePiSessionFile, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const sourceChildRoot = join(sessionsDir, "project-a", "parent");
    const sourceChild = join(sourceChildRoot, "keep", "run-0", "session.jsonl");
    const sourceSidecar = join(sourceChildRoot, "moved", "run-0", "session.jsonl.writer.sqlite");
    const targetChildRoot = join(archivedSessionsDir, "project-a", "parent");
    const targetChild = join(targetChildRoot, "moved", "run-0", "session.jsonl");
    const archivedParent = join(archivedSessionsDir, "project-a", "parent.jsonl");

    mkdirSync(dirname(sourceChild), { recursive: true });
    mkdirSync(dirname(sourceSidecar), { recursive: true });
    mkdirSync(dirname(targetChild), { recursive: true });
    writeFileSync(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent" })}\n`);
    writeFileSync(sourceChild, `${JSON.stringify({ type: "session", version: 3, id: "keep", parentSession: parent })}\nkeep\n`);
    writeFileSync(sourceSidecar, "");
    writeFileSync(targetChild, `${JSON.stringify({ type: "session", version: 3, id: "moved", parentSession: parent })}\nmoved\n`);

    assert.equal(movePiSessionFile(parent, true), archivedParent);
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(sourceChild), false);
    assert.equal(existsSync(sourceSidecar), true);
    assert.equal(readFileSync(join(targetChildRoot, "keep", "run-0", "session.jsonl"), "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "keep", parentSession: archivedParent }));
    assert.equal(readFileSync(targetChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "moved", parentSession: archivedParent }));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("moves past writer-only source child residue while retaining archived children", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-writer-residue-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { movePiSessionFile, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const sourceChildRoot = join(sessionsDir, "project-a", "parent");
    const sourceSidecar = join(sourceChildRoot, "session.jsonl.writer.sqlite");
    const targetChild = join(archivedSessionsDir, "project-a", "parent", "child", "run-0", "session.jsonl");
    const archivedParent = join(archivedSessionsDir, "project-a", "parent.jsonl");

    mkdirSync(dirname(sourceSidecar), { recursive: true });
    mkdirSync(dirname(targetChild), { recursive: true });
    writeFileSync(parent, `${JSON.stringify({ type: "session", version: 3, id: "parent" })}\n`);
    writeFileSync(sourceSidecar, "writer\n");
    writeFileSync(targetChild, `${JSON.stringify({ type: "session", version: 3, id: "child", parentSession: parent })}\nchild\n`);

    assert.equal(movePiSessionFile(parent, true), archivedParent);
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(sourceSidecar), true);
    assert.equal(readFileSync(targetChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", version: 3, id: "child", parentSession: archivedParent }));
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("moves a deleted session bundle into TokenMonitor deleted_sessions", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-deleted-move-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { movePiSessionToDeleted, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, deletedSessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const child = join(sessionsDir, "project-a", "parent", "run-1", "session.jsonl");
    const deletedParent = join(deletedSessionsDir, "project-a", "parent.jsonl");
    const deletedChild = join(deletedSessionsDir, "project-a", "parent", "run-1", "session.jsonl");
    const sibling = join(sessionsDir, "project-a", "sibling.jsonl");
    const siblingOriginal = `${JSON.stringify({ type: "session", id: "sibling", parentSession: parent })}\n`;
    const external = join(sessionsDir, "project-a", "subagent-artifacts", "trace.jsonl");

    mkdirSync(dirname(child), { recursive: true });
    mkdirSync(dirname(sibling), { recursive: true });
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    writeFileSync(child, `${JSON.stringify({ type: "session", id: "child", parentSession: parent })}\nchild\n`);
    writeFileSync(sibling, siblingOriginal);
    writeFileSync(external, "artifact\n");

    assert.equal(movePiSessionToDeleted(parent, [{
      path: sibling,
      originalContent: siblingOriginal,
      nextContent: `${JSON.stringify({ type: "session", id: "sibling" })}\n`,
    }]), deletedParent);
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(join(sessionsDir, "project-a", "parent")), false);
    assert.equal(readFileSync(deletedChild, "utf8").split("\n", 1)[0], JSON.stringify({ type: "session", id: "child", parentSession: deletedParent }));
    assert.equal(JSON.parse(readFileSync(sibling, "utf8"))["parentSession"], undefined);
    assert.equal(readFileSync(external, "utf8"), "artifact\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refuses child-tree target collision without moving the parent", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-conflict-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { movePiSessionFile, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const childRoot = join(sessionsDir, "project-a", "parent");
    const targetChildRoot = join(archivedSessionsDir, "project-a", "parent");
    mkdirSync(join(sessionsDir, "project-a"), { recursive: true });
    mkdirSync(dirname(join(childRoot, "run-0", "session.jsonl")), { recursive: true });
    mkdirSync(targetChildRoot, { recursive: true });
    writeFileSync(parent, JSON.stringify({ type: "session", version: 3, id: "parent" }) + "\n");
    writeFileSync(join(childRoot, "run-0", "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "child", parentSession: parent }) + "\n");
    writeFileSync(join(targetChildRoot, "marker.txt"), "existing\n");

    assert.throws(() => movePiSessionFile(parent, true), /Session child archive target already exists/);
    assert.equal(readFileSync(parent, "utf8").includes('"id":"parent"'), true);
    assert.equal(readFileSync(join(targetChildRoot, "marker.txt"), "utf8"), "existing\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("refuses overwriting an existing opposite-root session file", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-file-conflict-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile, SessionArchiveConflictError } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "session.jsonl");
    const target = join(archivedSessionsDir, "project-a", "session.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "file-conflict" }) + "\n");
    writeFileSync(target, "keep-existing\n");

    assert.throws(() => movePiSessionFile(source, true), SessionArchiveConflictError);
    assert.equal(readFileSync(source, "utf8").includes('"id":"file-conflict"'), true);
    assert.equal(readFileSync(target, "utf8"), "keep-existing\n");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("refuses a different target filename with the same session id", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-id-collision-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile, SessionArchiveConflictError } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "active.jsonl");
    const target = join(archivedSessionsDir, "project-a", "active.jsonl");
    const otherTarget = join(archivedSessionsDir, "project-a", "older-name.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const header = JSON.stringify({ type: "session", version: 3, id: "same-id" });
    writeFileSync(source, `${header}\nactive\n`);
    writeFileSync(otherTarget, `${header}\narchived\n`);

    assert.throws(() => movePiSessionFile(source, true), SessionArchiveConflictError);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(otherTarget), true);
    assert.equal(existsSync(target), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("reconciles a stale opposite-root copy and makes retries idempotent", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-reconcile-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "session.jsonl");
    const target = join(archivedSessionsDir, "project-a", "session.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const header = JSON.stringify({ type: "session", version: 3, id: "reconcile" });
    const oldContent = `${header}\nold\n`;
    const latestContent = `${oldContent}new\n`;
    writeFileSync(source, latestContent);
    writeFileSync(target, oldContent);

    assert.equal(movePiSessionFile(source, true), target);
    assert.equal(readFileSync(target, "utf8"), latestContent);
    assert.equal(existsSync(source), false);
    assert.equal(movePiSessionFile(source, true), target);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("unarchives past a headerless fragment left by a late writer", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-fragment-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(archivedSessionsDir, "project-a", "session.jsonl");
    const target = join(sessionsDir, "project-a", "session.jsonl");
    const sourceChildRoot = join(archivedSessionsDir, "project-a", "session");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(join(sourceChildRoot, "run-0"), { recursive: true });
    const realContent = `${JSON.stringify({ type: "session", version: 3, id: "frag", cwd: "/tmp/project-a" })}\nmsg\n`;
    writeFileSync(source, realContent);
    writeFileSync(join(sourceChildRoot, "run-0", "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "child" }) + "\n");
    // A late writer recreated the active path with one control entry only.
    writeFileSync(target, JSON.stringify({ type: "custom", customType: "plan-mode-state", data: { enabled: false } }) + "\n");

    assert.equal(movePiSessionFile(source, false), target);
    assert.equal(readFileSync(target, "utf8"), realContent);
    assert.equal(existsSync(source), false);
    assert.equal(existsSync(join(sessionsDir, "project-a", "session", "run-0", "session.jsonl")), true);
    // The residue is preserved for inspection, never deleted.
    const backupDir = join(tempRoot, "agent", "session-repair-backups", "archive-collisions");
    assert.equal(readdirSync(backupDir).some((name) => name.includes("stale-fragment")), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("archiving keeps the session and preserves the residue left on the active path", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-residue-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "session.jsonl");
    const target = join(archivedSessionsDir, "project-a", "session.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const realContent = `${JSON.stringify({ type: "session", version: 3, id: "residue", cwd: "/tmp/project-a" })}\nmsg\n`;
    writeFileSync(target, realContent);
    writeFileSync(source, JSON.stringify({ type: "custom", customType: "plan-mode-state", data: { enabled: false } }) + "\n");

    assert.equal(movePiSessionFile(source, true), target);
    assert.equal(readFileSync(target, "utf8"), realContent);
    assert.equal(existsSync(source), false);
    const backupDir = join(tempRoot, "agent", "session-repair-backups", "archive-collisions");
    assert.equal(readdirSync(backupDir).some((name) => name.includes("stale-fragment")), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("stays fail-closed when neither side is a session file", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-bothfrag-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile, SessionArchiveConflictError } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "session.jsonl");
    const target = join(archivedSessionsDir, "project-a", "session.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    const fragment = JSON.stringify({ type: "custom", customType: "plan-mode-state", data: { enabled: false } }) + "\n";
    writeFileSync(source, fragment);
    writeFileSync(target, fragment);

    assert.throws(() => movePiSessionFile(source, true), SessionArchiveConflictError);
    assert.equal(existsSync(source), true);
    assert.equal(existsSync(target), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("stays fail-closed when a residue move left the child tree behind", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-strandedchild-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, movePiSessionFile, SessionArchiveConflictError } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    // Interrupted move: the parent already reached the target, but its child
    // tree is still on the source side, whose path holds only a residue.
    const source = join(sessionsDir, "project-a", "session.jsonl");
    const target = join(archivedSessionsDir, "project-a", "session.jsonl");
    const sourceChildRoot = join(sessionsDir, "project-a", "session");
    mkdirSync(dirname(source), { recursive: true });
    mkdirSync(dirname(target), { recursive: true });
    mkdirSync(join(sourceChildRoot, "run-0"), { recursive: true });
    writeFileSync(join(sourceChildRoot, "run-0", "session.jsonl"), JSON.stringify({ type: "session", version: 3, id: "stranded" }) + "\n");
    writeFileSync(target, `${JSON.stringify({ type: "session", version: 3, id: "stranded", cwd: "/tmp/project-a" })}\nmsg\n`);
    writeFileSync(source, JSON.stringify({ type: "custom", customType: "plan-mode-state", data: { enabled: false } }) + "\n");

    assert.throws(() => movePiSessionFile(source, true), SessionArchiveConflictError);
    assert.equal(existsSync(join(sourceChildRoot, "run-0", "session.jsonl")), true);
    assert.equal(existsSync(source), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("flags recent session writes but allows settled files", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-mtime-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { isSessionFileRecentlyChanged } = await createJiti(import.meta.url).import("./session-archive.ts");
    const file = join(tempRoot, "session.jsonl");
    writeFileSync(file, "session\n");
    assert.equal(isSessionFileRecentlyChanged(file), true);
    const old = (Date.now() - 120_000) / 1000;
    utimesSync(file, old, old);
    assert.equal(isSessionFileRecentlyChanged(file), false);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("does not reblock an unchanged file after a Reader-owned move", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-archive-owned-move-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { getPiSessionRoots, isSessionFileRecentlyChanged, movePiSessionFile } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir } = getPiSessionRoots();
    const source = join(sessionsDir, "project-a", "session.jsonl");
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, JSON.stringify({ type: "session", version: 3, id: "owned-move" }) + "\n");

    const archived = movePiSessionFile(source, true);
    assert.equal(isSessionFileRecentlyChanged(archived), false);
    const restored = movePiSessionFile(archived, false);
    assert.equal(isSessionFileRecentlyChanged(restored), false);

    writeFileSync(restored, "external write\n", { flag: "a" });
    assert.equal(isSessionFileRecentlyChanged(restored), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
test("TokenMonitor metadata sync stays optional and clears stale lifecycle flags", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-token-monitor-optional-"));
  try {
    const { setTokenMonitorArchivedFlag, setTokenMonitorDeletedFlag, clearTokenMonitorLifecycleFlags } = await createJiti(import.meta.url).import("./session-archive.ts");
    const sessionFile = join(tempRoot, "session.jsonl");
    const storageDir = join(tempRoot, "token-monitor");
    writeFileSync(sessionFile, "session\n");

    setTokenMonitorArchivedFlag(sessionFile, true, storageDir);
    assert.equal(existsSync(storageDir), false, "Reader must not create TokenMonitor storage");

    mkdirSync(storageDir, { recursive: true });
    writeFileSync(join(storageDir, "pi-token-window-monitor.archived.json"), JSON.stringify({ session: true }));
    writeFileSync(join(storageDir, "pi-token-window-monitor.deleted.json"), JSON.stringify({ session: true }));
    setTokenMonitorArchivedFlag(sessionFile, false, storageDir);
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, "pi-token-window-monitor.archived.json"), "utf8")), {});
    setTokenMonitorDeletedFlag(sessionFile, false, storageDir);
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, "pi-token-window-monitor.deleted.json"), "utf8")), {});
    setTokenMonitorDeletedFlag(sessionFile, true, storageDir);
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, "pi-token-window-monitor.deleted.json"), "utf8")), { session: true });

    clearTokenMonitorLifecycleFlags(sessionFile, storageDir);
    assert.deepEqual(JSON.parse(readFileSync(join(storageDir, "pi-token-window-monitor.deleted.json"), "utf8")), {});
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});


test("permanent delete removes parent-owned nested tree but not external child", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-delete-tree-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { deletePiSessionTree, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const ownedChild = join(sessionsDir, "project-a", "parent", "run-1", "run-0", "session.jsonl");
    const ownedArtifact = join(sessionsDir, "project-a", "parent", "subagent-artifacts", "trace.jsonl");
    const external = join(sessionsDir, "project-b", "external.jsonl");
    mkdirSync(dirname(ownedChild), { recursive: true });
    mkdirSync(dirname(ownedArtifact), { recursive: true });
    mkdirSync(dirname(external), { recursive: true });
    writeFileSync(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    writeFileSync(ownedChild, JSON.stringify({ type: "session", id: "child" }) + "\n");
    writeFileSync(ownedArtifact, "artifact\n");
    writeFileSync(external, JSON.stringify({ type: "session", id: "external" }) + "\n");

    deletePiSessionTree(parent);
    assert.equal(existsSync(parent), false);
    assert.equal(existsSync(join(sessionsDir, "project-a", "parent")), false);
    assert.equal(existsSync(external), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("permanent delete fails closed when owned child path is not a directory", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-reader-session-delete-boundary-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { deletePiSessionTree, getPiSessionRoots } = await createJiti(import.meta.url).import("./session-archive.ts");
    const { sessionsDir } = getPiSessionRoots();
    const parent = join(sessionsDir, "project-a", "parent.jsonl");
    const childPath = join(sessionsDir, "project-a", "parent");
    mkdirSync(dirname(parent), { recursive: true });
    writeFileSync(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    writeFileSync(childPath, "not-a-directory\n");

    assert.throws(() => deletePiSessionTree(parent), /not a directory/);
    assert.equal(existsSync(parent), true);
    assert.equal(existsSync(childPath), true);
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

for (const failure of ["backup", "partial-delete", "restore", "cleanup", "related"]) {
  test(`delete transaction preserves complete evidence on ${failure} failure`, async () => {
    const fs = await import("node:fs");
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const ts = require("typescript");
    const root = mkdtempSync(join(tmpdir(), "usage4-delete-fault-"));
    try {
      const agent = join(root, "agent");
      const parent = join(agent, "sessions", "p", "parent.jsonl");
      const child = join(agent, "sessions", "p", "parent", "child.jsonl");
      const sibling = join(agent, "sessions", "p", "sibling.jsonl");
      mkdirSync(dirname(child), { recursive: true });
      writeFileSync(parent, "complete parent\n");
      writeFileSync(child, "complete child\n");
      writeFileSync(sibling, "original sibling\n");
      let relatedWrites = 0;
      const fakeFs = { ...fs,
        cpSync(source, target, options) {
          if (failure === "backup" && target.endsWith("/backup/children")) throw new Error("synthetic backup failure");
          if (failure === "restore" && target.endsWith("/restore")) throw new Error("synthetic restore failure");
          return fs.cpSync(source, target, options);
        },
        writeFileSync(target, data, options) {
          if (failure === "related" && target === sibling && relatedWrites++ === 0) throw new Error("synthetic sibling write failure");
          return fs.writeFileSync(target, data, options);
        },
        rmSync(target, options) {
          if (["partial-delete", "restore"].includes(failure) && target.endsWith("/detached")) {
            fs.rmSync(join(target, "session.jsonl"));
            throw new Error("synthetic partial removal");
          }
          if (failure === "cleanup" && /permanent-delete\/delete-[^/]+$/.test(target)) throw new Error("synthetic cleanup failure");
          return fs.rmSync(target, options);
        },
      };
      const source = readFileSync(new URL("./session-archive.ts", import.meta.url), "utf8");
      const mod = { exports: {} };
      new Function("require", "module", "exports", ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText)(
        (name) => name === "fs" ? fakeFs : name === "@earendil-works/pi-coding-agent" ? { getAgentDir: () => agent } : name.startsWith("./") ? {} : require(name), mod, mod.exports);
      const related = [{ path: sibling, originalContent: "original sibling\n", nextContent: "reparented sibling\n" }];
      if (failure === "cleanup") {
        const result = mod.exports.deletePiSessionTree(parent, related);
        assert.equal(result.deleted, true);
        assert.ok(result.cleanupPending);
        assert.equal(existsSync(parent), false);
        assert.equal(existsSync(dirname(child)), false);
        assert.equal(readFileSync(sibling, "utf8"), "reparented sibling\n");
      } else {
        assert.throws(() => mod.exports.deletePiSessionTree(parent, related), /backup|restored/);
        if (failure !== "restore") {
          assert.equal(readFileSync(parent, "utf8"), "complete parent\n");
          assert.equal(readFileSync(child, "utf8"), "complete child\n");
        }
        if (failure !== "backup") {
          const recoveryRoot = join(agent, "session-repair-backups", "permanent-delete");
          const backup = join(recoveryRoot, fs.readdirSync(recoveryRoot)[0], "backup");
          assert.equal(readFileSync(join(backup, "session.jsonl"), "utf8"), "complete parent\n");
          assert.equal(readFileSync(join(backup, "children", "child.jsonl"), "utf8"), "complete child\n");
          assert.equal(readFileSync(join(backup, "siblings", "0.jsonl"), "utf8"), "original sibling\n");
          assert.ok(!backup.startsWith(join(agent, "sessions")));
          assert.equal(fs.statSync(dirname(backup)).mode & 0o777, 0o700);
        }
        if (failure !== "restore" && failure !== "backup") {
          assert.equal(readFileSync(sibling, "utf8"), "original sibling\n");
        }
        if (failure === "backup") {
          assert.equal(readFileSync(sibling, "utf8"), "original sibling\n");
        }
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
}
