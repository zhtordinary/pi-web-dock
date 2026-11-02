import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const directory = await mkdtemp(join(tmpdir(), "pi-known-projects-"));
const projectsFile = join(directory, "projects.json");
process.env.PI_WEB_PROJECTS_FILE = projectsFile;
const known = await import("./known-projects.ts");

test.after(async () => {
  globalThis.__piKnownProjectsRuntime = undefined;
  await rm(directory, { recursive: true, force: true });
});

function reset() {
  globalThis.__piKnownProjectsRuntime = undefined;
}

test("add keeps the path with a timestamp and persists it", () => {
  reset();
  const added = known.addKnownProject("/tmp/project-a");
  assert.equal(added.length, 1);
  assert.equal(added[0].path, "/tmp/project-a");
  assert.ok(added[0].addedAt);
  assert.match(added[0].addedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.match(readFileSync(projectsFile, "utf8"), /project-a/);
});

test("re-adding the same path refreshes its timestamp without duplicating", () => {
  reset();
  known.addKnownProject("/tmp/project-a");
  const first = known.listKnownProjects();
  const refreshed = known.addKnownProject("/tmp/project-a");
  assert.equal(refreshed.length, 1);
  assert.ok(refreshed[0].addedAt >= first[0].addedAt);
});

test("remove forgets only the requested path", () => {
  reset();
  known.addKnownProject("/tmp/project-a");
  known.addKnownProject("/tmp/project-b");
  const after = known.removeKnownProject("/tmp/project-a");
  assert.deepEqual(after.map((p) => p.path), ["/tmp/project-b"]);
});

test("a corrupt file loads as an empty list", () => {
  reset();
  writeFileSync(projectsFile, "{not json");
  assert.deepEqual(known.listKnownProjects(), []);
});
