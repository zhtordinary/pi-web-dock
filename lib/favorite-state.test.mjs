import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-favorites-"));
const favoritesFile = path.join(directory, "favorites.json");
process.env.PI_WEB_FAVORITES_FILE = favoritesFile;
const favorites = await import("./favorite-state.ts");

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("starts empty and persists add/remove", () => {
  globalThis.__piFavoriteStateCache = undefined;
  assert.deepEqual(favorites.readFavoriteState(), { sessions: [] });
  favorites.setFavorite("s1", true);
  favorites.setFavorite("s2", true);
  assert.equal(favorites.isFavorite("s1"), true);
  favorites.setFavorite("s1", false);
  assert.deepEqual(favorites.readFavoriteState(), { sessions: ["s2"] });
  const persisted = JSON.parse(fs.readFileSync(favoritesFile, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  if (process.platform !== "win32") assert.equal(fs.statSync(favoritesFile).mode & 0o777, 0o600);
});

test("dedupes ids and ignores invalid entries on load", () => {
  fs.writeFileSync(favoritesFile, JSON.stringify({ schemaVersion: 1, sessions: ["s1", "s1", 7, ""] }));
  globalThis.__piFavoriteStateCache = undefined;
  assert.deepEqual(favorites.readFavoriteState(), { sessions: ["s1"] });
});

test("blank and repeated operations are no-ops", () => {
  fs.rmSync(favoritesFile, { force: true });
  globalThis.__piFavoriteStateCache = undefined;
  favorites.setFavorite("  ", true);
  favorites.setFavorite("s1", true);
  favorites.setFavorite("s1", true);
  favorites.setFavorite("s1", false);
  favorites.setFavorite("s1", false);
  assert.deepEqual(favorites.readFavoriteState(), { sessions: [] });
});
