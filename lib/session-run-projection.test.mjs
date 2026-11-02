import assert from "node:assert/strict";
import test from "node:test";
import { projectSessionRuns } from "./session-run-projection.ts";
test("live activity does not resurrect unknown or synthesize historical runs", () => {
  const records = [{sessionId:"s",runId:"old",status:"unknown"},{sessionId:"s",runId:"done",status:"completed"}];
  const result = projectSessionRuns(records,"s",true);
  assert.deepEqual(result.runs,records);
  assert.deepEqual(result.currentActivity,{active:true,runId:null});
  assert.equal(records[0].status,"unknown");
});
test("only an actual current run supplies identity, and idle has none", () => {
  const records = [{sessionId:"other",runId:"foreign",status:"running"},{sessionId:"s",runId:"actual",status:"running"}];
  assert.deepEqual(projectSessionRuns(records,"s",true).currentActivity,{active:true,runId:"actual"});
  assert.deepEqual(projectSessionRuns(records,"s",false).currentActivity,{active:false,runId:null});
});
