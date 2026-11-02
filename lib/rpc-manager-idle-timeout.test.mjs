import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";

const originalActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
const activityRoot = await mkdtemp(join(tmpdir(), "reader-idle-activity-"));
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(activityRoot, "session-activity.json");
test.after(async () => {
  if (originalActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = originalActivityFile;
  await rm(activityRoot, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { resolveSessionIdleTimeoutMs } = await jiti.import("./rpc-manager.ts");

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function makeIdleInner() {
  return {
    sessionId: "session-1",
    isBashRunning: false,
    isStreaming: false,
    isCompacting: false,
    extensionRunner: {},
    agent: { state: {} },
    subscribe: () => () => {},
    dispose() {},
  };
}

test("defaults to the 10-minute idle timeout when the env var is unset or blank", () => {
  assert.equal(resolveSessionIdleTimeoutMs(), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs(""), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("   "), 10 * 60 * 1000);
});

test("keeps a streaming wrapper alive without UI attachment or lifecycle polling", async (t) => {
  const previousIdle = process.env.PI_WEB_IDLE_TIMEOUT_MS;
  const previousStale = process.env.PI_WEB_STALE_RUNNING_TIMEOUT_MS;
  process.env.PI_WEB_IDLE_TIMEOUT_MS = "50";
  process.env.PI_WEB_STALE_RUNNING_TIMEOUT_MS = "1";
  try {
    const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const { AgentSessionWrapper: FreshAgentSessionWrapper } = await freshJiti.import("./rpc-manager.ts");
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    const wrapper = new FreshAgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    t.mock.timers.tick(50);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    inner.isStreaming = false;
    t.mock.timers.tick(50);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
  } finally {
    if (previousIdle === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
    else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousIdle;
    if (previousStale === undefined) delete process.env.PI_WEB_STALE_RUNNING_TIMEOUT_MS;
    else process.env.PI_WEB_STALE_RUNNING_TIMEOUT_MS = previousStale;
  }
});


for (const busyField of ["isStreaming", "isCompacting", "isBashRunning"]) {
  test(`keeps ${busyField} alive after the last browser lease is released`, async (t) => {
    await withIdleTimeoutEnv("50", async (AgentSessionWrapper) => {
      const { acquireSessionLivenessLease } = await jiti.import("./session-liveness.ts");
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const inner = makeIdleInner();
      inner[busyField] = true;
      const wrapper = new AgentSessionWrapper(inner);
      t.after(() => wrapper.destroy());
      const lease = acquireSessionLivenessLease(inner.sessionId);
      wrapper.start();
      lease.release(); // SSE disconnect releases only the browser's lease, not the runtime.
      for (let cycle = 0; cycle < 3; cycle += 1) {
        t.mock.timers.tick(50);
        await nextTurn();
        assert.equal(wrapper.isAlive(), true);
      }
      inner[busyField] = false;
      t.mock.timers.tick(50);
      await nextTurn();
      assert.equal(wrapper.isAlive(), false, "idle cleanup resumes after the work settles");
    });
  });
}

test("treats zero as disabling idle shutdown", () => {
  assert.equal(resolveSessionIdleTimeoutMs("0"), 0);
});

test("uses a positive value as the timeout in milliseconds", () => {
  assert.equal(resolveSessionIdleTimeoutMs("1800000"), 1_800_000);
  assert.equal(resolveSessionIdleTimeoutMs("2147483647"), 2_147_483_647);
});

test("falls back to the 10-minute default and warns for invalid or out-of-range values", (t) => {
  const warn = t.mock.method(console, "warn", () => {});
  assert.equal(resolveSessionIdleTimeoutMs("abc"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("-5"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("NaN"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("Infinity"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("2147483648"), 10 * 60 * 1000);
  assert.equal(resolveSessionIdleTimeoutMs("2592000000"), 10 * 60 * 1000);
  assert.equal(warn.mock.callCount(), 6);
});

async function withIdleTimeoutEnv(rawValue, run) {
  const previousValue = process.env.PI_WEB_IDLE_TIMEOUT_MS;
  process.env.PI_WEB_IDLE_TIMEOUT_MS = rawValue;
  try {
    const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
    const { AgentSessionWrapper } = await freshJiti.import("./rpc-manager.ts");
    await run(AgentSessionWrapper);
  } finally {
    if (previousValue === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
    else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousValue;
  }
}

test("an abort that cannot unwind disposes the session after the abort fallback", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    // A handler that ignores the abort signal keeps the SDK run pending forever.
    inner.abort = () => new Promise(() => {});
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    const abort = wrapper.send({ type: "abort" });
    await nextTurn();
    t.mock.timers.tick(2_000 - 1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), false);
    // The write owner remains held until the bounded SDK teardown completes.
    t.mock.timers.tick(5_000);
    await nextTurn();
    await abort;
  });
});

test("PI_WEB_IDLE_TIMEOUT_MS=0 keeps a session alive after Stop unwinds its run", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isStreaming = true;
    inner.abort = async () => {
      inner.isStreaming = false;
    };
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    await wrapper.send({ type: "abort" });
    t.mock.timers.tick(60 * 60 * 1000);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
  });
});

for (const rawValue of ["", "0"]) {
  test(`PI_WEB_IDLE_TIMEOUT_MS=${JSON.stringify(rawValue)}: Stop fallback cleanup cannot be postponed`, async (t) => {
    await withIdleTimeoutEnv(rawValue, async (AgentSessionWrapper) => {
      t.mock.timers.enable({ apis: ["setTimeout"] });
      const inner = makeIdleInner();
      inner.isStreaming = true;
      inner.abort = () => new Promise(() => {});
      const wrapper = new AgentSessionWrapper(inner);
      t.after(() => wrapper.destroy());
      wrapper.start();

      const abort = wrapper.send({ type: "abort" });
      await nextTurn();
      t.mock.timers.tick(2_000 - 1);
      await nextTurn();
      assert.equal(wrapper.isAlive(), true);

      t.mock.timers.tick(1);
      await nextTurn();
      assert.equal(wrapper.isAlive(), false);
      t.mock.timers.tick(5_000);
      await nextTurn();
      await abort;
      await assert.rejects(wrapper.send({ type: "abort" }), /Session is no longer available/);
    });
  });
}

test("PI_WEB_IDLE_TIMEOUT_MS=0 keeps an unending bash command alive", async (t) => {
  await withIdleTimeoutEnv("0", async (AgentSessionWrapper) => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const inner = makeIdleInner();
    inner.isBashRunning = true;
    inner.abortBash = () => {};
    const wrapper = new AgentSessionWrapper(inner);
    t.after(() => wrapper.destroy());
    wrapper.start();

    await wrapper.send({ type: "abort_bash" });
    t.mock.timers.tick(10 * 60 * 1000 - 1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);

    t.mock.timers.tick(1);
    await nextTurn();
    assert.equal(wrapper.isAlive(), true);
  });
});

for (const [rawValue, timeoutMs] of [
  ["0", 0],
  ["1800000", 1_800_000],
  ["2592000000", 600_000],
]) {
  test(`PI_WEB_IDLE_TIMEOUT_MS=${rawValue} applies to an idle session`, async (t) => {
    const previousValue = process.env.PI_WEB_IDLE_TIMEOUT_MS;
    process.env.PI_WEB_IDLE_TIMEOUT_MS = rawValue;
    try {
      const freshJiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
      const { AgentSessionWrapper } = await freshJiti.import("./rpc-manager.ts");

      t.mock.timers.enable({ apis: ["setTimeout"] });
      const wrapper = new AgentSessionWrapper(makeIdleInner());
      t.after(() => wrapper.destroy());
      wrapper.start();
      assert.equal(wrapper.isRunning(), false);

      t.mock.timers.tick(timeoutMs === 0 ? 60 * 60 * 1000 : timeoutMs - 1);
      await nextTurn();
      assert.equal(wrapper.isAlive(), true);

      if (timeoutMs !== 0) {
        t.mock.timers.tick(1);
        await nextTurn();
        assert.equal(wrapper.isAlive(), false);
      }
    } finally {
      if (previousValue === undefined) delete process.env.PI_WEB_IDLE_TIMEOUT_MS;
      else process.env.PI_WEB_IDLE_TIMEOUT_MS = previousValue;
    }
  });
}
