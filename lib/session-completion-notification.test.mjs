import assert from "node:assert/strict";
import test from "node:test";

const { sessionCompletionTag } = await import("./session-completion-notification.ts");

test("completion deduplication requires device, session and run identity", () => {
  assert.equal(sessionCompletionTag({ deviceId: "device-1", sessionId: "session-1", runId: "run-1" }), "pi-session-complete:device-1:session-1:run-1");
  assert.equal(sessionCompletionTag({ deviceId: "device-1", sessionId: "session-1", runId: "run-2" }), "pi-session-complete:device-1:session-1:run-2");
  assert.equal(sessionCompletionTag({ deviceId: "device-2", sessionId: "session-1", runId: "run-1" }), "pi-session-complete:device-2:session-1:run-1");
  for (const identity of [
    {},
    { deviceId: "device-1", sessionId: "session-1" },
    { deviceId: "device-1", runId: "run-1" },
    { sessionId: "session-1", runId: "run-1" },
  ]) assert.equal(sessionCompletionTag(identity), undefined);
});

test("completion tag escapes identity delimiters", () => {
  assert.equal(sessionCompletionTag({ deviceId: "device/1", sessionId: "session:1", runId: "run 1" }), "pi-session-complete:device%2F1:session%3A1:run%201");
});
