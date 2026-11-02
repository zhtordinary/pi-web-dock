import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("live projection is a read-only live-runtime fast path", () => {
  assert.match(source, /const session = getRpcSession\(id\)/);
  assert.match(source, /if \(!session \|\| !session\.isAlive\(\) \|\| session\.isShuttingDown\(\)\)/);
  assert.match(source, /runtimeStartAttempted: false/);
  assert.match(source, /writeSideEffects: false/);
  assert.match(source, /runtimeStatus: "live"/);
  assert.match(source, /outcome: "observed"/);
  assert.doesNotMatch(source, /resolveSessionPath/);
  assert.doesNotMatch(source, /startRpcSession/);
  assert.match(source, /boot_changed/);
  assert.match(source, /maxBytes/);
  assert.match(source, /no-store/);
  assert.match(source, /recoverFromCursor/);
  assert.match(source, /durableLedger/);
});

function fixture({ live = null, available = true, oldestCursor = 1, writeFailureObserved = false, gap } = {}) {
  let bindings = 0;
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  const fixtureModule = { exports: {} };
  const dependencies = {
    "next/server": { NextResponse: { json: Response.json } },
    "@/lib/request-security": { isApiRequestAllowed: () => true },
    "@/lib/live-agent-events": { LIVE_EVENT_BOOT_ID: "new-process", LIVE_EVENT_MAX_EVENTS: 100, LIVE_EVENT_MAX_BYTES: 128 * 1024 },
    "@/lib/rpc-manager": {
      getRpcSession: () => live,
      assertRpcSessionRuntimeBinding: async () => { bindings += 1; },
      readStoppedSessionLiveEvents: () => ({ bootId: "new-process", readerBootId: "new-process", bootScope: "reader-process",
        replayedRuntimeBootId: "old-process:runtime",
        cursor: 10, nextCursor: 10, oldestCursor, events: [{ cursor: 10, event: { type: "agent_end" } }],
        durableLedger: { available, writeFailureObserved, gap, replay: true } }),
    },
  };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), name); return dependencies[name];
  }, fixtureModule, fixtureModule.exports);
  return { get: (query = "") => fixtureModule.exports.GET(new Request(`http://localhost/api/agent/isolated/live${query}`),
    { params: Promise.resolve({ id: "isolated" }) }), bindings: () => bindings };
}

test("a real process identity change is visible without a live runtime or any binding/start operation", async () => {
  const f = fixture();
  const response = await f.get("?cursor=5&bootId=old-process:runtime");
  assert.equal(response.status, 409);
  const body = await response.json();
  assert.equal(body.code, "boot_changed");
  assert.equal(body.readerBootId, "new-process");
  assert.equal(body.bootScope, "reader-process");
  assert.equal(body.bootId, null);
  assert.equal(body.runtimeStatus, "not_live");
  assert.equal(f.bindings(), 0);
  assert.deepEqual(body.events, []);
});

test("after discarding an obsolete boot, the stopped path replays durable events without claiming a live runtime", async () => {
  const f = fixture(); const response = await f.get("?cursor=0");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.outcome, "replayed");
  assert.equal(body.source, "reader-durable-live-ledger");
  assert.equal(body.runtimeStatus, "not_live");
  assert.equal(body.events[0].cursor, 10);
  assert.equal(body.bootId, body.readerBootId);
  assert.equal(body.bootScope, "reader-process");
  assert.equal(body.writeSideEffects, false);
  assert.equal(body.coverageIncomplete, true);
  assert.equal(f.bindings(), 0);
  const next = await f.get(`?cursor=${body.nextCursor}&bootId=${body.bootId}`);
  assert.equal(next.status, 200, "echoing the returned stopped cursor fence must not loop boot_changed");
});

test("known persistence failures and internal cursor holes cannot become successful stopped replay", async () => {
  const failed = await fixture({ writeFailureObserved: true }).get();
  assert.equal(failed.status, 503);
  assert.equal((await failed.json()).code, "coverage_incomplete");
  const response = await fixture({ gap: { afterCursor: 2, recoverFromCursor: 4 } }).get("?cursor=1");
  assert.equal(response.status, 409);
  const body = await response.json(); assert.equal(body.code, "gap"); assert.equal(body.recoverFromCursor, 4);
  const ahead = await fixture().get("?cursor=100");
  assert.equal(ahead.status, 409);
  assert.equal((await ahead.json()).code, "cursor_ahead");
});

test("stopped corrupt ledgers are unknown and an evicted cursor reports gap explicitly", async () => {
  const unavailable = await fixture({ available: false }).get();
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).code, "coverage_incomplete");
  const gap = await fixture({ oldestCursor: 8 }).get("?cursor=1");
  assert.equal(gap.status, 409);
  const body = await gap.json(); assert.equal(body.code, "gap");
  assert.equal(body.recoverFromCursor, 7);
  const prefix = await fixture({ oldestCursor: 2 }).get("?cursor=0");
  assert.equal(prefix.status, 409, "initial cursor zero cannot hide a prefix gap after restart");
  assert.equal((await prefix.json()).recoverFromCursor, 1);
});

test("live projection has bounded cursor parameters", () => {
  assert.match(source, /LIVE_EVENT_MAX_EVENTS/);
  assert.match(source, /LIVE_EVENT_MAX_BYTES/);
  assert.match(source, /boundedInteger\(url\.searchParams\.get\("cursor"\)/);
  assert.match(source, /boundedBootId\(url\.searchParams\.get\("bootId"\)/);
  assert.match(source, /requestedBootId !== undefined && requestedBootId !== snapshot\.bootId/);
});
