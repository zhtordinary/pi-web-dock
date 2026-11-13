import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { installEnglishTestLocale, markupText, testTranslator } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  fsCache: false,
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const en = testTranslator("en");
const {
  AssistantMessageHeader,
  MessageView,
  TurnResourcesPanel,
  getEditNavigationEntryId,
  getTokenEstimateText,
  getToolCallInputText,
  replaceUserMessageText,
} = await jiti.import("./MessageView.tsx");
const { scrollSessionSearchTarget } = await jiti.import("../lib/session-search-dom.ts");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function renderMessage(message, props = {}) {
  return renderToStaticMarkup(
    React.createElement(
      I18nProvider,
      null,
      React.createElement(MessageView, { message, ...props }),
    ),
  );
}

test("streaming headers keep a stable line and only show non-empty metrics", () => {
  const renderHeader = (props) => renderToStaticMarkup(React.createElement(
    I18nProvider, null, React.createElement(AssistantMessageHeader, { modelName: "Test Model", ...props }),
  ));
  for (const props of [{}, { estimatedTokens: 0, tps: 20 }]) {
    const html = renderHeader(props);
    assert.match(html, />Test Model<\/span>/);
    assert.doesNotMatch(html, /t\/s|Estimated token count while streaming/);
  }
  const tokensOnly = renderHeader({ estimatedTokens: 100 });
  assert.match(tokensOnly, />100<\/span>/);
  assert.doesNotMatch(tokensOnly, /t\/s/);
  const streaming = renderHeader({ estimatedTokens: 1234567, tps: 12345.6 });
  assert.match(streaming, />1234567<\/span>/);
  assert.match(streaming, /12345\.6 t\/s/);

  const message = { role: "assistant", provider: "test", model: "model", content: [{ type: "text", text: "Response" }] };
  assert.doesNotMatch(renderMessage(message), /Estimated token count while streaming/);
  assert.match(renderMessage(message, { isStreaming: true }), /Estimated token count while streaming/);
});

test("marks visible user and assistant text for session search", () => {
  const userHtml = renderMessage({ role: "user", content: "visible user text" });
  const assistantHtml = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "visible assistant text" }],
  });
  assert.match(userHtml, /data-session-searchable="true"/);
  assert.match(assistantHtml, /data-session-searchable="true"/);
});

test("user messages show HTML literally without changing assistant markdown", () => {
  const user = renderMessage({ role: "user", content: '<div style="display:none">visible</div>\n<script>no()</script>' });
  assert.match(user, /&lt;div style=/);
  assert.match(user, /visible/);
  assert.match(user, /&lt;script&gt;no\(\)&lt;\/script&gt;/);
  assert.doesNotMatch(user, /<script|<div style="display:none"/);
  const assistant = renderMessage({ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "<b>formatted</b>" }] });
  assert.match(assistant, /<b>formatted<\/b>/);
});

test("a pathless tool labels a single successful result patch without guessing multiple files", () => {
  const block = { type: "toolCall", toolCallId: "anchor-edit", toolName: "insert", input: { anchor: "abc" } };
  const patch = (file) => `--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-old\n+new\n`;
  const render = (diff, changes = {}) => renderMessage({ role: "assistant", provider: "test", model: "test", content: [{ ...block, ...changes }] }, {
    toolResults: diff ? new Map([[block.toolCallId, { role: "toolResult", toolCallId: block.toolCallId, content: [], details: { patch: diff } }]]) : new Map(),
  });
  assert.match(render(patch("src/example.ts")), />src\/example\.ts</);
  assert.match(render(undefined), />abc</);
  assert.match(render(patch("one") + patch("two")), />abc</);
  assert.match(render(patch("src/example.ts"), { input: { path: "given.ts" } }), />given\.ts</);
});

test("excludes markdown chrome and oversized reveal prompts from session search", () => {
  const codeHtml = renderMessage({ role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "```ts\nvisible code text\n```" }] });
  assert.match(codeHtml, /class="markdown-code-header"/);
  assert.match(codeHtml, /data-session-search-exclude="true"/);
  assert.match(codeHtml, /Copy/);
  const largeHtml = renderMessage({ role: "assistant", provider: "test", model: "test-model", content: [{ type: "text", text: "x".repeat(100_001) }] });
  assert.match(largeHtml, /data-session-search-exclude="true"/);
});

test("keeps skill body outside the session-find surface", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="demo" location="/tmp/demo">\nReferences are relative to /tmp/demo.\n\nhidden body needle\n</skill>',
  });
  assert.match(html, /\/skill:demo/);
  assert.doesNotMatch(html, /hidden body needle/);
});

test("does not mark compaction metadata as session-searchable text", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: "compaction summary",
    display: true,
  });
  assert.doesNotMatch(html, /data-session-searchable="true"/);
});

test("reveals nested scrollports before navigating a session-search match", () => {
  const calls = [];
  const transcript = { parentElement: null, clientHeight: 400 };
  const row = {
    parentElement: transcript,
    scrollIntoView: (options) => calls.push(options),
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  };
  const scrollport = {
    parentElement: row,
    style: { overflowY: "auto" },
    scrollTop: 0,
    scrollHeight: 500,
    clientHeight: 100,
    getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
  };
  const mark = {
    parentElement: scrollport,
    getBoundingClientRect: () => ({ top: 160, bottom: 180, height: 20 }),
    closest: (selector) => selector === "[data-chat-message-row]" ? row : null,
  };
  scrollSessionSearchTarget(mark, transcript, (element, offset) => calls.push({ element, offset }));
  assert.deepEqual(calls, [{ element: mark, offset: 190 }]);
  assert.equal(scrollport.scrollTop, 88);
});

