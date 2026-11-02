import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-categories-"));
const categoriesFile = path.join(directory, "session-categories.json");
process.env.PI_WEB_SESSION_CATEGORIES_FILE = categoriesFile;
const categories = await import("./session-category-state.ts");

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("starts empty and persists category assignment", () => {
  categories.resetSessionCategoryStateForTests();
  assert.deepEqual(categories.readSessionCategoryState(), { to_discuss: [], to_revise: [], completed: [] });
  assert.equal(categories.sessionCategory("s1"), undefined);

  categories.setSessionCategory("s1", "to_discuss");
  assert.equal(categories.sessionCategory("s1"), "to_discuss");
  assert.deepEqual(categories.readSessionCategoryState(), { to_discuss: ["s1"], to_revise: [], completed: [] });

  // Switching category removes from previous
  categories.setSessionCategory("s1", "to_revise");
  assert.equal(categories.sessionCategory("s1"), "to_revise");
  assert.deepEqual(categories.readSessionCategoryState(), { to_discuss: [], to_revise: ["s1"], completed: [] });

  categories.setSessionCategory("s2", "completed");
  assert.equal(categories.sessionCategory("s2"), "completed");
  assert.deepEqual(categories.readSessionCategoryState(), { to_discuss: [], to_revise: ["s1"], completed: ["s2"] });

  // Clearing category removes from state
  categories.setSessionCategory("s1", null);
  assert.equal(categories.sessionCategory("s1"), undefined);
  assert.deepEqual(categories.readSessionCategoryState(), { to_discuss: [], to_revise: [], completed: ["s2"] });

  const persisted = JSON.parse(fs.readFileSync(categoriesFile, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(categoriesFile).mode & 0o777, 0o600);
});

test("dedupes ids and ignores invalid entries on load", () => {
  fs.writeFileSync(categoriesFile, JSON.stringify({
    schemaVersion: 1,
    to_discuss: ["s1", "s1", 123, ""],
    to_revise: ["s2"],
    completed: ["s3"],
  }));
  categories.resetSessionCategoryStateForTests();
  assert.deepEqual(categories.readSessionCategoryState(), {
    to_discuss: ["s1"],
    to_revise: ["s2"],
    completed: ["s3"],
  });
});

test("normal and category views use one exclusive category projection", () => {
  const state = {
    to_discuss: ["discussion"],
    to_revise: ["revision"],
    completed: ["done"],
  };
  const sessions = [{ id: "discussion" }, { id: "revision" }, { id: "done" }, { id: "plain" }];

  assert.deepEqual(categories.filterSessionsByCategory(sessions, state, null).map(({ id }) => id), ["plain"]);
  assert.deepEqual(categories.filterSessionsByCategory(sessions, state, "to_discuss").map(({ id }) => id), ["discussion"]);
  assert.deepEqual(categories.filterSessionsByCategory(sessions, state, "to_revise").map(({ id }) => id), ["revision"]);
  assert.deepEqual(categories.filterSessionsByCategory(sessions, state, "completed").map(({ id }) => id), ["done"]);
});

test("blank and duplicate category assignments are no-ops", () => {
  fs.rmSync(categoriesFile, { force: true });
  categories.resetSessionCategoryStateForTests();
  categories.setSessionCategory("  ", "to_discuss");
  categories.setSessionCategory("s1", "to_discuss");
  categories.setSessionCategory("s1", "to_discuss");
  assert.deepEqual(categories.readSessionCategoryState(), {
    to_discuss: ["s1"],
    to_revise: [],
    completed: [],
  });
});
