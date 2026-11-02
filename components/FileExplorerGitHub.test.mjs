import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("GitHub UI only renders the read-only snapshot and links", () => {
  assert.match(source, /git\/github/);
  assert.match(source, /gitHubSnapshot\.available/);
  assert.match(source, /gitHubPullRequests/);
  assert.match(source, /gitHubIssues/);
  assert.match(source, /gitHubChecks/);
  assert.match(source, /target="_blank" rel="noreferrer"/);
  assert.doesNotMatch(source, /git (reset|merge|push --force|branch -D)/);
});