test("scrolls mark directly into view when available without duplicate scrollBy conflict", () => {
  const markCalls = [];
  const transcriptCalls = [];
  const transcript = {
    parentElement: null, clientHeight: 400,
    getBoundingClientRect: () => ({ top: 0, bottom: 400, height: 400 }),
    scrollBy: (options) => transcriptCalls.push(options),
  };
  const row = { parentElement: transcript };
  const mark = {
    parentElement: row,
    scrollIntoView: (options) => markCalls.push(options),
    getBoundingClientRect: () => ({ top: 100, bottom: 120, height: 20 }),
    closest: (selector) => selector === "[data-chat-message-row]" ? row : null,
  };
  const ownerCalls = [];
  scrollSessionSearchTarget(mark, transcript, (element, offset) => ownerCalls.push({ element, offset }));
  assert.deepEqual(ownerCalls, [{ element: mark, offset: 190 }]);
  assert.deepEqual(markCalls, []);
  assert.equal(transcriptCalls.length, 0);
});

test("shows context size and ratio on compaction markers", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
    details: { tokensBefore: 12_800 },
  }, {
    compactionContext: { tokensBefore: 12_800, contextWindow: 16_000, provider: "provider", model: "small" },
  });

  assert.match(html, /12\.8K/);
  assert.match(html, /16K/);
  assert.match(html, /80\.0%/);
  assert.match(html, /provider\/small/);
});

test("keeps compaction context tokens visible when window is unknown", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: "summary",
    display: true,
    details: { tokensBefore: 1234 },
  });

  assert.match(html, /Context before compaction[^<]*1\.2K Token/);
  assert.doesNotMatch(html, /%/);
});

test("keeps streamed tool input out of collapsed markup while counting it", () => {
  const block = {
    type: "toolCall",
    toolCallId: "call-write-1",
    toolName: "write",
    input: {},
    rawInput: '{"path":"/tmp/file","content":"secret-stream-fragment',
  };
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { isStreaming: true });

  assert.match(html, /write/);
  assert.match(html, /(Generating parameters|正在生成参数)/);
  assert.doesNotMatch(html, /secret-stream-fragment/);
  assert.equal(getToolCallInputText(block), block.rawInput);
  assert.equal(getTokenEstimateText(block), block.rawInput);
});

const COMPLETE_SKILL_EXPANSION = `<skill name="review" location="/skills/review/SKILL.md">
References are relative to /skills/review.

Review the supplied files.
</skill>

src/main.ts`;

test("renders a provider error when the assistant message has no content", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [],
    stopReason: "error",
    errorMessage: "OpenAI API error (403): <html>request forbidden</html>",
  });

  assert.match(html, /role="alert"/);
  assert.match(html, /Error: OpenAI API error \(403\)/);
  assert.match(html, /&lt;html&gt;request forbidden&lt;\/html&gt;/);
});

test("renders partial assistant content before the provider error", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Partial response" }],
    stopReason: "error",
    errorMessage: "Connection closed",
  });

  assert.match(html, /Partial response/);
  assert.match(html, /Error: Connection closed/);
});

test("does not append provider error after an image answer was delivered", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [
      { type: "text", text: "![poster](https://example.com/poster.png)" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    stopReason: "error",
    errorMessage: "Request timed out.",
  });

  assert.match(html, /<img[^>]+src="https:\/\/example\.com\/poster\.png"/);
  assert.doesNotMatch(html, /Error: Request timed out\./);
});


test("deduplicates repeated assistant image references", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{
      type: "text",
      text: "![first](https://example.com/poster.png)\n\n说明\n\n![duplicate](https://example.com/poster.png)",
    }],
  });

  assert.equal((html.match(/<img /g) ?? []).length, 1);
});


test("routes remote assistant markdown images through the session peer", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "![poster](/Volumes/project/Pictures/poster.png)" }],
  }, {
    cwd: "/Volumes/project",
    sessionId: "550e8400-e29b-41d4-a716-446655440000",
    remotePeer: "mac mini",
  });

  assert.match(
    html,
    /<img src="\/api\/remote\/files\/Volumes\/project\/Pictures\/poster\.png\?type=read&amp;sessionId=550e8400-e29b-41d4-a716-446655440000&amp;peer=mac%20mini"/,
  );
});

test("renders assistant cache hit rate instead of raw token counts", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Done" }],
    usage: {
      input: 1_640_791,
      output: 29_912,
      cacheRead: 17_857_024,
      cacheWrite: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
  });

  assert.match(html, /Cache hit rate 91\.6%/);
  assert.doesNotMatch(html, /1\.64M in|29\.9K out|17\.9M cache R/);
});

test("shows turn cache hit rate and keeps the shared calculated cost", () => {
  const html = renderMessage({ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "Done" }] }, {
    turnUsage: { input: 20, output: 500, cacheRead: 70, cacheWrite: 10, cost: { total: 9 }, costAvailable: true },
    calculatedCost: 0.1234,
  });
  assert.match(html, /Cache hit rate 70\.0% · \$0\.1234/);
});

test("cache footer distinguishes zero hits from missing prompt token usage", () => {
  const message = { role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "Done" }] };
  const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  assert.match(renderMessage({ ...message, usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost } }), /Cache hit rate 0\.0%/);
  assert.match(renderMessage({ ...message, usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0, cost } }), /Cache hit rate unavailable/);
});

test("completed turn resource button has no runtime-list fallback and stays off streaming messages", () => {
  const message = { role: "assistant", provider: "test", model: "test", content: [{ type: "text", text: "Done" }] };
  const turnResources = { tools: [], nestedTools: [], omittedNestedCalls: 0, skills: [], plugins: [] };
  assert.match(renderMessage(message, { turnResources }), /data-turn-resources-toggle="true"[^>]*aria-expanded="false"/);
  assert.match(renderMessage(message, { turnResources }), /Tools, Skill and plugin information/);
  assert.doesNotMatch(renderMessage(message), /data-turn-resources-toggle/);
  assert.doesNotMatch(renderMessage(message, { turnResources, isStreaming: true }), /data-turn-resources-toggle/);
});

