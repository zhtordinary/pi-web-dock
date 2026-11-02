import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
import test from "node:test";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const { decorateSessionWaitSnapshot } = await jiti.import("./session-wait-aggregate.ts");
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs");

test("aggregated wait snapshots retain the state owner for display and controls", () => {
  const source = { deviceId: "macmini", deviceName: "Mac Mini", local: false, online: true };
  const snapshot = decorateSessionWaitSnapshot({
    waits: [{ id: "wait-1", status: "waiting" }],
    plans: [{ id: "plan-1", status: "waiting" }],
    notifications: [{ id: "notice-1", reason: "offline" }],
    worker: { health: { status: "idle" } },
  }, source);
  assert.deepEqual(snapshot.waits[0].source, source);
  assert.deepEqual(snapshot.plans[0].source, source);
  assert.deepEqual(snapshot.notifications[0].source, source);
  assert.deepEqual(snapshot.worker, { health: { status: "idle" } });
});

test("aggregate status includes local and configured peer waits with distinct control sources", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "session-wait-aggregate-"));
  const previous = {
    root: process.env.PI_WEB_SESSION_WAIT_STATE_ROOT,
    channel: process.env.PI_WEB_SESSION_WAIT_CHANNEL,
    device: process.env.PI_WEB_DEVICE_ID,
    config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG,
  };
  process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = root;
  process.env.PI_WEB_SESSION_WAIT_CHANNEL = "reader";
  process.env.PI_WEB_DEVICE_ID = "local";
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({
    device: { id: "local", name: "Local" },
    peers: [{ id: "macmini", name: "Mac Mini", url: "http://macmini.test" }],
  });
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    for (const [key, value] of Object.entries({
      PI_WEB_SESSION_WAIT_STATE_ROOT: previous.root,
      PI_WEB_SESSION_WAIT_CHANNEL: previous.channel,
      PI_WEB_DEVICE_ID: previous.device,
      PI_WEB_SESSION_ACTIVITY_CONFIG: previous.config,
    })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  core.createWait(root, "reader", {
    id: "local-wait",
    owner: { deviceId: "local", sessionId: "owner" },
    target: { deviceId: "local", sessionId: "target" },
    condition: "turn_settled",
  });
  const { readAggregatedSessionWaitStatus } = await jiti.import("./session-wait-aggregate.ts");
  const result = await readAggregatedSessionWaitStatus(async (url) => {
    assert.equal(String(url), "http://macmini.test/api/session-control");
    return new Response(JSON.stringify({
      waits: [{ id: "peer-wait", status: "waiting", condition: "task_completed", owner: { deviceId: "local", sessionId: "owner" }, target: { deviceId: "macmini", sessionId: "remote-target", title: "过期名字" } }],
      sessionTitles: { "remote-target": "远程回归验证" },
      plans: [],
      notifications: [],
      worker: { health: { status: "idle" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  assert.equal(result.waits.length, 2);
  assert.equal(result.waits.find((wait) => wait.id === "peer-wait").source.deviceId, "macmini");
  assert.equal(result.waits.find((wait) => wait.id === "local-wait").source.local, true);
  const relation = result.waits.find(wait => wait.id === "peer-wait");
  assert.equal(relation.target.title, "远程回归验证");
  assert.equal(relation.target.deviceName, "Mac Mini");
  assert.equal(relation.owner.deviceName, "Local");
});
