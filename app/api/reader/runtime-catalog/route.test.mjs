import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isApiRequestAllowed } from "../../../../lib/request-security.ts";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(readSnapshot) {
  let snapshotReads = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-security": { isApiRequestAllowed: (request) => isApiRequestAllowed(request, []) },
    "@/lib/rpc-manager": {
      listReaderRuntimeSafetySnapshot: () => { snapshotReads += 1; return readSnapshot(); },
    },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return { route: testModule.exports, reads: () => snapshotReads };
}

function runtime(sessionId, overrides = {}) {
  return {
    sessionId, bootId: `runtime-boot:${sessionId}`,
    isAlive: true, isShuttingDown: false, isRunning: false, settingsMutationPending: false, isStreaming: false,
    isPromptRunning: false, isBashRunning: false, isCompacting: false, waiting: false,
    queueRevision: `queue:${sessionId}`, queueCounts: { steering: 0, followUp: 0, total: 0 },
    ...overrides,
  };
}

function snapshot(runtimes, overrides = {}) {
  return {
    schemaVersion: 1, source: "reader-runtime-registry", bootId: "reader-boot",
    capturedAt: "2026-10-15T16:00:00.000Z",
    coverage: {
      complete: true, scope: "all-in-process-runtimes",
      runtimeCount: runtimes.length, startingRuntimeCount: 2, pendingRuntimeMutationCount: 1, readOnly: true,
    },
    runtimeStartAttempted: false, writeSideEffects: false, runtimes,
    ...overrides,
  };
}

function request(headers = { host: "localhost:30142" }) {
  return new Request("http://localhost:30142/api/reader/runtime-catalog", { headers });
}

function assertNoStore(response) {
  assert.equal(response.headers.get("cache-control"), "no-store");
}

test("runtime catalog includes idle, transient and hidden registry entries without exposing internal fields", async () => {
  const runtimes = [
    runtime("idle"),
    runtime("transient", { isRunning: true, isPromptRunning: true }),
    runtime("setting-write", { isRunning: true, settingsMutationPending: true }),
    runtime("hidden", { waiting: true, queueCounts: { steering: 1, followUp: 2, total: 3 } }),
    runtime("shutting-down", { isAlive: false, isShuttingDown: true }),
  ];
  const expected = snapshot(runtimes);
  const internal = snapshot(runtimes.map((entry) => ({
    ...entry,
    cwd: "/private/runtime-project",
    prompt: "private prompt text",
    secret: "private fixture value",
    waitingRequests: [{ title: "private user interaction" }],
    queueCounts: { ...entry.queueCounts, messages: ["private queued text"] },
  })), {
    cwd: "/private/registry-root",
    credentials: "private fixture value",
    coverage: { ...expected.coverage, internalPaths: ["/private/registry-root"] },
  });
  const { route, reads } = fixture(() => internal);
  const response = route.GET(request({
    host: "localhost:30142", origin: "http://localhost:30142", "sec-fetch-site": "same-origin",
  }));
  assert.equal(response.status, 200);
  assertNoStore(response);
  assert.deepEqual(await response.json(), expected);
  assert.equal(reads(), 1);
  assert.deepEqual(Object.keys(route).sort(), ["GET", "dynamic"]);
  assert.equal(route.dynamic, "force-dynamic");
});

test("non-browser local reads take fresh snapshots and preserve startup-in-progress coverage", async () => {
  const states = [snapshot([]), snapshot([runtime("new-runtime")], { capturedAt: "2026-10-15T16:00:01.000Z" })];
  const { route, reads } = fixture(() => states.shift());
  const first = route.GET(request());
  assertNoStore(first);
  const before = await first.json();
  assert.equal(before.coverage.runtimeCount, 0);
  assert.equal(before.coverage.startingRuntimeCount, 2);
  assert.equal(before.coverage.pendingRuntimeMutationCount, 1);
  const second = route.GET(request());
  assertNoStore(second);
  const after = await second.json();
  assert.equal(after.coverage.runtimeCount, 1);
  assert.notEqual(after.capturedAt, before.capturedAt);
  assert.equal(reads(), 2);
});

test("untrusted host and cross-origin requests are rejected before reading the registry", async () => {
  const { route, reads } = fixture(() => { throw new Error("registry must not be read"); });
  for (const headers of [
    {},
    { host: "attacker.example" },
    { host: "localhost:30142", origin: "https://attacker.example" },
    { host: "localhost:30142", "sec-fetch-site": "cross-site" },
    { host: "localhost:30142", origin: "null", "sec-fetch-site": "cross-site" },
  ]) {
    const response = route.GET(request(headers));
    assert.equal(response.status, 403);
    assertNoStore(response);
    assert.deepEqual(await response.json(), { error: "Untrusted API request" });
  }
  assert.equal(reads(), 0);
});

test("snapshot failures report incomplete coverage without leaking internal diagnostics", async () => {
  const { route, reads } = fixture(() => { throw new Error("private prompt at /private/runtime-project"); });
  const response = route.GET(request());
  assert.equal(response.status, 503);
  assertNoStore(response);
  assert.deepEqual(await response.json(), {
    error: "Reader runtime catalog is unavailable",
    code: "runtime_catalog_unavailable",
    coverage: { complete: false, scope: "all-in-process-runtimes" },
    runtimeStartAttempted: false,
    writeSideEffects: false,
  });
  assert.equal(reads(), 1);
});
