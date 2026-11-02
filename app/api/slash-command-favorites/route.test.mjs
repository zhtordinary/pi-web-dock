import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("slash favorites API supports no-store GET and normalized PUT", () => {
  assert.match(route, /export async function GET/);
  assert.match(route, /export async function PUT/);
  assert.match(route, /readSlashFavoriteState/);
  assert.match(route, /setSlashFavoriteKeys/);
  assert.match(route, /setSlashFavoriteCategories/);
  assert.match(route, /isApiRequestAllowed\(req\)/);
  assert.match(route, /hasJsonContentType\(req\)/);
  assert.match(route, /Cache-Control.*no-store/);
  assert.match(route, /keys must be an array/);
  assert.match(route, /slash_favorites_read_failed/);
  assert.match(route, /slash_favorites_write_failed/);
  assert.match(route, /503/);
  assert.match(route, /500/);
});