test("resource details render transcript counts, paths, nested omissions, plugin calls, and empty-record labels", () => {
  const html = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(TurnResourcesPanel, { resources: {
    tools: [{ name: "read", count: 2 }, { name: "codemode", count: 1 }],
    nestedTools: [{ name: "bash", count: 2 }], omittedNestedCalls: 1,
    skills: [{ name: "review", path: "/skills/review/SKILL.md", count: 1 }],
    plugins: [{ name: "pi-plan-mode", source: "npm:@narumitw/pi-plan-mode@0.59.2", path: "/plugin/pi-plan-mode/index.ts", count: 2, tools: [{ name: "plan_mode_question", count: 1 }, { name: "plan_mode_complete", count: 1 }] }],
  } })));
  assert.ok(html.indexOf("This turn only.") < html.indexOf("Tool calls: 3"), "evidence is shown before resource counts");
  assert.doesNotMatch(html, /Tool counts include failed calls|Skill counts include|Internal lifecycle state writes/);
  assert.match(html, /display:flex;flex-wrap:wrap/);
  assert.match(html, /Tool calls: 3/);
  assert.match(html, /read × 2/);
  assert.match(html, /Recorded codemode calls: 2/);
  assert.match(html, /1 earlier codemode calls/);
  assert.match(html, /Skill loads: 1/);
  assert.match(html, /Plugin calls: 2/);
  assert.match(html, /pi-plan-mode × 2/);
  assert.match(html, /plan_mode_question × 1, plan_mode_complete × 1/);
  assert.match(html, /review × 1/);
  assert.match(html, /\/skills\/review\/SKILL\.md/);
  assert.match(html, /review × 1<span[^>]*> · \/skills\/review\/SKILL\.md<\/span><\/li>/);
  assert.doesNotMatch(html, /review × 1<\/li>/);
  assert.match(html, /data-session-search-exclude="true"/);
  const empty = renderToStaticMarkup(React.createElement(I18nProvider, null, React.createElement(TurnResourcesPanel, { resources: { tools: [], nestedTools: [], omittedNestedCalls: 0, skills: [], plugins: [] } })));
  assert.match(empty, /No tool calls recorded/);
  assert.doesNotMatch(empty, /No Skill loads recorded/);
  assert.doesNotMatch(empty, /No plugin calls recorded/);
});

test("renders a queued user message at its persisted entry time", () => {
  const queuedAt = Date.UTC(2026, 0, 1, 0, 1, 40);
  const html = renderMessage({
    role: "user",
    content: "queued question",
    timestamp: Date.UTC(2026, 0, 1, 0, 0, 0),
    displayTimestamp: queuedAt,
  });
  const expected = new Date(queuedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  assert.match(html, new RegExp(escaped));
});

test("renders the response duration beside the assistant timestamp", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Done" }],
    timestamp: Date.UTC(2026, 0, 1, 0, 0, 12),
  }, { responseDurationMs: 12_400, showTimestamp: true });

  assert.match(html, /(?:Response time|回答耗时) 12s/);
});

test("renders turn model response share instead of final model duration", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Done" }],
    timestamp: 1_000,
    entryTimestamp: 37_000,
  }, { responseDurationMs: 62_000, modelWaitPercent: (61 / 62) * 100 });

  assert.match(html, /(?:Model response share|模型响应占比) 98\.4%/);
  assert.doesNotMatch(html, /(?:Model response time|模型响应耗时) 36s/);
});

test("uses persisted boundaries without repeating thinking time or tagging read with model wait", () => {
  const assistantStart = 1789306179105;
  const assistantEnd = Date.parse("2026-09-13T13:30:04.216Z");
  const toolEnd = Date.parse("2026-09-13T13:30:05.144Z");
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: assistantStart,
    entryTimestamp: assistantEnd,
    content: [
      { type: "thinking", thinking: "first" },
      { type: "thinking", thinking: "second" },
      { type: "toolCall", toolCallId: "call-a", toolName: "read", input: {} },
    ],
  }, {
    toolResults: new Map([
      ["call-a", {
        role: "toolResult",
        toolCallId: "call-a",
        timestamp: 1789306205144,
        entryTimestamp: toolEnd,
        content: [{ type: "text", text: "ok" }],
      }],
      ["other-round", {
        role: "toolResult",
        toolCallId: "other-round",
        timestamp: 1789306206000,
        entryTimestamp: Date.parse("2026-09-13T13:30:06.000Z"),
        content: [{ type: "text", text: "unrelated" }],
      }],
    ]),
  });

  assert.equal((html.match(/(?:Model response time|模型响应耗时)/g) ?? []).length, 1);
  assert.match(html, /(?:Model response time|模型响应耗时) 25s/);
  assert.match(html, /style="display:flex;align-items:center;gap:8px;margin-left:auto;flex-shrink:0;font-size:11px;color:var\(--text-dim\);font-variant-numeric:tabular-nums"/);
  assert.match(html, /(?:tool batch|工具批次耗时) 0\.9s/);
  assert.doesNotMatch(html, />25s<\/span>/);
  assert.doesNotMatch(html, />26s<\/span>/);
});

test("shows a serial tool batch once instead of cumulative per-tool durations", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 0,
    entryTimestamp: 25_000,
    content: [
      { type: "toolCall", toolCallId: "call-a", toolName: "read", input: {} },
      { type: "toolCall", toolCallId: "call-b", toolName: "bash", input: {} },
    ],
  }, {
    toolResults: new Map([
      ["call-a", { role: "toolResult", toolCallId: "call-a", entryTimestamp: 26_000, content: [] }],
      ["call-b", { role: "toolResult", toolCallId: "call-b", entryTimestamp: 28_000, content: [] }],
    ]),
  });

  assert.equal((html.match(/(?:tool batch|工具批次耗时) 3\.0s/g) ?? []).length, 1);
  assert.doesNotMatch(html, /(?:tool batch|工具批次耗时) 1\.0s/);
  assert.doesNotMatch(html, /(?:tool batch|工具批次耗时) 2\.0s/);
});

