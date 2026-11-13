import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./worktree.ts");
}

async function git(cwd, args) {
  await execFileAsync("git", ["-C", cwd, ...args]);
}

test("main and linked worktrees share one canonical project root", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/test", linked]);

  const { findCurrentWorktreePath, invalidateProjectCache, listWorktrees, resolveProject } = await loadSubject();
  const mainProject = await resolveProject(`${repo}${path.sep}`);
  const linkedProject = await resolveProject(linked);

  assert.equal(mainProject.isTopLevel, true);
  assert.equal(mainProject.isGit, true);
  assert.equal(mainProject.isWorktree, false);
  assert.equal(linkedProject.isTopLevel, true);
  assert.equal(linkedProject.isWorktree, true);
  assert.equal(linkedProject.branch, "feature/test");
  assert.equal(mainProject.projectRoot, linkedProject.projectRoot);

  await git(repo, ["checkout", "--detach"]);
  invalidateProjectCache();
  const detachedProject = await resolveProject(repo);
  assert.equal(detachedProject.isGit, true);
  assert.equal(detachedProject.branch, null);

  const worktrees = await listWorktrees(linked);
  const listedLinked = worktrees.find((worktree) => worktree.branch === "feature/test");
  assert.ok(listedLinked);
  assert.equal(findCurrentWorktreePath(worktrees, `${linked}${path.sep}`), listedLinked.path);
});

test("unregisters only a linked worktree already moved to the trash", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-trash-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  const other = path.join(root, "other");
  const trashed = path.join(root, "trashed");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["-c", "user.name=Pi Web Test", "-c", "user.email=pi-web-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "first", linked]);
  await git(repo, ["worktree", "add", "-b", "second", other]);
  await writeFile(path.join(linked, "unsaved.txt"), "keep this");
  const { linkedWorktreeForTrash, unregisterTrashedWorktree } = await loadSubject();
  const target = await linkedWorktreeForTrash(linked);
  assert.ok(target);
  await assert.rejects(unregisterTrashedWorktree(target), /recreated/);
  await rename(linked, trashed);
  await unregisterTrashedWorktree(target);
  assert.equal(await readFile(path.join(trashed, "unsaved.txt"), "utf8"), "keep this");
  const { stdout } = await execFileAsync("git", ["-C", repo, "worktree", "list", "--porcelain"]);
  assert.doesNotMatch(stdout, /refs\/heads\/first/);
  assert.match(stdout, /refs\/heads\/second/);
  assert.equal(existsSync(other), true);
});

test("peekProject never waits on git: a cold cwd is unknown until the background probe fills the cache", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-peek-project-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));
  const repo = path.join(tempRoot, "repo");
  const plain = path.join(tempRoot, "plain");
  await execFileAsync("git", ["init", repo]);
  // The project probe reads HEAD, so the repository needs a commit.
  await git(repo, ["-c", "user.name=Pi Web Test", "-c", "user.email=pi-web-test@example.invalid", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "initial"]);
  await mkdir(plain);

  const { invalidateProjectCache, peekProject } = await loadSubject();
  invalidateProjectCache();
  assert.equal(peekProject(repo), undefined, "a cold cwd reads as unknown instead of waiting for git");
  assert.equal(peekProject(plain), undefined);
  const settled = async (cwd) => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const info = peekProject(cwd);
      if (info) return info;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`background project probe did not settle for ${cwd}`);
  };
  assert.equal((await settled(repo)).isGit, true);
  assert.equal((await settled(plain)).isGit, false);
});

