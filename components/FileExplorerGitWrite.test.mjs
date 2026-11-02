import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("Git write actions require a confirmation dialog and scoped payload", () => {
  assert.match(source, /git\/write/);
  assert.match(source, /pendingGitWrite/);
  assert.match(source, /gitWriteMessage/);
  assert.match(source, /gitWriteBranchName/);
  assert.match(source, /files\.gitWriteConfirm/);
  assert.match(source, /create-pr/);
  assert.doesNotMatch(source, /git (reset|merge|push --force|branch -D)/);
});

test("all Git write actions retain the confirmed peer and workspace", () => {
  assert.match(source, /setPendingGitWrite\(\{ action, paths, \.\.\.workspaceRef\.current \}\)/);
  assert.match(source, /pendingGitWrite\.generation !== workspaceRef\.current\.generation/);
  assert.match(source, /apiFor\(pendingGitWrite\.peer, isPullRequest \? "git\/github" : "git\/write"\)/);
  assert.match(source, /cwd: pendingGitWrite\.cwd/);
  assert.match(source, /if \(!isCurrent\(\)\) return/);
  assert.match(source, /if \(isCurrent\(\)\) setGitWriteBusy\(false\)/);
});
