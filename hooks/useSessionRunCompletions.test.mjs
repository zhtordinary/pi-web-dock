import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url);
const completion = await jiti.import("../lib/session-run-completion.ts");
const activity = await jiti.import("../lib/session-activity-client.ts");
const source = await readFile(new URL("./useSessionRunCompletions.ts", import.meta.url), "utf8");
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = () => new Promise(resolve => setImmediate(resolve));
function snapshot(status = "running", runId = "run-1", { device = "remote", sessionId = "session-1" } = {}) {
  const run = { runId, sessionId, status, updatedAt: "2026-10-23T00:00:00Z" };
  return { devices: [{ id: device, online: true }], sessions: [{ device: { id: device, online: true }, session: { id: sessionId },
    status: status === "completed" ? "just_completed" : status, latestRun: run, runs: [run] }] };
}
const liveStart = { type: "activity", kind: "run", device: "remote", sessionId: "session-1", runId: "new", status: "running",
  at: Date.parse("2026-10-23T00:01:00Z"), replay: false };
function harness(scope = "all") {
  const requests = [], completions = [], listeners = new Map();
  const eventSource = { close() { this.closed = true; } };
  let cleanup, interval, cleared = false;
  const deps = {
    react: { useRef: current => ({ current }), useEffect: effect => { cleanup = effect(); } },
    "@/lib/reader-events-client": { openReaderEventSource: () => eventSource },
    "@/lib/session-activity-fetch": { fetchSessionActivity: url => new Promise((resolve, reject) => requests.push({ url, resolve, reject })) },
    "@/lib/session-run-completion": completion,
    "@/lib/session-activity-client": activity,
  };
  const window = { setInterval: callback => { interval = callback; return 1; }, clearInterval: () => { cleared = true; },
    addEventListener: (type, callback) => listeners.set(type, callback), removeEventListener: type => listeners.delete(type) };
  const loaded = { exports: {} };
  new Function("require", "module", "exports", "window", compiled)(name => deps[name], loaded, loaded.exports, window);
  loaded.exports.useSessionRunCompletions(scope, item => completions.push(item));
  return { requests, completions, eventSource, listeners, poll: () => interval(), cleanup: () => cleanup(),
    cleared: () => cleared, event: data => eventSource.onmessage({ data: JSON.stringify(data) }) };
}

test("registry observation completes an unmounted remote session without history/metadata/agent reads", async () => {
  const h = harness();
  h.requests[0].resolve(snapshot()); await flush();
  h.event({ type: "activity", device: "remote", status: "completed" });
  h.requests[1].resolve(snapshot("completed")); await flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].device.id, "remote");
  h.poll(); h.requests[2].resolve(snapshot("completed")); await flush();
  assert.equal(h.completions.length, 1);
  assert.ok(h.requests.every(({ url }) => url === "/api/session-runs?scope=all&view=completion&refresh=1"));
  h.cleanup();
  assert.equal(h.eventSource.closed, true);
  assert.equal(h.cleared(), true);
  assert.equal(h.listeners.size, 0);
});

test("failures preserve the last observed running run and unmount rejects late responses", async () => {
  const h = harness("local");
  assert.match(h.requests[0].url, /scope=local/);
  h.requests[0].resolve(snapshot()); await flush();
  h.poll(); h.requests[1].reject(new Error("offline")); await flush();
  assert.equal(h.completions.length, 0);
  h.listeners.get("focus")(); h.requests[2].resolve(snapshot("completed")); await flush();
  assert.equal(h.completions.length, 1);
  h.poll(); h.cleanup(); h.requests[3].resolve(snapshot("completed", "another")); await flush();
  assert.equal(h.completions.length, 1);
});

test("a live run start beats an in-flight snapshot; short observed runs complete once", async () => {
  const h = harness();
  h.requests[0].resolve(snapshot("completed", "old")); await flush();
  assert.equal(h.completions.length, 0, "initial terminal history is silent");
  h.poll();
  h.event({ type: "activity", kind: "run", device: "remote", sessionId: "session-1", runId: "new", status: "running", at: Date.parse("2026-10-23T00:01:00Z") });
  h.requests[1].resolve(snapshot("completed", "old")); await flush();
  assert.equal(h.requests.length, 3, "single-flight request is followed by a fresh read");
  h.requests[2].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].latestRun.runId, "new");
  h.cleanup();
});

for (const scope of ["local", "all"]) {
  test(`a short live run observed before the first ${scope} inventory completes exactly once`, async () => {
    const h = harness(scope);
    h.event(liveStart);
    h.event({ ...liveStart, status: "completed" });
    assert.equal(h.requests.length, 1, "events do not start concurrent inventory reads");
    h.requests[0].resolve(snapshot("running", "new")); await flush();
    assert.equal(h.requests.length, 2, "the pre-event response is stale even if it contains the run");
    assert.equal(h.completions.length, 0);
    h.requests[1].resolve(snapshot("completed", "new")); await flush();
    assert.equal(h.completions.length, 1, "this observer saw the real start, not just terminal history");
    assert.equal(h.completions[0].latestRun.runId, "new");
    h.poll(); h.requests[2].resolve(snapshot("completed", "new")); await flush();
    h.event(liveStart);
    h.requests[3].resolve(snapshot("completed", "new")); await flush();
    assert.equal(h.completions.length, 1, "neither repeated reads nor a duplicate start reopen a completed run");
    h.cleanup();
  });
}

