import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GitWriteError, runGitWrite } = await jiti.import("./git-write.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

function setupRepository() {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-git-write-"));
  git(cwd, ["init", "-q"]);
  git(cwd, ["config", "user.email", "reader@example.test"]);
  git(cwd, ["config", "user.name", "Reader Test"]);
  writeFileSync(join(cwd, "one.txt"), "one\n");
  git(cwd, ["add", "one.txt"]);
  git(cwd, ["commit", "-qm", "initial"]);
  return cwd;
}

test("stages and commits only the explicitly selected changed paths", async () => {
  const cwd = setupRepository();
  try {
    writeFileSync(join(cwd, "one.txt"), "one\ntwo\n");
    writeFileSync(join(cwd, "two.txt"), "two\n");
    const staged = await runGitWrite(cwd, "stage", { paths: ["one.txt"] });
    assert.deepEqual(staged.affectedPaths, ["one.txt"]);
    assert.equal(git(cwd, ["diff", "--cached", "--name-only"]), "one.txt");
    const committed = await runGitWrite(cwd, "commit", { paths: ["one.txt"], message: "fix: update one" });
    assert.equal(committed.branch, git(cwd, ["branch", "--show-current"]));
    assert.equal(git(cwd, ["log", "-1", "--format=%s"]), "fix: update one");
    assert.equal(readFileSync(join(cwd, "two.txt"), "utf8"), "two\n");
    assert.equal(git(cwd, ["status", "--porcelain"]), "?? two.txt");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("requires staged paths before commit and rejects paths outside cwd", async () => {
  const cwd = setupRepository();
  try {
    writeFileSync(join(cwd, "one.txt"), "changed\n");
    await assert.rejects(
      runGitWrite(cwd, "commit", { paths: ["one.txt"], message: "fix: changed" }),
      (error) => error instanceof GitWriteError && error.code === "paths_not_staged" && error.status === 409,
    );
    await assert.rejects(
      runGitWrite(cwd, "stage", { paths: ["../one.txt"] }),
      (error) => error instanceof GitWriteError && error.code === "invalid_path" && error.status === 400,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("pushes only through the configured upstream and creates a branch only when clean", async () => {
  const cwd = setupRepository();
  const remote = mkdtempSync(join(tmpdir(), "pi-web-git-remote-"));
  try {
    git(remote, ["init", "--bare", "-q"]);
    git(cwd, ["branch", "-M", "main"]);
    git(cwd, ["remote", "add", "origin", remote]);
    git(cwd, ["push", "-qu", "origin", "main"]);
    writeFileSync(join(cwd, "one.txt"), "one\ntwo\n");
    await runGitWrite(cwd, "stage", { paths: ["one.txt"] });
    await runGitWrite(cwd, "commit", { paths: ["one.txt"], message: "fix: update one" });
    const pushed = await runGitWrite(cwd, "push");
    assert.equal(pushed.upstream, "origin/main");
    assert.equal(git(remote, ["log", "-1", "--format=%s", "main"]), "fix: update one");
    const branch = await runGitWrite(cwd, "create-branch", { branchName: "feature/read-only-confirm" });
    assert.equal(branch.branch, "feature/read-only-confirm");
    writeFileSync(join(cwd, "dirty.txt"), "dirty\n");
    await assert.rejects(
      runGitWrite(cwd, "create-branch", { branchName: "feature/blocked" }),
      (error) => error instanceof GitWriteError && error.code === "dirty_worktree" && error.status === 409,
    );
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(remote, { recursive: true, force: true });
  }
});