test("a directory with no .git in itself or any ancestor resolves as non-Git without spawning git", async (t) => {
  // Symlinked ancestors (macOS /var -> /private/var) deliberately keep Git discovery on; start from a physical path.
  const tempRoot = await mkdtemp(path.join(await realpath(os.tmpdir()), "pi-web-gitless-"));
  const previousPath = process.env.PATH;
  t.after(async () => { process.env.PATH = previousPath; await rm(tempRoot, { recursive: true, force: true }); });
  const bin = path.join(tempRoot, "bin");
  const calls = path.join(tempRoot, "git-calls");
  const plain = path.join(tempRoot, "vault", "notes");
  const marked = path.join(tempRoot, "marked");
  await mkdir(bin);
  await mkdir(plain, { recursive: true });
  await mkdir(path.join(marked, ".git"), { recursive: true });
  // Stands in for git in a folder where it hangs (iCloud Drive) and records every invocation.
  await writeFile(path.join(bin, "git"), `#!/bin/sh\necho "$PWD $*" >> "${calls}"\nexit 128\n`, { mode: 0o755 });
  process.env.PATH = `${bin}${path.delimiter}${previousPath}`;

  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  assert.deepEqual(await resolveProject(plain), { projectRoot: plain, isGit: false, branch: null, isWorktree: false, isTopLevel: false });
  assert.equal(existsSync(calls), false, "no repository can be discovered, so git is never started");
  assert.equal((await resolveProject(marked)).isGit, false);
  assert.equal(existsSync(calls), true, "a .git entry still goes through git discovery");
  assert.equal((await resolveProject(marked)).isGit, false);
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1, "ordinary Git exits remain cacheable");
});


test("concurrent cold project lookups share one Git probe", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-project-coalesce-")));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const calls = path.join(root, "calls");
  const release = path.join(root, "release");
  await mkdir(bin);
  await mkdir(project);
  await mkdir(path.join(project, ".git"));
  const fakeGit = path.join(bin, "git");
  await writeFile(fakeGit, '#!/bin/sh\nprintf "call\\n" >> "$PI_TEST_GIT_CALLS"\nwhile [ ! -f "$PI_TEST_RELEASE" ]; do /bin/sleep 0.05; done\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n');
  await chmod(fakeGit, 0o755);
  const previous = { path: process.env.PATH, calls: process.env.PI_TEST_GIT_CALLS, release: process.env.PI_TEST_RELEASE };
  process.env.PATH = `${bin}${path.delimiter}${previous.path ?? ""}`;
  process.env.PI_TEST_GIT_CALLS = calls;
  process.env.PI_TEST_RELEASE = release;
  const { invalidateProjectCache, peekProject, resolveProject } = await loadSubject();
  invalidateProjectCache();
  let first, second;
  t.after(async () => {
    await writeFile(release, "release\n");
    await Promise.allSettled([first, second]);
    for (const [name, value] of [["PATH", previous.path], ["PI_TEST_GIT_CALLS", previous.calls], ["PI_TEST_RELEASE", previous.release]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    invalidateProjectCache();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal(peekProject(project), undefined);
  first = resolveProject(project);
  second = resolveProject(project);
  for (let attempt = 0; attempt < 100 && !existsSync(calls); attempt += 1) await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(existsSync(calls), true, "the first Git probe must start");
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal((await readFile(calls, "utf8")).trim().split("\n").length, 1);
  await writeFile(release, "release\n");
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => result.isGit && result.projectRoot === project));
});

test("a transient Git failure does not cache a cold non-Git result", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-project-transient-")));
  const bin = path.join(root, "bin"), project = path.join(root, "project"), ready = path.join(root, "ready");
  await mkdir(bin);
  await mkdir(path.join(project, ".git"), { recursive: true });
  await writeFile(path.join(bin, "git"), '#!/bin/sh\nif [ ! -f "$PI_TEST_GIT_READY" ]; then kill -TERM $$; fi\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n', { mode: 0o755 });
  const previous = { path: process.env.PATH, ready: process.env.PI_TEST_GIT_READY };
  process.env.PATH = `${bin}${path.delimiter}${previous.path ?? ""}`;
  process.env.PI_TEST_GIT_READY = ready;
  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  t.after(async () => {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.ready === undefined) delete process.env.PI_TEST_GIT_READY; else process.env.PI_TEST_GIT_READY = previous.ready;
    invalidateProjectCache();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await resolveProject(project)).isGit, false, "the failed request may degrade once");
  assert.equal(globalThis.__piProjectCache.has(project), false, "the transient result must not enter cache");
  await writeFile(ready, "ready");
  assert.equal((await resolveProject(project)).isGit, false, "the short retry budget prevents a spawn storm");
  globalThis.__piProjectRetryAt.set(project, 0);
  assert.equal((await resolveProject(project)).isGit, true, "the next lookup after backoff retries");
});

