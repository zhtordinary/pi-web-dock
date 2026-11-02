import assert from "node:assert/strict"
import test from "node:test"
import { createJiti } from "jiti"

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false })
const { UNCLASSIFIED_SUBPROJECT_ID, filterSubprojectItems, groupBySubproject, orderedSubprojectIds, projectKeysMatch, reorderSubprojectIds } = await jiti.import("./subproject-groups.ts")

const definitions = [
  { id: "a", projectKey: "p", label: "Alpha", createdAt: "1", updatedAt: "1" },
  { id: "empty", projectKey: "p", label: "Empty", createdAt: "1", updatedAt: "1" },
  { id: "other", projectKey: "q", label: "Other", createdAt: "1", updatedAt: "1" },
]

test("groups retain empty definitions and implicit unclassified bucket", () => {
  const groups = groupBySubproject([{ id: "1", subprojectId: "a" }, { id: "2" }], definitions, "p", "Unclassified")
  assert.deepEqual(groups.map((group) => [group.id, group.items.map((item) => item.id)]), [["a", ["1"]], ["empty", []], [UNCLASSIFIED_SUBPROJECT_ID, ["2"]]])
})

test("does not render an empty unclassified bucket", () => {
  const groups = groupBySubproject([{ id: "1", subprojectId: "a" }], definitions, "p", "Unclassified")
  assert.deepEqual(groups.map((group) => group.id), ["a", "empty"])
})

test("unknown or foreign assignments are unclassified", () => {
  const groups = groupBySubproject([{ id: "1", subprojectId: "other" }, { id: "2", subprojectId: "missing" }], definitions, "p", "Unclassified")
  assert.deepEqual(groups.at(-1).items.map((item) => item.id), ["1", "2"])
})

test("filters hidden assignments before grouping instead of reclassifying them", () => {
  const items = [{ id: "hidden", subprojectId: "a" }, { id: "visible", subprojectId: "empty" }, { id: "unclassified" }]
  assert.deepEqual(filterSubprojectItems(items, new Set(["a"])).map((item) => item.id), ["visible", "unclassified"])
})

test("sorts subproject buckets by name, inherited session order, and custom order", () => {
  const items = [
    { id: "session-a", subprojectId: "a", lastActivityAt: "2026-01-01T00:00:00.000Z" },
    { id: "session-empty", subprojectId: "empty", lastActivityAt: "2026-01-02T00:00:00.000Z" },
  ]
  const compareRecent = (left, right) => right.lastActivityAt.localeCompare(left.lastActivityAt)
  assert.deepEqual(groupBySubproject(items, definitions, "p", "Unclassified", { mode: "alpha" }).map((group) => group.id), ["a", "empty"])
  assert.deepEqual(groupBySubproject(items, definitions, "p", "Unclassified", { mode: "inherit", compareItems: compareRecent }).map((group) => group.id), ["empty", "a"])
  assert.deepEqual(groupBySubproject(items, definitions, "p", "Unclassified", { mode: "custom", customOrder: ["a", "empty"] }).map((group) => group.id), ["a", "empty"])
  assert.deepEqual(orderedSubprojectIds(definitions, ["empty", "missing", "a"]), ["empty", "a", "other"])
  assert.deepEqual(reorderSubprojectIds(["a", "empty"], "a", "empty", false), ["empty", "a"])
  assert.deepEqual(reorderSubprojectIds(["empty", "a"], "a", "empty", true), ["a", "empty"])
})

test("matches historical absolute and workspace-relative path keys", () => {
  assert.equal(projectKeysMatch("/Volumes/work/project", "path:/Volumes/work/project"), true)
  assert.equal(projectKeysMatch("path:../../Volumes/work/project", "path:/Volumes/work/project"), true)
  assert.equal(projectKeysMatch("path:Projects/work", "path:/Users/test/Projects/work"), true)
  assert.equal(projectKeysMatch("path:/Volumes/other", "path:/Volumes/work/project"), false)
  assert.equal(projectKeysMatch("git:one", "git:two"), false)
  assert.equal(projectKeysMatch(undefined, "path:/Volumes/work/project"), false)
})
