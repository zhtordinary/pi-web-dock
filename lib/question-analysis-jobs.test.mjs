import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  QUESTION_ANALYSIS_CUSTOM_TYPE,
  QUESTION_DRAFT_CUSTOM_TYPE,
  latestQuestionAnalysisJobs,
  latestQuestionDrafts,
  readQuestionAnalysisJobs,
  toQuestionAnalysisJobView,
  toQuestionDraftView,
  isResumableQuestionAnalysisJob,
} = await jiti.import("./question-analysis-jobs.ts");

function custom(id, data, parentId = null, customType = QUESTION_ANALYSIS_CUSTOM_TYPE) {
  return { type: "custom", id, parentId, timestamp: `2026-01-01T00:00:0${id}.000Z`, customType, data };
}

const pending = {
  version: 1,
  jobId: "job-1",
  targetEntryId: "user-1",
  status: "pending",
  question: "如何描述这个缓存问题？",
  mode: "context",
  model: { provider: "openai", modelId: "gpt-test" },
  priorContext: "[已有会话摘要]",
  context: { source: "existing-summary", summaryChars: 8, recentChars: 0, recentMessages: 0 },
  requestedAt: 10,
};

test("merges append-only terminology job states and hides private input from browser view", () => {
  const entries = [
    custom("1", pending),
    custom("2", { version: 1, jobId: "job-1", targetEntryId: "user-1", status: "running", startedAt: 20 }, "1"),
    custom("3", {
      version: 1,
      jobId: "job-1",
      targetEntryId: "user-1",
      status: "completed",
      completedAt: 30,
      result: { text: "- **缓存击穿**：……", context: { mode: "context", source: "existing-summary" } },
    }, "2"),
  ];
  const jobs = readQuestionAnalysisJobs(entries);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "completed");
  assert.equal(jobs[0].question, pending.question);
  assert.equal(latestQuestionAnalysisJobs(entries, new Set(["user-1"]))[0].jobId, "job-1");

  const view = toQuestionAnalysisJobView(jobs[0]);
  assert.equal(view.status, "completed");
  assert.equal(view.targetEntryId, "user-1");
  assert.equal("question" in view, false);
  assert.equal("priorContext" in view, false);
  assert.equal(view.result.text, "- **缓存击穿**：……");
});

test("latest job wins when user retries same saved question", () => {
  const entries = [
    custom("1", pending),
    custom("2", {
      ...pending,
      jobId: "job-2",
      requestedAt: 40,
      status: "pending",
    }, "1"),
  ];
  const jobs = latestQuestionAnalysisJobs(entries, new Set(["user-1"]));
  assert.deepEqual(jobs.map((job) => job.jobId), ["job-2"]);
});


test("reads composer draft snapshots and keeps the latest per target entry", () => {
  const entries = [
    custom("1", { version: 1, jobId: "job-1", targetEntryId: "user-1", requestedAt: 10, result: { text: "- **缓存击穿**：……" } }, null, QUESTION_DRAFT_CUSTOM_TYPE),
    custom("2", { version: 1, jobId: "job-2", targetEntryId: "user-1", requestedAt: 20, result: { text: "- **缓存穿透**：……" }, rewrite: { text: "如何描述缓存击穿问题？" } }, "1", QUESTION_DRAFT_CUSTOM_TYPE),
    custom("3", { version: 1, jobId: "job-3", targetEntryId: "user-2", requestedAt: 30, result: { text: "- **术语X**：……" } }, null, QUESTION_DRAFT_CUSTOM_TYPE),
  ];
  const drafts = latestQuestionDrafts(entries);
  assert.equal(drafts.length, 2);
  const forUser1 = drafts.find((d) => d.targetEntryId === "user-1");
  assert.equal(forUser1.jobId, "job-2");
  assert.equal(forUser1.rewrite.text, "如何描述缓存击穿问题？");
  const view = toQuestionDraftView(forUser1);
  assert.equal(view.targetEntryId, "user-1");
  assert.equal(view.result.text, "- **缓存穿透**：……");
  assert.equal(view.rewrite.text, "如何描述缓存击穿问题？");
  const scoped = latestQuestionDrafts(entries, new Set(["user-2"]));
  assert.equal(scoped.length, 1);
  assert.equal(scoped[0].targetEntryId, "user-2");
});


test("only pending question-analysis jobs auto-resume after process loss", () => {
  const base = {
    jobId: "job-resume",
    targetEntryId: "user-1",
    question: "question",
    mode: "question",
    model: { provider: "openai", modelId: "gpt-test" },
    priorContext: "",
    context: { source: "none", summaryChars: 0, recentChars: 0, recentMessages: 0 },
    requestedAt: 1,
  };
  assert.equal(isResumableQuestionAnalysisJob({ ...base, status: "pending" }), true);
  assert.equal(isResumableQuestionAnalysisJob({ ...base, status: "running", startedAt: 2 }), false);
  assert.equal(isResumableQuestionAnalysisJob({ ...base, status: "completed", completedAt: 3, result: { text: "done" } }), false);
  assert.equal(isResumableQuestionAnalysisJob({ ...base, status: "failed", completedAt: 3, error: "failed" }), false);
});
