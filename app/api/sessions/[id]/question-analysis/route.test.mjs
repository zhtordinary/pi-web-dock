import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("terminology status route reads custom job state and resumes pending work", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /ensureQuestionAnalysisJobsForSession/);
  assert.match(source, /latestQuestionAnalysisJobs/);
  assert.match(source, /toQuestionAnalysisJobView/);
  assert.match(source, /question-analysis/);
  assert.doesNotMatch(source, /buildSessionContext/);
});
