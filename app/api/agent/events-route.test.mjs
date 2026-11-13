import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const agentEventsSource = await readFile(new URL("./[id]/events/route.ts", import.meta.url), "utf8");
const agentEventStreamSource = await readFile(new URL("../../../lib/agent-event-stream.ts", import.meta.url), "utf8");

test("agent SSE observes persisted files and live wrappers without initializing and disables buffering", () => {
  assert.match(agentEventsSource, /createAgentEventStream\(req, id, Promise\.resolve\(session\), sessionFile \|\| undefined, \(publish\) => \{/);
  assert.match(agentEventsSource, /subscribeWaitingUserRequests/);
  assert.match(agentEventsSource, /assertRpcSessionRuntimeBinding\(live\)/);
  assert.match(agentEventsSource, /resolveSessionPathReadOnly\(id\)/);
  assert.doesNotMatch(agentEventsSource, /startRpcSession/);
  assert.match(agentEventsSource, /if \(req\.signal\.aborted\) return new Response\(null, \{ status: 204 \}\)/);
  assert.match(agentEventsSource, /"Cache-Control": "no-cache, no-transform"/);
  assert.match(agentEventsSource, /"X-Accel-Buffering": "no"/);
  assert.match(agentEventsSource, /holderValue === "foreground" \|\| holderValue === "background"/);
  assert.doesNotMatch(agentEventsSource, /\[A-Za-z0-9\._:-\]\{1,64\}/);
});

test("agent SSE reuses one TextEncoder per stream", () => {
  assert.equal((agentEventStreamSource.match(/new TextEncoder\(\)/g) ?? []).length, 1);
  assert.match(agentEventStreamSource, /controller\.enqueue\(encoder\.encode\(/);
});
