import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionHoverPreview, effectiveUserQuestions, formatUserQuestion, isSubagentWakeMessage, isSubagentWakeText, SESSION_DISPLAY_INPUT_CUSTOM_TYPE, stripHiddenUserQuestion, stripHiddenUserQuestionPreservingWhitespace } from "./session-hover-preview.ts";

test("uses latest structured recap and rpiv-todo snapshot", () => {
  const preview = buildSessionHoverPreview([
    {
      type: "custom",
      customType: "session-recap-title:result",
      data: { title: "旧标题", recap: "○ 旧标题\n└─ 1.旧任务 ✓", tasks: [{ title: "旧任务", status: "completed" }] },
    },
    {
      type: "custom",
      customType: "session-recap-title:result",
      data: { title: "Recap title", recap: "○ Recap title\n└─ 1.写测试 ◐", tasks: [{ id: "task-1", title: "写测试", status: "active" }], completedAt: 5 },
    },
    { type: "custom", customType: "session-recap-title:result", data: { recap: "", title: "", tasks: [] } },
    {
      type: "message",
      message: {
        role: "toolResult",
        toolName: "todo",
        details: {
          nextId: 4,
          tasks: [
            { id: 1, subject: "Done", status: "completed", description: "not shown" },
            { id: 2, subject: "Working", status: "in_progress", activeForm: "writing tests" },
            { id: 3, subject: "Deleted", status: "deleted" },
          ],
        },
      },
    },
  ]);

  assert.deepEqual(preview, {
    recap: { recap: "○ Recap title\n└─ 1.写测试 ◐", title: "Recap title", tasks: [{ title: "写测试", status: "active" }], completedAt: 5 },
    todos: {
      nextId: 4,
      tasks: [
        { id: 1, subject: "Done", status: "completed" },
        { id: 2, subject: "Working", status: "in_progress", activeForm: "writing tests" },
      ],
    },
  });
});

test("returns all effective user questions for lazy section", () => {
  const fullWakePrompt = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
  assert.deepEqual(effectiveUserQuestions([
    { type: "message", message: { role: "user", content: "初始问题" } },
    { type: "message", message: { role: "user", content: "继续" } },
    { type: "message", message: { role: "user", content: fullWakePrompt } },
    { type: "message", message: { role: "user", content: [{ type: "text", text: "最新问题" }] } },
  ]), ["初始问题", "最新问题"]);
  assert.deepEqual(effectiveUserQuestions([{ type: "message", message: { role: "user", content: "继续" } }]), []);
  assert.deepEqual(effectiveUserQuestions([{ type: "message", message: { role: "user", content: fullWakePrompt } }]), []);
});

test("formatUserQuestion strips images, discards blank lines, and limits to 5 lines", () => {
  assert.equal(formatUserQuestion(""), "");
  assert.equal(formatUserQuestion("  \n\n  \n"), "");

  assert.equal(
    formatUserQuestion("![screenshot](https://example.com/img.png)\n这是问题"),
    "这是问题",
  );
  assert.equal(
    formatUserQuestion("[image: 123]\n这是问题"),
    "这是问题",
  );

  const withBlanks = "第1行\n\n第2行\n\n\n第3行\n  \n第4行\n第5行";
  assert.equal(
    formatUserQuestion(withBlanks),
    "第1行\n第2行\n第3行\n第4行\n第5行",
  );

  const sixLines = "第1行\n\n第2行\n第3行\n\n第4行\n第5行\n第6行\n第7行";
  assert.equal(
    formatUserQuestion(sixLines),
    "第1行\n第2行\n第3行\n第4行\n第5行...",
  );
});

test("hides the subagent update bridge text from question previews", () => {
  const fullWakePrompt = "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.";
  assert.equal(stripHiddenUserQuestion("Subagent updates above."), "");
  assert.equal(stripHiddenUserQuestion("Inspect subagent updates above."), "");
  assert.equal(stripHiddenUserQuestion(fullWakePrompt), "");
  assert.equal(stripHiddenUserQuestion(`本次具体要求：${fullWakePrompt}`), "");
  assert.equal(stripHiddenUserQuestion("Subagent updates above.\nactual question"), "actual question");
  assert.equal(stripHiddenUserQuestion(`${fullWakePrompt}\nactual question`), "actual question");
  assert.equal(formatUserQuestion("![context](https://example.com/context.png)\nSubagent updates above."), "");
  assert.equal(formatUserQuestion(`![context](https://example.com/context.png)\n${fullWakePrompt}`), "");
  assert.equal(formatUserQuestion("Subagent updates above.\nactual question"), "actual question");
  assert.equal(formatUserQuestion(`${fullWakePrompt}\nactual question`), "actual question");

  assert.equal(isSubagentWakeText("Subagent updates above."), true);
  assert.equal(isSubagentWakeText("Inspect subagent updates above."), true);
  assert.equal(isSubagentWakeText(fullWakePrompt), true);
  assert.equal(isSubagentWakeText(`本次具体要求：${fullWakePrompt}`), true);
  assert.equal(isSubagentWakeText("普通用户问题"), false);
  assert.equal(isSubagentWakeText("Subagent updates above. 请只检查第二个结果，不要继续执行。"), false);
  assert.equal(stripHiddenUserQuestion("Subagent updates above. 请只检查第二个结果，不要继续执行。"), "Subagent updates above. 请只检查第二个结果，不要继续执行。");
  assert.equal(stripHiddenUserQuestionPreservingWhitespace("    print(1)\n"), "    print(1)\n");
  assert.equal(stripHiddenUserQuestionPreservingWhitespace("Subagent updates above.\n  actual question  "), "  actual question  ");

  assert.equal(isSubagentWakeMessage({ role: "user", content: fullWakePrompt }), true);
  assert.equal(isSubagentWakeMessage({ role: "user", content: [{ type: "text", text: fullWakePrompt }] }), true);
  assert.equal(isSubagentWakeMessage({ role: "user", content: [{ type: "text", text: "Subagent updates above." }, { type: "image", source: { type: "url", url: "https://example.com/image.png" } }] }), false);
  assert.equal(isSubagentWakeMessage({ role: "user", content: "普通用户问题" }), false);
  assert.equal(isSubagentWakeMessage({ role: "assistant", content: fullWakePrompt }), false);
});

test("formats expanded skill input as the slash command the user entered", () => {
  const expanded = `<skill name="review" location="/skills/review/SKILL.md">\nReferences are relative to /skills/review.\n\n${"expanded instructions\n".repeat(20)}</skill>\n\n检查 src/main.ts`;
  assert.equal(formatUserQuestion(expanded), "/skill:review 检查 src/main.ts");
});

test("uses persisted prompt-template input instead of expanded message text", () => {
  assert.deepEqual(effectiveUserQuestions([
    {
      type: "message",
      id: "user-1",
      message: { role: "user", content: "expanded prompt instructions" },
    },
    {
      type: "custom",
      customType: SESSION_DISPLAY_INPUT_CUSTOM_TYPE,
      data: { targetEntryId: "user-1", input: "/review src/main.ts" },
    },
  ]), ["/review src/main.ts"]);
});

test("last todo snapshot wins and an empty snapshot hides the panel", () => {
  const preview = buildSessionHoverPreview([
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 2, tasks: [{ id: 1, subject: "Old", status: "pending" }] } } },
    { type: "message", message: { role: "toolResult", toolName: "todo", details: { nextId: 1, tasks: [] } } },
  ]);
  assert.deepEqual(preview, {});
});
