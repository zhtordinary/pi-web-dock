import assert from "node:assert/strict";
import test from "node:test";
import { controlSiblingSession, readSiblingExecution } from "./session-channel-control.ts";
const originalFetch = globalThis.fetch, originalPort = process.env.PI_WEB_BOUND_PORT;
test.after(() => { globalThis.fetch = originalFetch; if (originalPort === undefined) delete process.env.PI_WEB_BOUND_PORT; else process.env.PI_WEB_BOUND_PORT = originalPort; });
test("sibling control only uses the paired loopback port and bounded local scope", async () => {
  process.env.PI_WEB_BOUND_PORT = "30141";
  globalThis.fetch = async (url, options) => {
    assert.equal(url, "http://127.0.0.1:30142/api/sessions/a%2Fb/stop?local=1");
    assert.equal(options.redirect, "error"); assert.equal(options.method, "POST");
    return Response.json({ protocol: 1, sessionId: "a/b", stopped: true });
  };
  assert.equal((await controlSiblingSession("a/b", "stop")).stopped, true);
});
test("unconfigured channels do not guess another server", async () => {
  delete process.env.PI_WEB_BOUND_PORT;
  globalThis.fetch = async () => { throw new Error("must not fetch"); };
  assert.equal(await controlSiblingSession("a", "shutdown"), null);
});
test("only connection refusal establishes absence; timeouts and wrong identities stay errors", async () => {
  process.env.PI_WEB_BOUND_PORT = "30142";
  globalThis.fetch = async () => { throw Object.assign(new Error("refused"), { cause: { code: "ECONNREFUSED" } }); };
  assert.equal(await controlSiblingSession("a", "shutdown"), null);
  globalThis.fetch = async () => { throw new Error("timeout"); };
  await assert.rejects(controlSiblingSession("a", "shutdown"), /could not be confirmed/);
  globalThis.fetch = async () => Response.json({ protocol: 1, sessionId: "foreign", ok: true });
  await assert.rejects(controlSiblingSession("a", "shutdown"), /compatible/);
});
test("an HTTP acknowledgement without successful closure is not shutdown proof", async () => {
  process.env.PI_WEB_BOUND_PORT = "30142";
  for (const ok of [false, undefined]) {
    globalThis.fetch = async () => Response.json({ protocol: 1, sessionId: "a", ok });
    await assert.rejects(controlSiblingSession("a", "shutdown"), /not confirmed/);
  }
});
test("read-only observation tolerates the legacy running-session snapshot", async () => {
  process.env.PI_WEB_BOUND_PORT = "30142";
  globalThis.fetch = async () => Response.json({ sessionListVersion: 1, runningSessionIds: ["legacy"] });
  const snapshot = await readSiblingExecution();
  assert.equal(snapshot.complete, false);
  assert.deepEqual(snapshot.execution.legacy, { parentActive: true, retrying: false, unattended: false, backgroundRunIds: [], queuedCount: 0, active: true });
});
test("read-only observation degrades to an incomplete snapshot on timeout", async () => {
  process.env.PI_WEB_BOUND_PORT = "30142";
  globalThis.fetch = async () => { throw new Error("timeout"); };
  assert.deepEqual(await readSiblingExecution(), { execution: {}, complete: false });
});
