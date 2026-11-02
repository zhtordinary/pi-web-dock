import test from "node:test";
import assert from "node:assert/strict";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createHistoryProjection, getHistoryWindow, readHistoryContent, searchHistory } = await jiti.import("./session-history.ts");
const { createHistoryImageGet } = await jiti.import("./session-history-http.ts");
const { decodeBoundedSessionImage } = await jiti.import("./session-history-media.ts");
const { MAX_TOOL_RESULT_IMAGE_BYTES } = await jiti.import("./tool-result-images.ts");
const timestamp = "2026-10-18T00:00:00.000Z";

function entry(id, parentId, message) {
  return { type: "message", id, parentId, timestamp, message };
}
const imageBlock = (data, mime = "image/png") => ({ type: "image", source: { type: "base64", media_type: mime, data } });

for (const role of ["user", "assistant", "toolResult"]) {
  test(`${role} history images travel as branch-scoped media URLs, never partial base64 payloads`, async () => {
    const data = Buffer.from("test-image-bytes").toString("base64");
    const message = { role, content: [imageBlock(data)] };
    if (role === "assistant") Object.assign(message, { model: "test", provider: "test" });
    if (role === "toolResult") Object.assign(message, { toolCallId: "call", toolName: "test" });
    const entries = [entry("image", null, message)];
    const projection = createHistoryProjection(entries, { sessionId: "images" });
    const window = getHistoryWindow(projection, { from: "image", to: "image" });
    const source = window.items[0].message.content[0].source;
    assert.equal(source.type, "url");
    assert.equal(JSON.stringify(window).includes(data), false);
    const url = new URL(source.url, "http://reader.invalid");
    assert.equal(url.searchParams.has("leafId"), false);
    const get = createHistoryImageGet(async (sessionId, leafId) => createHistoryProjection(entries, { sessionId, leafId }));
    const response = await get(new Request(url), { params: Promise.resolve({ id: "images", entryId: "image" }) });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("Content-Type"), "image/png");
    assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
    assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from("test-image-bytes"));
  });
}

test("media rejects sibling entries, SVG and malformed/oversized base64 under the existing budget", async () => {
  const bytes = Buffer.from("test").toString("base64");
  const entries = [
    entry("main", null, { role: "user", content: [imageBlock(bytes)] }),
    entry("side", null, { role: "user", content: [imageBlock(bytes, "image/svg+xml")] }),
  ];
  const load = async (sessionId, leafId) => createHistoryProjection(entries, { sessionId, leafId, currentLeafId: "main" });
  const get = createHistoryImageGet(load);
  const context = { params: Promise.resolve({ id: "images", entryId: "side" }) };
  const sibling = await get(new Request("http://reader.invalid/image?blockIndex=0&leafId=main"), context);
  assert.equal(sibling.status, 404);
  const svg = await get(new Request("http://reader.invalid/image?blockIndex=0&leafId=side"), context);
  assert.equal(svg.status, 415);
  assert.equal(decodeBoundedSessionImage("not base64"), null);
  assert.equal(decodeBoundedSessionImage(""), null);
  assert.equal(decodeBoundedSessionImage("A".repeat(Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 8)), null);
});

test("a distant search hit in joined Markdown blocks has a bounded, exact visible-text continuation", () => {
  const entries = [entry("q", null, { role: "user", content: [
    { type: "text", text: "**prefix** ".repeat(5000) },
    { type: "text", text: "[needle](https://example.invalid/) at the end" },
  ] })];
  const projection = createHistoryProjection(entries, { sessionId: "visible-content" });
  const search = searchHistory(projection, { q: "needle" });
  assert.equal(search.total, 1);
  const hit = search.matches[0];
  assert.equal(hit.blockIndex, 0, "user-visible blocks join the source text blocks");
  const part = readHistoryContent(projection, {
    entryId: hit.entryId, surface: "visible", blockIndex: hit.blockIndex, offset: hit.offset, limit: 100,
  });
  assert.equal(part.surface, "visible");
  assert.ok(part.text.startsWith(hit.match));
  assert.equal(part.text.includes("https://example.invalid"), false);
  assert.throws(() => readHistoryContent(projection, { entryId: "q", path: "/constructor/prototype" }), /does not exist/);
});

test("media URLs stay stable on append and stale revisions do not reject branch members", async () => {
  const data = Buffer.from("image").toString("base64");
  const entries = [entry("image", null, { role: "user", content: [imageBlock(data)] })];
  const old = createHistoryProjection(entries, { sessionId: "images" });
  const appended = [...entries, entry("new", "image", { role: "user", content: "new" })];
  const current = createHistoryProjection(appended, { sessionId: "images" });
  const oldUrl = getHistoryWindow(old).items[0].message.content[0].source.url;
  const newUrl = getHistoryWindow(current).items[0].message.content[0].source.url;
  assert.equal(oldUrl, newUrl);
  const get = createHistoryImageGet(async () => current);
  const response = await get(new Request(`http://reader.invalid${oldUrl}&revision=${old.revision}`), { params: Promise.resolve({ id: "images", entryId: "image" }) });
  assert.equal(response.status, 200);
});

test("media checks the current branch when omitted and honors an explicit historical branch", async () => {
  const data = Buffer.from("image").toString("base64");
  const entries = [entry("image", null, { role: "user", content: [imageBlock(data)] }), entry("side", null, { role: "user", content: "side" })];
  const get = createHistoryImageGet(async (sessionId, leafId) => createHistoryProjection(entries, { sessionId, leafId, currentLeafId: "side" }));
  const context = { params: Promise.resolve({ id: "images", entryId: "image" }) };
  const current = await get(new Request("http://reader.invalid/image?blockIndex=0&revision=old"), context);
  assert.equal(current.status, 404);
  assert.equal((await current.json()).code, "history_entry_not_on_branch");
  const historical = await get(new Request("http://reader.invalid/image?blockIndex=0&leafId=image&revision=old"), context);
  assert.equal(historical.status, 200);
});

test("full-message continuation URLizes images without changing their physical block positions", () => {
  const data = Buffer.from("image").toString("base64");
  const entries = [entry("image", null, { role: "user", content: [{ type: "text", text: "input" }, imageBlock(data)] })];
  const projection = createHistoryProjection(entries, { sessionId: "images", leafId: "image" });
  const page = readHistoryContent(projection, { entryId: "image", surface: "message", path: "" });
  const message = JSON.parse(page.text);
  assert.equal(message.content[0].text, "input");
  assert.equal(message.content[1].source.type, "url");
  const url = new URL(message.content[1].source.url, "http://reader.invalid");
  assert.equal(url.searchParams.get("blockIndex"), "1");
  assert.equal(url.searchParams.get("leafId"), "image");
  assert.equal(JSON.stringify(message).includes(data), false);
});
