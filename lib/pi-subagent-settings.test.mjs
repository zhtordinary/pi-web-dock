import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { readPiSubagentOverride, readPiSubagentStoredOverride, writePiSubagentOverride } = await createJiti(import.meta.url).import("./pi-subagent-settings.ts");

test("pi-subagents model overrides preserve unrelated settings and clear cleanly", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pi-subagent-settings-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({ defaultModel: "provider/default", futureSetting: true }));

  writePiSubagentOverride("worker", { model: "provider/worker", thinking: "high" }, root);
  assert.deepEqual(readPiSubagentOverride("worker", root), { model: "provider/worker", thinking: "high" });
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    defaultModel: "provider/default",
    futureSetting: true,
    subagents: { agentOverrides: { worker: { model: "provider/worker", thinking: "high" } } },
  });

  writePiSubagentOverride("worker", { model: null, thinking: null }, root);
  assert.deepEqual(readPiSubagentOverride("worker", root), {});
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    defaultModel: "provider/default",
    futureSetting: true,
  });
});

test("native false sentinels can explicitly clear a thinking pin", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pi-subagent-settings-inherit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "settings.json"), JSON.stringify({
    subagents: { agentOverrides: { reviewer: { thinking: "high" } } },
  }));

  writePiSubagentOverride("reviewer", { thinking: false }, root);
  assert.deepEqual(readPiSubagentStoredOverride("reviewer", root), { thinking: false });
  assert.deepEqual(readPiSubagentOverride("reviewer", root), {});
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), {
    subagents: { agentOverrides: { reviewer: { thinking: false } } },
  });
});

test("native false sentinels and unknown entry fields survive a field-level edit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-pi-subagent-settings-sentinel-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const settingsPath = join(root, "settings.json");
  await writeFile(settingsPath, JSON.stringify({
    future: { keep: true },
    subagents: {
      futureSubagentSetting: 4,
      agentOverrides: {
        worker: { model: false, thinking: "high", futureField: { keep: true } },
        sibling: { model: "provider/sibling" },
      },
    },
  }));

  writePiSubagentOverride("worker", { thinking: null }, root);
  assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
    future: { keep: true },
    subagents: {
      futureSubagentSetting: 4,
      agentOverrides: {
        worker: { model: false, futureField: { keep: true } },
        sibling: { model: "provider/sibling" },
      },
    },
  });
});
