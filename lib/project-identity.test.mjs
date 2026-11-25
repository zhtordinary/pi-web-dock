import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import test from "node:test";
import os from "node:os";
import path from "node:path";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./project-identity.ts");
}

test("Windows project identity ignores full-path casing and separator style", async () => {
  const { projectIdentityKey } = await loadSubject();

  const expected = projectIdentityKey("C:\\Users\\Alex\\Project\\Study\\ELM", "win32");
  assert.equal(projectIdentityKey("c:/users/ALEX/project/study/elm", "win32"), expected);
  assert.equal(projectIdentityKey("c:\\Users\\Alex\\Project\\Study\\.\\ELM\\", "win32"), expected);
});

test("macOS project identity uses filesystem casing for existing paths", async (t) => {
  if (process.platform !== "darwin") {
    t.skip("requires a case-insensitive macOS volume");
    return;
  }
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-project-macos-case-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const actual = path.join(root, "Project");
  await mkdir(actual);
  const mixedCase = path.join(root, "pRoJeCt");
  try {
    await realpath(mixedCase);
  } catch (error) {
    if (error?.code === "ENOENT") {
      t.skip("requires a case-insensitive macOS volume");
      return;
    }
    throw error;
  }
  const { projectIdentityKey } = await loadSubject();
  assert.equal(projectIdentityKey(mixedCase, "darwin"), projectIdentityKey(actual, "darwin"));
});

test("missing Windows project paths keep equivalent separator and case aliases", async () => {
  const { projectIdentityKey, projectIdentityKeys } = await loadSubject();
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-project-missing-"));
  try {
    const missing = process.platform === "win32"
      ? path.join(root, "Missing", "Project")
      : `C:\\${path.basename(root)}\\Missing\\Project`;
    const slash = missing.replaceAll("\\", "/");
    const canonical = projectIdentityKey(slash, "win32");
    assert.ok(projectIdentityKeys(slash, "win32").includes(canonical));
    assert.ok(projectIdentityKeys(`path:${slash}`, "win32").includes(`path:${canonical}`));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("root-relative Windows aliases include the current drive", async () => {
  const { projectIdentityKey, projectIdentityKeys } = await loadSubject();
  const rootRelative = `/reader-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const keys = projectIdentityKeys(rootRelative);
  if (process.platform === "win32") {
    assert.ok(keys.includes(projectIdentityKey(path.resolve(rootRelative), "win32")));
  } else {
    assert.deepEqual(keys, [rootRelative]);
  }
});

test("missing Windows paths on different drives remain distinct", async () => {
  const { projectIdentityKeys } = await loadSubject();
  const name = `reader-missing-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const first = new Set(projectIdentityKeys(`C:\\${name}\\project`, "win32"));
  const second = projectIdentityKeys(`Z:\\${name}\\project`, "win32");
  assert.equal(second.some((key) => first.has(key)), false);
});

test("Windows project identity handles UNC casing and separators", async () => {
  const { projectIdentityKey } = await loadSubject();

  assert.equal(
    projectIdentityKey("\\\\Server\\Share\\Team\\Agent", "win32"),
    projectIdentityKey("//server/share/team/AGENT/", "win32"),
  );
});

test("project identity preserves case on case-sensitive platforms", async () => {
  const { projectIdentityKey } = await loadSubject();

  assert.notEqual(
    projectIdentityKey("/Users/Alex/Project", "linux"),
    projectIdentityKey("/users/alex/project", "linux"),
  );
  assert.notEqual(
    projectIdentityKey("/a\\b", "linux"),
    projectIdentityKey("/a/b", "linux"),
  );
});


test("project identity expands workspace-relative aliases from any cwd", async () => {
  const { projectIdentityKeys } = await loadSubject();
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pi-project-identity-"));
  const previousWorkspace = process.env.PI_WEB_WORKSPACE_ROOT;
  process.env.PI_WEB_WORKSPACE_ROOT = workspace;
  try {
    const project = await mkdtemp(path.join(workspace, "project-"));
    const relative = path.relative(workspace, project);
    const alias = "path:" + relative;
    const keys = projectIdentityKeys(alias);
    assert.ok(keys.includes(project));
    assert.ok(keys.includes(alias));
    assert.ok(projectIdentityKeys(alias, "win32").includes(project));
  } finally {
    if (previousWorkspace === undefined) delete process.env.PI_WEB_WORKSPACE_ROOT;
    else process.env.PI_WEB_WORKSPACE_ROOT = previousWorkspace;
    await rm(workspace, { recursive: true, force: true });
  }
});
