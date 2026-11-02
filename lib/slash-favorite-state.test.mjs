import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-slash-favorites-"));
const favoritesFile = path.join(directory, "slash-command-favorites.json");
process.env.PI_WEB_SLASH_FAVORITES_FILE = favoritesFile;
const favorites = await import("./slash-favorite-state.ts");

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("starts empty and persists normalized order", () => {
  assert.deepEqual(favorites.readSlashFavoriteState(), {
    schemaVersion: 2,
    categories: [{ id: "default", name: "常用", keys: [] }],
    keys: [],
  });
  assert.deepEqual(favorites.setSlashFavoriteKeys([" skill:review ", "skill:review", "", 3, " prompt:polish "]), {
    schemaVersion: 2,
    categories: [{ id: "default", name: "常用", keys: ["skill:review", "prompt:polish"] }],
    keys: ["skill:review", "prompt:polish"],
  });
  assert.deepEqual(favorites.readSlashFavoriteState(), {
    schemaVersion: 2,
    categories: [{ id: "default", name: "常用", keys: ["skill:review", "prompt:polish"] }],
    keys: ["skill:review", "prompt:polish"],
  });
  const persisted = JSON.parse(fs.readFileSync(favoritesFile, "utf8"));
  assert.equal(persisted.schemaVersion, 2);
  if (process.platform !== "win32") assert.equal(fs.statSync(favoritesFile).mode & 0o777, 0o600);
});

test("supports custom categories and persists category structure", () => {
  const result = favorites.setSlashFavoriteCategories([
    { id: "cat_code", name: "代码审查", keys: ["skill:code-review", "builtin:diff"] },
    { id: "cat_write", name: "日常写作", keys: ["skill:write", "prompt:polish"] },
  ]);
  assert.equal(result.schemaVersion, 2);
  assert.equal(result.categories.length, 2);
  assert.deepEqual(result.keys, ["skill:code-review", "builtin:diff", "skill:write", "prompt:polish"]);

  // Reading back reproduces exact categories and flat keys
  const readBack = favorites.readSlashFavoriteState();
  assert.deepEqual(readBack.categories, [
    { id: "cat_code", name: "代码审查", keys: ["skill:code-review", "builtin:diff"] },
    { id: "cat_write", name: "日常写作", keys: ["skill:write", "prompt:polish"] },
  ]);
  assert.deepEqual(readBack.keys, ["skill:code-review", "builtin:diff", "skill:write", "prompt:polish"]);

  // Updating keys preserves existing categories and appends new keys to first category
  const updated = favorites.setSlashFavoriteKeys(["builtin:diff", "skill:write", "skill:new"]);
  assert.deepEqual(updated.categories[0].keys, ["builtin:diff", "skill:new"]);
  assert.deepEqual(updated.categories[1].keys, ["skill:write"]);
});

test("accepts a legacy array file or schemaVersion 1 and upgrades smoothly", () => {
  fs.writeFileSync(favoritesFile, JSON.stringify(["a", "a", 4, "b"]));
  assert.deepEqual(favorites.readSlashFavoriteState(), {
    schemaVersion: 2,
    categories: [{ id: "default", name: "常用", keys: ["a", "b"] }],
    keys: ["a", "b"],
  });

  fs.writeFileSync(favoritesFile, JSON.stringify({ schemaVersion: 1, keys: ["x", "y"] }));
  assert.deepEqual(favorites.readSlashFavoriteState(), {
    schemaVersion: 2,
    categories: [{ id: "default", name: "常用", keys: ["x", "y"] }],
    keys: ["x", "y"],
  });

  fs.writeFileSync(favoritesFile, "not json");
  assert.throws(() => favorites.readSlashFavoriteState(), /Failed to read slash favorites state/);
  fs.writeFileSync(favoritesFile, JSON.stringify({ schemaVersion: 1 }));
  assert.throws(() => favorites.readSlashFavoriteState(), /Invalid slash favorites file format/);
});

test("propagates write failures without replacing the original path", () => {
  fs.rmSync(favoritesFile, { force: true });
  fs.mkdirSync(favoritesFile);
  assert.throws(() => favorites.setSlashFavoriteKeys(["a"]));
  assert.equal(fs.statSync(favoritesFile).isDirectory(), true);
});
