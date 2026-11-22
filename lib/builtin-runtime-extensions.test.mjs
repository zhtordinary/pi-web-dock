import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BUILTIN_RUNTIME_EXTENSION_NAMES, BUILTIN_RUNTIME_EXTENSIONS } = await jiti.import("./builtin-runtime-extensions.ts");

test("keeps Reader runtime capabilities and infrastructure distinct, unique and tied to their source", async () => {
  const names = Object.entries(BUILTIN_RUNTIME_EXTENSION_NAMES);
  const ids = BUILTIN_RUNTIME_EXTENSIONS.map((extension) => extension.id);
  assert.deepEqual([...ids].sort(), names.map(([, value]) => value).sort());
  assert.equal(new Set(ids).size, ids.length);
  assert.deepEqual(BUILTIN_RUNTIME_EXTENSIONS.filter((extension) => extension.category === "capability").map((extension) => extension.id), [
    BUILTIN_RUNTIME_EXTENSION_NAMES.compactionModel,
    BUILTIN_RUNTIME_EXTENSION_NAMES.fastMode,
    BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandEnvironment,
    BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandPowerShell,
    BUILTIN_RUNTIME_EXTENSION_NAMES.sessionControl,
    BUILTIN_RUNTIME_EXTENSION_NAMES.subagents,
  ]);
  for (const extension of BUILTIN_RUNTIME_EXTENSIONS) {
    assert.equal(extension.source, "reader");
    assert.equal(extension.origin, "inline");
    assert.equal(extension.scope, "session");
    assert.equal(extension.status, "reader-provided");
    assert.ok(extension.capabilities.length > 0);
    const key = names.find(([, value]) => value === extension.id)[0];
    const source = await readFile(new URL(`../${extension.sourcePath}`, import.meta.url), "utf8");
    assert.ok(source.includes(extension.id) || source.includes(`BUILTIN_RUNTIME_EXTENSION_NAMES.${key}`), extension.id);
  }
});

test("every catalog entry and heading has a localized label", async () => {
  const locales = [
    (await jiti.import("./i18n/messages/en.ts")).enLocale,
    (await jiti.import("./i18n/messages/zh-CN.ts")).zhCNLocale,
    (await jiti.import("./i18n/messages/zh-TW.ts")).zhTWLocale,
  ];
  for (const locale of locales) {
    for (const key of ["i18n.builtinRuntimeExtensions", "i18n.builtinRuntimeInfrastructure", "i18n.builtinRuntimeExtensionSourceFile",
      ...BUILTIN_RUNTIME_EXTENSIONS.flatMap((extension) => [extension.labelKey, extension.descriptionKey])]) {
      assert.ok(locale.messages[key], `${locale.id}: ${key}`);
    }
  }
});