test("a transient Git failure retains a stale known project while retrying", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-project-stale-")));
  const bin = path.join(root, "bin"), project = path.join(root, "project"), fail = path.join(root, "fail");
  await mkdir(bin);
  await mkdir(path.join(project, ".git"), { recursive: true });
  await writeFile(path.join(bin, "git"), '#!/bin/sh\nif [ -f "$PI_TEST_GIT_FAIL" ]; then kill -TERM $$; fi\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n', { mode: 0o755 });
  const previous = { path: process.env.PATH, fail: process.env.PI_TEST_GIT_FAIL };
  process.env.PATH = `${bin}${path.delimiter}${previous.path ?? ""}`;
  process.env.PI_TEST_GIT_FAIL = fail;
  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  t.after(async () => {
    await Promise.allSettled([globalThis.__piProjectRefresh?.get(project)]);
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.fail === undefined) delete process.env.PI_TEST_GIT_FAIL; else process.env.PI_TEST_GIT_FAIL = previous.fail;
    invalidateProjectCache();
    await rm(root, { recursive: true, force: true });
  });
  assert.equal((await resolveProject(project)).isGit, true);
  globalThis.__piProjectCache.get(project).expiresAt = 0;
  await writeFile(fail, "fail");
  assert.equal((await resolveProject(project)).isGit, true);
  await globalThis.__piProjectRefresh.get(project);
  assert.equal(globalThis.__piProjectCache.get(project).info.isGit, true, "a failed refresh must retain the old project");
  await rm(fail);
  globalThis.__piProjectRetryAt.set(project, 0);
  assert.equal((await resolveProject(project)).isGit, true);
  await globalThis.__piProjectRefresh.get(project);
  assert.ok(globalThis.__piProjectCache.get(project).expiresAt > Date.now(), "a successful retry refreshes the cache");
});

test("invalidating a pending project lookup prevents stale cache recovery", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-project-generation-")));
  const bin = path.join(root, "bin");
  const project = path.join(root, "project");
  const calls = path.join(root, "calls");
  const firstFlag = path.join(root, "first");
  const oldRelease = path.join(root, "old-release");
  const newRelease = path.join(root, "new-release");
  await mkdir(bin);
  await mkdir(project);
  await mkdir(path.join(project, ".git"));
  const fakeGit = path.join(bin, "git");
  await writeFile(fakeGit, '#!/bin/sh\nif mkdir "$PI_TEST_FIRST" 2>/dev/null; then name=old; gate="$PI_TEST_OLD_RELEASE"; else name=new; gate="$PI_TEST_NEW_RELEASE"; fi\nprintf "%s\\n" "$name" >> "$PI_TEST_GIT_CALLS"\nwhile [ ! -f "$gate" ]; do /bin/sleep 0.05; done\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" "$name"\n');
  await chmod(fakeGit, 0o755);
  const keys = ["PATH", "PI_TEST_GIT_CALLS", "PI_TEST_FIRST", "PI_TEST_OLD_RELEASE", "PI_TEST_NEW_RELEASE"];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PI_TEST_GIT_CALLS = calls;
  process.env.PI_TEST_FIRST = firstFlag;
  process.env.PI_TEST_OLD_RELEASE = oldRelease;
  process.env.PI_TEST_NEW_RELEASE = newRelease;
  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  let oldLookup, newLookup;
  t.after(async () => {
    await Promise.all([writeFile(oldRelease, "release\n"), writeFile(newRelease, "release\n")]);
    await Promise.allSettled([oldLookup, newLookup]);
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    invalidateProjectCache();
    await rm(root, { recursive: true, force: true });
  });
  const waitForCall = async (name) => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(calls) && (await readFile(calls, "utf8")).split("\n").includes(name)) return;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    assert.fail(`Git probe ${name} did not start`);
  };
  oldLookup = resolveProject(project);
  await waitForCall("old");
  invalidateProjectCache();
  newLookup = resolveProject(project);
  await waitForCall("new");
  await writeFile(newRelease, "release\n");
  assert.equal((await newLookup).branch, "new");
  await writeFile(oldRelease, "release\n");
  assert.equal((await oldLookup).branch, "new");
  assert.equal((await resolveProject(project)).branch, "new");
});

