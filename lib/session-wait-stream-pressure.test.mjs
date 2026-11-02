import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, request } from "node:http";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { createJiti } from "jiti";
import test from "node:test";
const core = createRequire(import.meta.url)("../bin/session-wait-core.cjs");
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const immediate = () => new Promise(resolve => setImmediate(resolve));

test("large-state streamed RPC observations do no control I/O while HTTP remains responsive", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "wait-stream-pressure-"));
  const keys = ["PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_WAIT_CHANNEL", "PI_WEB_DEVICE_ID", "PI_WEB_SESSION_ACTIVITY_CONFIG"];
  const old = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root;
  process.env.PI_WEB_SESSION_WAIT_CHANNEL = "pressure";
  process.env.PI_WEB_DEVICE_ID = "fixture";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "fixture" } });
  t.after(() => { rmSync(root, { recursive: true, force: true }); for (const key of keys) { if (old[key] === undefined) delete process.env[key]; else process.env[key] = old[key]; } });
  const waits = await jiti.import("./session-waits.ts");
  const identity = { deviceId: "fixture", sessionId: "target" };
  for (const condition of ["turn_settled", "task_completed", "acceptance_passed"]) {
    core.createWait(root, "pressure", { id: condition, owner: { deviceId: "fixture", sessionId: "owner" }, target: identity, condition, taskId: "run" });
  }
  const file = core.stateFile(root, "pressure");
  const legacy = core.readState(root, "pressure");
  for (let i = 0; i < 50_000; i++) {
    const id = `legacy-${i}`;
    legacy.events[id] = { id, type: "runtime_event", identity, summary: "message_update", padding: "x".repeat(500) };
    legacy.eventOrder.push(id);
  }
  core.atomicWriteJson(file, legacy);
  const bytes = readFileSync(file);
  let runtimeCalls = 0; let statusCalls = 0;
  const originalRuntime = core.runtimeEvent; const originalStatus = core.getStatus;
  core.runtimeEvent = (...args) => { runtimeCalls++; return originalRuntime(...args); };
  core.getStatus = (...args) => { statusCalls++; return originalStatus(...args); };
  t.after(() => { core.runtimeEvent = originalRuntime; core.getStatus = originalStatus; });
  const server = createServer((_req, res) => { res.end("ok"); });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const latencies = [];
  let stopped = false;
  const heartbeat = (async () => {
    while (!stopped) {
      const start = performance.now();
      await new Promise((resolve, reject) => { const req = request({ hostname: "127.0.0.1", port: server.address().port, agent: false }, res => { assert.equal(res.statusCode, 200); res.resume(); res.on("end", resolve); }); req.on("error", reject); req.end(); });
      latencies.push(performance.now() - start);
    }
  })();
  const started = performance.now();
  const count = Number(process.env.PI_WEB_WAIT_PRESSURE_EVENTS || 200_000);
  const types = ["message_update", "tool_execution_update", "message_start", "message_end", "tool_execution_start", "tool_execution_end", "turn_start", "turn_end"];
  for (let offset = 0; offset < count; offset += 1000) {
    for (let i = offset; i < Math.min(offset + 1000, count); i++) {
      waits.persistSessionWaitEvent({ type: types[i % types.length], sessionId: `session-${i % 64}`, runId: `run-${i % 64}`, toolName: "fixture-tool" });
    }
    await immediate();
  }
  stopped = true; await heartbeat;
  const elapsedMs = performance.now() - started;
  assert.equal(runtimeCalls, 0);
  assert.equal(statusCalls, 0, "stream deltas must not schedule drains");
  assert.deepEqual(readFileSync(file), bytes);
  assert.ok(latencies.length >= 2);
  assert.ok(Math.max(...latencies) < 1000, "HTTP heartbeat must not starve");
  assert.ok(elapsedMs < 10_000, "stream bridge must stay off the synchronous state path");
  waits.persistSessionWaitEvent({ type: "agent_settled", sessionId: "target", runId: "run" });
  await waits.drainLocalOwnerOutboxes();
  let state = core.readState(root, "pressure");
  assert.equal(state.waits.turn_settled, undefined);
  assert.equal(state.terminalWaits.turn_settled.status, "completed");
  assert.equal(state.waits.task_completed.status, "waiting");
  assert.equal(state.waits.acceptance_passed.status, "waiting");
  waits.persistSessionWaitEvent({ type: "prompt_error", sessionId: "target", runId: "run", errorMessage: "fixture failure" });
  await waits.drainLocalOwnerOutboxes();
  state = core.readState(root, "pressure");
  assert.equal(state.waits.task_completed.status, "failed");
  assert.equal(state.waits.acceptance_passed.status, "failed");
  t.diagnostic(JSON.stringify({ events: count, sessions: 64, elapsedMs, httpResponses: latencies.length, maxHttpLatencyMs: Math.max(...latencies), streamRuntimeCalls: 0, streamStatusCalls: 0, stateBytes: bytes.length }));
});

test("drain requests coalesce, serialize, and retry busy work without another runtime event", async (t) => {
  const { createWaitDrainScheduler } = await jiti.import("./session-wait-drain.ts");
  let calls = 0; let active = 0; let maximumActive = 0; let busy = true;
  const scheduler = createWaitDrainScheduler(async () => {
    calls++; active++; maximumActive = Math.max(maximumActive, active);
    await immediate(); active--; return busy;
  }, 30);
  t.after(() => scheduler.cancelRetry());
  for (let i = 0; i < 100_000; i++) scheduler.request();
  await immediate(); await immediate();
  assert.equal(calls, 1);
  assert.equal(maximumActive, 1);
  busy = false;
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(calls, 2);
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(calls, 2, "terminal drain stops retrying");
});

test("requests at the drain completion boundary survive both idle and busy outcomes", async (t) => {
  const { createWaitDrainScheduler } = await jiti.import("./session-wait-drain.ts");
  for (const busy of [false, true]) {
    let calls = 0;
    const scheduler = createWaitDrainScheduler(async () => { calls++; return busy; }, 10_000);
    t.after(() => scheduler.cancelRetry());
    const first = scheduler.flush();
    queueMicrotask(() => scheduler.request());
    await first; await immediate();
    assert.equal(calls, 2, `completion boundary must retain request when retry=${busy}`);
    scheduler.cancelRetry();
  }
});
