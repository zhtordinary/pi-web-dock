import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { zhCNLocale } from "../../../lib/i18n/messages/zh-CN.ts";
const routeSource = await readFile(new URL("./[id]/archive/route.ts", import.meta.url), "utf8");
const closeSource = await readFile(new URL("../../../lib/session-close.ts", import.meta.url), "utf8");
const shutdownSource = await readFile(new URL("./[id]/shutdown/route.ts", import.meta.url), "utf8");
function compile(source, dependencies) {
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const mod = { exports: {} };
  new Function("require", "module", "exports", compiled)(name => { assert.ok(name in dependencies, name); return dependencies[name]; }, mod, mod.exports);
  return mod.exports;
}
const security = compile(await readFile(new URL("../../../lib/request-security.ts", import.meta.url), "utf8"), { "node:net": await import("node:net") });
const { sessionMutationRequest } = compile(await readFile(new URL("../../../lib/session-mutation-command.ts", import.meta.url), "utf8"), {});
function fixture({ background = [], busy = false, sideAsk = false, queued = 0, siblingError, siblingHadRuntime = false, recent = false, conflict = false, closingOwner = false, already = false } = {}) {
  const calls = [], rpc = {
    sessionFile: "/active/session.jsonl", isAlive: () => true, isRunning: () => busy, hasActiveSideAsk: () => sideAsk,
    getExecutionState: () => ({ active: busy, queuedCount: queued }),
    setUnattendedEnabled: value => calls.push(["unattended", value]),
    shutdown: async () => { calls.push("shutdown"); },
  };
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-security": { ...security, isApiRequestAllowed: req => security.isApiRequestAllowed(req, ["reader.test"]) },
    "@/lib/rpc-manager": { getRpcSession: () => recent ? undefined : rpc, getRpcSessionTree: () => [] },
    "@/lib/session-reader": {
      resolveSessionPathReadOnly: async () => "/active/session.jsonl",
      resolveSessionPath: async (_id, options) => { calls.push(["resolve", options.archived]); return already ? options.archived ? "/archive/session.jsonl" : null : "/active/session.jsonl"; },
      SessionPathConflictError: class extends Error {}, updateSessionListCachesForMove: () => calls.push("cache"),
    },
    "@/lib/session-archive": { isSessionFileRecentlyChanged: () => recent,
      sessionArchiveFiles: path => [path],
      movePiSessionFile: () => { calls.push("move"); return "/archive/session.jsonl"; }, verifySessionMove: () => calls.push("verify"),
      SessionArchiveConflictError: class extends Error {}, setTokenMonitorArchivedFlag: () => calls.push("monitor"),
    },
    "@/lib/session-channel-control": { controlSiblingSession: async () => { calls.push("sibling"); if (siblingError) throw new Error(siblingError); return { ok: true, hadRuntime: siblingHadRuntime }; } },
    "@/lib/state-file-transaction": { acquireStateWriteLock: () => { calls.push("lock"); if (conflict) throw Object.assign(new Error("owned"), { code: "ELOCKED" }); return () => calls.push("unlock"); } },
    "@/lib/activity-events": { emitActivityEvent: () => calls.push("event") },
    "@/lib/session-caches": { clearSessionCaches: () => calls.push("clear") },
  };
  const close = compile(closeSource, { "./rpc-manager": dependencies["@/lib/rpc-manager"], "./subagent-activity": { getSessionBackgroundRunIds: () => background },
    "./i18n/messages/zh-CN.ts": { zhCNLocale },
    "./state-file-transaction": { acquireStateWriteLock: () => { calls.push("runtime-lock"); if (closingOwner) throw Object.assign(new Error("native writer still owns transcript"), { code: "ELOCKED" }); return () => calls.push("runtime-unlock"); } },
  });
  dependencies["@/lib/session-close"] = close;
  const route = compile(routeSource, dependencies);
  const shutdown = compile(shutdownSource, dependencies);
  return { calls, shutdown: () => shutdown.POST(new Request("http://localhost/api/sessions/fixture/shutdown?local=1", { method: "POST", headers: { host: "localhost" } }), { params: Promise.resolve({ id: "fixture" }) }), archive: (req = new Request("http://localhost/api/sessions/fixture/archive", { method: "POST", headers: { host: "localhost", "Content-Type": "application/json" }, body: "{}" })) => route.POST(req, { params: Promise.resolve({ id: "fixture" }) }) };
}
for (const origin of ["http://localhost:30141", "http://127.0.0.1:30142", "http://[::1]:30141", "https://reader.test:30144"]) {
  for (const op of ["archive", "unarchive"]) {
    test(`forwarded ${op} from ${origin} passes real request security and moves history`, async () => {
      const req = sessionMutationRequest({ operationId: "archive-forwarding-fixture", deviceId: "fixture-device", sessionId: "fixture", op, force: false }, origin);
      const f = fixture(); const response = await f.archive(req);
      assert.equal(response.status, 200);
      assert.equal((await response.json()).archived, op === "archive");
      assert.deepEqual(f.calls[0], ["resolve", op === "unarchive"]);
      assert.ok(f.calls.includes("move"));
    });
  }
}
test("archive rejects missing Host, untrusted hosts, cross-origin requests and non-JSON before effects", async () => {
  for (const overrides of [{ host: undefined }, { host: "evil.invalid" }, { origin: "https://evil.invalid" }, { "sec-fetch-site": "cross-site" }, { "content-type": "text/plain" }]) {
    const headers = new Headers({ host: "localhost", "content-type": "application/json" });
    for (const [key, value] of Object.entries(overrides)) { if (value === undefined) headers.delete(key); else headers.set(key, value); }
    const f = fixture();
    const response = await f.archive(new Request("http://localhost/api/sessions/fixture/archive", { method: "POST", headers, body: "{}" }));
    assert.equal(response.status, 403);
    assert.deepEqual(f.calls, []);
  }
});
for (const [label, values] of [["parent", { busy: true }], ["background child", { background: ["child"] }], ["queue", { queued: 1 }], ["side ask", { sideAsk: true }]]) {
  test(`archive refuses active ${label} without moving history`, async () => {
    const f = fixture(values); assert.equal((await f.archive()).status, 409); assert.ok(!f.calls.includes("move")); assert.ok(!f.calls.includes("shutdown"));
  });
}
test("a running Side Ask blocks archive with its own message", async () => {
  const f = fixture({ sideAsk: true });
  const response = await f.archive();
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "session_busy");
  assert.match(body.error, /侧边提问正在回答/);
  assert.ok(!f.calls.includes("move") && !f.calls.includes("shutdown"));
});
test("archive closes both channels then exclusively moves and verifies history", async () => {
  const f = fixture(); const response = await f.archive();
  assert.equal(response.status, 200); assert.equal((await response.json()).executionClosed, true);
  const indices = ["shutdown", "sibling", "lock", "move", "verify", "unlock"].map(value => f.calls.indexOf(value));
  assert.ok(indices.every((value, index) => value >= 0 && (index === 0 || value > indices[index - 1])));
});
test("unknown sibling closure and a competing runtime both prevent a successful archive", async () => {
  for (const values of [{ siblingError: "timeout" }, { conflict: true }]) {
    const f = fixture(values); assert.ok((await f.archive()).status >= 400); assert.ok(!f.calls.includes("move"));
  }
});
test("an already-moved file is not success until runtime closure is also confirmed", async () => {
  const f = fixture({ already: true, background: ["child"] }); assert.equal((await f.archive()).status, 409);
  const done = fixture({ already: true }); assert.equal((await done.archive()).status, 200); assert.ok(done.calls.includes("sibling")); assert.ok(!done.calls.includes("move"));
});
test("external recent writes keep their refusal boundary", async () => {
  const f = fixture({ recent: true }); assert.equal((await f.archive()).status, 409); assert.ok(!f.calls.includes("move"));
});
test("a proven idle sibling owner can close and immediately archive its recent transcript", async () => {
  const f = fixture({ recent: true, siblingHadRuntime: true });
  assert.equal((await f.archive()).status, 200);
  assert.ok(f.calls.indexOf("sibling") < f.calls.indexOf("move"));
});
test("shutdown reports an actual prior runtime only after successful closure", async () => {
  const closed = fixture(); assert.equal((await (await closed.shutdown()).json()).hadRuntime, true);
  const absent = fixture({ recent: true }); assert.equal((await (await absent.shutdown()).json()).hadRuntime, false);
  const busy = fixture({ busy: true }); const response = await busy.shutdown();
  assert.equal(response.status, 409); assert.notEqual((await response.json()).hadRuntime, true);
});
test("UI shutdown cannot authorize archive while the final native writer still owns its file", async () => {
  const f = fixture({ closingOwner: true });
  assert.equal((await f.archive()).status, 409);
  assert.ok(f.calls.includes("shutdown")); assert.ok(!f.calls.includes("move"));
  const closing = fixture({ closingOwner: true }); const response = await closing.shutdown();
  assert.equal(response.status, 503); assert.notEqual((await response.json()).hadRuntime, true);
});
