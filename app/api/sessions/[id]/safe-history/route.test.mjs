import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const reader = await readFile(new URL("../../../../../lib/reader-safe-history.ts", import.meta.url), "utf8");

test("safe history uses the read-only Reader path and never rehydrates a runtime", () => {
  assert.match(route, /readSafeSessionHistory/);
  assert.match(route, /runtimeStartAttempted: false/);
  assert.match(route, /writeSideEffects: false/);
  assert.doesNotMatch(route, /startRpcSession/);
  assert.doesNotMatch(reader, /ensureQuestionAnalysisJobsForSession/);
  assert.doesNotMatch(reader, /startRpcSession/);
  assert.match(reader, /resolveSessionPathReadOnly/);
  assert.match(reader, /getSessionReadSnapshot/);
  assert.match(reader, /const liveSessionManager = liveRpc\?\.inner\?\.sessionManager;/);
  assert.match(reader, /liveSessionManager\?\.getSessionFile\?\.\(\)/);
  assert.match(reader, /resolveSafeHistorySource/);
  assert.match(reader, /sessionFilePath: source\.sessionFilePath/);
  assert.match(reader, /liveRpc\?\.inner\.sessionManager\.getEntries\(\) \?\? snapshot\?\.entries/);
  assert.match(reader, /durableOnly: !liveRpc/);
  assert.doesNotMatch(reader, /listAllSessions\(/);
  assert.doesNotMatch(reader, /listArchivedSessions\(/);
  assert.match(reader, /durableOnly/);
});

test("safe history is bounded and redacted", () => {
  assert.match(route, /maxBytes/);
  assert.match(reader, /MAX_BYTES/);
  assert.match(reader, /fitMessageToByteBudget/);
  assert.match(reader, /truncated \|\| messages\.length/);
  assert.match(reader, /redactLiveValue/);
  assert.match(reader, /maxEntries/);
});
