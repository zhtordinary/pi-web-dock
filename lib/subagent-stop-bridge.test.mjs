import assert from "node:assert/strict";
import test from "node:test";
import { createSubagentStopBridge } from "./subagent-stop-bridge.ts";
function fixture(respond) {
  const handlers = new Map();
  const bridge = createSubagentStopBridge();
  bridge.extension.factory({ events: {
    on(name, fn) { handlers.set(name, fn); return () => handlers.delete(name); },
    emit(name, request) { assert.equal(name, "subagents:rpc:v1:request"); respond(request, handlers); },
  }, on() {} });
  return { bridge, handlers };
}
test("stop uses the public session-scoped RPC without a model prompt", async () => {
  const { bridge, handlers } = fixture((request, handlers) => {
    assert.equal(request.method, "stop"); assert.deepEqual(request.params, { id: "child" });
    handlers.get('subagents:rpc:v1:reply:' + request.requestId)({ version: 1, requestId: request.requestId, success: true, data: { state: "stopping" } });
  });
  await bridge.stop("child"); assert.equal(handlers.size, 0);
});
test("a rejected stop preserves the reason and disposes the reply listener", async () => {
  const { bridge, handlers } = fixture((r, h) => h.get('subagents:rpc:v1:reply:' + r.requestId)({ version: 1, requestId: r.requestId, success: false, error: { message: "foreign owner" } }));
  await assert.rejects(bridge.stop("child"), /foreign owner/); assert.equal(handlers.size, 0);
});
test("shutdown cancels an outstanding control and never resolves it as success", async () => {
  const { bridge, handlers } = fixture(() => {});
  const pending = bridge.stop("child"); bridge.dispose();
  await assert.rejects(pending, /closed/); assert.equal(handlers.size, 0);
});
