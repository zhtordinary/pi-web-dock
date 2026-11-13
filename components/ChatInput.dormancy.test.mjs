import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const {
  buildSlashCommandLayout,
  getSlashGroupBoundaryDownIndex,
  sortSlashCommandItems,
} = await jiti.import("./ChatInput.tsx");

test("uses the rendered slash command order for selection indices", () => {
  const dormant = {
    name: "skill:alpha",
    description: "Dormant skill",
    source: "skill",
  };
  const active = {
    name: "skill:beta",
    description: "Active skill",
    source: "skill",
  };
  const builtin = {
    name: "compact",
    description: "Compact",
    source: "builtin",
  };

  const layout = buildSlashCommandLayout(
    [dormant, active, builtin],
    { alpha: true, beta: false },
  );

  assert.deepEqual(
    layout.commands.map((command) => command.name),
    ["compact", "skill:beta", "skill:alpha"],
  );
  assert.deepEqual(
    layout.groups.flatMap((group) => group.items.map((item) => item.index)),
    [0, 1, 2],
  );
});

test("keeps search relevance ahead of dormancy within the skill group", () => {
  const commands = [
    { name: "skill:review-pr", description: "Active prefix", source: "skill" },
    { name: "skill:review", description: "Dormant exact", source: "skill" },
    { name: "skill:other", description: "review in description", source: "skill" },
  ];
  const dormancy = { review: true, "review-pr": false, other: false };
  const sorted = sortSlashCommandItems(commands, "review", (value) => value);
  const layout = buildSlashCommandLayout(sorted, dormancy, "review");

  assert.deepEqual(layout.commands.map((command) => command.name), ["skill:review", "skill:review-pr", "skill:other"]);
  assert.deepEqual(layout.groups.flatMap((group) => group.items.map((item) => item.index)), [0, 1, 2]);
  assert.deepEqual(buildSlashCommandLayout(sorted, dormancy, "   ").commands.map((command) => command.name),
    ["skill:review-pr", "skill:other", "skill:review"]);
});

test("orders customPrompt group before builtin and skills", () => {
  const prompt = {
    name: "My custom prompt",
    description: "Preview text",
    source: "customPrompt",
    promptId: "p1",
    content: "Full content text",
    order: 1,
  };
  const builtin = {
    name: "compact",
    description: "Compact",
    source: "builtin",
  };
  const skill = {
    name: "skill:test",
    description: "Test skill",
    source: "skill",
  };

  const layout = buildSlashCommandLayout(
    [skill, builtin, prompt],
    {},
  );

  assert.deepEqual(
    layout.commands.map((command) => command.name),
    ["My custom prompt", "compact", "skill:test"],
  );
  assert.equal(layout.groups[0].source, "customPrompt");
});

test("moves down from a single-card group to the first card in the next group", () => {
  const groups = [
    { items: [{ index: 0 }] },
    { items: [{ index: 1 }, { index: 2 }, { index: 3 }] },
  ];

  assert.equal(getSlashGroupBoundaryDownIndex(groups, 0), 1);
  assert.equal(getSlashGroupBoundaryDownIndex(groups, 1), null);
  assert.equal(getSlashGroupBoundaryDownIndex(groups, 3), null);
});