test("keeps parallel tool results in persisted order for one wall-clock batch", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 0,
    entryTimestamp: 25_000,
    content: [
      { type: "toolCall", toolCallId: "call-a", toolName: "read", input: {} },
      { type: "toolCall", toolCallId: "call-b", toolName: "read", input: {} },
    ],
  }, {
    toolResults: new Map([
      ["call-b", { role: "toolResult", toolCallId: "call-b", entryTimestamp: 26_000, content: [] }],
      ["call-a", { role: "toolResult", toolCallId: "call-a", entryTimestamp: 28_000, content: [] }],
    ]),
  });

  assert.equal((html.match(/(?:tool batch|工具批次耗时) 3\.0s/g) ?? []).length, 1);
});

test("hides timing when persisted boundaries are missing or reversed", () => {
  const html = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    timestamp: 2_000,
    entryTimestamp: 1_000,
    content: [
      { type: "thinking", thinking: "reasoning" },
      { type: "toolCall", toolCallId: "call-bad", toolName: "read", input: {} },
    ],
  }, {
    toolResults: new Map([
      ["call-bad", {
        role: "toolResult",
        toolCallId: "call-bad",
        timestamp: 3_000,
        entryTimestamp: 900,
        content: [{ type: "text", text: "bad" }],
      }],
    ]),
  });

  assert.doesNotMatch(html, />1s<\/span>/);
  assert.doesNotMatch(html, /(?:NaN|Infinity|-1)s/);
});

test("shows the current assistant timestamp while streaming", () => {
  const timestamp = Date.now();
  const expected = new Date(timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  const escaped = expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const html = renderMessage({
    role: "assistant",
    provider: "openai",
    model: "gpt-test",
    content: [{ type: "text", text: "Streaming" }],
    timestamp,
  }, { isStreaming: true, showTimestamp: true });

  assert.match(html, new RegExp(escaped));
});

test("renders a complete SDK skill expansion as a compact command", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION,
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /Review the supplied files/);
});

test("does not collapse incomplete skill-looking user text", () => {
  const html = renderMessage({
    role: "user",
    content: '<skill name="review" location="/skills/review/SKILL.md">\nordinary user text',
  });

  assert.match(html, /ordinary user text/);
  assert.doesNotMatch(html, /aria-expanded/);
});

test("shows every line of pasted plain text in a user message (#680)", () => {
  const lines = [
    "第1题（看门狗）",
    "嵌入式系统中，看门狗（WatchDog）的基本工作原理是（ ）",
    "A. 监控系统温度，过热时自动降频",
    "B. 计数器自动计数，程序定期将其重置；若程序跑飞计数器溢出，则系统复位重启",
  ];
  const expected = `<p>${lines.join("<br/>")}</p>`;

  for (const lineEnding of ["\n", "\r\n", "\r"]) {
    const html = renderMessage({ role: "user", content: lines.join(lineEnding) });
    assert.ok(html.includes(expected), JSON.stringify(lineEnding));
    assert.doesNotMatch(html, /\r/);
  }

  const listHtml = renderMessage({
    role: "user",
    content: [{ type: "text", text: "1. 看门狗的原理是（ ）\nA. 监控温度\nB. 计数器" }],
  });
  assert.match(listHtml, /<li>看门狗的原理是（ ）<br\/>A\. 监控温度<br\/>B\. 计数器<\/li>/);
});

test("keeps assistant soft line breaks as Markdown paragraphs", () => {
  const html = renderMessage({ role: "assistant", content: [{ type: "text", text: "one\ntwo" }] });

  assert.match(html, /<p>one\ntwo<\/p>/);
  assert.doesNotMatch(html, /<br/);
});

test("renders lone carriage returns in compact command arguments as line breaks", () => {
  const html = renderMessage({
    role: "user",
    content: COMPLETE_SKILL_EXPANSION.replace("src/main.ts", "src/main.ts\rsrc/app.ts"),
  });

  assert.match(html, /\/skill:review/);
  assert.match(html, /src\/main\.ts\nsrc\/app\.ts/);
  assert.doesNotMatch(html, /\r/);
});

test("keeps attached images when restoring a compact command for editing", () => {
  const image = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const restored = replaceUserMessageText({
    role: "user",
    content: [{ type: "text", text: COMPLETE_SKILL_EXPANSION }, image],
  }, "/skill:review src/main.ts");

  assert.deepEqual(restored.content, [
    { type: "text", text: "/skill:review src/main.ts" },
    image,
  ]);
});

