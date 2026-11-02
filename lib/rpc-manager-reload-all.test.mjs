import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { reloadRpcSessions } = await jiti.import("./rpc-manager.ts");

test("reloadRpcSessions reloads every live runtime without waking cold sessions", async (t) => {
  const previousSessions = globalThis.__piSessions;
  const previousError = console.error;
  const calls = [];
  console.error = () => {};
  globalThis.__piSessions = new Map([
    ["idle", {
      sessionId: "idle",
      isAlive: () => true,
      send: async (command) => { calls.push(["idle", command]); },
    }],
    ["busy", {
      sessionId: "busy",
      isAlive: () => true,
      send: async () => { throw new Error("Cannot reload resources while the session is busy"); },
    }],
    ["cold", {
      sessionId: "cold",
      isAlive: () => false,
      send: async () => { throw new Error("cold runtime must not be touched"); },
    }],
  ]);
  t.after(() => {
    console.error = previousError;
    if (previousSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previousSessions;
  });

  const result = await reloadRpcSessions();

  assert.deepEqual(calls, [["idle", { type: "reload" }]]);
  assert.deepEqual(result, {
    liveSessions: 2,
    reloadedSessions: 1,
    busySessionIds: ["busy"],
    failedSessionIds: [],
  });
});

test("reloadRpcSessions reports a reload failure separately from a busy session", async (t) => {
  const previousSessions = globalThis.__piSessions;
  const previousError = console.error;
  console.error = () => {};
  globalThis.__piSessions = new Map([
    ["failed", {
      sessionId: "failed",
      isAlive: () => true,
      send: async () => { throw new Error("resource loader failed"); },
    }],
  ]);
  t.after(() => {
    console.error = previousError;
    if (previousSessions === undefined) delete globalThis.__piSessions;
    else globalThis.__piSessions = previousSessions;
  });

  assert.deepEqual(await reloadRpcSessions(), {
    liveSessions: 1,
    reloadedSessions: 0,
    busySessionIds: [],
    failedSessionIds: ["failed"],
  });
});
