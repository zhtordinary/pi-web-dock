import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { RecentNoticeBuffer } = await jiti.import("./recent-notice.ts");

test("replays an undelivered warning once and expires it", () => {
  const notices = new RecentNoticeBuffer(1000);
  notices.remember("model unavailable", 100);
  assert.deepEqual(notices.take(500), ["model unavailable"]);
  assert.deepEqual(notices.take(600), []);
  notices.remember("later failure", 700);
  assert.deepEqual(notices.take(1700), []);
});

test("keeps only newest notices within bounded memory", () => {
  const notices = new RecentNoticeBuffer(1000, 2);
  notices.remember("old", 0);
  notices.remember("middle", 1);
  notices.remember("new", 2);
  assert.deepEqual(notices.take(3), ["middle", "new"]);
});
