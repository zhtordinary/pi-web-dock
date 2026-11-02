import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("Git history UI stays read-only and loads commit details", () => {
  assert.match(source, /git\/history/);
  assert.match(source, /gitHistoryOpen/);
  assert.match(source, /loadGitCommitDetail/);
  assert.match(source, /files\.gitHistory/);
  assert.match(source, /gitAiReleaseNotes/);
  assert.doesNotMatch(source, /git (reset|merge|push --force|branch -D)/);
});
