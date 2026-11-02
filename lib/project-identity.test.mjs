import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
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
  } finally {
    if (previousWorkspace === undefined) delete process.env.PI_WEB_WORKSPACE_ROOT;
    else process.env.PI_WEB_WORKSPACE_ROOT = previousWorkspace;
    await rm(workspace, { recursive: true, force: true });
  }
});
