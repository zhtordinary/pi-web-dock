import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("archived paths and stale active pointers cannot execute; explicit restoration restores eligibility", async () => {
  const root = mkdtempSync(join(tmpdir(), "reader-archived-execution-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const { assertSessionFileExecutable } = await createJiti(import.meta.url).import("./session-archive.ts");
    mkdirSync(join(root, "sessions")); mkdirSync(join(root, "archived_sessions"));
    const active = join(root, "sessions", "a.jsonl"), archived = join(root, "archived_sessions", "a.jsonl");
    writeFileSync(active, "history\n");
    assert.doesNotThrow(() => assertSessionFileExecutable(active));
    renameSync(active, archived);
    assert.throws(() => assertSessionFileExecutable(archived), { code: "session_archived" });
    assert.throws(() => assertSessionFileExecutable(active), { code: "session_archived" });
    assert.equal(existsSync(active), false);
    renameSync(archived, active);
    assert.doesNotThrow(() => assertSessionFileExecutable(active));
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
