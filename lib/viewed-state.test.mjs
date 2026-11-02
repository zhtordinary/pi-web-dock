import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "pi-web-viewed-"));
const viewedFile = path.join(directory, "viewed.json");
process.env.PI_WEB_VIEWED_FILE = viewedFile;
const viewed = await import("./viewed-state.ts");

test.after(() => fs.rmSync(directory, { recursive: true, force: true }));

test("starts empty, marks a session viewed, persists with 0600", async () => {
  globalThis.__piViewedStateCache = undefined;
  assert.deepEqual(viewed.readViewedState(), {});
  const before = Date.now();
  const viewedAt = viewed.markSessionViewed("s1");
  assert.ok(viewedAt >= before && viewedAt <= Date.now());
  assert.deepEqual(viewed.readViewedState(), { s1: viewedAt });
  const persisted = JSON.parse(fs.readFileSync(viewedFile, "utf8"));
  assert.deepEqual(persisted, { s1: viewedAt });
  if (process.platform !== "win32") {
    assert.equal(fs.statSync(viewedFile).mode & 0o777, 0o600);
  }
});

test("ignores invalid entries on load and trims ids", () => {
  globalThis.__piViewedStateCache = undefined;
  fs.writeFileSync(viewedFile, JSON.stringify({ s1: "nope", s2: NaN, s3: -5, s4: 0, s5: Date.now() - 1000 }));
  globalThis.__piViewedStateCache = undefined;
  const kept = viewed.readViewedState();
  assert.deepEqual(Object.keys(kept), ["s5"]);
  assert.ok(Math.abs(kept.s5 - (Date.now() - 1000)) < 2000);
  const viewedAt = viewed.markSessionViewed("  s6  ");
  const after = viewed.readViewedState();
  assert.deepEqual(Object.keys(after).sort(), ["s5", "s6"]);
  assert.equal(after.s6, viewedAt); // 空白 id 被 trim
});

test("overwrites existing mark and prunes stale entries on write", () => {
  globalThis.__piViewedStateCache = undefined;
  fs.rmSync(viewedFile, { force: true });
  const first = viewed.markSessionViewed("s1");
  const second = viewed.markSessionViewed("s1");
  assert.deepEqual(viewed.readViewedState(), { s1: second });
  assert.ok(second >= first);
  // 写入一条 31 天前的旧标记：下次 mark 时被清理。
  const stale = Date.now() - 31 * 24 * 60 * 60 * 1000;
  viewed.markSessionViewed("s2");
  const state = viewed.readViewedState();
  state.s2 = stale;
  fs.writeFileSync(viewedFile, JSON.stringify(state));
  const third = viewed.markSessionViewed("s3");
  assert.deepEqual(viewed.readViewedState(), { s1: second, s3: third });
});

test("caps entries at MAX_ENTRIES keeping newest", () => {
  globalThis.__piViewedStateCache = undefined;
  fs.rmSync(viewedFile, { force: true });
  // 注入超量持久状态（时间戳都新鲜）：超过 5000 条时只保留最新的 5000 条。
  const now = Date.now();
  const many = {};
  for (let i = 0; i < 5005; i++) many[`session-${i}`] = now - i;
  fs.writeFileSync(viewedFile, JSON.stringify(many));
  viewed.markSessionViewed("newest");
  const result = viewed.readViewedState();
  assert.equal(Object.keys(result).length, 5000);
  assert.equal(typeof result.newest, "number"); // 刚标记的保留
  assert.equal(result["session-0"], now); // 最新时间戳保留
  assert.equal(result["session-4999"], undefined); // 最旧被淘汰
});
