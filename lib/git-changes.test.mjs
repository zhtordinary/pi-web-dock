import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

async function loadSubject() {
  return import("./git-status.ts");
}

test("parses null-delimited Git status entries including renames", async () => {
  const { parseGitPorcelainV1 } = await loadSubject();
  const entries = parseGitPorcelainV1([
    " M components/App.tsx",
    "?? notes.txt",
    "R  src/new-name.ts",
    "src/old-name.ts",
    "",
  ].join("\0"));

  assert.deepEqual(entries, [
    {
      path: "components/App.tsx",
      indexStatus: " ",
      worktreeStatus: "M",
    },
    {
      path: "notes.txt",
      indexStatus: "?",
      worktreeStatus: "?",
    },
    {
      path: "src/new-name.ts",
      originalPath: "src/old-name.ts",
      indexStatus: "R",
      worktreeStatus: " ",
    },
  ]);
});

test("classifies Git status for explorer badges", async () => {
  const { classifyGitStatus } = await loadSubject();
  const classify = (pair) => classifyGitStatus({
    path: "file.ts",
    indexStatus: pair[0],
    worktreeStatus: pair[1],
  });

  assert.deepEqual(classify(" M"), { status: "modified", code: "M" });
  assert.deepEqual(classify("??"), { status: "untracked", code: "U" });
  assert.deepEqual(classify("A "), { status: "added", code: "A" });
  assert.deepEqual(classify("R "), { status: "renamed", code: "R" });
  assert.deepEqual(classify("UU"), { status: "conflict", code: "C" });
  assert.deepEqual(classify(" D"), { status: "deleted", code: "D" });
});

async function loadGitChanges() {
  return createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false }).import("./git-changes.ts");
}

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}

function createFixtureRepository() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-diff-")));
  git(root, ["init", "--quiet"]);
  fs.writeFileSync(path.join(root, "tracked.txt"), "before\n");
  git(root, ["add", "tracked.txt"]);
  git(root, ["-c", "user.name=Reader Test", "-c", "user.email=reader@example.invalid", "commit", "--quiet", "-m", "fixture"]);
  return root;
}

test("authorizes physical Git targets and keeps deleted files diffable", async (t) => {
  const { getGitFileDiff } = await loadGitChanges();
  const root = createFixtureRepository();
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  fs.writeFileSync(path.join(root, "tracked.txt"), "after\n");
  const modified = await getGitFileDiff(root, path.join(root, "tracked.txt"));
  assert.equal(modified.supported, true);
  assert.equal(modified.status, "modified");
  assert.match(modified.patch, /-before/);
  assert.match(modified.patch, /\+after/);

  fs.unlinkSync(path.join(root, "tracked.txt"));
  const deleted = await getGitFileDiff(root, path.join(root, "tracked.txt"));
  assert.equal(deleted.supported, true);
  assert.equal(deleted.status, "deleted");
  assert.match(deleted.patch, /-before/);
});

test("rejects non-repository, unrecognized missing, and physical escape targets", async (t) => {
  const { getGitFileDiff } = await loadGitChanges();
  const root = createFixtureRepository();
  const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-outside-")));
  t.after(() => {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  });

  fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
  fs.symlinkSync(outside, path.join(root, "outside-dir"), "dir");
  fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "outside-file"));

  assert.deepEqual(
    await getGitFileDiff(root, path.join(root, "missing.txt")),
    { supported: false },
  );
  assert.deepEqual(
    await getGitFileDiff(outside, path.join(outside, "secret.txt")),
    { supported: false },
  );
  assert.deepEqual(
    await getGitFileDiff(root, path.join(root, "outside-dir", "secret.txt")),
    { supported: false },
  );
  assert.deepEqual(
    await getGitFileDiff(root, path.join(root, "outside-file")),
    { supported: false },
  );
});
