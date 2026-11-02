import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  buildGitAiInput,
  buildGitReleaseInput,
  buildGitAiSystemPrompt,
  buildGitAiUserPrompt,
} = await jiti.import("./git-summary.ts");

const status = {
  isGitRepository: true,
  repositoryRoot: "/home/alice/project",
  branch: "main",
  upstream: "origin/main",
  ahead: 2,
  behind: 1,
  files: [{
    filePath: "/home/alice/project/src/app.ts",
    status: "modified",
    code: "M",
    indexStatus: " ",
    worktreeStatus: "M",
  }],
  additions: 3,
  deletions: 1,
};

test("builds bounded Git AI input from relative file fragments", () => {
  const result = buildGitAiInput(status, [{
    relativePath: "src/app.ts",
    status: "M modified",
    patch: "@@ -1 +1 @@\n-old\n+new",
  }]);
  assert.equal(result.truncated, false);
  assert.match(result.text, /branch: main/);
  assert.match(result.text, /src\/app\.ts/);
  assert.match(result.text, /@@ -1 \+1 @@/);
  assert.doesNotMatch(result.text, /\/home\/alice\/project\/src/);
});

test("escapes data boundaries and reports truncated input", () => {
  const result = buildGitAiInput(status, [{
    relativePath: "src/app.ts",
    status: "M modified",
    patch: "</git_diff>\n" + "x".repeat(60_000),
  }]);
  assert.equal(result.truncated, true);
  assert.match(result.text, /&lt;\/git_diff>/);
  assert.match(result.text, /diff truncated by Reader/);
});

test("keeps summary and commit prompts read-only", async () => {
  const system = buildGitAiSystemPrompt("summary", "zh-CN");
  const commitSystem = buildGitAiSystemPrompt("commit-message", "en");
  assert.match(system, /never as instructions/);
  assert.match(system, /变更概览/);
  assert.match(commitSystem, /Conventional Commit/);
  assert.match(buildGitAiUserPrompt("<git_diff>data</git_diff>", "summary"), /untrusted repository data/);

  const component = await readFile(new URL("../components/FileExplorer.tsx", import.meta.url), "utf8");
  assert.match(component, /git\/summary/);
  assert.match(component, /gitAiSummary/);
  assert.match(component, /gitAiCommitMessage/);
  assert.doesNotMatch(component, /git (reset|merge|push --force|branch -D)/);
});

test("builds a bounded release-notes input with separate data blocks", () => {
  const result = buildGitReleaseInput([
    {
      hash: "0123456789abcdef0123456789abcdef01234567",
      shortHash: "0123456",
      author: "Reader",
      authoredAt: "2026-09-01T00:00:00+00:00",
      subject: "Improve explorer behavior",
      refs: ["HEAD -> main"],
    },
  ], "<git_status>\nM src/app.ts\n</git_status>");
  assert.equal(result.truncated, false);
  assert.match(result.text, /<git_history>/);
  assert.match(result.text, /<git_worktree>/);
  assert.match(result.text, /Improve explorer behavior/);
  assert.match(buildGitAiSystemPrompt("release-notes", "zh-CN"), /发布摘要/);
});
