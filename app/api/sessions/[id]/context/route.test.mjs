import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const require = createRequire(import.meta.url);
const ts = require("typescript");
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const reader = await jiti.import("../../../../../lib/session-reader.ts");
const readCache = await jiti.import("../../../../../lib/session-read-cache.ts");
const timestamp = "2026-01-01T00:00:00.000Z";
const firstText = "synthetic large output:" + "x".repeat(30_000);
const secondText = "second block:" + "y".repeat(1000);
const entries = [
  { type: "message", id: "u0", parentId: null, timestamp, message: { role: "user", content: "old question" } },
  { type: "message", id: "a0", parentId: "u0", timestamp, message: { role: "assistant", content: [{ type: "text", text: "old answer" }] } },
  { type: "compaction", id: "compact", parentId: "a0", timestamp, summary: "synthetic summary", firstKeptEntryId: "u1", tokensBefore: 100 },
  { type: "message", id: "u1", parentId: "compact", timestamp, message: { role: "user", content: "latest real question" } },
  { type: "message", id: "a1", parentId: "u1", timestamp, message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: "synthetic" } }] } },
  { type: "message", id: "result", parentId: "a1", timestamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", content: [{ type: "text", text: firstText }, { type: "text", text: secondText }] } },
  { type: "message", id: "a2", parentId: "result", timestamp, message: { role: "assistant", content: [{ type: "text", text: "final answer" }] } },
];
const manager = { getEntries: () => entries, getLeafId: () => "a2" };

