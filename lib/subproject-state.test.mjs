import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { after, test } from "node:test"
import { createJiti } from "jiti"

const dir = await mkdtemp(join(tmpdir(), "pi-web-subprojects-"))
const file = join(dir, "subprojects.json")
process.env.PI_WEB_SUBPROJECTS_FILE = file
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false })
const state = await jiti.import("./subproject-state.ts")
after(() => rm(dir, { recursive: true, force: true }))

test("missing state is empty and CRUD is atomic", async () => {
  state.resetSubprojectStateForTests()
  assert.deepEqual(state.readSubprojectState(), { schemaVersion: 1, subprojects: [], assignments: [] })
  const created = state.createSubproject("git:project", "Alpha")
  assert.equal(created.label, "Alpha")
  const assignment = state.assignSession("git:project", "session-1", created.id)
  assert.equal(assignment.subprojectId, created.id)
  state.unassignSession("session-1", "git:project")
  state.restoreSubprojectAssignment(assignment)
  assert.equal(state.assignmentForSession("session-1", "git:project").subprojectId, created.id)
  state.renameSubproject(created.id, "Renamed")
  assert.equal(state.listSubprojects("git:project")[0].label, "Renamed")
  assert.equal(state.setSubprojectHidden(created.id, true).hidden, true)
  assert.equal(state.listSubprojects("git:project")[0].hidden, true)
  assert.equal(state.setSubprojectHidden(created.id, false).hidden, false)
  state.deleteSubproject(created.id)
  assert.deepEqual(state.readSubprojectState().assignments, [])
  const parsed = JSON.parse(await readFile(file, "utf8"))
  assert.equal(parsed.schemaVersion, 1)
})

test("relative and absolute path keys share one subproject identity", () => {
  const previousRoot = process.env.PI_WEB_WORKSPACE_ROOT;
  const aliasFile = join(dir, "aliases.json");
  process.env.PI_WEB_WORKSPACE_ROOT = dir;
  process.env.PI_WEB_SUBPROJECTS_FILE = aliasFile;
  state.resetSubprojectStateForTests();
  const relativeKey = "path:project";
  const absolutePath = join(dir, "project");
  const canonicalKey = `path:${absolutePath}`;
  const created = state.createSubproject(relativeKey, "Alias");
  assert.equal(state.listSubprojects(absolutePath)[0].projectKey, canonicalKey);
  const assignment = state.assignSession(absolutePath, "session-alias", created.id);
  assert.equal(assignment.projectKey, canonicalKey);
  assert.equal(state.assignmentForSession("session-alias", relativeKey)?.subprojectId, created.id);
  assert.equal(state.applySubprojectAssignments([{ id: "session-alias", projectKey: absolutePath }])[0].subprojectId, created.id);
  state.unassignSession("session-alias", absolutePath);
  assert.equal(state.assignmentForSession("session-alias", relativeKey), undefined);
  if (previousRoot === undefined) delete process.env.PI_WEB_WORKSPACE_ROOT;
  else process.env.PI_WEB_WORKSPACE_ROOT = previousRoot;
})

test("bulk assignment keeps every related session in one subproject", () => {
  process.env.PI_WEB_SUBPROJECTS_FILE = file;
  state.resetSubprojectStateForTests();
  const first = state.createSubproject("lineage-project", "First");
  const second = state.createSubproject("lineage-project", "Second");
  state.setSubprojectForSessions("lineage-project", ["root", "child", "injected"], first.id);
  assert.deepEqual(
    ["root", "child", "injected"].map((id) => state.assignmentForSession(id, "lineage-project")?.subprojectId),
    [first.id, first.id, first.id],
  );
  state.setSubprojectForSessions("lineage-project", ["child", "root", "injected"], second.id);
  assert.deepEqual(
    ["root", "child", "injected"].map((id) => state.assignmentForSession(id, "lineage-project")?.subprojectId),
    [second.id, second.id, second.id],
  );
  state.setSubprojectForSessions("lineage-project", ["root", "child", "injected"], null);
  assert.deepEqual(["root", "child", "injected"].map((id) => state.assignmentForSession(id, "lineage-project")), [undefined, undefined, undefined]);
});