test("renders user-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "inspect this" },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="(Preview image|预览图片|Open image preview)"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("keeps attached images while hiding a wake bridge text block", () => {
  const html = renderMessage({
    role: "user",
    content: [
      { type: "text", text: "Subagent updates above." },
      { type: "image", data: "YWJj", mimeType: "image/png" },
    ],
    timestamp: Date.now(),
  });

  assert.doesNotMatch(html, /Subagent updates above/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("preserves leading indentation in ordinary user messages through Markdown rendering", () => {
  const html = renderMessage({ role: "user", content: "    print(1)\n" });
  assert.match(html, /class="markdown-code-block"/);
  assert.match(html, /print\(1\)/);
});

test("renders compaction file metadata as clickable when an open handler is present", () => {
  const html = renderMessage({
    role: "custom",
    customType: "compaction",
    content: `## Goal
Keep context.

<modified-files>
/tmp/changed.ts
</modified-files>`,
    timestamp: Date.now(),
  }, { onOpenFile() {} });

  assert.match(html, /class="compaction-file-clickable"/);
  assert.match(html, /\/tmp\/changed\.ts/);
});
test("renders compaction usage and cost in header", () => {
  const html = renderMessage({ role: "custom", customType: "compaction", content: "summary", timestamp: Date.now() }, {
    compactionCost: { usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 10, reasoningTokens: 2, totalTokens: 135 }, amount: 0.0012, currency: "USD", status: "calculated" },
  });
  assert.match(html, /135 Token/);
  assert.match(html, /\$0\.0012/);
  assert.match(html, /(?:Input|输入):/);
});

test("renders unknown compaction cost as a zero lower bound", () => {
  const html = renderMessage({ role: "custom", customType: "compaction", content: "summary", timestamp: Date.now() }, {
    compactionCost: { usage: { inputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 10, reasoningTokens: 0, totalTokens: 110 }, amount: 0, currency: "USD", status: "partial" },
  });
  assert.match(html, /≥\$0\.0000/);
  assert.doesNotMatch(html, /unpriced|未计价/);
});

test("uses compact K/M/B notation for large compaction usage", () => {
  const html = renderMessage({ role: "custom", customType: "compaction", content: "summary", timestamp: Date.now() }, {
    compactionCost: { usage: { inputTokens: 100, cachedInputTokens: 20, cacheWriteTokens: 5, outputTokens: 10, reasoningTokens: 2, totalTokens: 498_897 }, amount: 0.2323, currency: "USD", status: "calculated" },
  });
  assert.match(html, /498\.9K Token/);
  assert.doesNotMatch(html, /498,897 Token/);
});

test("renders custom-message images as buttons that open a larger preview", () => {
  const html = renderMessage({
    role: "custom",
    customType: "extension",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
    timestamp: Date.now(),
  });

  assert.match(html, /<button[^>]+aria-label="(Preview image|预览图片|Open image preview)"[^>]*>/);
  assert.match(html, /<img[^>]+src="data:image\/png;base64,YWJj"/);
});

test("extension text keeps terminal layout without changing peer collaboration or remote media", () => {
  const content = "Status\n  │ ready │\n  └───────┘";
  const extension = renderMessage({ role: "custom", customType: "extension", content, display: true });
  assert.match(extension, /class="markdown-body markdown-custom-message is-terminal-layout"/);
  assert.match(extension, /Status<br\/> {2}│ ready │<br\/> {2}└───────┘/);
  const remote = renderMessage({ role: "custom", customType: "extension", content: "![chart](/Volumes/project/chart.png)", display: true }, {
    sessionId: "session-1", remotePeer: "air",
  });
  assert.match(remote, /\/api\/remote\/files\/Volumes\/project\/chart\.png\?type=read&amp;sessionId=session-1&amp;peer=air/);
  const peer = renderMessage({ role: "custom", customType: "pi-web:session-peer", content, display: true });
  assert.doesNotMatch(peer, /is-terminal-layout/);
});

test("renders native peer messages as a collapsible Agent collaboration card", () => {
  const html = renderMessage({
    role: "custom",
    customType: "pi-web:session-peer",
    content: "peer body",
    display: true,
    details: {
      source: "session-control",
      messageId: "peer-message-1",
      kind: "request",
      sender: { sessionId: "worker", title: "Worker" },
    },
  });
  assert.match(html, /Agent collaboration/);
  assert.match(html, /request · from Worker/);
  assert.match(html, /Expand|展开/);
  assert.doesNotMatch(html, /markdown-user-message/);
});

test("adds question-analysis action to saved text user messages", () => {
  const html = renderMessage({
    role: "user",
    content: "如何让这个问题表达得更准确？",
  }, { sessionId: "session-1", entryId: "entry-1" });

  assert.ok(html.includes(markupText(en("questionAnalysis.analyze"))));
  assert.match(html, /aria-haspopup="dialog"/);
  assert.ok(html.includes(`aria-label="${markupText(en("questionAnalysis.analyze"))}"`));
});

test("restores a persisted terminology result beside its saved question", () => {
  const html = renderMessage({
    role: "user",
    content: "如何描述这个缓存问题？",
  }, {
    sessionId: "session-1",
    entryId: "entry-1",
    questionAnalysisJob: {
      jobId: "job-1",
      targetEntryId: "entry-1",
      status: "completed",
      mode: "question",
      requestedAt: 1,
      result: { text: "- **缓存击穿**：……" },
    },
  });
  assert.match(html, /缓存击穿/);
  assert.ok([en("questionAnalysis.hide"), en("questionAnalysis.show")].some((label) => html.includes(markupText(label))));
  assert.ok(html.includes(markupText(en("questionAnalysis.rewrite"))));
});

test("restores composer-attached terminology beside its sent question", () => {
  const html = renderMessage({
    role: "user",
    content: "如何描述这个缓存问题？",
  }, {
    sessionId: "session-1",
    entryId: "entry-1",
    questionDraftView: {
      version: 1,
      jobId: "draft-1",
      targetEntryId: "entry-1",
      requestedAt: 1,
      result: { text: "- **缓存击穿**：……" },
      rewrite: { text: "如何用缓存击穿准确描述该问题？" },
    },
  });

  assert.match(html, /缓存击穿/);
  assert.ok([en("questionAnalysis.hide"), en("questionAnalysis.show")].some((label) => html.includes(markupText(label))));
  assert.match(html, /如何用缓存击穿准确描述该问题/);
});

test("keeps question-analysis action unavailable for image-only messages", () => {
  const html = renderMessage({
    role: "user",
    content: [{ type: "image", data: "YWJj", mimeType: "image/png" }],
  }, { sessionId: "session-1" });

  assert.ok(html.includes(markupText(en("questionAnalysis.analyze"))));
  assert.match(html, /disabled=""/);
});

test("uses the persisted parent as the in-page fork anchor when it is not an assistant", () => {
  assert.equal(getEditNavigationEntryId("user-2", undefined, "user-1"), "user-1");
});

test("shows pull-back title on first message in-page fork and side-branch title on subsequent messages", () => {
  const firstMsgHtml = renderMessage({
    role: "user",
    content: "测试首条消息",
  }, {
    entryId: "user-1",
    isFirstUserMessage: true,
    onEditContent() {},
    onStartSideBranch() {},
    onNavigate() {},
  });
  assert.ok(firstMsgHtml.includes(`title="${markupText(en("message.pullBackEditTitle"))}"`));
  assert.ok(firstMsgHtml.includes(markupText(en("message.pullBackEdit"))));
  assert.ok(!firstMsgHtml.includes(markupText(en("message.inPageFork"))));

  const secondMsgHtml = renderMessage({
    role: "user",
    content: "测试第二条消息",
  }, {
    entryId: "user-2",
    prevAssistantEntryId: "asst-1",
    onEditContent() {},
    onStartSideBranch() {},
    onNavigate() {},
  });
  assert.ok(secondMsgHtml.includes(`title="${markupText(en("chat.startSideBranchTitle"))}"`));
  assert.ok(secondMsgHtml.includes(markupText(en("message.inPageFork"))));
  const consecutiveUserHtml = renderMessage({ role: "user", content: "连续的后续用户消息" }, {
    entryId: "user-3", isFirstUserMessage: false, onEditContent() {}, onNavigate() {},
  });
  assert.ok(consecutiveUserHtml.includes(markupText(en("message.inPageFork"))));
  assert.ok(!consecutiveUserHtml.includes(`>${markupText(en("message.pullBackEdit"))}<`));
});

test("user edit buttons submit explicit root or side-branch intent without navigating before restoration", async () => {
  const { readFile } = await import("node:fs/promises");
  const ts = (await import("typescript")).default;
  const vm = await import("node:vm");
  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  const syntax = ts.createSourceFile("MessageView.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isJsxAttribute(node) && node.name.getText(syntax) === "onClick"
      && node.initializer?.expression?.getText(syntax).includes("transformInput:")) return node.initializer.expression;
    return ts.forEachChild(node, find);
  }
  const button = find(syntax); assert.ok(button);
  const code = ts.transpileModule(`(${button.getText(syntax)})`, {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  for (const first of [true, false]) {
    const calls=[];
    const context={editTarget:{role:"user",content:"bounded preview"},entryId:"user",isFirstUserMessage:first,
      prevAssistantEntryId:"assistant",editNavigationEntryId:"assistant",onStartSideBranch:()=>assert.fail("must restore before branch"),
      onNavigate:()=>assert.fail("must restore before navigate"),skillExpansionToCommand:input=>input.startsWith("expanded")?"/skill complete":null,
      onEditContent:(...args)=>calls.push(args)};
    vm.runInNewContext(code,context)();
    assert.equal(calls.length,1); assert.equal(calls[0][1],"user"); assert.equal(calls[0][2],first);
    assert.equal(calls[0][3].sideBranchAnchor,first?undefined:"assistant");
    assert.equal(calls[0][3].transformInput("expanded full source"),"/skill complete");
    assert.equal(calls[0][3].transformInput("plain full source"),"plain full source");
  }
  const parentCalls=[];
  vm.runInNewContext(code, {
    editTarget:{role:"user",content:"bounded preview"}, entryId:"user", isFirstUserMessage:false,
    prevAssistantEntryId:undefined, editNavigationEntryId:"parent", onStartSideBranch:()=>{},
    onNavigate:()=>assert.fail("must restore before branch"), skillExpansionToCommand:input=>input,
    onEditContent:(...args)=>parentCalls.push(args),
  })();
  assert.equal(parentCalls[0][3].sideBranchAnchor,"parent");
});


test("keeps user line breaks while leaving assistant soft breaks unchanged", () => {
  const userHtml = renderMessage({ role: "user", content: "one\ntwo" });
  const assistantHtml = renderMessage({
    role: "assistant",
    provider: "test",
    model: "test-model",
    content: [{ type: "text", text: "one\ntwo" }],
  });

  assert.match(userHtml, /one<br\/>two/);
  assert.doesNotMatch(assistantHtml, /<br/);
});

test("wires keepLineBreaks only to the two user Markdown callsites", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");
  assert.equal((source.match(/className="markdown-user-message" keepLineBreaks/g) ?? []).length, 2);
  assert.doesNotMatch(source, /SafeMarkdownBody dedupeImages keepLineBreaks/);
});

test("uses the unanswered truncation notice for an empty length reply", () => {
  // A nearly full context can clamp the output so far that nothing, not even
  // thinking, comes back; the notice must not blame thinking alone.
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [],
    stopReason: "length",
  });

  assert.match(html, /output limit was reached before an answer/i);
  assert.match(html, /nearly full context/i);
  assert.doesNotMatch(html, /follow-up/i);
});

