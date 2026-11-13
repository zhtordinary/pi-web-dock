import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { isApiRequestAllowed } from "../../../../lib/request-security.ts";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;

function fixture(readDiagnostics) {
  let reads = 0;
  const dependencies = {
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/request-security": { isApiRequestAllowed: (request) => isApiRequestAllowed(request, []) },
    "@/lib/activity-peers": { localDeviceId: () => "fixture-device", readActivityConfig: () => ({}) },
    "@/lib/reader-event-stream": {
      listReaderStreamDiagnostics: () => { reads += 1; return readDiagnostics(); },
      READER_STREAM_KINDS: ["agent", "reader-events", "activity", "terminal", "file-watch", "ui-requests", "quick-ask", "provider-login"],
    },
  };
  const testModule = { exports: {} };
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  return { route: testModule.exports, reads: () => reads };
}

function request(headers = { host: "localhost:30142" }) {
  return new Request("http://localhost:30142/api/reader/stream-diagnostics", { headers });
}

test("returns only bounded connection counters", async () => {
  const diagnostics = [{
    kind: "agent", sessionId: "session-a", holder: "foreground", openedAt: 1,
    connectedAt: 2, lastWriteAt: 3, droppedEvents: 4, queuedBytes: 5,
    ip: "private", userAgent: "private", eventContent: "private",
  }];
  const { route, reads } = fixture(() => diagnostics);
  const response = route.GET(request({ host: "localhost:30142", origin: "http://localhost:30142", "sec-fetch-site": "same-origin" }));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const body = await response.json();
  assert.equal(body.deviceId, "fixture-device");
  assert.deepEqual(body.streams, [{
    kind: "agent", sessionId: "session-a", holder: "foreground", openedAt: 1,
    connectedAt: 2, lastWriteAt: 3, droppedEvents: 4, queuedBytes: 5,
  }]);
  assert.deepEqual(body.counts, { agent: 1 });
  assert.deepEqual(body.coverage.excludes, ["ip", "userAgent", "requestMetadata", "eventContent"]);
  assert.deepEqual(body.coverage.streamKinds, {
    included: ["agent", "reader-events", "activity", "terminal", "file-watch", "ui-requests", "quick-ask", "provider-login"],
    excluded: [],
  });
  assert.equal(body.coverage.complete, true);
  assert.match(body.coverage.sampling.queuedBytes, /write-time/);
  assert.equal(reads(), 1);
});

test("rejects untrusted requests before reading connection state", async () => {
  const { route, reads } = fixture(() => { throw new Error("must not read"); });
  const response = route.GET(request({ host: "attacker.example" }));
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "Untrusted API request" });
  assert.equal(reads(), 0);
});
