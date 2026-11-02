import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// Keep the machine's git configuration out of the answers: a global excludes
// file could ignore the very names these tests expect to see, and a repository
// above the temp directory could claim the "non-Git" fixtures.
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-tree-visibility-")));
fs.writeFileSync(path.join(root, "gitconfig"), "");
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_CONFIG_GLOBAL = path.join(root, "gitconfig");
process.env.XDG_CONFIG_HOME = path.join(root, "xdg");
process.env.GIT_CEILING_DIRECTORIES = root;
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const { getFileTreeVisibility, isHiddenOutsideGit } = await import("./file-tree-visibility.ts");

let fixtureCount = 0;
function fixture(files) {
  const dir = path.join(root, `fixture-${++fixtureCount}`);
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
}

function repo(files, tracked = []) {
  const dir = fixture(files);
  git(dir, "init", "-q");
  if (tracked.length > 0) git(dir, "add", "-f", "--", ...tracked);
  return dir;
}

async function visibleNames(dir, hideGitIgnored = false) {
  const names = fs.readdirSync(dir);
  const isVisible = await getFileTreeVisibility(dir, names, hideGitIgnored);
  return names.filter(isVisible).sort();
}

test("a Git work tree shows tracked directories the name list would hide", async () => {
  const dir = repo({
    "build/index.js": "",
    "dist/app.js": "",
    "src/main.ts": "",
  }, ["build/index.js", "dist/app.js", "src/main.ts"]);

  assert.deepEqual(await visibleNames(dir), ["build", "dist", "src"]);
});

test("a Git work tree hides what the repository ignores when the project enables it", async () => {
  const dir = repo({
    ".gitignore": "build/\n*.log\ngenerated/\n",
    "build/index.js": "",
    "generated/types.ts": "",
    "debug.log": "",
    "release.log": "",
    "src/main.ts": "",
  }, [".gitignore", "release.log", "src/main.ts"]);

  // A force-added file stays visible under a matching pattern, as in `git status`.
  assert.deepEqual(await visibleNames(dir, true), [".gitignore", "release.log", "src"]);
});

test("a Git work tree shows ignored entries by default while fixed names stay hidden", async () => {
  const dir = repo({
    ".gitignore": "build/\n*.log\ngenerated/\n",
    "build/index.js": "",
    "generated/types.ts": "",
    "debug.log": "",
    "release.log": "",
    ".DS_Store": "",
    "src/main.ts": "",
  }, [".gitignore", "release.log", "src/main.ts"]);

  assert.deepEqual(await visibleNames(dir), [".gitignore", "build", "debug.log", "generated", "release.log", "src"]);
});

test("a Git work tree shows untracked entries it does not ignore", async () => {
  const dir = repo({
    ".gitignore": "*.tmp\n",
    "notes/todo.md": "",
    "vendor/lib.js": "",
    "coverage/lcov.info": "",
    "scratch.tmp": "",
  });

  assert.deepEqual(await visibleNames(dir), [".gitignore", "coverage", "notes", "scratch.tmp", "vendor"]);
});

test("an ignored directory holding a tracked file is shown with only its tracked entries", async () => {
  const dir = repo({
    ".gitignore": "out/\n",
    "out/keep.txt": "",
    "out/stale.txt": "",
  }, [".gitignore", "out/keep.txt"]);

  assert.deepEqual(await visibleNames(dir, true), [".gitignore", "out"]);
  assert.deepEqual(await visibleNames(path.join(dir, "out"), true), ["keep.txt"]);
});

test("candidate generated paths follow Git ignore while tracked nested paths stay visible", async () => {
  const dir = repo({
    ".gitignore": [
      "/.archify/",
      "/.build/",
      "/.ruff_cache/",
      "/.pi/messenger/",
      "/.pi/task-plans-by-plan-execute/",
      "__pycache__/",
      "*.py[cod]",
    ].join("\n") + "\n",
    ".archify/untracked.html": "",
    ".build/tracked.txt": "",
    ".build/untracked.txt": "",
    ".pi/messenger/untracked.json": "",
    ".pi/task-plans-by-plan-execute/kept.md": "",
    "__pycache__/module.pyc": "",
    "notes/readme.md": "",
  }, [
    ".gitignore",
    ".build/tracked.txt",
    ".pi/task-plans-by-plan-execute/kept.md",
  ]);

  assert.deepEqual(await visibleNames(dir, true), [".build", ".gitignore", ".pi", "notes"]);
  assert.deepEqual(await visibleNames(path.join(dir, ".build"), true), ["tracked.txt"]);
  assert.deepEqual(await visibleNames(path.join(dir, ".pi"), true), ["task-plans-by-plan-execute"]);
  assert.deepEqual(await visibleNames(path.join(dir, ".pi/task-plans-by-plan-execute"), true), ["kept.md"]);
});

