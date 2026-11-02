// The find bar highlights only mounted messages, which is now a bounded page.
// This route supplies the session-wide total so the bar never presents a
// partial count as the complete result.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { createJiti } from "jiti";

const routeSrc = await readFileSync(new URL("./[id]/search/route.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { countQueryInSession } = await jiti.import("@/lib/session-search");

test("session search route counts the whole selected branch beyond a window, with no-store responses", async () => {
  assert.match(routeSrc, /createSessionSearchGet\(loadSessionHistoryProjection\)/);
  const { createSessionSearchGet } = await jiti.import("@/lib/session-history-http");
  const { createHistoryProjection } = await jiti.import("@/lib/session-history");
  const entries = Array.from({length: 80}, (_, index) => ({ type: "message", id: `e${index}`, parentId: index ? `e${index-1}` : null,
    timestamp: "2026-10-19T00:00:00Z", message: {role: "user", content: "needle"} }));
  let loads = 0;
  const get = createSessionSearchGet(async (sessionId, leafId) => {
    loads++; return createHistoryProjection(entries, { sessionId, leafId, currentLeafId: "e79" });
  });
  const response = await get(new Request("http://reader.invalid/search?q=needle"), {params: Promise.resolve({id: "s"})});
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  assert.equal((await response.json()).total, 80);
  const short = await get(new Request("http://reader.invalid/search?q=n"), {params: Promise.resolve({id: "s"})});
  assert.equal(short.status, 200);
  assert.equal((await short.json()).total, 0);
  assert.equal(loads, 1, "short queries do not load history");
});

test("the counted surface matches the highlighted surface", () => {
  const line = (role, text) =>
    JSON.stringify({ type: "message", id: Math.random().toString(16).slice(2), message: { role, content: [{ type: "text", text }] } });
  const body = [
    line("user", "please fix the pagination pagination bug"),
    line("assistant", "pagination is now bounded"),
    JSON.stringify({ type: "custom", customType: "noise", data: { text: "pagination" } }),
  ].join("\n");

  const counted = countQueryInSession(body, "pagination");
  // Only user/assistant text counts: metadata rows stay outside the surface the
  // page can highlight, so the total never exceeds what is locatable.
  assert.equal(counted.matchCount, 3);
  assert.equal(counted.contentMatchCount, 3);
});
