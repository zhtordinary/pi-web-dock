import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { parsePluginModelDescriptor, projectPluginModelSettings, readPluginModelSettings, writePluginModelSettings, discoverPluginModelSettings } = await jiti.import("./plugin-model-settings.ts");
const ref = { version: 1, label: "Fixture", directory: "fixture-plugin",
  model: { kind: "reference", paths: ["inference.suggesterModel", "inference.seederModel"], follow: "session-default" },
  thinking: { paths: ["inference.suggesterThinking", "inference.seederThinking"], fallback: "session-default", options: ["session-default", "low", "high"] } };
const split = { version: 1, label: "Recap fixture", directory: "recap-fixture",
  model: { kind: "split", provider: "provider", model: "model", mode: "mode", follow: "follow", fixed: "fixed" },
  thinking: { paths: ["thinkingLevel"], fallback: "low", options: ["auto", "off", "low"] } };

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-plugin-models-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("shared row preserves separately configured values until that field is explicitly changed", async (t) => {
  const root = await fixture(t), descriptor = parsePluginModelDescriptor("fixture", ref);
  await mkdir(join(root, "fixture-plugin"));
  const path = join(root, "fixture-plugin", "config.json");
  await writeFile(path, JSON.stringify({ inference: { suggesterModel: "a/m1", seederModel: "b/m2", suggesterThinking: "low", seederThinking: "high", extra: 7 }, another: true }));
  const initial = readPluginModelSettings(descriptor, root);
  assert.equal(initial.model, "mixed");
  assert.equal(initial.thinking, "mixed");
  const saved = writePluginModelSettings(descriptor, root, initial.revision, { model: { provider: "c", modelId: "m3" } });
  assert.deepEqual(saved.model, { provider: "c", modelId: "m3" });
  assert.equal(saved.thinking, "mixed");
  const document = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(document.inference, { suggesterModel: "c/m3", seederModel: "c/m3", suggesterThinking: "low", seederThinking: "high", extra: 7 });
  assert.equal(document.another, true);
  assert.throws(() => writePluginModelSettings(descriptor, root, initial.revision, { thinking: "low" }), /revision changed/i);
  const next = writePluginModelSettings(descriptor, root, saved.revision, { thinking: "low" });
  assert.equal(next.thinking, "low");
  assert.deepEqual(writePluginModelSettings(descriptor, root, next.revision, { model: null }).model, null);
});

test("split plugin settings keep unrelated values and support a missing configuration directory", async (t) => {
  const root = await fixture(t), descriptor = parsePluginModelDescriptor("recap", split);
  const initial = readPluginModelSettings(descriptor, root);
  assert.equal(initial.model, null);
  assert.equal(initial.thinking, "low");
  const saved = writePluginModelSettings(descriptor, root, initial.revision, { model: { provider: "fixture", modelId: "model" }, thinking: "off" });
  assert.deepEqual(saved.model, { provider: "fixture", modelId: "model" });
  assert.equal(saved.thinking, "off");
  const path = join(root, "recap-fixture", "config.json");
  const document = JSON.parse(await readFile(path, "utf8"));
  document.extra = { retained: true };
  await writeFile(path, JSON.stringify(document));
  const current = readPluginModelSettings(descriptor, root);
  writePluginModelSettings(descriptor, root, current.revision, { model: null });
  const result = JSON.parse(await readFile(path, "utf8"));
  assert.equal(result.mode, "follow");
  assert.deepEqual(result.extra, { retained: true });
});

test("rejects unsafe descriptors and leaves invalid or symlinked configuration untouched", async (t) => {
  const root = await fixture(t), descriptor = parsePluginModelDescriptor("fixture", ref);
  assert.equal(parsePluginModelDescriptor("fixture", { ...ref, directory: "../escape" }), null);
  assert.equal(parsePluginModelDescriptor("fixture", { ...ref, model: { ...ref.model, paths: ["inference.__proto__.polluted"] } }), null);
  assert.equal(parsePluginModelDescriptor("fixture", { ...ref, thinking: { ...ref.thinking, paths: ["inference"] } }), null);
  await mkdir(join(root, "fixture-plugin"));
  const path = join(root, "fixture-plugin", "config.json");
  await writeFile(path, "{broken");
  assert.throws(() => readPluginModelSettings(descriptor, root), /invalid JSON/);
  assert.equal(await readFile(path, "utf8"), "{broken");
  await rm(path);
  await symlink(join(root, "other.json"), path);
  assert.throws(() => readPluginModelSettings(descriptor, root), /symlink/i);
  assert.throws(() => writePluginModelSettings(descriptor, root, "x", { model: null }), /symlink/i);
});

test("plugin auto behavior is explicitly described without inventing a meaning", () => {
  const descriptor = parsePluginModelDescriptor("recap", { ...split, thinking: { ...split.thinking, autoBehavior: "session" } });
  const row = projectPluginModelSettings(descriptor, {}, "rev");
  assert.equal(row.thinkingAutoBehavior, "session");
  assert.equal(projectPluginModelSettings(parsePluginModelDescriptor("recap", split), {}, "rev").thinkingAutoBehavior, undefined);
  assert.equal(parsePluginModelDescriptor("recap", { ...split, thinking: { ...split.thinking, autoBehavior: "arbitrary" } }), null);
});

test("concrete model levels are not restricted by a legacy descriptor list", async (t) => {
  const root = await fixture(t), descriptor = parsePluginModelDescriptor("fixture", ref);
  await mkdir(join(root, "fixture-plugin"));
  const initial = readPluginModelSettings(descriptor, root);
  const saved = writePluginModelSettings(descriptor, root, initial.revision, { thinking: "max" });
  assert.equal(saved.thinking, "max");
});

test("bare model IDs remain visible without guessing a provider", () => {
  const row = projectPluginModelSettings(parsePluginModelDescriptor("fixture", ref), { inference: { suggesterModel: "plain", seederModel: "plain" } }, "rev");
  assert.deepEqual(row.model, { provider: "", modelId: "plain" });
});

test("discovers model settings only from configured user packages", async (t) => {
  const root = await fixture(t), pkg = join(root, "package");
  await mkdir(pkg);
  await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture", piWeb: { modelSettings: ref }, pi: { extensions: [] } }));
  await writeFile(join(root, "settings.json"), JSON.stringify({ packages: [pkg] }));
  const descriptors = discoverPluginModelSettings(root);
  assert.equal(descriptors.length, 1);
  assert.equal(descriptors[0].id, "fixture");
});
