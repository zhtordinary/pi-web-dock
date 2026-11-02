import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { getGitCommitDetail, getGitHistory, parseGitLog } = await jiti.import("./git-changes.ts");

function git(cwd, args) {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
}

test("parses bounded Git log records without trusting ref formatting", () => {
  const history = parseGitLog([
    "0123456789abcdef0123456789abcdef01234567",
    "0123456",
    "Ada",
    "2026-09-01T00:00:00+00:00",
    "subject",
    "HEAD -> main, origin/main",
  ].join("\0") + "\x1e");
  assert.equal(history.length, 1);
  assert.equal(history[0].shortHash, "0123456");
  assert.deepEqual(history[0].refs, ["HEAD -> main", "origin/main"]);
});

test("reads history and commit details through Git read commands", async () => {
  const cwd = mkdtempSync(join(tmpdir(), "pi-web-git-history-"));
  try {
    git(cwd, ["init", "-q"]);
    git(cwd, ["config", "user.email", "reader@example.test"]);
    git(cwd, ["config", "user.name", "Reader Test"]);
    writeFileSync(join(cwd, "one.txt"), "one\n");
    git(cwd, ["add", "one.txt"]);
    git(cwd, ["commit", "-qm", "first commit"]);
    writeFileSync(join(cwd, "one.txt"), "one\ntwo\n");
    git(cwd, ["commit", "-qam", "second commit"]);

    const history = await getGitHistory(cwd, 10);
    assert.equal(history.length, 2);
    assert.equal(history[0].subject, "second commit");
    const detail = await getGitCommitDetail(cwd, history[0].hash);
    assert.equal(detail.subject, "second commit");
    assert.deepEqual(detail.files, [{ path: "one.txt", status: "M" }]);
    assert.equal(await getGitHistory(join(cwd, "missing")), null);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});
