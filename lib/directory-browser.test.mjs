import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./directory-browser.ts");
}

function git(cwd, ...args) {
  execFileSync("git", ["-C", cwd, ...args], {
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", LC_ALL: "C" },
    stdio: "ignore",
  });
}

test("lists directories and directory symlinks without returning files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-browse-"));
  try {
    await mkdir(path.join(root, "project"));
    await writeFile(path.join(root, "notes.txt"), "test", "utf8");
    await symlink(path.join(root, "project"), path.join(root, "linked-project"));

    const { listDirectories } = await loadSubject();
    const directories = await listDirectories(root);

    assert.deepEqual(directories.map((entry) => entry.name), ["linked-project", "project"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("shows Git-ignored project choices by default and supports opt-in hiding", async (t) => {
  const repo = await mkdtemp(path.join(tmpdir(), "pi-web-browse-git-"));
  const plain = await mkdtemp(path.join(tmpdir(), "pi-web-browse-plain-"));
  t.after(() => Promise.all([
    rm(repo, { recursive: true, force: true }),
    rm(plain, { recursive: true, force: true }),
  ]));

  await writeFile(path.join(repo, ".gitignore"), "ignored/\n", "utf8");
  await mkdir(path.join(repo, "ignored", "tracked"), { recursive: true });
  await mkdir(path.join(repo, "ignored", "untracked"), { recursive: true });
  await mkdir(path.join(repo, "project"));
  await writeFile(path.join(repo, "ignored", "tracked", "keep.txt"), "tracked", "utf8");
  git(repo, "init", "-q");
  git(repo, "add", ".gitignore");
  git(repo, "add", "-f", "ignored/tracked/keep.txt");

  const { listDirectories } = await loadSubject();
  assert.deepEqual((await listDirectories(repo)).map((entry) => entry.name), ["ignored", "project"]);
  assert.deepEqual((await listDirectories(path.join(repo, "ignored"))).map((entry) => entry.name), ["tracked", "untracked"]);
  assert.deepEqual((await listDirectories(repo, true)).map((entry) => entry.name), ["ignored", "project"]);
  assert.deepEqual((await listDirectories(path.join(repo, "ignored"), true)).map((entry) => entry.name), ["tracked"]);

  await mkdir(path.join(plain, ".archify"));
  await mkdir(path.join(plain, ".build"));
  await mkdir(path.join(plain, ".ruff_cache"));
  await mkdir(path.join(plain, ".pi", "messenger"), { recursive: true });
  await mkdir(path.join(plain, ".pi", "task-plans-by-plan-execute"), { recursive: true });
  await mkdir(path.join(plain, ".pi", "normal"), { recursive: true });
  await mkdir(path.join(plain, "project"));
  assert.deepEqual((await listDirectories(plain)).map((entry) => entry.name), [".pi", "project"]);
  assert.deepEqual(
    (await listDirectories(path.join(plain, ".pi"))).map((entry) => entry.name),
    ["normal"],
  );
});

test("expands home-relative paths and rejects missing directories", async () => {
  const {
    getBrowseStartDirectory,
    normalizeDirectory,
    resolveDirectory,
    shouldShowWindowsDrivePicker,
  } = await loadSubject();
  assert.equal(getBrowseStartDirectory(), homedir());
  assert.equal(getBrowseStartDirectory("/project"), "/project");
  assert.equal(shouldShowWindowsDrivePicker(undefined, "win32"), true);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "darwin"), false);
  assert.equal(shouldShowWindowsDrivePicker(undefined, "linux"), false);
  assert.equal(shouldShowWindowsDrivePicker("C:\\Projects", "win32"), false);
  assert.equal(normalizeDirectory("~/project"), path.join(homedir(), "project"));
  await assert.rejects(resolveDirectory(path.join(tmpdir(), `pi-web-missing-${Date.now()}`)));
});

test("builds every Windows drive-letter candidate", async () => {
  const { getWindowsDriveCandidates } = await loadSubject();
  const drives = getWindowsDriveCandidates();

  assert.equal(drives.length, 26);
  assert.deepEqual(drives[0], { name: "A:", path: "A:\\" });
  assert.deepEqual(drives.at(-1), { name: "Z:", path: "Z:\\" });
});

test("finds parent directories across POSIX and Windows paths", async () => {
  const { getParentDirectory } = await loadSubject();

  assert.equal(getParentDirectory("/Users/alex/project"), "/Users/alex");
  assert.equal(getParentDirectory("/"), null);
  assert.equal(getParentDirectory("C:\\Users\\Alex\\project"), "C:\\Users\\Alex");
  assert.equal(getParentDirectory("C:\\"), null);
});

test("creates one direct child directory and returns its resolved path", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-create-directory-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const { createDirectory, resolveDirectory } = await loadSubject();
  const createdPath = await createDirectory(root, "new-project");

  assert.equal(createdPath, await resolveDirectory(path.join(root, "new-project")));
  await assert.rejects(createDirectory(root, "new-project"), { code: "EEXIST" });
});

test("new directory names cannot escape the current directory", async () => {
  const { isValidDirectoryName } = await loadSubject();

  assert.equal(isValidDirectoryName("project"), true);
  assert.equal(isValidDirectoryName("project name"), true);
  assert.equal(isValidDirectoryName(""), false);
  assert.equal(isValidDirectoryName("."), false);
  assert.equal(isValidDirectoryName(".."), false);
  assert.equal(isValidDirectoryName("../outside"), false);
  assert.equal(isValidDirectoryName("nested/directory"), false);
  assert.equal(isValidDirectoryName("nested\\directory"), false);
  assert.equal(isValidDirectoryName("bad\0name"), false);
});


test("directory creation preserves the file allow-list and refuses a symlink escape or traversal", async (t) => {
  const { createDirectory } = await loadSubject();
  const root = await mkdtemp(path.join(tmpdir(), "pi-web-create-roots-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = path.join(root, "allowed");
  const outside = path.join(root, "outside");
  await mkdir(allowed);
  await mkdir(outside);
  await symlink(outside, path.join(allowed, "linked"), process.platform === "win32" ? "junction" : "dir");
  const roots = new Set([allowed]);
  await assert.rejects(createDirectory(outside, "denied", roots), { code: "EACCES" });
  await assert.rejects(createDirectory(path.join(allowed, "linked"), "denied", roots), { code: "EACCES" });
  const traversal = [allowed, "linked", ".."].join(path.sep);
  await assert.rejects(createDirectory(traversal, "denied", roots), { code: "EACCES" });
  const created = await createDirectory(allowed, "accepted", roots);
  assert.equal(created, await (await import("node:fs/promises")).realpath(path.join(allowed, "accepted")));
  assert.deepEqual((await (await import("node:fs/promises")).readdir(outside)), []);
});
