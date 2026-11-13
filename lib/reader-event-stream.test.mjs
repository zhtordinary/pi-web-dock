import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const {
  createReaderEventStream,
  listReaderStreamDiagnostics,
  READER_STREAM_HIGH_WATER_MARK_BYTES,
} = await jiti.import("./reader-event-stream.ts");

function frames(bytes) {
  return new TextDecoder().decode(bytes)
    .split("\n\n")
    .map((block) => block.split("\n").find((line) => line.startsWith("data: "))?.slice(6))
    .filter(Boolean)
    .map((data) => JSON.parse(data));
}

async function readFrames(reader) {
  const result = await reader.read();
  assert.equal(result.done, false);
  return frames(result.value);
}

test("subscriptions precede all authoritative snapshots and live events remain immediate", async () => {
  const controller = new AbortController();
  let live;
  let stopped = 0;
  const stream = createReaderEventStream(new Request("http://localhost/api/reader/events", { signal: controller.signal }), {
    subscribe(emit, register) { live = emit; register(() => stopped++); },
    snapshot() {
      assert.equal(typeof live, "function");
      return [
        { type: "running", runningSessionIds: ["s"] },
        { type: "waiting_user", sessions: [{ sessionId: "s", requestIds: ["q"] }] },
        { type: "waits_changed" },
      ];
    },
  });
  const reader = stream.getReader();
  const snapshotFrames = [];
  while (snapshotFrames.length < 3) snapshotFrames.push(...await readFrames(reader));
  assert.deepEqual(snapshotFrames.map((event) => event.type), ["running", "waiting_user", "waits_changed"]);
  live({ type: "activity", device: "peer", seq: 1, runId: "run", status: "completed" });
  assert.equal((await readFrames(reader))[0].runId, "run");
  controller.abort();
  assert.equal(stopped, 1);
  assert.equal((await reader.read()).done, true);
});

test("consumer cancellation and partial startup failure release every registered resource", async () => {
  let released = 0;
  const stream = createReaderEventStream(new Request("http://localhost"), {
    subscribe(_emit, register) { register(() => released++); },
    snapshot: () => [],
  });
  await stream.cancel();
  assert.equal(released, 1);

  const broken = createReaderEventStream(new Request("http://localhost"), {
    subscribe(_emit, register) {
      register(() => released++);
      throw new Error("offline source");
    },
    snapshot: () => [],
  });
  const reader = broken.getReader();
  assert.equal((await readFrames(reader))[0].type, "transport_error");
  assert.equal((await reader.read()).done, true);
  assert.equal(released, 2);
});

test("already aborted requests never subscribe", async () => {
  const controller = new AbortController();
  controller.abort();
  let subscriptions = 0;
  const stream = createReaderEventStream(new Request("http://localhost", { signal: controller.signal }), {
    subscribe() { subscriptions += 1; },
    snapshot: () => [],
  });
  assert.equal((await stream.getReader().read()).done, true);
  assert.equal(subscriptions, 0);
});

test("notification streams participate in the existing graceful-shutdown registry", async () => {
  let stopped = 0;
  const stream = createReaderEventStream(new Request("http://localhost"), {
    subscribe(_emit, register) { register(() => stopped++); },
    snapshot: () => [],
  });
  const registry = globalThis[Symbol.for("pi-web.agentEventStreamClosers")];
  assert.equal(registry.size, 1);
  const reader = stream.getReader();
  const pending = reader.read();
  for (const close of [...registry]) close("error");
  await assert.rejects(pending, /shutting down/);
  assert.equal(registry.size, 0);
  assert.equal(stopped, 1);
});

test("a single oversized snapshot is delivered, while a later write hard-terminates a slow reader", async () => {
  const snapshotPayload = "x".repeat(READER_STREAM_HIGH_WATER_MARK_BYTES + 1024);
  let live;
  let stopped = 0;
  const snapshotStream = createReaderEventStream(new Request("http://localhost"), {
    subscribe(emit, register) { live = emit; register(() => stopped++); },
    snapshot: () => [{ type: "snapshot", payload: snapshotPayload }],
  });
  const snapshotReader = snapshotStream.getReader();
  const snapshot = await readFrames(snapshotReader);
  assert.equal(snapshot[0].payload, snapshotPayload);
  assert.equal(listReaderStreamDiagnostics().length >= 1, true);
  await snapshotReader.cancel();
  assert.equal(stopped, 1);

  let slowLive;
  let slowStopped = 0;
  const slowStream = createReaderEventStream(new Request("http://localhost"), {
    subscribe(emit, register) { slowLive = emit; register(() => slowStopped++); },
    snapshot: () => [],
  });
  const slowReader = slowStream.getReader();
  slowLive({ type: "large", payload: snapshotPayload });
  slowLive({ type: "overflow" });
  await assert.rejects(slowReader.read(), /shutting down/);
  assert.equal(slowStopped, 1);
  assert.equal(listReaderStreamDiagnostics().length, 0);
});

test("diagnostics expose transport counters only and cancel unregisters the stream", async () => {
  let stopped = 0;
  const stream = createReaderEventStream(
    new Request("http://localhost/api/reader/events"),
    {
      subscribe(emit, register) {
        register(() => { stopped += 1; });
        emit({ type: "fixture", payload: "not returned by diagnostics" });
      },
      snapshot: () => [],
    },
    { kind: "activity" },
  );
  const reader = stream.getReader();
  const first = await readFrames(reader);
  assert.equal(first[0].type, "fixture");
  const live = listReaderStreamDiagnostics().filter((item) => item.kind === "activity");
  assert.equal(live.length, 1);
  assert.equal(live[0].sessionId, null);
  assert.equal(live[0].holder, null);
  assert.ok(live[0].openedAt > 0);
  assert.ok(live[0].lastWriteAt >= live[0].openedAt);
  assert.equal(Object.hasOwn(live[0], "eventContent"), false);

  await reader.cancel();
  assert.equal(stopped, 1);
  assert.equal(listReaderStreamDiagnostics().some((item) => item.kind === "activity"), false);
});