test("project discovery follows a symlink into a Git repository subdirectory", async (t) => {
  const { root, repo } = await localWorktreeRepo(t);
  const nested = path.join(repo, "nested");
  const alias = path.join(root, "alias");
  await mkdir(nested);
  await mkdir(path.join(nested, "deeper"));
  await symlink(nested, alias, "dir");
  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  t.after(() => invalidateProjectCache());
  const info = await resolveProject(alias);
  assert.equal(info.isGit, true);
  assert.equal(info.isTopLevel, false);
  assert.equal(info.projectRoot, alias);
  assert.equal((await resolveProject(path.join(alias, "deeper"))).isGit, true);
  const throughParent = await resolveProject(`${alias}${path.sep}..`);
  assert.equal(throughParent.isGit, true);
});

test("project discovery respects an explicit Git directory outside cwd", async (t) => {
  const { root, repo } = await localWorktreeRepo(t);
  const plain = path.join(root, "plain");
  await mkdir(plain);
  const previous = { dir: process.env.GIT_DIR, workTree: process.env.GIT_WORK_TREE };
  process.env.GIT_DIR = path.join(repo, ".git");
  process.env.GIT_WORK_TREE = repo;
  const { invalidateProjectCache, resolveProject } = await loadSubject();
  invalidateProjectCache();
  t.after(() => {
    if (previous.dir === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previous.dir;
    if (previous.workTree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previous.workTree;
    invalidateProjectCache();
  });
  const info = await resolveProject(plain);
  assert.equal(info.isGit, true);
  assert.equal(info.isTopLevel, false);
  assert.equal(info.projectRoot, plain);
});

test("recognizes submodule and dirty-worktree removal errors as forceable", async () => {
  const { worktreeRemovalRequiresForce } = await loadSubject();

  assert.equal(worktreeRemovalRequiresForce("fatal: working trees containing submodules cannot be moved or removed"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: '/tmp/linked' contains modified or untracked files, use --force to delete it"), true);
  assert.equal(worktreeRemovalRequiresForce("fatal: worktree is dirty"), true);
  // A locked worktree needs `remove -f -f`; a single force would still fail.
  assert.equal(worktreeRemovalRequiresForce("fatal: cannot remove a locked working tree;\nuse 'remove -f -f' to override or unlock first"), false);
  assert.equal(worktreeRemovalRequiresForce("fatal: unrelated git failure"), false);
});


test("forced worktree removal passes Git's force flag", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-force-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const linked = path.join(tempRoot, "linked");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/force", linked]);
  await writeFile(path.join(linked, "untracked.txt"), "discard me\n");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, linked, true);
  assert.equal(existsSync(linked), false);
});


test("worktree removal accepts a path that runs through a link", async (t) => {
  // Git lists worktrees by their real path; macOS's tmpdir is a link to /private/var.
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-link-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  const alias = path.join(tempRoot, "alias");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);
  await git(repo, ["worktree", "add", "-b", "feature/link", path.join(tempRoot, "linked")]);
  await symlink(tempRoot, alias, "dir");

  const { removeWorktree } = await loadSubject();
  await removeWorktree(repo, path.join(alias, "linked"));
  assert.equal(existsSync(path.join(tempRoot, "linked")), false);
});

test("buildWorktreeGraph resolves GitHub repository only when a github remote is present", async (t) => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "pi-worktree-gh-test-"));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const repo = path.join(tempRoot, "repo");
  await execFileAsync("git", ["init", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(repo, "README.md"), "# test\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "initial"]);

  const { buildWorktreeGraph } = await loadSubject();

  // Pure git repo without remotes
  const pureGraph = await buildWorktreeGraph(repo, { forceRefresh: true });
  assert.equal(pureGraph.githubRepository, null);
  assert.equal(pureGraph.githubUrl, null);

  // With a GitHub remote
  await git(repo, ["remote", "add", "origin", "git@github.com:my-org/my-project.git"]);
  const githubGraph = await buildWorktreeGraph(repo, { forceRefresh: true });
  assert.deepEqual(githubGraph.githubRepository, { owner: "my-org", repo: "my-project" });
  assert.equal(githubGraph.githubUrl, "https://github.com/my-org/my-project");
});