const { setToolCallExpanded } = await jiti.import("@/lib/tool-call-expansion");

function textOf(html) {
  return html.replace(/<[^>]+>/g, "").replace(/&quot;/g, "\"").replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
}

function codemodeCall(toolCallId, code) {
  return { type: "toolCall", toolCallId, toolName: "codemode", input: { code } };
}

function renderCodemode(block, result) {
  return renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { toolResults: new Map(result ? [[block.toolCallId, result]] : []) });
}

const CODEMODE_SCRIPT = "// @options: {\"timeoutMs\": 5000}\nconst files = await tools.ls({ path: \".\" });\nreturn files.length;";

test("collapses a codemode call to its first script line and call count", (t) => {
  const block = codemodeCall("call-codemode-collapsed", CODEMODE_SCRIPT);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }, { type: "text", text: "3" }],
    details: {
      calls: [
        { id: "call-codemode-collapsed/1", name: "ls", args: "{\"path\":\".\"}", status: "ok", durationMs: 4 },
        { id: "call-codemode-collapsed/2", name: "read", args: "{\"path\":\"a\"}", status: "ok", durationMs: 2 },
      ],
    },
  });
  const text = textOf(html);
  assert.match(text, /codemode/);
  assert.match(text, /const files = await tools\.ls\(\{ path: "\." \}\);/);
  assert.match(text, /2 calls/);
  assert.doesNotMatch(text, /@options/);
  assert.doesNotMatch(text, /"code"/);
  assert.doesNotMatch(text, /Tool calls/);
});

