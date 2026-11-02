import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createAgentEventStream } = await jiti.import("./agent-event-stream.ts");
const decoder = new TextDecoder();
async function fixture(t, observe) {
  const directory = await mkdtemp(join(tmpdir(), "reader-cold-observation-"));
  const file = join(directory, "history.jsonl");
  const controller = new AbortController();
  console.log(JSON.stringify({ fixtureDirectory: directory, purpose: "cold-to-native observation", cleanup: "abort the owned stream and remove this fixture directory" }));
  t.after(async () => {
    controller.abort();
    assert.equal((await lstat(directory)).isDirectory(), true);
    await rm(directory, { recursive: true });
    await assert.rejects(lstat(directory), { code: "ENOENT" });
  });
  await writeFile(file, "");
  return { controller, reader: createAgentEventStream(new Request("http://localhost/events", { signal: controller.signal }),
    "session", Promise.resolve(null), file, observe).getReader() };
}
async function data(reader) {
  let timeout;
  try {
    const chunk = await Promise.race([reader.read(), new Promise((_, reject) => {
      timeout = setTimeout(() => reject(new Error("No runtime observation arrived")), 1000);
    })]);
    assert.equal(chunk.done, false);
    return JSON.parse(decoder.decode(chunk.value).slice("data: ".length));
  } finally { clearTimeout(timeout); }
}

test("a cold observer upgrades and replays startup UI before initialization completes", async t => {
  let publish, discoveriesReleased = 0, eventsReleased = 0;
  const { reader, controller } = await fixture(t, next => {
    publish = next;
    return () => { discoveriesReleased++; };
  });
  await reader.read();
  assert.equal((await data(reader)).runtimeAvailable, false);
  assert.equal(discoveriesReleased, 0);
  publish(Promise.resolve({ isStreaming: false, streamingMessage: undefined, onEvent(listener) {
    listener({ type: "extension_ui_request", id: "startup-confirm", method: "confirm", title: "Startup confirmation" });
    return () => { eventsReleased++; };
  } }));
  const connected = await data(reader);
  assert.equal(connected.type, "connected");
  assert.deepEqual(connected.pendingExtensionUiIds, ["startup-confirm"]);
  assert.equal((await data(reader)).id, "startup-confirm");
  assert.equal(discoveriesReleased, 1);
  controller.abort();
  assert.equal(eventsReleased, 1);
  assert.equal((await reader.read()).done, true);
});

test("synchronous discovery releases its observer once after subscribing to native events", async t => {
  let releases = 0;
  const { reader } = await fixture(t, publish => {
    publish(Promise.resolve({ isStreaming: false, streamingMessage: undefined, onEvent: () => () => {} }));
    return () => { releases++; };
  });
  await reader.read();
  assert.equal((await data(reader)).runtimeAvailable, false);
  assert.equal((await data(reader)).type, "connected");
  assert.equal(releases, 1);
});

test("a failed runtime identity check ends discovery rather than publishing unbound native events", async t => {
  let publish, releases = 0;
  const { reader } = await fixture(t, next => { publish = next; return () => { releases++; }; });
  await reader.read(); await data(reader);
  publish(Promise.reject(new Error("runtime identity changed")));
  const error = await data(reader);
  assert.equal(error.type, "startup_error");
  assert.match(error.errorMessage, /runtime identity changed/);
  assert.equal(releases, 1);
  assert.equal((await reader.read()).done, true);
});

test("closing a cold observer removes discovery and cannot subscribe a late runtime", async t => {
  let publish, releases = 0, subscriptions = 0;
  const { reader, controller } = await fixture(t, next => { publish = next; return () => { releases++; }; });
  await reader.read(); await data(reader);
  controller.abort();
  publish(Promise.resolve({ isStreaming: false, streamingMessage: undefined, onEvent() { subscriptions++; return () => {}; } }));
  await Promise.resolve();
  assert.equal(releases, 1);
  assert.equal(subscriptions, 0);
  assert.equal((await reader.read()).done, true);
});
