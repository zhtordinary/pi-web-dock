import assert from "node:assert/strict";
import test from "node:test";
import { fetchAllSessionWaitStatus, fetchSessionWaitStatus, postSessionWaitControl } from "./session-wait-client.ts";

test("session wait client routes aggregate reads and source-specific controls", async () => {
  const calls = [];
  const fakeFetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response(JSON.stringify({ waits: [] }), { status: 200, headers: { "content-type": "application/json" } }); };
  await fetchSessionWaitStatus("mac-mini", fakeFetch);
  await fetchAllSessionWaitStatus(fakeFetch);
  await postSessionWaitControl("mac-mini", { operation: "pause", waitId: "same-id" }, fakeFetch);
  assert.equal(calls[0].url, "/api/remote/session-control?peer=mac-mini");
  assert.equal(calls[1].url, "/api/session-control?scope=all");
  assert.equal(calls[2].url, "/api/remote/session-control?peer=mac-mini");
  assert.match(calls[2].init.body, /same-id/);
});
