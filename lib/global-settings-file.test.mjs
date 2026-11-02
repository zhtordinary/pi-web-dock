import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const { readGlobalSettings, updateGlobalSettings } = await createJiti(import.meta.url).import("./global-settings-file.ts");

test("invalid settings report the authorized path without exposing contents or overwriting", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reader-settings-parse-test-"));
  t.after(() => rm(dir, { recursive: true }));
  const path = join(dir, "settings.json");
  for (const [original, errorType] of [['{"example":"SYNTHETIC_SECRET",}', SyntaxError], ['[]', Error]]) {
    await writeFile(path, original);
    for (const operation of [() => readGlobalSettings(path, value => value), () => updateGlobalSettings(path, value => { value.test = true; })]) {
      await assert.rejects(operation, error => {
        assert.equal(error.constructor, errorType);
        assert.ok(error.message.includes(path));
        assert.doesNotMatch(error.message, /SYNTHETIC_SECRET/);
        return true;
      });
      assert.equal(await readFile(path, "utf8"), original);
    }
  }
});