test("an initial live start survives failed, offline and not-yet-matching inventories", async () => {
  const h = harness();
  h.event(liveStart);
  h.requests[0].reject(new Error("offline")); await flush();
  h.requests[1].resolve({ devices: [{ id: "remote", online: false }], sessions: [] }); await flush();
  assert.equal(h.completions.length, 0);
  h.poll(); h.requests[2].resolve(snapshot("completed", "old")); await flush();
  assert.equal(h.completions.length, 0, "an older historical terminal does not consume the observed start");
  h.poll(); h.requests[3].resolve(snapshot("aborted", "new")); await flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].latestRun.status, "aborted");
  h.poll(); h.requests[4].resolve(snapshot("aborted", "new")); await flush();
  assert.equal(h.completions.length, 1);
  h.cleanup();
});

test("the first matching running inventory takes over from the initial start fact", async () => {
  const h = harness();
  h.event(liveStart);
  h.requests[0].resolve(snapshot("completed", "old")); await flush();
  h.requests[1].resolve(snapshot("running", "new")); await flush();
  assert.equal(h.completions.length, 0);
  h.poll(); h.requests[2].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.completions.length, 1);
  h.poll(); h.requests[3].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.completions.length, 1, "the consumed start cannot re-notify the same terminal snapshot");
  h.cleanup();
});

test("an offline matching terminal cannot consume an initial start before reconnect", async () => {
  const h = harness();
  h.event(liveStart);
  h.requests[0].resolve(snapshot("completed", "old")); await flush();
  const offline = snapshot("completed", "new");
  offline.devices[0].online = false;
  offline.sessions[0].device.online = false;
  h.requests[1].resolve(offline); await flush();
  assert.equal(h.completions.length, 0);
  h.poll(); h.requests[2].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.completions.length, 1);
  h.poll(); h.requests[3].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.completions.length, 1);
  h.cleanup();
});

test("unmount discards initial start facts and ignores its late first response", async () => {
  const h = harness();
  h.event(liveStart);
  h.cleanup();
  h.requests[0].resolve(snapshot("completed", "new")); await flush();
  assert.equal(h.requests.length, 1);
  assert.equal(h.completions.length, 0);
  const fresh = harness();
  fresh.requests[0].resolve(snapshot("completed", "new")); await flush();
  assert.equal(fresh.completions.length, 0, "another observer cannot inherit the old start");
  fresh.cleanup();
});

test("initial live starts match terminal inventories by device, session and run", async () => {
  const h = harness();
  h.event(liveStart);
  h.requests[0].resolve(snapshot("completed", "old")); await flush();
  const wrongDevice = snapshot("completed", "new", { device: "another-peer" });
  const wrongSession = snapshot("completed", "new", { sessionId: "another-session" });
  const wrongRun = snapshot("completed", "another-run");
  h.requests[1].resolve({ devices: [...wrongDevice.devices, ...wrongRun.devices],
    sessions: [...wrongDevice.sessions, ...wrongSession.sessions, ...wrongRun.sessions] }); await flush();
  assert.equal(h.completions.length, 0);
  h.poll(); h.requests[2].resolve(snapshot("failed", "new")); await flush();
  assert.equal(h.completions.length, 1);
  assert.equal(h.completions[0].device.id, "remote");
  assert.equal(h.completions[0].session.id, "session-1");
  assert.equal(h.completions[0].latestRun.status, "failed");
  h.cleanup();
});

test("first-inventory terminal history, replay and identity-less starts stay silent", async () => {
  for (const event of [{ ...liveStart, status: "completed" }, { ...liveStart, replay: true },
    { ...liveStart, kind: "session" }, { ...liveStart, device: undefined }, { ...liveStart, sessionId: undefined },
    { ...liveStart, runId: undefined }, { ...liveStart, runId: "" }]) {
    const h = harness();
    h.event(event);
    h.requests[0].resolve(snapshot("completed", "new")); await flush();
    h.requests[1].resolve(snapshot("completed", "new")); await flush();
    assert.equal(h.completions.length, 0, JSON.stringify(event));
    h.poll(); h.requests[2].resolve(snapshot("completed", "new")); await flush();
    assert.equal(h.completions.length, 0);
    h.cleanup();
  }
});

test("replayed starts and malformed messages do not invent a fresh running transition", async () => {
  const h = harness();
  h.requests[0].resolve(snapshot("completed")); await flush();
  h.eventSource.onmessage({ data: "broken" });
  assert.equal(h.requests.length, 1);
  h.event({ type: "activity", kind: "run", device: "remote", sessionId: "session-1", runId: "run-1", status: "running", replay: true });
  h.requests[1].resolve(snapshot("completed")); await flush();
  assert.equal(h.completions.length, 0);
  h.cleanup();
});


test("a remote peer reconnect can finish a run observed before its offline inventory", async () => {
  const h = harness();
  h.requests[0].resolve(snapshot()); await flush();
  h.poll();
  h.requests[1].resolve({ devices: [{ id: "remote", online: false }], sessions: [] }); await flush();
  assert.equal(h.completions.length, 0);
  h.poll(); h.requests[2].resolve(snapshot("completed")); await flush();
  assert.equal(h.completions.length, 1);
  h.cleanup();
});
