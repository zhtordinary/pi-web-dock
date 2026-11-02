import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
const files = await Promise.all([
  readFile(new URL("./route.ts", import.meta.url), "utf8"),
  readFile(new URL("./events/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./wake/route.ts", import.meta.url), "utf8"),
  readFile(new URL("./peer/route.ts", import.meta.url), "utf8"),
]);
test("session-control routes share security gates and persistent state", () => {
  const [main, events, wake, peer] = files;
  assert.match(main, /isApiRequestAllowed/); assert.match(main, /hasJsonContentType/); assert.match(main, /readAggregatedSessionWaitStatus/); assert.match(main, /scope.*all/); assert.match(main, /createHandoffPlan/); assert.match(main, /transitionPersistentWait/); assert.match(main, /report/);
  assert.match(events, /withRead/); assert.match(events, /nextCursor/);
  assert.match(wake, /completePullReceipt/); assert.doesNotMatch(wake, /applyPersistentEvent/);
  assert.match(peer, /acceptSessionControlEnvelope/); assert.match(peer, /queueAuthorizedSessionWake/); assert.match(peer, /completeInbox/); assert.match(peer, /pull_messages/);
});