test("cross-project assignment is rejected and unassign never deletes session", () => {
  state.resetSubprojectStateForTests()
  const created = state.createSubproject("path:one", "One")
  assert.throws(() => state.assignSession("path:two", "session-2", created.id), /another project/)
  state.assignSession("path:one", "session-2", created.id)
  state.unassignSession("session-2", "path:one")
  assert.equal(state.subprojectForSession("session-2", "path:one"), undefined)
})

test("labels are unique per project after trim and case folding", () => {
  process.env.PI_WEB_SUBPROJECTS_FILE = file
  state.resetSubprojectStateForTests()
  state.createSubproject("same-project", " Alpha ")
  assert.throws(() => state.createSubproject("same-project", "alpha"), (error) => error.code === "subproject_label_conflict" && /already exists/.test(error.message))
  const other = state.createSubproject("same-project", "Beta")
  assert.equal(other.label, "Beta")
  assert.throws(() => state.renameSubproject(other.id, " ALPHA "), (error) => error.code === "subproject_label_conflict")
  const differentProject = state.createSubproject("other-project", "alpha")
  assert.equal(differentProject.label, "alpha")
})


test("persists per-project sort mode and normalizes custom order", () => {
  process.env.PI_WEB_SUBPROJECTS_FILE = file
  state.resetSubprojectStateForTests()
  const first = state.createSubproject("sort-project", "First")
  const second = state.createSubproject("sort-project", "Second")
  const setting = state.setSubprojectSort("sort-project", "custom", [second.id, "missing", first.id, second.id])
  assert.equal(setting.mode, "custom")
  assert.deepEqual(setting.order, [second.id, first.id])
  assert.deepEqual(state.readSubprojectState().sortSettings, [{ projectKey: "sort-project", mode: "custom", order: [second.id, first.id] }])
  state.setSubprojectSort("sort-project", "alpha")
  assert.equal(state.readSubprojectState().sortSettings[0].mode, "alpha")
  state.deleteSubproject(second.id)
  assert.deepEqual(state.readSubprojectState().sortSettings[0].order, [first.id])
})

test("persists the project-scoped auto-hide policy without losing sort settings", () => {
  const previousStateFile = process.env.PI_WEB_SUBPROJECTS_FILE
  const autoHideFile = join(dir, "auto-hide.json")
  process.env.PI_WEB_SUBPROJECTS_FILE = autoHideFile
  state.resetSubprojectStateForTests()
  try {
    const first = state.createSubproject("auto-project", "First")
    const setting = state.setSubprojectAutoHideEmpty("auto-project", true)
    assert.equal(setting.autoHideEmptySubprojects, true)
    assert.equal(setting.mode, "custom")
    state.setSubprojectSort("auto-project", "alpha", [first.id])
    assert.equal(state.readSubprojectState().sortSettings[0].autoHideEmptySubprojects, true)
    const disabled = state.setSubprojectAutoHideEmpty("auto-project", false)
    assert.equal(disabled.autoHideEmptySubprojects, false)
  } finally {
    if (previousStateFile === undefined) delete process.env.PI_WEB_SUBPROJECTS_FILE
    else process.env.PI_WEB_SUBPROJECTS_FILE = previousStateFile
    state.resetSubprojectStateForTests()
  }
})

