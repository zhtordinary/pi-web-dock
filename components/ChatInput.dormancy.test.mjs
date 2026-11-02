import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const { buildSlashCommandLayout } = await jiti.import("./ChatInput.tsx");

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