test("expands a codemode call into its script, its calls, and the output without the header", (t) => {
  const block = codemodeCall("call-codemode-expanded", CODEMODE_SCRIPT);
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const calls = Array.from({ length: 23 }, (_, index) => ({
    id: `call-codemode-expanded/${index + 1}`,
    name: index === 22 ? "bash" : "read",
    args: `{"path":"file-${index + 1}"}`,
    status: index === 22 ? "error" : "ok",
    durationMs: 1500,
    ...(index === 22 ? { error: "exit code 2" } : {}),
  }));
  calls.push(
    { id: "call-codemode-expanded/24", name: "models.classify", args: "", status: "ok", cost: 0.004 },
    { id: "call-codemode-expanded/25", name: "models.classify", args: "", status: "ok", cost: 0.006 },
  );
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    isError: true,
    content: [
      { type: "text", text: "Script failed\nWall time 4.2 seconds\nOutput:\n" },
      { type: "text", text: "Script error:\nError: exit code 2" },
    ],
    details: { calls },
  });
  const text = textOf(html);

  // The script sits in the plain box any tool's input uses, not a highlighted code block.
  assert.doesNotMatch(html, /markdown-code-block/);
  assert.equal(textOf(html.match(/<pre[^>]*>([\s\S]*?)<\/pre>/)[1]), CODEMODE_SCRIPT);
  assert.match(text, /Tool calls/);
  assert.match(text, /Show 5 earlier calls/);
  // The newest 20 of 25 calls are listed; the 5 oldest are folded.
  assert.doesNotMatch(text, /"file-5"/);
  assert.match(text, /"file-6"/);
  assert.match(text, /bash\{"path":"file-23"\}1\.5s/);
  assert.match(text, /exit code 2/);
  assert.match(html, /aria-label="Failed"/);
  assert.match(text, /Model calls: \$0\.01/);
  assert.match(text, /Script error:\nError: exit code 2/);
  assert.doesNotMatch(text, /Wall time/);
  assert.doesNotMatch(text, /"code":/);
});

test("shows a running script's calls without an empty output", (t) => {
  const block = codemodeCall("call-codemode-running", "await tools.read({ path: \"a\" })");
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderCodemode(block, {
    role: "toolResult",
    toolCallId: block.toolCallId,
    content: [],
    details: {
      calls: [{ id: "call-codemode-running/201", name: "read", args: "{\"path\":\"a\"}", status: "running" }],
      omittedCalls: 200,
    },
  });
  const text = textOf(html);
  assert.match(text, /201 calls/);
  assert.match(text, /200 earlier calls not shown/);
  assert.match(html, /aria-label="Running"/);
  assert.doesNotMatch(text, /No output/i);
});

test("keeps the generic view for a codemode call whose input is still streaming or has no script", (t) => {
  const streaming = { ...codemodeCall("call-codemode-streaming", ""), input: {}, rawInput: "{\"code\":\"const secret" };
  setToolCallExpanded(streaming.toolCallId, true);
  t.after(() => setToolCallExpanded(streaming.toolCallId, false));
  const streamingText = textOf(renderCodemode(streaming));
  assert.match(streamingText, /Generating parameters/);
  assert.match(streamingText, /\{"code":"const secret/);
  assert.doesNotMatch(streamingText, /Tool calls/);

  const other = { type: "toolCall", toolCallId: "call-codemode-other", toolName: "codemode", input: { script: "x" } };
  setToolCallExpanded(other.toolCallId, true);
  t.after(() => setToolCallExpanded(other.toolCallId, false));
  assert.match(textOf(renderCodemode(other)), /"script": "x"/);
});

test("labels an MCP call server/tool and indents a JSON result", (t) => {
  const block = {
    type: "toolCall",
    toolCallId: "call-mcp-1",
    toolName: "mcp__docs_v2__search",
    input: { query: "codemode" },
  };
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, {
    toolResults: new Map([[block.toolCallId, {
      role: "toolResult",
      toolCallId: block.toolCallId,
      content: [{ type: "text", text: "{\"hits\":[{\"title\":\"Code mode\"}]}" }],
      details: { server: "docs.v2", tool: "search" },
    }]]),
  });
  const text = textOf(html);
  assert.match(text, /docs\.v2\/search/);
  assert.match(html, /title="mcp__docs_v2__search"/);
  assert.match(text, /\{\n {2}"hits": \[\n {4}\{\n {6}"title": "Code mode"/);
});

test("keeps the registered name where no result names the server and tool", (t) => {
  // Sanitizing maps docs.v2/search.pages and docs_v2/search_pages to one name, so it is not split.
  const block = { type: "toolCall", toolCallId: "call-mcp-running", toolName: "mcp__docs_v2__search_pages", input: {} };
  const running = textOf(renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  }, { toolResults: new Map() }));
  assert.match(running, /mcp__docs_v2__search_pages/);
  assert.doesNotMatch(running, /docs_v2\//);

  // A codemode script's calls carry only that name, which is also what the script calls.
  const script = codemodeCall("call-codemode-mcp", "await tools.mcp__docs_v2__search_pages({})");
  setToolCallExpanded(script.toolCallId, true);
  t.after(() => setToolCallExpanded(script.toolCallId, false));
  const html = renderCodemode(script, {
    role: "toolResult",
    toolCallId: script.toolCallId,
    content: [{ type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" }],
    details: { calls: [{ id: "call-codemode-mcp/1", name: "mcp__docs_v2__search_pages", args: "{}", status: "ok" }] },
  });
  assert.match(textOf(html), /mcp__docs_v2__search_pages\{\}/);
});

test("image generation shows reconciled charges even when the tool is collapsed or nested in codemode", () => {
  for (const nested of [false, true]) {
    const toolCallId = nested ? "billing-codemode" : "billing-call";
    const billing = { status: "confirmed", amount: 0.015, currency: "USD", source: "apimart-task", taskId: "task-billing", startedAt: 1,
      toolCallId: nested ? toolCallId + "/1" : toolCallId, returnedImages: 2, credits: 0.15 };
    const receipt = { id: "image-generation:billing", provider: "apimart", model: "gpt-image-2", billing };
    const html = renderMessage({ role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "toolCall", toolCallId,
      toolName: nested ? "codemode" : "generate_image", input: nested ? { code: "await tools.generate_image({prompt: 'fixture'})" } : { prompt: "fixture" } }] }, {
      toolResults: new Map([[toolCallId, { role: "toolResult", toolCallId, isError: true, content: [{ type: "text", text: "Download failed" }],
        details: { imageGeneration: [{ ...receipt, billing: { ...billing, status: "pending", amount: undefined } }] } }]]),
      imageGenerationCosts: [{ ...receipt, amount: 0.015, status: "confirmed" }],
    });
    assert.match(html, /data-cost-status="confirmed"/);
    assert.match(html, /Actual charge \$0\.015/);
    assert.match(html, /0.15 credits/);
    assert.match(html, /2 images returned/);
    assert.match(html, /task-billing/);
    assert.doesNotMatch(html, /Pending reconciliation/);
  }
});

test("the final answer renders its receipt directly below the generated image without expanding tool history", () => {
  const billing = { status: "confirmed", currency: "USD", amount: 0.015, credits: 0.15, source: "apimart-task", taskId: "task-final", toolCallId: "outer/1", startedAt: 1, returnedImages: 1, resolution: "2K" };
  const receipt = { id: "image-generation:final", provider: "apimart", model: "gpt-image-2", status: "confirmed", amount: 0.015, billing,
    outputs: [{ version: 1, toolCallId: "outer/1", files: ["/tmp/final.png"], usageIds: ["image-generation:final"] }] };
  const html = renderMessage({ role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "text", text: "![result](/tmp/final.png)" }] }, {
    cwd: "/tmp", imageGenerationCosts: [receipt], toolResults: new Map(),
  });
  assert.match(html, /alt="result"/);
  assert.ok(html.indexOf('alt="result"') < html.indexOf('data-cost-placement="image"'));
  assert.match(html, /Actual charge \$0\.015/);
  assert.match(html, /gpt-image-2 · 2K · Verified/);
});

test("an unknown image charge is not displayed as free and stale cost responses do not hide a confirmed receipt", () => {
  const toolCallId = "billing-unknown";
  const pending = { status: "pending", currency: "USD", source: "apimart-task", taskId: "task-unknown", startedAt: 1, toolCallId };
  const receipt = { id: "image-generation:unknown", provider: "apimart", model: "gpt-image-2", billing: pending };
  const message = { role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "toolCall", toolCallId, toolName: "generate_image", input: {} }] };
  const result = { role: "toolResult", toolCallId, content: [], details: { imageGeneration: [receipt] } };
  const unknown = renderMessage(message, { toolResults: new Map([[toolCallId, result]]) });
  assert.match(unknown, /Pending reconciliation/);
  assert.doesNotMatch(unknown, /\$0(?:[<\s]|$)/);
  const known = renderMessage(message, { toolResults: new Map([[toolCallId, { ...result, details: { imageGeneration: [{ ...receipt, billing: { ...pending, status: "confirmed", amount: 0.0000002 } }] } }]]),
    imageGenerationCosts: [{ ...receipt, status: "pending", amount: null }] });
  assert.match(known, /Actual charge \$2e-7/);
  assert.doesNotMatch(known, /Pending reconciliation/);
});