test(".git and .DS_Store are hidden in a work tree even when nothing else is", async () => {
  const dir = repo({ "README.md": "", ".DS_Store": "" });
  assert.ok(fs.existsSync(path.join(dir, ".git")));

  assert.deepEqual(await visibleNames(dir, true), ["README.md"]);
});

test("a directory outside any work tree falls back to the name list", async () => {
  const dir = fixture({
    ".archify/index.html": "",
    ".build/index.html": "",
    ".ruff_cache/marker": "",
    ".pi/messenger/events.json": "",
    ".pi/task-plans-by-plan-execute/plan.md": "",
    "build/index.js": "",
    "node_modules/pkg/index.js": "",
    "cache.pyc": "",
    "cache.pyo": "",
    "cache.pyd": "",
    "src/main.ts": "",
    "notes/readme.md": "",
  });

  assert.deepEqual(await visibleNames(dir), [".pi", "notes", "src"]);
  assert.deepEqual(await visibleNames(path.join(dir, ".pi")), []);
});

test("a directory the repository ignores falls back to the name list instead of listing empty", async () => {
  // Dotfile repositories ignore `*` and force-add what they track.
  const dir = repo({
    ".gitignore": "*\n",
    ".bashrc": "",
    "project/build/index.js": "",
    "project/src/main.ts": "",
  }, [".gitignore", ".bashrc"]);

  assert.deepEqual(await visibleNames(dir, true), [".bashrc", ".gitignore"]);
  assert.deepEqual(await visibleNames(path.join(dir, "project"), true), ["src"]);
});

test("a nested repository answers for its own entries", async () => {
  const outer = repo({ ".gitignore": "build/\n", "inner/build/index.js": "", "inner/out/a.js": "" }, [".gitignore"]);
  const inner = path.join(outer, "inner");
  git(inner, "init", "-q");
  fs.writeFileSync(path.join(inner, ".gitignore"), "out/\n");

  assert.deepEqual(await visibleNames(outer, true), [".gitignore", "inner"]);
  assert.deepEqual(await visibleNames(inner, true), [".gitignore", "build"]);
});

test("names are passed to git as literal paths", { skip: process.platform === "win32" }, async () => {
  // A leading `:(` is pathspec magic, which check-ignore rejects for the whole
  // batch. The tracked build/ proves the answer came from Git, not the fallback.
  const dir = repo({
    ".gitignore": "*.tmp\n",
    ":(glob)x.tmp": "",
    ":!y.txt": "",
    "[id]/page.tsx": "",
    "build/index.js": "",
  }, [".gitignore", "[id]/page.tsx", "build/index.js"]);

  assert.deepEqual(await visibleNames(dir, true), [".gitignore", ":!y.txt", "[id]", "build"]);
});

test("an ignored name is not un-ignored by a tracked name its glob characters match", { skip: process.platform === "win32" }, async () => {
  // Checked against the index, `*.log` and `[id]` would match the tracked
  // `app.log` and `i` as pathspec globs and show up although Git ignores them.
  const dir = repo({
    ".gitignore": "*.log\n[[]id]/\n",
    "*.log": "",
    "app.log": "",
    "[id]/page.tsx": "",
    "i": "",
  }, [".gitignore", "app.log", "i"]);

  assert.deepEqual(await visibleNames(dir, true), [".gitignore", "app.log", "i"]);
});

test("listing a directory does not run the repository's fsmonitor hook", { skip: process.platform === "win32" }, async () => {
  const dir = repo({ "build/index.js": "" }, ["build/index.js"]);
  const marker = path.join(root, "fsmonitor-ran");
  const hook = path.join(root, "fsmonitor-hook.sh");
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
  git(dir, "config", "core.fsmonitor", hook);

  assert.deepEqual(await visibleNames(dir, true), ["build"]);
  assert.equal(fs.existsSync(marker), false);
});

test("a missing git falls back to the name list", async (t) => {
  const dir = repo({ "build/index.js": "", "src/main.ts": "" }, ["build/index.js", "src/main.ts"]);
  const originalPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = originalPath;
  });
  process.env.PATH = path.join(root, "no-git-here");

  assert.deepEqual(await visibleNames(dir, true), ["src"]);
});

test("the fallback name list matches names and generated suffixes", () => {
  for (const name of [
    "node_modules", ".git", "build", "dist", ".archify", ".build", ".ruff_cache",
    ".DS_Store", "module.pyc", "module.pyo", "module.pyd",
  ]) {
    assert.equal(isHiddenOutsideGit(name), true, name);
  }
  for (const name of ["src", "builds", ".github", ".pi", "messenger", "pyc"]) {
    assert.equal(isHiddenOutsideGit(name), false, name);
  }
  assert.equal(isHiddenOutsideGit("messenger", ".pi/messenger"), true);
  assert.equal(isHiddenOutsideGit("task-plans-by-plan-execute", ".pi/task-plans-by-plan-execute"), true);
  assert.equal(isHiddenOutsideGit("messenger", "other/messenger"), false);
});
