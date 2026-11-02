import assert from "node:assert/strict";
import test from "node:test";
import { isContinuationPrompt } from "./user-question.ts";

test("recognizes continuation prompts", () => {
  assert.equal(isContinuationPrompt("继续"), true);
  assert.equal(isContinuationPrompt("继续检查共享请求"), false);
  assert.equal(isContinuationPrompt("好，修复登录"), false);
  assert.equal(isContinuationPrompt("完成报告"), false);
  assert.equal(isContinuationPrompt("好的，继续检查数据库"), true);
  assert.equal(isContinuationPrompt("检查共享请求"), false);
  assert.equal(isContinuationPrompt("Subagent updates above."), true);
  assert.equal(isContinuationPrompt("Inspect subagent updates above."), true);
  assert.equal(isContinuationPrompt("Inspect subagent updates above. Answer pending supervisor requests within your authority."), true);
});
