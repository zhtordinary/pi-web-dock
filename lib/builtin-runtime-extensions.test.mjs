import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { BUILTIN_RUNTIME_EXTENSION_NAMES, BUILTIN_RUNTIME_EXTENSIONS } = await jiti.import("./builtin-runtime-extensions.ts");

test("keeps the Reader-injected runtime extension registry complete and unique", () => {
  assert.deepEqual(BUILTIN_RUNTIME_EXTENSIONS.map((extension) => extension.id), [
    BUILTIN_RUNTIME_EXTENSION_NAMES.compactionModel,
    BUILTIN_RUNTIME_EXTENSION_NAMES.fastMode,
    BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandEnvironment,
    BUILTIN_RUNTIME_EXTENSION_NAMES.sessionControl,
  ]);
  assert.equal(new Set(BUILTIN_RUNTIME_EXTENSIONS.map((extension) => extension.id)).size, 4);
  assert.ok(BUILTIN_RUNTIME_EXTENSIONS.every((extension) => (
    extension.source === "reader"
    && ["inline", "builtin"].includes(extension.origin)
    && extension.scope === "session"
    && extension.status === "reader-provided"
    && extension.capabilities.length > 0
  )));
});
