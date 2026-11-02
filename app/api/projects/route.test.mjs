import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const directory = await mkdtemp(path.join(os.tmpdir(), "pi-web-project-route-"));
process.env.PI_WEB_PROJECTS_FILE = path.join(directory, "projects.json");
process.env.PI_WEB_SUBPROJECTS_FILE = path.join(directory, "subprojects.json");
process.env.PI_WEB_HIDDEN_FILE = path.join(directory, "hidden.json");
process.env.PI_WEB_WORKSPACE_ROOT = directory;
globalThis.__piKnownProjectsRuntime = undefined;
globalThis.__piSubprojectStateRuntimes = undefined;

test.beforeEach(async () => {
  globalThis.__piKnownProjectsRuntime = undefined;
  globalThis.__piSubprojectStateRuntimes = undefined;
  globalThis.__piHiddenStateCache = undefined;
  await Promise.all([
    rm(process.env.PI_WEB_PROJECTS_FILE, { force: true }),
    rm(process.env.PI_WEB_SUBPROJECTS_FILE, { force: true }),
    rm(process.env.PI_WEB_HIDDEN_FILE, { force: true }),
  ]);
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { DELETE, GET } = await jiti.import("./route.ts");
const known = await jiti.import("../../../lib/known-projects.ts");
const subprojects = await jiti.import("../../../lib/subproject-state.ts");
const { getProjectIdentity } = await jiti.import("../../../lib/project-identity.ts");
const hidden = await jiti.import("../../../lib/hidden-state.ts");

test.after(async () => {
  globalThis.__piKnownProjectsRuntime = undefined;
  globalThis.__piSubprojectStateRuntimes = undefined;
  globalThis.__piHiddenStateCache = undefined;
  await rm(directory, { recursive: true, force: true });
});

async function makeGitProject(name) {
  const project = await mkdtemp(path.join(directory, `${name}-`));
  execFileSync("git", ["-C", project, "init", "--quiet"]);
  execFileSync("git", ["-C", project, "remote", "add", "origin", `https://github.com/example/${name}.git`]);
  return project;
}

function deleteRequest(cwd) {
  return new Request("http://localhost/api/projects", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
}

test("DELETE blocks a Git project when its current path key owns a subproject", async () => {
  const project = await makeGitProject("path-key");
  known.addKnownProject(project);
  const subproject = subprojects.createSubproject(`path:${project}`, "Child");

  const response = await DELETE(deleteRequest(project));
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), {
    error: "Project has subprojects; remove them first",
    code: "project_has_subprojects",
  });
  assert.deepEqual(known.listKnownProjects().map((item) => item.path), [project]);
  assert.equal(subprojects.listSubprojects(project).length, 1);

  subprojects.deleteSubproject(subproject.id);
  const removed = await DELETE(deleteRequest(project));
  assert.equal(removed.status, 200);
  assert.deepEqual(known.listKnownProjects(), []);
});

test("DELETE still blocks legacy Git-key sidecars", async () => {
  const project = await makeGitProject("git-key");
  known.addKnownProject(project);
  const gitKey = getProjectIdentity(project).key;
  subprojects.createSubproject(gitKey, "Legacy");

  const response = await DELETE(deleteRequest(project));
  assert.equal(response.status, 409);
  assert.equal((await response.json()).code, "project_has_subprojects");
});

test("GET hides a project regardless of its stored path identity shape", async () => {
  const project = await makeGitProject("hidden");
  known.addKnownProject(project);
  hidden.setHidden("project", project, true);

  const response = await GET();
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).projects, []);
});