test("unrelated tool metadata cannot self-claim an actual image charge", () => {
  const toolCallId = "not-image";
  const html = renderMessage({ role: "assistant", provider: "fixture", model: "fixture", content: [{ type: "toolCall", toolCallId, toolName: "mcp__other__read", input: {} }] }, {
    toolResults: new Map([[toolCallId, { role: "toolResult", toolCallId, content: [], details: { imageGeneration: [{ id: "forged", provider: "apimart", model: "gpt-image-2",
      billing: { status: "confirmed", source: "apimart-task", currency: "USD", amount: 999, taskId: "forged-task", startedAt: 1 } }] } }]]),
  });
  assert.doesNotMatch(html, /Actual charge|data-image-generation-cost/);
});

test("does not render subagent wake messages as user chat bubbles", () => {
  const wakeMessage = {
    role: "user",
    content: "Inspect subagent updates above. Answer pending supervisor requests within your authority. For completed work, read saved results and resume the already-authorized parent task, or report completion. If approval is required, explicitly ask the user. Do not silently yield, rerun completed work, or infer new authorization.",
  };
  const html = renderMessage(wakeMessage);
  assert.equal(html, "");

  const shortWake = {
    role: "user",
    content: "Subagent updates above.",
  };
  assert.equal(renderMessage(shortWake), "");
});

test("flat tool arguments render as one labelled row each", (t) => {
  const block = {
    type: "toolCall",
    toolCallId: "call-flat-fields",
    toolName: "read",
    input: { path: "/tmp/a.txt", offset: 10, limit: 20 },
  };
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  });

  assert.match(html, /class="tool-call-fields"/);
  assert.match(html, /<dt[^>]*>path<\/dt><dd[^>]*>\/tmp\/a\.txt<\/dd>/);
  assert.match(html, /<dt[^>]*>offset<\/dt><dd[^>]*>10<\/dd>/);
  assert.match(html, /<dt[^>]*>limit<\/dt><dd[^>]*>20<\/dd>/);
  assert.doesNotMatch(html, /&quot;path&quot;: &quot;\/tmp\/a\.txt&quot;/);
});

test("nested tool arguments keep the JSON view so no subtree is hidden", (t) => {
  const block = {
    type: "toolCall",
    toolCallId: "call-nested-fields",
    // Not an edit tool: those have their own richer view, not the generic one.
    toolName: "todo",
    input: { action: "create", items: [{ subject: "a", blockedBy: [1] }] },
  };
  setToolCallExpanded(block.toolCallId, true);
  t.after(() => setToolCallExpanded(block.toolCallId, false));
  const html = renderMessage({
    role: "assistant",
    provider: "anthropic",
    model: "claude-test",
    content: [block],
  });

  assert.doesNotMatch(html, /class="tool-call-fields"/);
  assert.match(html, /blockedBy/);
  assert.match(html, /subject/);
});
