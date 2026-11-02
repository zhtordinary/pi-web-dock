import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { countQueryInSession, countQueryInSessionFile, sessionIdMatchesQuery } = await jiti.import("./session-search.ts");
const { sessionSearchResultMatchesFilter, sessionSearchResultSources } = await jiti.import("./types.ts");
const { visibleMarkdownText } = await jiti.import("./session-search-text.ts");

function line(obj) {
  return JSON.stringify(obj);
}

test("counts only user/assistant text, not base64/paths/metadata/tool results", () => {
  const file = [
    line({ type: "message", message: { role: "user", content: [{ type: "text", text: "今天想一起玩好玩的东西" }] } }),
    // Tool result text that happens to contain the query (rendered collapsed).
    line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "表里也有好玩好玩" }] } }),
    // Metadata row whose path/summary contains the query but is not message text.
    line({ type: "custom", customType: "cwd", data: { cwd: "/home/want/好玩/好玩/好玩" } }),
  ].join("\n");

  const { matchCount, contentMatchCount, snippets } = countQueryInSession(file, "好玩");
  assert.equal(matchCount, 1, "toolResult and metadata matches must not count");
  assert.equal(contentMatchCount, 1);
  assert.equal(snippets.length, 1);
  assert.match(snippets[0], /好玩的东西/);
});

test("counts each real occurrence inside a single message text field", () => {
  const file = line({
    type: "message",
    message: { role: "assistant", content: [{ type: "text", text: "好玩好玩好玩" }] },
  });
  const result = countQueryInSession(file, "好玩");
  assert.equal(result.matchCount, 3);
  assert.equal(result.contentMatchCount, 3);
});

test("joins multiple text parts in one message", () => {
  const file = line({
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "这个游戏好玩" },
        { type: "text", text: "执行结果：好玩" },
      ],
    },
  });
  const result = countQueryInSession(file, "好玩");
  assert.equal(result.matchCount, 2);
  assert.equal(result.contentMatchCount, 2);
});

test("returns no match when query only appears in tool result or non-title metadata", () => {
  // toolResult-role message with text content (rendered collapsed inline).
  const toolOnly = line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: "输出：好玩" }] } });
  assert.equal(countQueryInSession(toolOnly, "好玩").matchCount, 0);

  // custom row carrying a path.
  const metaOnly = line({ type: "custom", customType: "cwd", data: { path: "/好玩/x" } });
  assert.equal(countQueryInSession(metaOnly, "好玩").matchCount, 0);

  // bashExecution message output.
  const bashOnly = line({ type: "message", message: { role: "bashExecution", content: [{ type: "text", text: "$ echo 好玩" }] } });
  assert.equal(countQueryInSession(bashOnly, "好玩").matchCount, 0);
});

test("empty body / missing query returns no match", () => {
  assert.deepEqual(countQueryInSession("", "ab"), { matchCount: 0, contentMatchCount: 0, titleMatchCount: 0, snippets: [] });
  assert.deepEqual(countQueryInSession(line({ type: "message", message: { role: "user", content: "x" } }), "ab"), { matchCount: 0, contentMatchCount: 0, titleMatchCount: 0, snippets: [] });
});

test("matches session names and recap titles without searching recap bodies", () => {
  const body = [
    line({ type: "session_info", id: "info-1", parentId: null, timestamp: "t", name: "Archive restore follow-up" }),
    line({ type: "custom", customType: "session-recap-title:result", data: { title: "Live status audit", recap: "body-only-marker" } }),
  ].join("\n");

  const nameResult = countQueryInSession(body, "restore follow-up");
  assert.equal(nameResult.matchCount, 1);
  assert.equal(nameResult.contentMatchCount, 0);
  assert.equal(nameResult.titleMatchCount, 1);
  assert.match(nameResult.snippets[0], /^title: Archive restore follow-up$/);

  const recapResult = countQueryInSession(body, "status audit");
  assert.equal(recapResult.matchCount, 1);
  assert.equal(recapResult.contentMatchCount, 0);
  assert.equal(recapResult.titleMatchCount, 1);
  assert.match(recapResult.snippets[0], /^title: Live status audit$/);

  assert.equal(countQueryInSession(body, "body-only-marker").matchCount, 0);
});