test("keeps recoverable assignments and prunes permanently deleted sessions", async () => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR
  const previousStateFile = process.env.PI_WEB_SUBPROJECTS_FILE
  const sandbox = await mkdtemp(join(dir, "orphan-"))
  const agentDir = join(sandbox, "agent")
  const stateFile = join(sandbox, "subprojects.json")
  const roots = ["sessions", "archived_sessions", "deleted_sessions"]
  const fileFor = (root, id) => join(agentDir, root, "project", `2026-01-01T00-00-00-000Z_${id}.jsonl`)
  try {
    process.env.PI_CODING_AGENT_DIR = agentDir
    process.env.PI_WEB_SUBPROJECTS_FILE = stateFile
    await Promise.all(roots.map((root) => mkdir(join(agentDir, root, "project"), { recursive: true })))
    for (const [root, id] of [["sessions", "active-session"], ["archived_sessions", "archived-session"], ["deleted_sessions", "deleted-session"]]) {
      await writeFile(fileFor(root, id), JSON.stringify({ type: "session", id }) + "\n")
    }
    state.resetSubprojectStateForTests()
    const subproject = state.createSubproject("orphan-project", "Keep")
    for (const id of ["active-session", "archived-session", "deleted-session", "permanently-deleted"]) {
      state.assignSession("orphan-project", id, subproject.id)
    }

    assert.equal(state.pruneOrphanedSubprojectAssignments(), 1)
    assert.deepEqual(state.readSubprojectState().assignments.map((item) => item.sessionId).sort(), ["active-session", "archived-session", "deleted-session"])

    await rm(fileFor("deleted_sessions", "deleted-session"))
    assert.deepEqual(state.readSubprojectState().assignments.map((item) => item.sessionId).sort(), ["active-session", "archived-session", "deleted-session"])
    state.resetSubprojectStateForTests()
    assert.deepEqual(state.readSubprojectState().assignments.map((item) => item.sessionId).sort(), ["active-session", "archived-session"])
    state.assignSession("orphan-project", "scan-unavailable", subproject.id)
    await rm(join(agentDir, "deleted_sessions"), { recursive: true, force: true })
    await writeFile(join(agentDir, "deleted_sessions"), "not-a-directory")
    state.resetSubprojectStateForTests()
    assert.deepEqual(state.readSubprojectState().assignments.map((item) => item.sessionId).sort(), ["active-session", "archived-session", "scan-unavailable"])

    state.assignSession("orphan-project", "missing-root", subproject.id)
    await rm(join(agentDir, "deleted_sessions"), { recursive: true, force: true })
    state.resetSubprojectStateForTests()
    assert.deepEqual(state.readSubprojectState().assignments.map((item) => item.sessionId).sort(), ["active-session", "archived-session", "missing-root", "scan-unavailable"])
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir
    if (previousStateFile === undefined) delete process.env.PI_WEB_SUBPROJECTS_FILE
    else process.env.PI_WEB_SUBPROJECTS_FILE = previousStateFile
    await rm(sandbox, { recursive: true, force: true })
  }
})
test("corrupt or unknown schema throws instead of being overwritten, then reloads after repair", async () => {
  const corruptFile = join(dir, "corrupt.json")
  process.env.PI_WEB_SUBPROJECTS_FILE = corruptFile
  await writeFile(corruptFile, JSON.stringify({ schemaVersion: 99, subprojects: [], assignments: [] }))
  state.resetSubprojectStateForTests()
  assert.throws(() => state.readSubprojectState(), /Unsupported subproject state schema/)
  await writeFile(corruptFile, JSON.stringify({ schemaVersion: 1, subprojects: [], assignments: [] }))
  assert.deepEqual(state.readSubprojectState(), { schemaVersion: 1, subprojects: [], assignments: [] })
})

test("failed persistence does not replace cached state", async () => {
  const blocked = join(dir, "blocked")
  await writeFile(blocked, "not a directory")
  process.env.PI_WEB_SUBPROJECTS_FILE = join(blocked, "subprojects.json")
  state.resetSubprojectStateForTests()
  assert.throws(() => state.createSubproject("project", "Alpha"))
  assert.deepEqual(state.readSubprojectState(), { schemaVersion: 1, subprojects: [], assignments: [] })
})
