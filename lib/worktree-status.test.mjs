import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parsePorcelainStatusZ, summarizePorcelainStatus } = await jiti.import("./worktree.ts");

test("porcelain -z status keeps leading columns and rename records together", () => {
  const output = [
    " M credentials.env",
    "?? notes.txt",
    "!! ignored.log",
    "R  renamed.txt",
    "credentials.json",
    "",
  ].join("\0");
  const entries = parsePorcelainStatusZ(output);
  assert.deepEqual(entries.map((entry) => entry.status), [" M", "??", "!!", "R "]);
  assert.deepEqual(entries[3]?.paths, ["renamed.txt", "credentials.json"]);

  assert.deepEqual(summarizePorcelainStatus(output), {
    state: "dirty",
    hasUncommitted: true,
    dirtyCount: 3,
    stagedCount: 1,
    unstagedCount: 1,
    untrackedCount: 1,
    ignoredCount: 1,
  });
});

test("empty porcelain status is a clean summary", () => {
  assert.deepEqual(summarizePorcelainStatus(""), {
    state: "clean",
    hasUncommitted: false,
    dirtyCount: 0,
    stagedCount: 0,
    unstagedCount: 0,
    untrackedCount: 0,
    ignoredCount: 0,
  });
});