async function localWorktreeRepo(t, ignored = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-local-worktree-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "project with spaces");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  await git(repo, ["config", "user.name", "Pi Web Test"]);
  await git(repo, ["config", "user.email", "pi-web-test@example.invalid"]);
  await git(repo, ["config", "commit.gpgsign", "false"]);
  await git(repo, ["config", "core.excludesFile", path.join(root, "no-global-ignores")]);
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  if (ignored) await writeFile(path.join(repo, ".gitignore"), "/.worktrees/\n");
  await git(repo, ["add", "README.md", ...(ignored ? [".gitignore"] : [])]);
  await git(repo, ["commit", "-m", "initial"]);
  return { root, repo };
}

test("creation from a linked checkout or its subdirectory uses the main project's .worktrees", async (t) => {
  const { repo } = await localWorktreeRepo(t);
  const { addWorktree, resolveProject } = await loadSubject();
  const first = await addWorktree(repo, "task/中文");
  assert.equal(first.path, path.join(repo, ".worktrees", "task-中文"));
  const subdir = path.join(first.path, "nested");
  await mkdir(subdir);
  const second = await addWorktree(subdir, "task/second");
  assert.equal(second.path, path.join(repo, ".worktrees", "task-second"));
  assert.equal((await resolveProject(first.path)).projectRoot, repo);
  const { stdout } = await execFileAsync("git", ["-C", repo, "status", "--porcelain"]);
  assert.equal(stdout, "");
  assert.equal(existsSync(path.join(first.path, ".worktrees")), false);
});

test("creation requires ignore policy and does not edit project files or create a branch on refusal", async (t) => {
  const { repo } = await localWorktreeRepo(t, false);
  const { addWorktree } = await loadSubject();
  await assert.rejects(addWorktree(repo, "task/new"), /Add \/.worktrees\/ to the project root .gitignore/);
  assert.equal(existsSync(path.join(repo, ".gitignore")), false);
  assert.equal(existsSync(path.join(repo, ".worktrees")), false);
  const { stdout } = await execFileAsync("git", ["-C", repo, "branch", "--list", "task/new"]);
  assert.equal(stdout, "");
});

test("creation refuses symbolic worktree parents and path-like invalid branch names", async (t) => {
  const { root, repo } = await localWorktreeRepo(t);
  const { addWorktree } = await loadSubject();
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(repo, ".worktrees"), "dir");
  await assert.rejects(addWorktree(repo, "task/new"), /physical directory/);
  assert.equal(existsSync(path.join(outside, "task-new")), false);
  for (const branch of ["", ".", "..", "/"]) {
    await assert.rejects(addWorktree(repo, branch), /Branch name|Invalid branch/);
  }
});

test("creation preserves existing and fetched branch tips and rejects sanitized path collisions", async (t) => {
  const { repo } = await localWorktreeRepo(t);
  const { addWorktree, removeWorktree } = await loadSubject();
  await git(repo, ["branch", "existing"]);
  await git(repo, ["update-ref", "refs/remotes/origin/fetched", "HEAD"]);
  const { stdout: initial } = await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"]);
  await writeFile(path.join(repo, "README.md"), "new main\n");
  await git(repo, ["add", "README.md"]);
  await git(repo, ["commit", "-m", "advance main"]);
  for (const branch of ["existing", "fetched"]) {
    const worktree = await addWorktree(repo, branch);
    const { stdout } = await execFileAsync("git", ["-C", worktree.path, "rev-parse", "HEAD"]);
    assert.equal(stdout, initial);
    await removeWorktree(repo, worktree.path);
  }
  await addWorktree(repo, "task/collision");
  await assert.rejects(addWorktree(repo, "task-collision"), /Directory already exists/);
});

test("removed internal and historical sibling worktrees retain project grouping", async (t) => {
  const { root, repo } = await localWorktreeRepo(t);
  const { addWorktree, invalidateProjectCache, removeWorktree, resolveProject } = await loadSubject();
  const worktree = await addWorktree(repo, "task/removed");
  await removeWorktree(repo, worktree.path);
  const historical = path.join(`${repo}-worktrees`, "older");
  invalidateProjectCache();
  for (const cwd of [worktree.path, historical]) {
    const project = await resolveProject(cwd);
    assert.equal(project.projectRoot, repo);
    assert.equal(project.isWorktree, true);
    assert.equal(project.isGit, true);
    assert.equal(existsSync(cwd), false);
  }
  assert.equal((await resolveProject(path.join(root, "not-a-repo", ".worktrees", "gone"))).isGit, false);
});
