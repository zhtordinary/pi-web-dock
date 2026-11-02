import assert from "node:assert/strict";
import test from "node:test";
import { isSessionRecapUsageEntry, readSessionRecap, sessionRecapDisplay } from "./session-recap.ts";

const result = (data) => ({ type: "custom", customType: "session-recap-title:result", data });

test("reads structured recap results and skips coverage-only results", () => {
  assert.deepEqual(readSessionRecap(result({
    recap: "○ 修复会话\n├─ 1.定位问题 ✓\n└─ 2.补测试 ◐",
    title: " 修复会话 ",
    tasks: [{ id: "task-a", title: "定位问题", status: "completed" }, { title: "补  测试\n", status: "unknown" }, { title: " " }],
    completedAt: 42,
    coverageEndEntryId: "covered",
  })), {
    recap: "○ 修复会话\n├─ 1.定位问题 ✓\n└─ 2.补测试 ◐",
    title: "修复会话",
    tasks: [{ title: "定位问题", status: "completed" }, { title: "补 测试", status: "active" }],
    completedAt: 42,
  });
  assert.equal(readSessionRecap(result({ recap: "", title: "", tasks: [], coverageEndEntryId: "covered" })), undefined);
  assert.equal(readSessionRecap({ type: "custom", customType: "session-recap-title:title", data: { title: "首标题" } }), undefined);
  assert.equal(readSessionRecap({ type: "message", message: { role: "user", content: "问题" } }), undefined);
});

test("renders the task flow from title and tasks instead of the stored layout", () => {
  assert.deepEqual(sessionRecapDisplay({
    recap: "stored layout is not parsed",
    title: "修复会话",
    tasks: [
      { title: "定位问题", status: "completed" },
      { title: "等待确认", status: "paused" },
      { title: "上线", status: "blocked" },
      { title: "补测试", status: "active" },
    ],
  }), {
    title: "修复会话",
    taskFlow: ["├─ 1.定位问题 ✓", "├─ 2.等待确认 ○", "├─ 3.上线 ✗", "└─ 4.补测试 ◐"],
    body: "├─ 1.定位问题 ✓\n├─ 2.等待确认 ○\n├─ 3.上线 ✗\n└─ 4.补测试 ◐",
  });
});

test("shows stored text as-is when a result lacks a title or task flow", () => {
  assert.deepEqual(sessionRecapDisplay({ recap: "• 背景：旧格式", title: "旧标题" }), { taskFlow: [], body: "• 背景：旧格式" });
  assert.deepEqual(sessionRecapDisplay({ recap: "○ 无标题\n└─ 1.任务 ◐", tasks: [{ title: "任务", status: "active" }] }), { taskFlow: [], body: "○ 无标题\n└─ 1.任务 ◐" });
  assert.deepEqual(sessionRecapDisplay(undefined), { taskFlow: [], body: "" });
});

test("counts the package's recap, title and repair calls as Recap usage", () => {
  for (const kind of ["recap", "title", "repair"]) {
    assert.equal(isSessionRecapUsageEntry({ type: "custom", customType: "session-recap-title:usage", data: { kind } }), true);
  }
  assert.equal(isSessionRecapUsageEntry({ type: "custom", customType: "other-extension:usage", data: { kind: "recap" } }), true);
  assert.equal(isSessionRecapUsageEntry({ type: "custom", customType: "pi-extension-usage", data: { event: { kind: "suggester" } } }), false);
  assert.equal(isSessionRecapUsageEntry({ type: "message", customType: "session-recap-title:usage" }), false);
});
