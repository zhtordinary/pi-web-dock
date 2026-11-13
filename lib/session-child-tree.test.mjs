import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { isPiSubagentSessionPath, resolvePiSubagentBundleRoot } = await createJiti(import.meta.url).import("./session-child-tree.ts");

test("resolves a child to its parent bundle across active and archived roots", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reader-child-tree-"));
  try {
    const sessionsDir = join(root, "sessions");
    const archivedSessionsDir = join(root, "archived_sessions");
    const parent = join(sessionsDir, "project", "parent.jsonl");
    const archivedParent = join(archivedSessionsDir, "project", "parent.jsonl");
    const child = join(archivedSessionsDir, "project", "parent", "run-1", "run-0", "session.jsonl");
    mkdirSync(join(archivedSessionsDir, "project", "parent", "run-1", "run-0"), { recursive: true });
    mkdirSync(join(sessionsDir, "project"), { recursive: true });
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    writeFileSync(child, `${JSON.stringify({ type: "session", id: "child", parentSession: parent })}\n`);

    assert.equal(isPiSubagentSessionPath(archivedParent, child), true);
    assert.equal(resolvePiSubagentBundleRoot(child, { sessionsDir, archivedSessionsDir }), parent);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("does not treat an ordinary fork as a parent-owned child", () => {
  const root = mkdtempSync(join(tmpdir(), "pi-reader-child-tree-fork-"));
  try {
    const sessionsDir = join(root, "sessions");
    const archivedSessionsDir = join(root, "archived_sessions");
    const parent = join(sessionsDir, "project", "parent.jsonl");
    const fork = join(sessionsDir, "project", "fork.jsonl");
    mkdirSync(join(sessionsDir, "project"), { recursive: true });
    writeFileSync(parent, `${JSON.stringify({ type: "session", id: "parent" })}\n`);
    writeFileSync(fork, `${JSON.stringify({ type: "session", id: "fork", parentSession: parent })}\n`);

    assert.equal(isPiSubagentSessionPath(parent, fork), false);
    assert.equal(resolvePiSubagentBundleRoot(fork, { sessionsDir, archivedSessionsDir }), fork);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
