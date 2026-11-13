import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createJiti } from "jiti";

const { readGlobalSettings, updateGlobalSettings } = await createJiti(import.meta.url).import("./global-settings-file.ts");

test("updates a linked project settings file without changing its mode", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reader-settings-linked-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const shared = join(dir, "shared.json");
  const link = join(dir, "project", "settings.json");
  await mkdir(join(dir, "project"));
  await writeFile(shared, "{}\n");
  await chmod(shared, 0o644);
  try { await symlink(shared, link); } catch (error) {
    if (error?.code === "EPERM") return t.skip("Creating symbolic links requires additional privileges");
    throw error;
  }
  await updateGlobalSettings(link, (value) => { value.changed = true; }, () => shared, true);
  assert.deepEqual(JSON.parse(await readFile(shared, "utf8")), { changed: true });
  if (process.platform !== "win32") assert.equal((await stat(shared)).mode & 0o777, 0o644);
});

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