async function routeExports(url, mocks) {
  const source = await readFile(url, "utf8");
  const mod = { exports: {} };
  new Function("require", "module", "exports", ts.transpileModule(source, {
    compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText)((name) => {
    assert.ok(name in mocks, `unexpected dependency: ${name}`);
    return mocks[name];
  }, mod, mod.exports);
  return mod.exports;
}

const wire = { NextResponse: { json: (body, init) => Response.json(body, init) } };
const { GET } = await routeExports(new URL("./route.ts", import.meta.url), {
  "next/server": wire,
  "@/lib/session-reader": { ...reader, resolveSessionPath: async () => "/synthetic/session.jsonl" },
  "@/lib/session-read-cache": { getSessionReadSnapshot: () => ({ manager, entries, leafId: "a2" }) },
  "@/lib/rpc-manager": { getRpcSession: () => undefined, ensureQuestionAnalysisJobsForSession: async () => {} },
});
for (const [name, query] of [
  ["ordinary initial context", "tail=50"],
  ["ordinary backward page", "tail=50&before=a2"],
  ["compaction history step", "historyBefore=a2"],
  ["explicit full history", "fullHistory=1"],
]) {
  test(`${name} honors deferred result text without losing entry/call association`, async () => {
    const response = await GET(new Request(`http://synthetic/api/sessions/s1/context?leafId=a2&deferThinking=1&deferMedia=1&deferToolResultText=1&${query}`), { params: Promise.resolve({ id: "s1" }) });
    assert.equal(response.status, 200);
    const body = await response.json();
    const index = body.context.entryIds.indexOf("result");
    assert.ok(index >= 0);
    const result = body.context.messages[index];
    assert.equal(result.deferredText, true);
    assert.equal(result.entryId, "result");
    assert.equal(result.toolCallId, "call-1");
    assert.equal(result.content[0].text.length, 24_000);
    assert.ok(body.context.messages.some((message) => message.role === "user" && message.content === "latest real question"));
    assert.equal(entries[5].message.content[0].text, firstText, "display deferral cannot mutate durable input");
  });
}

test("without deferral the ordinary page returns the original text", async () => {
  const response = await GET(new Request("http://synthetic/context?leafId=a2&before=a2&tail=50"), { params: Promise.resolve({ id: "s1" }) });
  const body = await response.json();
  const result = body.context.messages[body.context.entryIds.indexOf("result")];
  assert.equal(result.deferredText, undefined);
  assert.deepEqual(result.content, entries[5].message.content);
});

test("deferred context and lazy endpoint bind session/path/entry and reread real JSONL original blocks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "reader-context-lazy-disk-"));
  const sessionId = "context-lazy-disk-a";
  const otherId = "context-lazy-disk-b";
  const path = join(root, `${sessionId}.jsonl`);
  const otherPath = join(root, `${otherId}.jsonl`);
  t.after(async () => {
    for (const id of [sessionId, otherId]) reader.invalidateSessionPathCache(id);
    for (const file of [path, otherPath]) readCache.invalidateSessionReadCache(file);
    await rm(root, { recursive: true, force: true });
  });
  // Independent disk oracle, not the earlier route mock's in-memory entries.
  const diskBlocks = ["disk block A:" + "原文".repeat(16_000), "disk block B:" + "z".repeat(1234)];
  const otherBlocks = ["other session A", "other session B"];
  const resultId = "disk-result";
  const makeSource = (id, blocks) => [
    { type: "session", version: 3, id, timestamp, cwd: root },
    { type: "message", id: "disk-user", parentId: null, timestamp, message: { role: "user", content: "disk question" } },
    { type: "message", id: "disk-call", parentId: "disk-user", timestamp, message: { role: "assistant", content: [{ type: "toolCall", toolCallId: "disk-call-1", toolName: "bash", input: { command: "synthetic" } }] } },
    { type: "message", id: resultId, parentId: "disk-call", timestamp, message: { role: "toolResult", toolCallId: "disk-call-1", toolName: "bash", content: blocks.map((text) => ({ type: "text", text })) } },
    { type: "message", id: "disk-answer", parentId: resultId, timestamp, message: { role: "assistant", content: [{ type: "text", text: "disk answer" }] } },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const originalBytes = makeSource(sessionId, diskBlocks);
  await writeFile(path, originalBytes);
  await writeFile(otherPath, makeSource(otherId, otherBlocks));
  reader.cacheSessionPath(sessionId, path);
  reader.cacheSessionPath(otherId, otherPath);
  const expectedPaths = new Map([[sessionId, path], [otherId, otherPath]]);
  const resolvedIds = [];
  const readPaths = [];
  const resolveSessionPath = async (id) => {
    resolvedIds.push(id);
    assert.ok(expectedPaths.has(id), "route must pass the requested session identity");
    const actual = await reader.resolveSessionPath(id);
    assert.equal(actual, expectedPaths.get(id));
    return actual;
  };
  const { GET: diskContext } = await routeExports(new URL("./route.ts", import.meta.url), {
    "next/server": wire,
    "@/lib/session-reader": { ...reader, resolveSessionPath },
    "@/lib/session-read-cache": readCache,
    "@/lib/rpc-manager": {
      getRpcSession: () => undefined,
      ensureQuestionAnalysisJobsForSession: async (id, file) => assert.equal(file, expectedPaths.get(id)),
    },
  });
  const { GET: lazyResult } = await routeExports(new URL("../entries/[entryId]/tool-result/route.ts", import.meta.url), {
    "next/server": wire,
    "@/lib/session-reader": {
      resolveSessionPath,
      getSessionEntries: (file) => {
        readPaths.push(file);
        assert.ok([...expectedPaths.values()].includes(file));
        return reader.getSessionEntries(file); // Real snapshot -> SDK open -> disk, never fixed entries.
      },
    },
  });
  const contextResponse = await diskContext(new Request("http://synthetic/context?tail=50&deferToolResultText=1"), { params: Promise.resolve({ id: sessionId }) });
  assert.equal(contextResponse.status, 200);
  const context = (await contextResponse.json()).context;
  const preview = context.messages[context.entryIds.indexOf(resultId)];
  assert.equal(preview.deferredText, true);
  assert.equal(preview.entryId, resultId);
  assert.equal(preview.toolCallId, "disk-call-1");
  assert.equal(preview.content[0].text, diskBlocks[0].slice(0, 24_000));
  assert.equal(await readFile(path, "utf8"), originalBytes, "deferral cannot overwrite original JSONL");
  const loaded = readCache.getSessionReadSnapshot(path);
  const fetchResult = (id, entryId) => lazyResult(new Request("http://synthetic/result"), { params: Promise.resolve({ id, entryId }) });
  const warm = await fetchResult(sessionId, resultId);
  assert.equal(warm.status, 200);
  assert.equal((await warm.json()).text, diskBlocks[0] + "\n" + diskBlocks[1]);
  assert.strictEqual(readCache.getSessionReadSnapshot(path), loaded);
  readCache.invalidateSessionReadCache(path);
  const cold = await fetchResult(sessionId, resultId);
  assert.equal(cold.status, 200);
  assert.equal((await cold.json()).text, diskBlocks[0] + "\n" + diskBlocks[1]);
  assert.notStrictEqual(readCache.getSessionReadSnapshot(path), loaded, "cold lazy path must parse the file again");
  const other = await fetchResult(otherId, resultId); // Same entry id must not alias across sessions.
  assert.equal(other.status, 200);
  assert.equal((await other.json()).text, otherBlocks[0] + "\n" + otherBlocks[1]);
  assert.equal((await fetchResult(sessionId, "disk-call")).status, 404);
  assert.equal((await fetchResult(sessionId, "missing-entry")).status, 404);
  assert.deepEqual(resolvedIds, [sessionId, sessionId, sessionId, otherId, sessionId, sessionId]);
  assert.deepEqual(readPaths, [path, path, otherPath, path, path]);
  assert.equal(await readFile(path, "utf8"), originalBytes);
});
