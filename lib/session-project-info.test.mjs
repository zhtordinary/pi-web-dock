import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const sessionReader = await readFile(new URL("./session-reader.ts", import.meta.url), "utf8");
const types = await readFile(new URL("./types.ts", import.meta.url), "utf8");

test("session project hydration exposes branch metadata without breaking Reader aliases", () => {
  assert.match(sessionReader, /project \? \{ isGit: project\.isGit \}/);
  assert.match(sessionReader, /project\?\.branch \? \{ branch: project\.branch \} : \{\}/);
  assert.match(sessionReader, /isWorktree: true/);
  assert.match(sessionReader, /project\.branch \? \{ worktreeBranch: project\.branch \} : \{\}/);
});

test("SessionInfo keeps additive project metadata fields", () => {
  assert.match(types, /isGit\?: boolean;/);
  assert.match(types, /branch\?: string;/);
  assert.match(types, /isWorktree\?: boolean;/);
  assert.match(types, /worktreeBranch\?: string;/);
});
