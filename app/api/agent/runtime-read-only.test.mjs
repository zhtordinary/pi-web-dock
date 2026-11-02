import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const commandSource = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");
const eventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
function fixture({ live = false, trusted = true, startError } = {}) {
  const calls = { start: 0, send: [], commands: [], binding: 0, stream: 0, fileReads: 0 };
  const runtime = { sessionFile: "/fixture/session.jsonl", isAlive: () => live, send: async body => { calls.send.push(body.type); calls.commands.push(body); return { systemPrompt: "fixture" }; } };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/rpc-manager": {
      getRpcSession: () => live ? runtime : undefined,
      startRpcSession: async () => { calls.start++; if (startError) throw startError; return { session: runtime }; },
      assertRpcSessionRuntimeBinding: async () => { calls.binding++; },
    },
    "@/lib/session-reader": { resolveSessionPath: async () => "/fixture/session.jsonl", resolveSessionPathReadOnly: async () => { calls.fileReads++; return "/fixture/session.jsonl"; } },
    "@/lib/request-security": { isApiRequestAllowed: () => trusted, hasJsonContentType: () => true },
    "@/lib/live-agent-events": { redactLiveValue: value => value },
    "@/lib/agent-event-stream": { createAgentEventStream: (_req, _id, session, file) => { calls.stream++; calls.observedSession = session; calls.observedFile = file; return new ReadableStream({ start(c) { c.close(); } }); } },
    "@/lib/queue-recall-store": {}, "@/lib/session-tool-selection": {}, "@/lib/branch-navigation": {},
    "@/lib/activity-peers": {}, "@/lib/paths": {}, "@/lib/reader-control-receipts": {},
  };
  const load = source => {
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const mod = { exports: {} };
    new Function("require", "module", "exports", compiled)(name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, mod, mod.exports);
    return mod.exports;
  };
  const route = load(commandSource), events = load(eventsSource);
  const params = { params: Promise.resolve({ id: "fixture" }) };
  return { calls, get: (query = "") => route.GET(new Request(`http://reader.invalid/api/agent/fixture${query}`), params),
    events: () => events.GET(new Request("http://reader.invalid/api/agent/fixture/events"), params),
    post: type => route.POST(new Request("http://reader.invalid/api/agent/fixture", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type }) }), params) };
}

for (const type of ["get_unattended", "get_tools", "get_commands", "get_state", "get_session_stats", "get_last_assistant_text", "get_future_read"]) {
  test(`cold ${type} is unavailable without creating a runtime or loading project extensions`, async () => {
    const f = fixture(); const response = await f.post(type); const body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.code, "runtime_not_live");
    assert.equal(body.runtimeStartAttempted, false); assert.equal(body.writeSideEffects, false);
    assert.equal(f.calls.start, 0); assert.deepEqual(f.calls.send, []); assert.equal(f.calls.binding, 0);
  });
}
test("unknown cold commands never gain runtime creation authority", async () => {
  const f = fixture(); const response = await f.post("unknown_operation");
  assert.equal(response.status, 400); assert.equal((await response.json()).code, "unsupported_operation"); assert.equal(f.calls.start, 0);
});
test("state GET and file-only SSE observe a cold session without creating a runtime", async () => {
  const f = fixture(); assert.deepEqual(await (await f.get()).json(), { running: false });
  const response = await f.events(); assert.equal(response.status, 200);
  assert.equal(await f.calls.observedSession, null);
  assert.equal(f.calls.observedFile, "/fixture/session.jsonl");
  assert.equal(f.calls.fileReads, 1);
  assert.equal(f.calls.start, 0); assert.equal(f.calls.stream, 1);
  assert.deepEqual(f.calls.send, []); assert.equal(f.calls.binding, 0);
});
test("live state supports an opt-in lightweight poll without changing the default", async () => {
  const f = fixture({ live: true });
  assert.equal((await f.get()).status, 200);
  assert.equal((await f.get("?systemPrompt=0")).status, 200);
  assert.equal((await f.get("?systemPrompt=1")).status, 200);
  assert.deepEqual(f.calls.commands, [
    { type: "get_state" },
    { type: "get_state", systemPrompt: false },
    { type: "get_state" },
  ]);
  assert.equal(f.calls.start, 0);
  assert.equal(f.calls.binding, 3);
});

test("live reads and events retain runtime binding validation", async () => {
  const f = fixture({ live: true }); assert.equal((await f.post("get_tools")).status, 200); assert.equal((await f.events()).status, 200);
  assert.equal(f.calls.start, 0); assert.equal(f.calls.binding, 2); assert.equal(f.calls.stream, 1);
});
test("explicit runtime initialization is trusted JSON only and returns actual state", async () => {
  const denied = fixture({ trusted: false }); assert.equal((await denied.post("initialize_runtime")).status, 403); assert.equal(denied.calls.start, 0);
  const f = fixture(); const response = await f.post("initialize_runtime"); assert.equal(response.status, 200);
  assert.equal(f.calls.start, 1); assert.deepEqual(f.calls.send, ["get_state"]);
});
test("ownership rejection preserves stable code and proven owner instead of generic prompt_rejected", async () => {
  const owner = { pid: 1234, entry: "reader", bootId: "fixture-generation" };
  const f = fixture({ startError: Object.assign(new Error("Session is owned by another Reader runtime"), { code: "session_runtime_owned", owner }) });
  const response = await f.post("prompt"); const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, "session_runtime_owned"); assert.deepEqual(body.owner, owner); assert.equal(body.accepted, false); assert.deepEqual(f.calls.send, []);
  assert.equal(Object.hasOwn(body, "writeSideEffects"), false, "a later tool-runtime rebuild conflict cannot promise earlier settings were not persisted");
});
