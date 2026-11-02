import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);

const stateSource = readFileSync(new URL("./custom-prompts-state.ts", import.meta.url), "utf8");

test("custom prompts default to the shared Pi agent config root", () => {
  assert.match(stateSource, /getAgentDir/);
  assert.match(stateSource, /join\(getAgentDir\(\), "custom-prompts\.json"\)/);
  assert.doesNotMatch(stateSource, /XDG_CONFIG_HOME/);
});

test("custom prompts state management", async (t) => {
  const tempDir = mkdtempSync(join(tmpdir(), "custom-prompts-test-"));
  const testFile = join(tempDir, "custom-prompts.json");
  process.env.PI_WEB_CUSTOM_PROMPTS_FILE = testFile;

  const {
    readCustomPrompts,
    saveCustomPrompt,
    deleteCustomPrompt,
    reorderCustomPrompts,
  } = await jiti.import("./custom-prompts-state.ts");

  t.after(() => {
    delete process.env.PI_WEB_CUSTOM_PROMPTS_FILE;
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  await t.test("starts empty", () => {
    assert.deepEqual(readCustomPrompts(), []);
  });

  await t.test("rereads external file edits", () => {
    writeFileSync(testFile, JSON.stringify({ version: 1, prompts: [{ id: "external", title: "External", content: "fixture" }] }));
    assert.deepEqual(readCustomPrompts().map(({ id, title }) => ({ id, title })), [{ id: "external", title: "External" }]);
    writeFileSync(testFile, JSON.stringify({ version: 1, prompts: [] }));
  });

  await t.test("does not treat invalid data as empty or overwrite it", () => {
    writeFileSync(testFile, "{");
    const original = readFileSync(testFile, "utf8");
    assert.throws(() => readCustomPrompts(), /invalid JSON/i);
    assert.throws(() => saveCustomPrompt({ title: "Fixture", content: "fixture" }), /invalid JSON/i);
    assert.equal(readFileSync(testFile, "utf8"), original);
    writeFileSync(testFile, JSON.stringify({ version: 1, prompts: [] }));
  });

  let p1;
  let p2;

  await t.test("can save new prompts", () => {
    p1 = saveCustomPrompt({
      title: "Review Code",
      content: "Please review the changes in detail.",
      description: "Code review prompt",
    });
    assert.ok(p1.id);
    assert.equal(p1.title, "Review Code");
    assert.equal(p1.content, "Please review the changes in detail.");
    assert.equal(p1.description, "Code review prompt");
    assert.equal(p1.order, 0);

    p2 = saveCustomPrompt({
      title: "Fix Bug",
      content: "Find root cause and propose minimal fix.",
    });
    assert.ok(p2.id);
    assert.equal(p2.title, "Fix Bug");
    assert.equal(p2.order, 1);

    const list = readCustomPrompts();
    assert.equal(list.length, 2);
    assert.equal(list[0].id, p1.id);
    assert.equal(list[1].id, p2.id);
  });

  await t.test("can update existing prompt", () => {
    const updated = saveCustomPrompt({
      id: p1.id,
      title: "Review Code Updated",
      content: "Please review the changes with extra scrutiny.",
    });
    assert.equal(updated.id, p1.id);
    assert.equal(updated.title, "Review Code Updated");
    assert.equal(updated.content, "Please review the changes with extra scrutiny.");

    const list = readCustomPrompts();
    assert.equal(list.length, 2);
    assert.equal(list[0].title, "Review Code Updated");
  });

  await t.test("can reorder prompts", () => {
    const reordered = reorderCustomPrompts([p2.id, p1.id]);
    assert.equal(reordered[0].id, p2.id);
    assert.equal(reordered[1].id, p1.id);

    const list = readCustomPrompts();
    assert.equal(list[0].id, p2.id);
    assert.equal(list[1].id, p1.id);
  });

  await t.test("can delete prompt", () => {
    const ok = deleteCustomPrompt(p1.id);
    assert.equal(ok, true);

    const list = readCustomPrompts();
    assert.equal(list.length, 1);
    assert.equal(list[0].id, p2.id);

    const deleteAgain = deleteCustomPrompt(p1.id);
    assert.equal(deleteAgain, false);
  });

  await t.test("missing file is empty after prior writes", () => {
    unlinkSync(testFile);
    assert.deepEqual(readCustomPrompts(), []);
  });
});
