import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

function git(repository, args) {
  return execFileSync("git", ["-C", repository, ...args], { encoding: "utf8" });
}

const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-git-route-")));
const home = path.join(fixture, "home");
const workspace = path.join(fixture, "workspace");
const outside = path.join(fixture, "outside");
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
fs.mkdirSync(outside, { recursive: true });
git(workspace, ["init", "--quiet"]);
fs.writeFileSync(path.join(workspace, "tracked.txt"), "before\n");
git(workspace, ["add", "tracked.txt"]);
git(workspace, ["-c", "user.name=Reader Test", "-c", "user.email=reader@example.invalid", "commit", "--quiet", "-m", "fixture"]);
fs.writeFileSync(path.join(workspace, "tracked.txt"), "after\n");
fs.writeFileSync(path.join(outside, "secret.txt"), "secret\n");
fs.symlinkSync(outside, path.join(workspace, "outside-dir"), "dir");
const projectsFile = path.join(home, "projects.json");
fs.writeFileSync(projectsFile, JSON.stringify({ projects: [{ path: workspace, addedAt: new Date().toISOString() }] }));

const previousEnv = {
  HOME: process.env.HOME,
  XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  PI_WEB_PROJECTS_FILE: process.env.PI_WEB_PROJECTS_FILE,
};
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
process.env.PI_CODING_AGENT_DIR = path.join(home, ".pi", "agent");
process.env.PI_WEB_PROJECTS_FILE = projectsFile;
globalThis.__piAllowedRootsCache = undefined;
globalThis.__piKnownProjectsRuntime = undefined;

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const { GET } = await jiti.import("./route.ts");

function request(cwd, filePath) {
  const url = new URL("http://localhost:30141/api/git/diff");
  url.searchParams.set("cwd", cwd);
  url.searchParams.set("path", filePath);
  const request = new Request(url, { headers: { host: "localhost:30141" } });
  Object.defineProperty(request, "nextUrl", { value: url });
  return request;
}

test.after(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.__piAllowedRootsCache = undefined;
  globalThis.__piKnownProjectsRuntime = undefined;
  fs.rmSync(fixture, { recursive: true, force: true });
});

test("returns normal and deleted Git diffs without treating an external link as a repository file", async () => {
  const modified = await GET(request(workspace, path.join(workspace, "tracked.txt")));
  assert.equal(modified.status, 200);
  const modifiedBody = await modified.json();
  assert.equal(modifiedBody.supported, true);
  assert.equal(modifiedBody.status, "modified");
  assert.match(modifiedBody.patch, /-before/);

  fs.unlinkSync(path.join(workspace, "tracked.txt"));
  const deleted = await GET(request(workspace, path.join(workspace, "tracked.txt")));
  assert.equal(deleted.status, 200);
  const deletedBody = await deleted.json();
  assert.equal(deletedBody.supported, true);
  assert.equal(deletedBody.status, "deleted");
  assert.match(deletedBody.patch, /-before/);

  const escaped = await GET(request(workspace, path.join(workspace, "outside-dir", "secret.txt")));
  assert.equal(escaped.status, 200);
  assert.deepEqual(await escaped.json(), { supported: false });
});

test("keeps unknown missing targets unsupported instead of authorizing arbitrary paths", async () => {
  const response = await GET(request(workspace, path.join(workspace, "not-in-git.txt")));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { supported: false });

  const outsideResponse = await GET(request(workspace, path.join(outside, "secret.txt")));
  assert.equal(outsideResponse.status, 200);
  assert.deepEqual(await outsideResponse.json(), { supported: false });
});
