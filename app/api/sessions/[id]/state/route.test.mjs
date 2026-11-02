import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import ts from "typescript";

const getSource = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const postSource = await readFile(new URL("../../../agent/[id]/route.ts", import.meta.url), "utf8");
function fixture({ preference, inherited = false, live = false, missing = false, readError, liveAfterRead = false, bindingError = false } = {}) {
  const calls = { read: 0, resolve: 0, authority: 0, start: 0, send: 0, commands: [] };
  let currentLive = live;
  const runtime = { isAlive: () => currentLive, send: async (command) => { calls.send++; calls.commands.push(command); return { autoCompactionEnabled: false, model: { id: "actual", provider: "live" } }; } };
  const dependencies = {
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    "@/lib/rpc-manager": { getRpcSession: () => runtime, startRpcSession: async () => { calls.start++; return { session: runtime }; }, assertRpcSessionRuntimeBinding: async () => { calls.authority++; if (bindingError) throw new Error("Git authority unavailable"); } },
    "@/lib/session-reader": {
      resolveSessionPath: async () => { calls.resolve++; return missing ? null : "/fixture/session.jsonl"; },
      resolveSessionPathReadOnly: async () => { calls.resolve++; return missing ? null : "/fixture/session.jsonl"; },
    },
    "@/lib/session-persisted-state": { readPersistedSessionState: async () => { calls.read++; if (liveAfterRead) currentLive = true; if (readError) throw new Error(readError); return typeof preference === "boolean" ? { autoCompactionEnabled: preference, ...(inherited ? { autoCompactionSource: "inherited" } : {}) } : {}; } },
    "@/lib/live-agent-events": { redactLiveValue: value => value },
    "@/lib/queue-recall-store": {}, "@/lib/session-tool-selection": {}, "@/lib/branch-navigation": {}, "@/lib/activity-peers": {}, "@/lib/paths": {}, "@/lib/request-security": {}, "@/lib/reader-control-receipts": {},
  };
  const load = source => {
    const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const testModule = { exports: {} };
    new Function("require", "module", "exports", compiled)(name => { assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name]; }, testModule, testModule.exports);
    return testModule.exports;
  };
  const get = load(getSource).GET;
  const post = load(postSource).POST;
  return { calls, get: (query = "") => get(new Request(`http://reader.invalid/api/sessions/session/state${query}`), { params: Promise.resolve({ id: "session" }) }), post: type => post(new Request("http://reader.invalid/api/agent/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ type, enabled: true }) }), { params: Promise.resolve({ id: "session" }) }) };
}

for (const preference of [true, false]) {
  test(`cold state returns persisted ${preference} without runtime or Git authority`, async () => {
    const f = fixture({ preference, bindingError: true });
    const response = await f.get(); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.running, false);
    assert.equal(body.state.autoCompactionEnabled, preference);
    assert.equal(f.calls.read, 1); assert.equal(f.calls.authority, 0);
    assert.equal(f.calls.start, 0); assert.equal(f.calls.send, 0);
  });
}
for (const preference of [true, false]) {
  test(`cold state returns inherited ${preference} without claiming a persisted override or starting a runtime`, async () => {
    const f = fixture({ preference, inherited: true, bindingError: true });
    const response = await f.get(); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.running, false);
    assert.equal(body.source, "inherited"); assert.equal(body.state.autoCompactionEnabled, preference);
    assert.equal(f.calls.start, 0); assert.equal(f.calls.authority, 0); assert.equal(f.calls.send, 0);
  });
}

test("cold state without any verifiable effective preference is explicit unavailable, never true", async () => {
  const f = fixture(); const response = await f.get(); const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, "session_state_unavailable");
  assert.equal(body.state?.autoCompactionEnabled, undefined); assert.equal(f.calls.start, 0);
});
test("malformed persisted state is unavailable without runtime recovery", async () => {
  const f = fixture({ readError: "Invalid persisted automatic compaction state" });
  const response = await f.get(); const body = await response.json();
  assert.equal(response.status, 409); assert.equal(body.code, "session_state_unavailable");
  assert.equal(f.calls.start, 0); assert.equal(f.calls.authority, 0);
});
test("live state wins over persisted settings, including a runtime appearing during the read", async () => {
  for (const options of [{ live: true }, { liveAfterRead: true }]) {
    const f = fixture({ preference: true, ...options }); const response = await f.get(); const body = await response.json();
    assert.equal(response.status, 200); assert.equal(body.running, true); assert.equal(body.state.autoCompactionEnabled, false);
    assert.equal(body.state.model.id, "actual"); assert.equal(f.calls.send, 1);
    if (options.live) assert.equal(f.calls.read, 0);
  }
});
test("lightweight session state preserves cold reads and forwards the option to a live runtime", async () => {
  const cold = fixture({ preference: true });
  assert.equal((await cold.get("?systemPrompt=0")).status, 200);
  assert.equal(cold.calls.start, 0);
  assert.deepEqual(cold.calls.commands, []);
  const live = fixture({ live: true });
  assert.equal((await live.get()).status, 200);
  assert.equal((await live.get("?systemPrompt=0")).status, 200);
  assert.deepEqual(live.calls.commands, [{ type: "get_state" }, { type: "get_state", systemPrompt: false }]);
});

test("missing sessions stay 404 and cold POST state/control never wakes a runtime", async () => {
  const missing = fixture({ missing: true }); assert.equal((await missing.get()).status, 404);
  for (const type of ["get_state", "set_auto_compaction"]) {
    const f = fixture(); const response = await f.post(type); const body = await response.json();
    assert.equal(response.status, 409); assert.equal(body.code, "runtime_not_live");
    assert.equal(f.calls.start, 0); assert.equal(f.calls.resolve, 0); assert.equal(f.calls.send, 0);
  }
});
test("live compaction control retains the existing runtime-binding guard", async () => {
  const f = fixture({ live: true, bindingError: true }); const response = await f.post("set_auto_compaction");
  assert.equal(response.status, 500); assert.equal(f.calls.authority, 1); assert.equal(f.calls.send, 0);
});