test("keeps content matches distinct when title snippets fill the preview", () => {
  const body = [
    line({ type: "session_info", id: "info-1", parentId: null, timestamp: "t", name: "needle session title" }),
    line({ type: "custom", customType: "session-recap-title:result", data: { title: "needle recap one", recap: "recap body" } }),
    line({ type: "custom", customType: "session-recap-title:result", data: { title: "needle recap two", recap: "recap body" } }),
    line({ type: "message", message: { role: "user", content: "needle in conversation" } }),
  ].join("\n");

  const result = countQueryInSession(body, "needle");
  assert.equal(result.matchCount, 4);
  assert.equal(result.contentMatchCount, 1, "正文命中不能因标题 snippets 已满而丢失");
  assert.equal(result.titleMatchCount, 3);
});

test("streams session and recap titles", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-search-title-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, [
      line({ type: "session_info", id: "info-1", parentId: null, timestamp: "t", name: "Streamed session title" }),
      line({ type: "custom", customType: "session-recap-title:result", data: { title: "Streamed recap title", recap: "recap body" } }),
    ].join("\n"));

    assert.equal((await countQueryInSessionFile(path, "session title")).matchCount, 1);
    assert.equal((await countQueryInSessionFile(path, "session title")).contentMatchCount, 0);
    assert.equal((await countQueryInSessionFile(path, "recap title")).matchCount, 1);
    assert.equal((await countQueryInSessionFile(path, "recap title")).contentMatchCount, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("streams oversized tool-result lines without treating them as hits", async () => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-session-search-"));
  const path = join(root, "session.jsonl");
  try {
    writeFileSync(path, [
      line({ type: "message", message: { role: "user", content: "needle" } }),
      line({ type: "message", message: { role: "toolResult", content: [{ type: "text", text: `${"needle"}${"x".repeat(100_000)}` }] } }),
    ].join("\n"));

    const result = await countQueryInSessionFile(path, "needle");
    assert.equal(result.matchCount, 1);
    assert.equal(result.contentMatchCount, 1);
    assert.equal(result.snippets.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("excludes persisted question-analysis records from locatable message search", () => {
  const body = [
    line({ type: "custom", customType: "question-terminology", data: { result: { text: "缓存击穿" }, rewrite: { text: "重写后的内容" } } }),
    line({ type: "message", message: { role: "user", content: "正文内容" } }),
  ].join("\n");

  assert.equal(countQueryInSession(body, "缓存击穿").matchCount, 0);
  assert.equal(countQueryInSession(body, "重写后的内容").matchCount, 0);
});

test("collapses skill envelopes and excludes image/math surfaces", () => {
  const skill = `<skill name="demo" location="/tmp/demo">\nReferences are relative to /tmp/demo.\n\nhidden body needle\n</skill>`;
  assert.equal(visibleMarkdownText(skill, { collapseSkill: true }), "/skill:demo");

  const skillBody = line({ type: "message", message: { role: "user", content: [{ type: "text", text: skill }] } });
  const richBody = line({ type: "message", message: { role: "user", content: [{ type: "text", text: "![needle](https://example.test/image.png)\n$needle$" }] } });
  assert.equal(countQueryInSession(skillBody, "hidden body").matchCount, 0);
  assert.equal(countQueryInSession(skillBody, "/skill:demo").matchCount, 1);
  assert.equal(countQueryInSession(richBody, "needle").matchCount, 0);
});

test("merges user text parts before skill and Markdown extraction", () => {
  const parts = [
    '<skill name="demo" location="/tmp/demo">\nReferences are relative to /tmp/demo.',
    '\nhidden body needle\n</skill>',
  ];
  const body = line({ type: "message", message: { role: "user", content: parts.map((text) => ({ type: "text", text })) } });
  assert.equal(countQueryInSession(body, "hidden body").matchCount, 0);
  assert.equal(countQueryInSession(body, "/skill:demo").matchCount, 1);
});

test("matches rendered markdown text but excludes source-only markdown chrome", () => {
  const body = line({ type: "message", message: {
    role: "assistant",
    content: [{ type: "text", text: "[visible label](https://example.test/raw-url)\n`needle`\n```ts\nfenced needle\n```\nfoo_bar" }],
  } });

  assert.equal(countQueryInSession(body, "visible label").matchCount, 1);
  assert.equal(countQueryInSession(body, "raw-url").matchCount, 0);
  assert.equal(countQueryInSession(body, "ts").matchCount, 0);
  assert.equal(countQueryInSession(body, "needle").matchCount, 1);
  assert.equal(countQueryInSession(body, "fenced needle").matchCount, 0);
  assert.equal(countQueryInSession(body, "foo_bar").matchCount, 1);
  assert.equal(visibleMarkdownText("foo_bar"), "foo_bar");
  assert.equal(visibleMarkdownText("hello **world**"), "hello world");
  assert.equal(visibleMarkdownText("~needle~"), "~needle~");
  assert.doesNotMatch(visibleMarkdownText("before <script>needle</script> after"), /needle/);
  assert.match(visibleMarkdownText("`<script>needle</script>`"), /needle/);
  assert.doesNotMatch(visibleMarkdownText("before <script>needle</script> after"), /needle/);
  assert.match(visibleMarkdownText("before\n<iframe>hidden needle</iframe>\nafter"), /after/);
  assert.doesNotMatch(visibleMarkdownText("text[^1]\n\n[^1]: footnote needle"), /footnote/);
});

test("excludes collapsed oversized messages and hidden process text", () => {
  const body = [
    line({ type: "message", message: { role: "user", content: "needle".repeat(30_000) } }),
    line({ type: "message", message: { role: "assistant", content: [
      { type: "text", text: "hidden process needle" },
      { type: "toolCall", toolCallId: "tool-1", name: "bash", arguments: {} },
    ] } }),
    line({ type: "message", message: { role: "assistant", content: [
      { type: "toolCall", toolCallId: "tool-2", name: "bash", arguments: {} },
      { type: "text", text: "visible final needle" },
    ] } }),
  ].join("\n");

  assert.equal(countQueryInSession(body, "needle").matchCount, 1);
  assert.equal(countQueryInSession(body, "hidden process").matchCount, 0);
});

test("matches full and partial session IDs case-insensitively", () => {
  assert.equal(sessionIdMatchesQuery("01ABC-def-234", "01abc-def-234"), true);
  assert.equal(sessionIdMatchesQuery("01ABC-def-234", "abc-def"), true);
  assert.equal(sessionIdMatchesQuery("01ABC-def-234", "xyz"), false);
  assert.equal(sessionIdMatchesQuery("01ABC-def-234", "a"), false);
  assert.equal(sessionIdMatchesQuery("01ABC-def-234", ""), false);
});

test("source labels render each matching source once", () => {
  assert.deepEqual(sessionSearchResultSources({ contentMatchCount: 2, titleMatchCount: 1, idMatch: true }), ["content", "title", "id"]);
  assert.deepEqual(sessionSearchResultSources({ contentMatchCount: 0, titleMatchCount: 0, idMatch: false }), []);
});

test("filters search hits by content, title, and own ID", () => {
  const hit = { contentMatchCount: 2, titleMatchCount: 1, idMatch: true };
  assert.equal(sessionSearchResultMatchesFilter(hit, "all"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "content"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "title"), true);
  assert.equal(sessionSearchResultMatchesFilter(hit, "id"), true);
  assert.equal(sessionSearchResultMatchesFilter({ contentMatchCount: 0, titleMatchCount: 0, idMatch: false }, "content"), false);
  assert.equal(sessionSearchResultMatchesFilter({ contentMatchCount: 0, titleMatchCount: 0, idMatch: false }, "title"), false);
  assert.equal(sessionSearchResultMatchesFilter({ contentMatchCount: 0, titleMatchCount: 0, idMatch: false }, "id"), false);
});
