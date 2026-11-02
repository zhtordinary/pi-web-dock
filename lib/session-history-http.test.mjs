import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHistoryProjection, HistoryReadError } = await jiti.import("./session-history.ts");
const { createHistoryGet, createSessionSearchGet } = await jiti.import("./session-history-http.ts");
const { HISTORY_PAGE_BYTES } = await jiti.import("./session-history-types.ts");
const timestamp = "2026-10-18T00:00:00.000Z";
const entries = [
  { type: "message", id: "q", parentId: null, timestamp, message: { role: "user", content: "needle needle" } },
  { type: "message", id: "a", parentId: "q", timestamp, message: { role: "assistant", content: [{ type: "text", text: "answer" }], model: "test", provider: "test" } },
  { type: "message", id: "sibling", parentId: "q", timestamp, message: { role: "user", content: "needle" } },
  { type: "session_info", id: "title", parentId: "a", timestamp, name: "needle" },
];
const context = () => ({ params: Promise.resolve({ id: "test-session" }) });
function loader(calls = []) {
  return async (sessionId, leafId) => {
    calls.push({ sessionId, leafId });
    return createHistoryProjection(entries, { sessionId, leafId, currentLeafId: "title" });
  };
}
const request = (query) => new Request(`http://reader.invalid/api/sessions/test-session/history?${query}`);

test("all history modes return no-store bounded JSON from the injected production handler", async () => {
  const get = createHistoryGet(loader());
  for (const query of ["mode=index", "mode=window&around=q", "mode=search&q=needle", "mode=content&entryId=q&blockIndex=0"]) {
    const response = await get(request(query), context());
    assert.equal(response.status, 200, query);
    assert.match(response.headers.get("Cache-Control"), /no-store/);
    const raw = await response.text();
    assert.ok(Buffer.byteLength(raw, "utf8") <= HISTORY_PAGE_BYTES);
    const body = JSON.parse(raw);
    assert.equal(body.leafId, "title");
    assert.equal(typeof body.revision, "string");
  }
});

test("invalid/contradictory input is rejected before source resolution", async () => {
  const calls = [];
  const get = createHistoryGet(loader(calls));
  for (const query of [
    "mode=window&around=q&before=a", "mode=window&limit=-1", "mode=window&leafId=a&leafId=q",
    "mode=window&turns=0", "mode=window&from=q", "mode=window&from=q&to=a&around=q",
    "mode=index&cursor=x&offset=0", "mode=content&entryId=q&offset=-1",
  ]) {
    const response = await get(request(query), context());
    assert.equal(response.status, 400, query);
    assert.equal((await response.json()).code, "history_invalid_request");
  }
  assert.equal(calls.length, 0);
});

test("explicit empty leaf reaches the loader as root, not omitted current branch", async () => {
  const calls = [];
  const get = createHistoryGet(loader(calls));
  const root = await get(request("mode=window&leafId="), context());
  assert.equal(root.status, 200);
  assert.equal((await root.json()).items.length, 0);
  await get(request("mode=window"), context());
  assert.deepEqual(calls.map((call) => call.leafId), [null, undefined]);
});

test("not found, stale revision and internal failures have distinct HTTP outcomes", async () => {
  const get = createHistoryGet(loader());
  const sibling = await get(request("mode=window&around=sibling"), context());
  assert.equal(sibling.status, 404);
  assert.equal((await sibling.json()).code, "history_entry_not_on_branch");
  const current = await get(request("mode=window&revision=old"), context());
  assert.equal(current.status, 200);
  const stale = await get(request("mode=index&revision=old"), context());
  assert.equal(stale.status, 409);
  const conflict = await stale.json();
  assert.equal(conflict.code, "history_revision_changed");
  assert.equal(typeof conflict.revision, "string");
  const missing = createHistoryGet(async () => { throw new HistoryReadError(404, "history_session_not_found", "Session not found"); });
  assert.equal((await missing(request("mode=window"), context())).status, 404);
  const failed = createHistoryGet(async () => { throw new Error("private filesystem details"); });
  const failure = await failed(request("mode=window"), context());
  assert.equal(failure.status, 500);
  assert.equal((await failure.json()).error.includes("private filesystem"), false);
});

test("cancellation does not become a successful stale body or an ordinary network failure", async () => {
  const calls = [];
  const controller = new AbortController();
  controller.abort();
  const get = createHistoryGet(loader(calls));
  const response = await get(new Request("http://reader.invalid/history", { signal: controller.signal }), context());
  assert.equal(response.status, 499);
  assert.equal((await response.json()).code, "history_cancelled");
  assert.equal(calls.length, 0);
});

test("the existing count route counts the same selected-branch body, never titles or sibling matches", async () => {
  const counts = createSessionSearchGet(loader());
  const response = await counts(request("q=needle"), context());
  const result = await response.json();
  assert.equal(response.status, 200);
  assert.equal(result.total, 2);
  assert.equal(result.contentTotal, 2);
  assert.equal(result.snippets.length, 2);
  const full = await createHistoryGet(loader())(request("mode=search&q=needle"), context());
  assert.equal((await full.json()).total, result.total);
});

test("turn windows and full-message continuations are available through the production HTTP boundary", async () => {
  const get = createHistoryGet(loader());
  const window = await get(request("mode=window&turns=1&revision=old"), context());
  assert.equal(window.status, 200);
  assert.equal(Object.hasOwn(await window.json(), 'processSummaries'), false);
  const expanded = await get(request("mode=window&from=q&to=a&limit=1&revision=old"), context());
  assert.equal(expanded.status, 200);
  const page = await expanded.json();
  assert.deepEqual(page.items.map(item => item.entryId), ["q"]);
  assert.equal(page.after, "q");
  const content = await get(request("mode=content&entryId=q&surface=message&path=&revision=old"), context());
  assert.equal(content.status, 200);
  assert.equal(JSON.parse((await content.json()).text).content, "needle needle");
});
