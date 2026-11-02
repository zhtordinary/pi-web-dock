import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);
const jiti = createJiti(import.meta.url);
const suiteAgentRoot = mkdtempSync(join(tmpdir(), "pi-web-session-reader-suite-"));
const suiteAgentDirBefore = process.env.PI_CODING_AGENT_DIR;
const suiteCacheHomeBefore = process.env.XDG_CACHE_HOME;
process.env.PI_CODING_AGENT_DIR = join(suiteAgentRoot, "agent");
process.env.XDG_CACHE_HOME = join(suiteAgentRoot, "cache");
process.once("exit", () => {
  if (suiteAgentDirBefore === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = suiteAgentDirBefore;
  if (suiteCacheHomeBefore === undefined) delete process.env.XDG_CACHE_HOME;
  else process.env.XDG_CACHE_HOME = suiteCacheHomeBefore;
  rmSync(suiteAgentRoot, { recursive: true, force: true });
});
const { sessionPathKey } = await jiti.import("./session-path.ts");
const {
  listAllSessions,
listProjectSessions,
listSessionSummaries,
  listArchivedSessions,
  mergeSessionLists,
  buildSessionContext,
  buildFullSessionContext,
  buildHistoryStepContext,
  buildSessionHistoryInfo,
  getQuestionAnalysisJobsForBranch,
  getQuestionDraftViewsForBranch,
  cacheSessionPath,
  invalidateSessionListCache,
  invalidateSessionPathCache,
  readSessionHeader,
  resolveSessionIdByPath,
  resolveSessionPath,
  resolveSessionPathReadOnly,
  updateSessionListCachesForMove,
  SessionPathConflictError,
} = await jiti.import("./session-reader.ts");
const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
const { getPiSessionRoots } = await jiti.import("./session-archive.ts");
const { resetSubprojectStateForTests } = await jiti.import("./subproject-state.ts");
const { resetSessionScanIndexForTests } = await jiti.import("./session-list-scanner.ts");

function resetSessionListState() {
  globalThis.__piSessionPathStateCache = undefined;
  globalThis.__piSessionPathCache = undefined;
  globalThis.__piPathToSessionIdCache = undefined;
  globalThis.__piSessionListCache = undefined;
  globalThis.__piSessionListPromise = undefined;
  globalThis.__piSessionListPromiseGeneration = undefined;
  globalThis.__piArchivedListCache = undefined;
  globalThis.__piArchivedListPromise = undefined;
  globalThis.__piArchivedListPromiseGeneration = undefined;
  globalThis.__piArchivedDirCache = undefined;
  globalThis.__piSessionListGeneration = 0;
}

function userEntry(id, parentId, content, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "user",
      content,
    },
  };
}

function assistantEntry(id, parentId, text, timestamp = "2026-01-01T00:00:00.000Z") {
  return {
    type: "message",
    id,
    parentId,
    timestamp,
    message: {
      role: "assistant",
      provider: "test",
      model: "test-model",
      content: [{ type: "text", text }],
    },
  };
}

test("renders the SDK compaction-aware context with aligned entry IDs", () => {
  const entries = [
    userEntry("u1", null, "old user request"),
    assistantEntry("a1", "u1", "old assistant answer"),
    userEntry("u2", "a1", "kept user request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "old exchange summary",
      firstKeptEntryId: "u2",
      tokensBefore: 123,
    },
    userEntry("u3", "cmp", "after compaction"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp", "u2", "u3"]);
  assert.deepEqual(
    context.messages.map((message) => [message.role, message.customType, message.content]),
    [
      ["custom", "compaction", "old exchange summary"],
      ["user", undefined, "kept user request"],
      ["user", undefined, "after compaction"],
    ],
  );
});

test("uses only the latest compaction on the active path", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "first kept request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "second kept answer"),
    userEntry("u3", "a2", "second kept request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].content, "latest summary");
  assert.equal(context.messages.length, context.entryIds.length);
});

test("keeps the newest compaction card in front of a bounded page", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("u2", "cmp1", "latest request"),
    assistantEntry("a2", "u2", "latest answer"),
  ];

  const context = buildSessionContext(entries, "a2", { tail: 2 });

  // The page stays a plain tail; only the card summarizing the hidden prefix
  // is added, and earlier entries remain reachable through pagination.
  assert.deepEqual(context.entryIds, ["cmp1", "u2", "a2"]);
  assert.equal(context.hasMore, true);
  // The cursor must point at a real page entry, not at the added card: a card
  // cursor would make the next page re-offer an already-visible message.
  assert.equal(context.oldestEntryId, "u2");
});

test("keeps user-visible entries when a bounded page crosses a compaction", () => {
  const entries = [
    userEntry("u0", null, "old request"),
    assistantEntry("a0", "u0", "old answer"),
    userEntry("u1", "a0", "question before compaction"),
    assistantEntry("a1", "u1", "work before compaction"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "context summary",
      firstKeptEntryId: "a0",
      tokensBefore: 100,
    },
    userEntry("u2", "cmp", "latest request"),
    assistantEntry("a2", "u2", "latest answer"),
  ];

  const context = buildSessionContext(entries, "a2", { tail: 5 });

  // The SDK context intentionally drops entries before firstKeptEntryId. A
  // bounded Reader page is a display window, so it must retain the question
  // that still lies inside that window while keeping the compaction card in
  // display order.
  assert.deepEqual(context.entryIds, ["cmp", "u1", "a1", "u2", "a2"]);
  assert.equal(context.messages[1].content, "question before compaction");
  assert.equal(context.messages[0].customType, "compaction");
});

test("returns a bounded page when the branch has several compactions", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "middle request"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp1", "middle answer"),
    userEntry("u3", "a2", "latest request"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "u3",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    assistantEntry("a3", "cmp2", "latest answer"),
  ];

  const context = buildSessionContext(entries, "a3", { tail: 2 });

  // The page is bounded to the raw tail — the newest compaction is its own
  // turn anchor, so u3 is not pulled back in. The older compaction stays
  // behind the pagination cursor instead of being sent on open.
  assert.deepEqual(context.entryIds, ["cmp2", "a3"]);
  assert.equal(context.entryIds.includes("cmp1"), false);
  assert.equal(context.entryIds.includes("u3"), false);
  assert.equal(context.hasMore, true);
});

test("uses the selected leaf's path before a later compaction", () => {
  const entries = [
    userEntry("u1", null, "root request"),
    assistantEntry("a1", "u1", "root answer"),
    userEntry("u2", "a1", "main branch"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "main branch summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries, "alt");

  assert.deepEqual(context.entryIds, ["u1", "a1", "alt"]);
  assert.equal(context.messages.some((message) => message.role === "custom"), false);
});

test("builds full display history from the selected leaf without mixing branches", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "kept request"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
    assistantEntry("a2", "cmp", "latest answer"),
    userEntry("alt", "a1", "alternate branch"),
  ];

  const context = buildSessionContext(entries);
  const full = buildFullSessionContext(entries, "a2");
  assert.deepEqual(full.entryIds, ["u1", "a1", "cmp", "u2", "a2"]);
  assert.equal(full.messages.at(-1).content[0].text, "latest answer");
  assert.equal(full.messages.some((message) => message.content === "alternate branch"), false);
  assert.deepEqual(buildSessionHistoryInfo(entries, "a2", context), {
    hasEarlierHistory: true,
    hasCompaction: true,
    totalMessages: 5,
  });
});

test("keeps the final answer after a trailing compaction in full history", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    userEntry("u2", "a1", "kept request"),
    assistantEntry("a2", "u2", "latest answer"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "a2",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "summary",
      firstKeptEntryId: "u2",
      tokensBefore: 100,
    },
  ];

  const full = buildFullSessionContext(entries, "cmp");
  assert.deepEqual(full.entryIds, ["u1", "a1", "cmp", "u2", "a2"]);
  assert.equal(full.messages.at(-1).content[0].text, "latest answer");
});

test("reveals one earlier compaction at a time without mixing branches", () => {
  const entries = [
    userEntry("u1", null, "old request"),
    assistantEntry("a1", "u1", "old answer"),
    {
      type: "compaction",
      id: "cmp1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:03.000Z",
      summary: "first compaction summary",
      firstKeptEntryId: "a1",
      tokensBefore: 100,
    },
    userEntry("u2", "cmp1", "middle request"),
    assistantEntry("a2", "u2", "middle answer"),
    {
      type: "compaction",
      id: "cmp2",
      parentId: "a2",
      timestamp: "2026-01-01T00:00:06.000Z",
      summary: "latest compaction summary",
      firstKeptEntryId: "a2",
      tokensBefore: 200,
    },
    userEntry("u3", "cmp2", "latest request"),
    assistantEntry("a3", "u3", "latest answer"),
    userEntry("alt", "a1", "alternate branch"),
  ];

  const latestStep = buildHistoryStepContext(entries, "a3", "u3");
  assert.deepEqual(latestStep.context.entryIds, ["cmp2", "a2", "u3", "a3"]);
  assert.equal(latestStep.history.hasCompaction, true);

  const firstStep = buildHistoryStepContext(entries, "a3", "cmp2");
  assert.deepEqual(firstStep.context.entryIds, ["cmp1", "a1", "u2", "cmp2", "a2", "u3", "a3"]);
  assert.equal(firstStep.history.hasEarlierHistory, true);
  assert.equal(firstStep.history.hasCompaction, true);
  assert.equal(firstStep.context.messages.some((message) => message.content === "alternate branch"), false);

  const secondStep = buildHistoryStepContext(entries, "a3", "cmp1");
  assert.deepEqual(secondStep.context.entryIds, ["u1", "cmp1", "a1", "u2", "cmp2", "a2", "u3", "a3"]);
  assert.equal(secondStep.history.hasEarlierHistory, false);
  assert.equal(secondStep.history.hasCompaction, true);
});

test("expands a non-compacted branch in one history step", () => {
  const entries = [
    userEntry("u1", null, "first request"),
    assistantEntry("a1", "u1", "first answer"),
    userEntry("u2", "a1", "latest request"),
    assistantEntry("a2", "u2", "latest answer"),
  ];

  const step = buildHistoryStepContext(entries, "a2", "u2");
  assert.deepEqual(step.context.entryIds, ["u1", "a1", "u2", "a2"]);
  assert.equal(step.history.hasEarlierHistory, false);
  assert.equal(step.history.hasCompaction, false);
});

test("returns an empty context for a null leaf", () => {
  const context = buildSessionContext([
    userEntry("u1", null, "not active"),
  ], null);

  assert.deepEqual(context.messages, []);
  assert.deepEqual(context.entryIds, []);
});

test("defers historical thinking without changing live-session content", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "large reasoning", thinkingSignature: "signature" },
          { type: "text", text: "answer", textSignature: "signature" },
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(deferred.messages[1].content[0], {
    type: "thinking",
    thinking: "",
    deferred: true,
  });
  assert.equal(Object.hasOwn(deferred.messages[1].content[0], "thinkingSignature"), false);
  assert.equal(Object.hasOwn(deferred.messages[1].content[1], "textSignature"), false);

  const full = buildSessionContext(entries);
  assert.equal(full.messages[1].content[0].thinking, "large reasoning");

  const largeToolEntries = [
    userEntry("tu", null, "tool"),
    assistantEntry("ta", "tu", "call"),
    {
      type: "message",
      id: "tr",
      parentId: "ta",
      timestamp: "2026-01-01T00:00:02.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call",
        content: [{ type: "text", text: "x".repeat(30_000) }],
      },
    },
  ];
  const deferredTool = buildSessionContext(largeToolEntries, "tr", {
    deferToolResultText: true,
    sessionId: "session-1",
  });
  const deferredResult = deferredTool.messages.find((message) => message.role === "toolResult");
  assert.equal(deferredResult.deferredText, true);
  assert.equal(deferredResult.entryId, "tr");
  assert.ok(deferredResult.content[0].text.length < 30_000);
});

test("preserves outer JSONL timestamps across history context paths", () => {
  const jsonl = [
    {
      type: "session",
      version: 3,
      id: "timing-session",
      timestamp: "2026-09-13T13:29:38.000Z",
      cwd: "/tmp/project",
    },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp: "2026-09-13T13:29:38.500Z",
      message: { role: "user", content: "run tools", timestamp: 1789306178500 },
    },
    {
      type: "message",
      id: "a1",
      parentId: "u1",
      timestamp: "2026-09-13T13:30:04.216Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        timestamp: 1789306179105,
        content: [
          { type: "thinking", thinking: "reasoning" },
          { type: "toolCall", toolCallId: "call-a", toolName: "read", input: {} },
        ],
      },
    },
    {
      type: "message",
      id: "r1",
      parentId: "a1",
      timestamp: "2026-09-13T13:30:05.144Z",
      message: {
        role: "toolResult",
        toolCallId: "call-a",
        timestamp: 1789306205144,
        content: [{ type: "text", text: "ok" }],
      },
    },
    {
      type: "message",
      id: "noise",
      parentId: "r1",
      timestamp: "2026-09-13T13:30:06.000Z",
      message: {
        role: "toolResult",
        toolCallId: "other-round",
        timestamp: 1789306206000,
        content: [{ type: "text", text: "unrelated" }],
      },
    },
    {
      type: "message",
      id: "a2",
      parentId: "noise",
      timestamp: "2026-09-13T13:30:07.500Z",
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        timestamp: 1789306206500,
        content: [{ type: "toolCall", toolCallId: "call-b", toolName: "write", input: {} }],
      },
    },
    {
      type: "message",
      id: "r2",
      parentId: "a2",
      timestamp: "2026-09-13T13:30:08.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call-b",
        timestamp: 1789306208000,
        content: [{ type: "text", text: "done" }],
      },
    },
  ].map((entry) => JSON.stringify(entry)).join("\n");
  const entries = jsonl.split("\n").map((line) => JSON.parse(line)).slice(1);
  const expectedUserDisplay = Date.parse("2026-09-13T13:29:38.500Z");
  const expectedAssistantEnd = Date.parse("2026-09-13T13:30:04.216Z");
  const expectedToolEnd = Date.parse("2026-09-13T13:30:05.144Z");

  const context = buildSessionContext(entries, "r2");
  const byId = new Map(context.entryIds.map((id, index) => [id, context.messages[index]]));
  assert.equal(byId.get("u1").displayTimestamp, expectedUserDisplay);
  assert.equal(byId.get("u1").timestamp, 1789306178500);
  assert.equal(byId.get("a1").entryTimestamp, expectedAssistantEnd);
  assert.equal(byId.get("r1").entryTimestamp, expectedToolEnd);
  assert.equal(byId.get("a2").entryTimestamp, Date.parse("2026-09-13T13:30:07.500Z"));

  const full = buildFullSessionContext(entries, "r2");
  const fullUser = full.messages[full.entryIds.indexOf("u1")];
  const fullA1 = full.messages[full.entryIds.indexOf("a1")];
  assert.equal(fullUser.displayTimestamp, expectedUserDisplay);
  assert.equal(fullA1.entryTimestamp, expectedAssistantEnd);

  const paged = buildSessionContext(entries, "r2", { tail: 100 });
  assert.equal(paged.messages[paged.entryIds.indexOf("u1")].displayTimestamp, expectedUserDisplay);
  assert.equal(paged.messages[paged.entryIds.indexOf("r1")].entryTimestamp, expectedToolEnd);

  const deferred = buildSessionContext(entries, "r2", {
    deferThinking: true,
    deferToolResultText: true,
    tail: 100,
  });
  assert.equal(deferred.messages[deferred.entryIds.indexOf("u1")].displayTimestamp, expectedUserDisplay);
  assert.equal(deferred.messages[deferred.entryIds.indexOf("a1")].entryTimestamp, expectedAssistantEnd);
  assert.equal(deferred.messages[deferred.entryIds.indexOf("r1")].entryTimestamp, expectedToolEnd);

  const history = buildHistoryStepContext(entries, "r2", "a1");
  assert.equal(history.context.messages[history.context.entryIds.indexOf("u1")].displayTimestamp, expectedUserDisplay);
  assert.equal(history.context.messages[history.context.entryIds.indexOf("a1")].entryTimestamp, expectedAssistantEnd);
});

test("keeps malformed historical thinking blocks from crashing deferred loads", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [{ type: "thinking", thinking: 123 }],
      },
    },
  ];

  assert.doesNotThrow(() => buildSessionContext(entries, undefined, { deferThinking: true }));
});

test("does not defer empty historical thinking blocks", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      ...assistantEntry("a1", "u1", "answer"),
      message: {
        role: "assistant",
        provider: "test",
        model: "test-model",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    },
  ];

  const context = buildSessionContext(entries, undefined, { deferThinking: true });
  assert.deepEqual(context.messages[1].content[0], { type: "thinking", thinking: "" });
});

test("defers only base64 images from historical tool results", () => {
  const userImage = {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "QUJDRA==" },
  };
  const toolImage = {
    type: "image",
    source: { type: "base64", media_type: "image/jpeg", data: "QUJDRA==" },
  };
  const toolUrlImage = {
    type: "image",
    source: { type: "url", url: "https://example.com/result.png" },
  };
  const flatToolImage = {
    type: "image",
    data: "QUJDRA==",
    mimeType: "image/png",
  };
  const entries = [
    userEntry("u1", null, [{ type: "text", text: "inspect this" }, userImage]),
    assistantEntry("a1", "u1", "reading"),
    {
      type: "message",
      id: "tr1",
      parentId: "a1",
      timestamp: "2026-01-01T00:00:01.000Z",
      message: {
        role: "toolResult",
        toolCallId: "call1",
        content: [
          { type: "text", text: "Read image file" },
          toolImage,
          flatToolImage,
          toolUrlImage,
        ],
      },
    },
  ];

  const deferred = buildSessionContext(entries, undefined, { deferToolResultImages: true });
  assert.deepEqual(deferred.messages[0].content[1], userImage);
  assert.deepEqual(deferred.messages[2].content[0], { type: "text", text: "Read image file" });
  assert.deepEqual(deferred.messages[2].content[1], toolUrlImage);
  assert.match(deferred.messages[2].content[2].text, /2 tool result images omitted.*image\/jpeg, image\/png.*~8 bytes/);

  const full = buildSessionContext(entries);
  assert.deepEqual(full.messages[2].content[1], toolImage);
  assert.deepEqual(full.messages[2].content[2], flatToolImage);
  assert.deepEqual(full.messages[2].content[3], toolUrlImage);
});

test("preserves hidden custom messages so the UI can render them collapsed", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "custom_message",
      id: "c1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "extension_debug",
      content: "hidden extension payload",
      display: false,
      details: { source: "test" },
    },
    assistantEntry("a1", "c1", "done"),
  ];

  const context = buildSessionContext(entries);

  assert.deepEqual(context.entryIds, ["u1", "c1", "a1"]);
  assert.equal(context.messages[1].role, "custom");
  assert.equal(context.messages[1].customType, "extension_debug");
  assert.equal(context.messages[1].display, false);
  assert.equal(context.messages[1].content, "hidden extension payload");
});

test("persists terminology custom entries without adding them to model context", () => {
  const entries = [
    userEntry("u1", null, "如何描述缓存问题？"),
    {
      type: "custom",
      id: "job1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:01.000Z",
      customType: "question-terminology",
      data: {
        version: 1,
        jobId: "job-1",
        targetEntryId: "u1",
        status: "pending",
        question: "如何描述缓存问题？",
        mode: "question",
        model: { provider: "openai", modelId: "gpt-test" },
        priorContext: "",
        context: { source: "none", summaryChars: 0, recentChars: 0, recentMessages: 0 },
        requestedAt: 1,
      },
    },
    assistantEntry("a1", "job1", "保留普通回答上下文"),
  ];
  const context = buildSessionContext(entries);
  assert.deepEqual(context.entryIds, ["u1", "a1"]);
  assert.equal(context.messages.some((message) => message.role === "custom" && message.customType === "question-terminology"), false);
  const jobs = getQuestionAnalysisJobsForBranch(entries, "a1");
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, "pending");
  assert.equal(jobs[0].targetEntryId, "u1");
});

test("exposes composer draft snapshots beside their target user entry only", () => {
  const entries = [
    userEntry("u1", null, "如何描述缓存问题？"),
    {
      type: "custom",
      id: "draft1",
      parentId: "u1",
      timestamp: "2026-01-01T00:00:02.000Z",
      customType: "question-draft",
      data: {
        version: 1,
        jobId: "draft-abc",
        targetEntryId: "u1",
        requestedAt: 2,
        result: { text: "- **缓存击穿**：……" },
        rewrite: { text: "如何用缓存击穿准确描述该问题？" },
      },
    },
    assistantEntry("a1", "draft1", "回答"),
    userEntry("u2", "a1", "另一分支提问"),
  ];
  const context = buildSessionContext(entries);
  assert.equal(context.messages.some((message) => message.role === "custom" && message.customType === "question-draft"), false);
  const draftViews = getQuestionDraftViewsForBranch(entries, "a1");
  const view = draftViews.get("u1");
  assert.equal(view.targetEntryId, "u1");
  assert.equal(view.result.text, "- **缓存击穿**：……");
  assert.equal(view.rewrite.text, "如何用缓存击穿准确描述该问题？");
});

test("preserves valid epoch timestamps on synthetic UI messages", () => {
  const entries = [
    userEntry("u1", null, "start"),
    {
      type: "compaction",
      id: "cmp",
      parentId: "u1",
      timestamp: "1970-01-01T00:00:00.000Z",
      summary: "epoch summary",
      firstKeptEntryId: "u1",
      tokensBefore: 10,
    },
  ];

  const context = buildSessionContext(entries);

  assert.equal(context.messages[0].role, "custom");
  assert.equal(context.messages[0].customType, "compaction");
  assert.equal(context.messages[0].timestamp, 0);
});

test("reads only a bounded session header, including headers larger than 4 KiB", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-"));
  const filePath = join(dir, "session.jsonl");
  const parentSession = `/tmp/${"p".repeat(5_000)}.jsonl`;
  writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id: "session",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: dir,
    parentSession,
    contextSourceSessionId: "source-session",
  })}\n${JSON.stringify(userEntry("u1", null, "message"))}\n`);

  try {
    assert.equal(readSessionHeader(filePath)?.parentSession, parentSession);
    assert.equal(readSessionHeader(filePath)?.contextSourceSessionId, "source-session");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("returns null for malformed or unbounded session headers", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-web-header-invalid-"));
  const malformedPath = join(dir, "malformed.jsonl");
  const oversizedPath = join(dir, "oversized.jsonl");
  writeFileSync(malformedPath, "{not-json}\n");
  writeFileSync(oversizedPath, "x".repeat(64 * 1024));

  try {
    assert.equal(readSessionHeader(malformedPath), null);
    assert.equal(readSessionHeader(oversizedPath), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("keeps forward and reverse session path caches in sync", async () => {
  const sessionId = "cache-test-session";
  const filePath = join(tmpdir(), "pi-web-cache-test", "..", "cache-test", "session.jsonl");

  cacheSessionPath(sessionId, filePath);
  try {
    assert.equal(
      await resolveSessionIdByPath(filePath),
      sessionId,
    );
  } finally {
    invalidateSessionPathCache(sessionId);
  }

  assert.equal(globalThis.__piSessionPathCache?.has(sessionId), false);
  assert.equal(globalThis.__piPathToSessionIdCache?.has(sessionPathKey(filePath)), false);
});

test("forced session listing bypasses the fresh server cache", async (t) => {
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  SessionManager.listAll = async () => {
    scans += 1;
    return [];
  };
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    resetSessionListState();
  });

  await listAllSessions({ force: true });
  await listAllSessions();
  assert.equal(scans, 1);

  await listAllSessions({ force: true });
  assert.equal(scans, 2);
});

test("scoped session listing resolves only selected projects without poisoning the full-list cache", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-selected-projects-")));
  const bin = join(root, "bin");
  const selected = join(root, "selected");
  const unrelated = join(root, "unrelated");
  const calls = join(root, "git-calls");
  for (const dir of [bin, selected, unrelated]) mkdirSync(dir);
  for (const dir of [selected, unrelated]) mkdirSync(join(dir, ".git"));
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$PI_TEST_GIT_CALLS"\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n');
  chmodSync(fakeGit, 0o755);
  const priorPath = process.env.PATH;
  const priorCalls = process.env.PI_TEST_GIT_CALLS;
  const originalListAll = SessionManager.listAll;
  const parentPath = join(root, "parent.jsonl");
  const selectedPath = join(root, "selected.jsonl");
  writeFileSync(parentPath, "{}\n");
  writeFileSync(selectedPath, "{}\n");
  SessionManager.listAll = async () => [
    { path: parentPath, id: "parent", cwd: unrelated, created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "parent" },
    { path: selectedPath, id: "selected", cwd: selected, parentSessionPath: parentPath, created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "selected" },
  ];
  process.env.PATH = `${bin}${delimiter}${priorPath ?? ""}`;
  process.env.PI_TEST_GIT_CALLS = calls;
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (priorPath === undefined) delete process.env.PATH; else process.env.PATH = priorPath;
    if (priorCalls === undefined) delete process.env.PI_TEST_GIT_CALLS; else process.env.PI_TEST_GIT_CALLS = priorCalls;
    globalThis.__piProjectCache?.delete(selected);
    globalThis.__piProjectCache?.delete(unrelated);
    resetSessionListState();
    rmSync(root, { recursive: true, force: true });
  });

  const emptyScope = await listAllSessions({ projectSessionIds: new Set() });
  assert.deepEqual(emptyScope.map((session) => session.id), ["parent", "selected"]);
  assert.equal(existsSync(calls), false);
  const scoped = await listAllSessions({ projectSessionIds: new Set(["selected"]) });
  assert.deepEqual(scoped.map((session) => session.id), ["parent", "selected"]);
  assert.equal(scoped.find((session) => session.id === "selected").parentSessionId, "parent");
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [selected]);
  assert.equal(scoped.find((session) => session.id === "parent").isGit, undefined);
  assert.equal(scoped.find((session) => session.id === "selected").isGit, true);

  const full = await listAllSessions();
  assert.equal(full.find((session) => session.id === "parent").isGit, true);
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [selected, unrelated]);
});

test("a scoped scan does not wait for an unrelated in-flight full scan", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-selected-concurrency-")));
  const bin = join(root, "bin");
  const selected = join(root, "selected");
  const unrelated = join(root, "unrelated");
  const calls = join(root, "git-calls");
  const release = join(root, "release");
  for (const dir of [bin, selected, unrelated]) mkdirSync(dir);
  for (const dir of [selected, unrelated]) mkdirSync(join(dir, ".git"));
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$PI_TEST_GIT_CALLS"\nif [ "$2" = "$PI_TEST_SLOW_PROJECT" ]; then while [ ! -f "$PI_TEST_RELEASE" ]; do /bin/sleep 0.05; done; fi\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n');
  chmodSync(fakeGit, 0o755);
  const previous = { path: process.env.PATH, calls: process.env.PI_TEST_GIT_CALLS, slow: process.env.PI_TEST_SLOW_PROJECT, release: process.env.PI_TEST_RELEASE };
  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => [
    { path: join(root, "selected.jsonl"), id: "selected", cwd: selected, created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "selected" },
    { path: join(root, "unrelated.jsonl"), id: "unrelated", cwd: unrelated, created: new Date(), modified: new Date(), messageCount: 1, firstMessage: "unrelated" },
  ];
  process.env.PATH = `${bin}${delimiter}${previous.path ?? ""}`;
  process.env.PI_TEST_GIT_CALLS = calls;
  process.env.PI_TEST_SLOW_PROJECT = unrelated;
  process.env.PI_TEST_RELEASE = release;
  resetSessionListState();
  let full;
  t.after(async () => {
    writeFileSync(release, "release\n");
    await full?.catch(() => {});
    SessionManager.listAll = originalListAll;
    for (const [name, value] of [["PATH", previous.path], ["PI_TEST_GIT_CALLS", previous.calls], ["PI_TEST_SLOW_PROJECT", previous.slow], ["PI_TEST_RELEASE", previous.release]]) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
    globalThis.__piProjectCache?.delete(selected);
    globalThis.__piProjectCache?.delete(unrelated);
    resetSessionListState();
    rmSync(root, { recursive: true, force: true });
  });

  full = listAllSessions();
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(calls) && readFileSync(calls, "utf8").split("\n").includes(unrelated)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(existsSync(calls) && readFileSync(calls, "utf8").split("\n").includes(unrelated), "the full scan must be blocked first");
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("scoped scan waited for unrelated Git")), 1500); });
  try {
    const scoped = await Promise.race([listAllSessions({ projectSessionIds: new Set(["selected"]) }), timeout]);
    assert.deepEqual(scoped.map((session) => session.id), ["selected", "unrelated"]);
    assert.equal(scoped[0].isGit, true);
  } finally {
    clearTimeout(timer);
  }
});

test("an invalidated scoped session scan retries without populating the full cache", async (t) => {
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  let release;
  let started;
  const firstStarted = new Promise((resolve) => { started = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  SessionManager.listAll = async () => {
    scans += 1;
    if (scans === 1) { started(); await gate; }
    return [];
  };
  resetSessionListState();
  t.after(() => { SessionManager.listAll = originalListAll; resetSessionListState(); });
  const listing = listAllSessions({ projectSessionIds: new Set() });
  await firstStarted;
  invalidateSessionListCache();
  release();
  assert.deepEqual(await listing, []);
  assert.equal(scans, 2);
  assert.equal(globalThis.__piSessionListCache, undefined);
});

test("read-only active and archived scans resolve only selected projects", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-selected-readonly-")));
  const bin = join(root, "bin");
  const selected = join(root, "selected");
  const unrelated = join(root, "unrelated");
  const calls = join(root, "git-calls");
  for (const dir of [bin, selected, unrelated]) mkdirSync(dir);
  for (const dir of [selected, unrelated]) mkdirSync(join(dir, ".git"));
  const fakeGit = join(bin, "git");
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$PI_TEST_GIT_CALLS"\nprintf "%s\\n" "$2/.git" "$2/.git" "$2" main\n');
  chmodSync(fakeGit, 0o755);
  const previous = { path: process.env.PATH, calls: process.env.PI_TEST_GIT_CALLS, agent: process.env.PI_CODING_AGENT_DIR };
  process.env.PATH = `${bin}${delimiter}${previous.path ?? ""}`;
  process.env.PI_TEST_GIT_CALLS = calls;
  process.env.PI_CODING_AGENT_DIR = join(root, "agent");
  resetSessionListState();
  resetSessionScanIndexForTests();
  t.after(() => {
    if (previous.path === undefined) delete process.env.PATH; else process.env.PATH = previous.path;
    if (previous.calls === undefined) delete process.env.PI_TEST_GIT_CALLS; else process.env.PI_TEST_GIT_CALLS = previous.calls;
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous.agent;
    globalThis.__piProjectCache?.delete(selected);
    globalThis.__piProjectCache?.delete(unrelated);
    resetSessionListState();
    resetSessionScanIndexForTests();
    rmSync(root, { recursive: true, force: true });
  });

  const roots = getPiSessionRoots();
  for (const [archived, sessionsRoot] of [[false, roots.sessionsDir], [true, roots.archivedSessionsDir]]) {
    const directory = join(sessionsRoot, "project");
    mkdirSync(directory, { recursive: true });
    const parent = join(directory, "2026-01-01_parent.jsonl");
    const child = join(directory, "2026-01-02_selected.jsonl");
    const header = (id, cwd, parentSession) => JSON.stringify({ type: "session", version: 3, id, cwd, parentSession, timestamp: "2026-01-01T00:00:00.000Z" });
    writeFileSync(parent, `${header("parent", unrelated)}\n`);
    writeFileSync(child, `${header("selected", selected, parent)}\n`);
    const options = { readOnly: true, projectSessionIds: new Set(["selected"]) };
    const sessions = archived ? await listArchivedSessions(options) : await listAllSessions(options);
    assert.deepEqual(new Set(sessions.map((session) => session.id)), new Set(["parent", "selected"]));
    assert.equal(sessions.find((session) => session.id === "selected").parentSessionId, "parent");
    assert.equal(sessions.find((session) => session.id === "selected").isGit, true);
    assert.equal(sessions.find((session) => session.id === "parent").isGit, undefined);
  }
  assert.deepEqual(readFileSync(calls, "utf8").trim().split("\n"), [selected]);
  assert.equal(globalThis.__piSessionListCache, undefined);
  assert.equal(globalThis.__piArchivedListCache, undefined);
});

test("project session listing scans only the selected repository and linked worktrees", async (t) => {
  const tempRoot = realpathSync(mkdtempSync(join(tmpdir(), "pi-web-project-session-scope-")));
  const repoRoot = join(tempRoot, "repo");
  const linkedWorktree = join(tempRoot, "linked");
  mkdirSync(repoRoot, { recursive: true });
  await execFileAsync("git", ["-C", repoRoot, "init"]);
  await execFileAsync("git", ["-C", repoRoot, "config", "user.name", "Pi Web Test"]);
  await execFileAsync("git", ["-C", repoRoot, "config", "user.email", "pi-web-test@example.invalid"]);
  await execFileAsync("git", ["-C", repoRoot, "config", "commit.gpgsign", "false"]);
  const readme = join(repoRoot, "README.md");
  writeFileSync(readme, "# test\n");
  await execFileAsync("git", ["-C", repoRoot, "add", "README.md"]);
  await execFileAsync("git", ["-C", repoRoot, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repoRoot, "worktree", "add", "-b", "feature/test", linkedWorktree]);

  const { sessionsDir } = getPiSessionRoots();
  const mainPath = join(sessionsDir, "project-scope-test", "main.jsonl");
  const linkedPath = join(sessionsDir, "project-scope-test", "linked.jsonl");
  mkdirSync(join(sessionsDir, "project-scope-test"), { recursive: true });
  writeFileSync(mainPath, "{}\n");
  writeFileSync(linkedPath, "{}\n");
  const sessionFor = (id, path, cwd) => ({
    path,
    id,
    cwd,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 1,
    firstMessage: id,
  });
  const sessionsByCwd = new Map([
    [repoRoot, [sessionFor("main-session", mainPath, repoRoot)]],
    [linkedWorktree, [sessionFor("linked-session", linkedPath, linkedWorktree)]],
  ]);
  const originalList = SessionManager.list;
  const originalListAll = SessionManager.listAll;
  const originalSubprojectRuntimes = globalThis.__piSubprojectStateRuntimes && new Map(globalThis.__piSubprojectStateRuntimes);
  resetSubprojectStateForTests();
  const sessionListGeneration = globalThis.__piSessionListGeneration ?? 0;
  const scannedDirectories = [];
  let globalScans = 0;
  SessionManager.list = async (cwd) => {
    scannedDirectories.push(cwd);
    return sessionsByCwd.get(cwd) ?? [];
  };
  SessionManager.listAll = async () => {
    globalScans += 1;
    return [...sessionsByCwd.values()].flat();
  };
  const runtimeSession = {
    ...sessionFor("runtime-session", join(tempRoot, "not-persisted.jsonl"), repoRoot),
    transient: true,
  };
  const worktreeRuntimeSession = {
    ...sessionFor("worktree-runtime-session", join(tempRoot, "worktree-not-persisted.jsonl"), linkedWorktree),
    transient: true,
  };
  const unrelatedRuntimeSession = {
    ...sessionFor("unrelated-runtime-session", join(tempRoot, "unrelated-not-persisted.jsonl"), join(tempRoot, "other-project")),
    transient: true,
  };
  t.after(() => {
    SessionManager.list = originalList;
    SessionManager.listAll = originalListAll;
    if (originalSubprojectRuntimes) globalThis.__piSubprojectStateRuntimes = originalSubprojectRuntimes;
    else resetSubprojectStateForTests();
    invalidateSessionPathCache("main-session");
    invalidateSessionPathCache("linked-session");
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const sessions = await listProjectSessions(repoRoot, [runtimeSession, worktreeRuntimeSession, unrelatedRuntimeSession]);

  assert.deepEqual(new Set(scannedDirectories), new Set([repoRoot, linkedWorktree]));
  assert.equal(globalScans, 0);
  assert.equal(globalThis.__piSubprojectStateRuntimes?.size ?? 0, 0);
  assert.equal(globalThis.__piSessionListGeneration ?? 0, sessionListGeneration);
  assert.deepEqual(sessions.map((session) => session.id).sort(), [
    "linked-session",
    "main-session",
    "runtime-session",
    "worktree-runtime-session",
  ]);
  assert.ok(sessions.every((session) => session.projectRoot === repoRoot));
});

test("a scan invalidated in flight retries before returning to its caller", async (t) => {
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  let releaseFirstScan;
  let markFirstScanStarted;
  const firstScanStarted = new Promise((resolve) => {
    markFirstScanStarted = resolve;
  });
  const firstScanGate = new Promise((resolve) => {
    releaseFirstScan = resolve;
  });
  SessionManager.listAll = async () => {
    scans += 1;
    if (scans === 1) {
      markFirstScanStarted();
      await firstScanGate;
    }
    return [];
  };
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    resetSessionListState();
  });

  const listing = listAllSessions({ force: true });
  await firstScanStarted;
  invalidateSessionListCache();
  releaseFirstScan();
  await listing;

  assert.equal(scans, 2);
});

test("disk sessions replace runtime snapshots with the same id", () => {
  const base = {
    path: "/tmp/session.jsonl",
    id: "same-id",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 2,
    firstMessage: "persisted",
  };
  const persisted = { ...base };
  const runtime = {
    ...base,
    path: "/tmp/not-written-yet.jsonl",
    modified: "2026-01-01T00:00:02.000Z",
    firstMessage: "runtime",
    transient: true,
  };
  const runtimeOnly = {
    ...runtime,
    id: "runtime-only",
    modified: "2026-01-01T00:00:03.000Z",
  };

  const merged = mergeSessionLists([persisted], [runtime, runtimeOnly]);

  assert.deepEqual(merged.map((session) => session.id), ["runtime-only", "same-id"]);
  assert.equal(merged[1], persisted);
  assert.equal(merged[1].transient, undefined);
});

test("drops moved runtime snapshots while retaining explicit transient sessions", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-merge-"));
  const livePath = join(tempRoot, "live.jsonl");
  const movedPath = join(tempRoot, "moved.jsonl");
  writeFileSync(livePath, "live\n");
  writeFileSync(movedPath, "moved\n");
  const info = (id, path, modified, extra = {}) => ({
    path,
    id,
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified,
    messageCount: 1,
    firstMessage: id,
    ...extra,
  });
  try {
    const stale = info("moved", movedPath, "2026-01-01T00:00:03.000Z");
    const live = info("live", livePath, "2026-01-01T00:00:02.000Z");
    const transient = info("pending", join(tempRoot, "pending.jsonl"), "2026-01-01T00:00:01.000Z", { transient: true });
    rmSync(movedPath);

    const merged = mergeSessionLists([], [stale, live, transient]);

    assert.deepEqual(merged.map((session) => session.id), ["live", "pending"]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("drops cached persisted snapshots after an active file moves to archive", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-cache-race-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalListAll = SessionManager.listAll;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
  const activePath = join(sessionsDir, "project", "session.jsonl");
  const archivedPath = join(archivedSessionsDir, "project", "session.jsonl");
  mkdirSync(join(sessionsDir, "project"), { recursive: true });
  writeFileSync(activePath, "session\n");
  const session = {
    path: activePath,
    id: "cached-session",
    cwd: tempRoot,
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 1,
    firstMessage: "cached",
  };
  SessionManager.listAll = async () => [session];
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetSessionListState();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const before = await listAllSessions({ force: true });
  assert.deepEqual(before.map((entry) => entry.id), ["cached-session"]);

  mkdirSync(join(archivedSessionsDir, "project"), { recursive: true });
  renameSync(activePath, archivedPath);

  assert.deepEqual(mergeSessionLists(before, []).map((entry) => entry.id), []);
  assert.deepEqual((await listAllSessions()).map((entry) => entry.id), []);
  assert.equal(await resolveSessionPath("cached-session", { archived: false }), null);
});

test("keeps archived runtime snapshots out of active lists", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-archive-merge-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  try {
    const { archivedSessionsDir } = getPiSessionRoots();
    const archivedPath = join(archivedSessionsDir, "project", "session.jsonl");
    mkdirSync(join(archivedSessionsDir, "project"), { recursive: true });
    writeFileSync(archivedPath, "archived\n");
    const runtime = {
      path: archivedPath,
      id: "archived-runtime",
      cwd: "/tmp",
      created: "2026-01-01T00:00:00.000Z",
      modified: "2026-01-01T00:00:01.000Z",
      messageCount: 1,
      firstMessage: "archived",
      transient: false,
    };

    assert.deepEqual(mergeSessionLists([], [runtime]), []);
    assert.deepEqual(
      mergeSessionLists([], [runtime], { includeArchived: true }).map((session) => session.id),
      ["archived-runtime"],
    );
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("an archived scan invalidated in flight retries before returning", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-archived-list-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalListAll = SessionManager.listAll;
  let scans = 0;
  let releaseFirstScan;
  let markFirstScanStarted;
  const firstScanStarted = new Promise((resolve) => {
    markFirstScanStarted = resolve;
  });
  const firstScanGate = new Promise((resolve) => {
    releaseFirstScan = resolve;
  });
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { archivedSessionsDir } = getPiSessionRoots();
  mkdirSync(join(archivedSessionsDir, "project"), { recursive: true });
  SessionManager.listAll = async () => {
    scans += 1;
    if (scans === 1) {
      markFirstScanStarted();
      await firstScanGate;
    }
    return [];
  };
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetSessionListState();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const listing = listArchivedSessions();
  await firstScanStarted;
  invalidateSessionListCache();
  releaseFirstScan();
  await listing;

  assert.equal(scans, 2);
});

test("listAllSessions retains persisted empty, named, and populated sessions", async (t) => {
  const originalListAll = SessionManager.listAll;
  SessionManager.listAll = async () => [
    {
      path: "/tmp/empty.jsonl",
      id: "empty-session",
      cwd: "/tmp/project",
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      name: undefined,
    },
    {
      path: "/tmp/named-empty.jsonl",
      id: "named-empty-session",
      cwd: "/tmp/project",
      created: new Date(),
      modified: new Date(),
      messageCount: 0,
      firstMessage: "",
      name: "custom-named",
    },
    {
      path: "/tmp/populated.jsonl",
      id: "populated-session",
      cwd: "/tmp/project",
      created: new Date(),
      modified: new Date(),
      messageCount: 1,
      firstMessage: "hello",
      name: undefined,
    },
  ];
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    resetSessionListState();
  });

  const sessions = await listAllSessions({ force: true });
  const ids = sessions.map((s) => s.id);
  assert.ok(ids.includes("empty-session"), "persisted empty session must be retained");
  assert.ok(ids.includes("named-empty-session"), "named 0-message session must be retained");
  assert.ok(ids.includes("populated-session"), "session with messages must be retained");
});


test("scanned session lists retain unnamed metadata-only session files", async (t) => {
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-empty-session-scan-"));
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { sessionsDir } = getPiSessionRoots();
  const projectDir = join(sessionsDir, "project");
  mkdirSync(projectDir, { recursive: true });
  const header = (id) => JSON.stringify({
    type: "session",
    version: 3,
    id,
    cwd: "/tmp/project",
    timestamp: "2026-01-01T00:00:00.000Z",
  });
  writeFileSync(join(projectDir, "2026-01-01_empty.jsonl"), `${header("empty-scan")}\n${JSON.stringify({ type: "model_change", id: "m", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "test", modelId: "test" })}\n`);
  writeFileSync(join(projectDir, "2026-01-01_populated.jsonl"), `${header("populated-scan")}\n${JSON.stringify(userEntry("u", null, "hello"))}\n`);
  resetSessionListState();
  t.after(() => {
    resetSessionListState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const sessions = await listAllSessions({ force: true });
  const ids = sessions.map((session) => session.id);
  assert.ok(ids.includes("empty-scan"));
  assert.ok(ids.includes("populated-scan"));
});

test("resolves a header session ID when SDK allocation used a different filename ID", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-header-id-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  resetSessionListState();
  try {
    const { sessionsDir } = getPiSessionRoots();
    const projectDir = join(sessionsDir, "project");
    const sessionId = "01a19374-3e90-744a-bcf5-d02096fccace";
    const allocationId = "01a19374-3e88-744a-bcf5-d01e93f23f47";
    const sessionFile = join(projectDir, `2026-01-01_${allocationId}.jsonl`);
    mkdirSync(projectDir, { recursive: true });
    writeFileSync(sessionFile, `${JSON.stringify({ type: "session", version: 3, id: sessionId, cwd: "/tmp/project" })}\n`);

    assert.equal(await resolveSessionPath(sessionId, { archived: false }), sessionFile);
    assert.equal(await resolveSessionPathReadOnly(sessionId), sessionFile);
  } finally {
    resetSessionListState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("keeps active and archived path resolution independent", async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-path-scope-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  resetSessionListState();
  try {
    const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
    const sessionId = "scoped-session";
    const active = join(sessionsDir, "project-a", `2026-01-01_${sessionId}.jsonl`);
    const archived = join(archivedSessionsDir, "project-a", `2026-01-01_${sessionId}.jsonl`);
    mkdirSync(join(sessionsDir, "project-a"), { recursive: true });
    mkdirSync(join(archivedSessionsDir, "project-a"), { recursive: true });
    const header = JSON.stringify({ type: "session", version: 3, id: sessionId });
    writeFileSync(active, `${header}\nactive\n`);
    writeFileSync(archived, `${header}\narchived\n`);

    // Simulate the old shared-cache failure: archived scan wins before an
    // active archive request resolves its source.
    cacheSessionPath(sessionId, archived);
    assert.equal(await resolveSessionPath(sessionId, { archived: false }), active);
    assert.equal(await resolveSessionPath(sessionId, { archived: true }), archived);
    assert.equal(await resolveSessionIdByPath(archived), sessionId);
    await assert.rejects(() => resolveSessionPath(sessionId), SessionPathConflictError);
  } finally {
    resetSessionListState();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("updateSessionListCachesForMove updates active and archived caches without full invalidation", async () => {
  resetSessionListState();
  const sessionA = {
    path: "/tmp/active/proj/2026-01-01_s1.jsonl",
    id: "s1",
    cwd: "/tmp",
    created: "2026-01-01T00:00:00.000Z",
    modified: "2026-01-01T00:00:01.000Z",
    messageCount: 1,
    firstMessage: "hello",
  };
  globalThis.__piSessionListCache = { data: [{ ...sessionA }], ts: Date.now() };
  globalThis.__piArchivedListCache = { data: [], ts: Date.now() };

  // Move s1 to archive
  updateSessionListCachesForMove("s1", sessionA.path, "/tmp/archived/proj/2026-01-01_s1.jsonl", true);

  assert.equal(globalThis.__piSessionListCache.data.length, 0);
  assert.equal(globalThis.__piArchivedListCache.data.length, 1);
  assert.equal(globalThis.__piArchivedListCache.data[0].id, "s1");
  assert.equal(globalThis.__piArchivedListCache.data[0].archived, true);
  assert.equal(globalThis.__piArchivedListCache.data[0].path, "/tmp/archived/proj/2026-01-01_s1.jsonl");

  // Move s1 back to active (unarchive)
  updateSessionListCachesForMove("s1", "/tmp/archived/proj/2026-01-01_s1.jsonl", sessionA.path, false);

  assert.equal(globalThis.__piSessionListCache.data.length, 1);
  assert.equal(globalThis.__piSessionListCache.data[0].id, "s1");
  assert.equal(globalThis.__piSessionListCache.data[0].archived, undefined);
  assert.equal(globalThis.__piSessionListCache.data[0].path, sessionA.path);
  assert.equal(globalThis.__piArchivedListCache.data.length, 0);
  resetSessionListState();
});


test("session lists use persisted prompt-template input for the first message", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-display-input-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalListAll = SessionManager.listAll;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { sessionsDir } = getPiSessionRoots();
  const sessionPath = join(sessionsDir, "project", "session.jsonl");
  mkdirSync(join(sessionsDir, "project"), { recursive: true });
  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: "display-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempRoot }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "expanded prompt instructions" } }),
    JSON.stringify({ type: "custom", id: "display-1", parentId: "user-1", timestamp: "2026-01-01T00:00:01.001Z", customType: "pi-web:display-input", data: { targetEntryId: "user-1", input: "/review src/main.ts" } }),
    "",
  ].join("\n"));
  SessionManager.listAll = async () => [{
    path: sessionPath,
    id: "display-session",
    cwd: tempRoot,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:01.000Z"),
    messageCount: 1,
    firstMessage: "expanded prompt instructions",
  }];
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetSessionListState();
    globalThis.__piSessionReadCache = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const sessions = await listAllSessions({ force: true });
  assert.equal(sessions.find((session) => session.id === "display-session")?.firstMessage, "/review src/main.ts");
});

test("session listing does not thrash getSessionReadSnapshot cache", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-session-read-cache-thrash-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalListAll = SessionManager.listAll;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { sessionsDir } = getPiSessionRoots();
  const sessionPath = join(sessionsDir, "project", "large-session.jsonl");
  mkdirSync(join(sessionsDir, "project"), { recursive: true });
  writeFileSync(sessionPath, [
    JSON.stringify({ type: "session", version: 3, id: "perf-session", timestamp: "2026-01-01T00:00:00.000Z", cwd: tempRoot }),
    JSON.stringify({ type: "message", id: "user-1", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: "expanded instructions" } }),
    JSON.stringify({ type: "custom", id: "display-1", parentId: "user-1", timestamp: "2026-01-01T00:00:01.001Z", customType: "pi-web:display-input", data: { targetEntryId: "user-1", input: "/fast-test" } }),
    JSON.stringify({ type: "message", id: "assistant-1", parentId: "user-1", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "assistant", content: "response" } }),
    "",
  ].join("\n"));
  SessionManager.listAll = async () => [{
    path: sessionPath,
    id: "perf-session",
    cwd: tempRoot,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:01.000Z"),
    messageCount: 2,
    firstMessage: "expanded instructions",
  }];
  resetSessionListState();
  globalThis.__piSessionReadCache = undefined;
  globalThis.__piFirstMessageCache = undefined;
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetSessionListState();
    globalThis.__piSessionReadCache = undefined;
    globalThis.__piFirstMessageCache = undefined;
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const sessions = await listAllSessions({ force: true });
  assert.equal(sessions.find((session) => session.id === "perf-session")?.firstMessage, "/fast-test");
  // Crucial check: getSessionReadSnapshot was NOT called, so __piSessionReadCache remains empty!
  assert.equal(globalThis.__piSessionReadCache, undefined, "session listing must not populate or thrash full session read snapshot cache");
  assert.ok(globalThis.__piFirstMessageCache?.has(sessionPath), "first message display must be cached in __piFirstMessageCache");
});


test("active and archived session lists preserve context source metadata from the JSONL header", async (t) => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pi-web-context-source-list-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const originalListAll = SessionManager.listAll;
  process.env.PI_CODING_AGENT_DIR = join(tempRoot, "agent");
  const { sessionsDir, archivedSessionsDir } = getPiSessionRoots();
  const activePath = join(sessionsDir, "project", "active.jsonl");
  const archivedPath = join(archivedSessionsDir, "project", "archived.jsonl");
  mkdirSync(join(sessionsDir, "project"), { recursive: true });
  mkdirSync(join(archivedSessionsDir, "project"), { recursive: true });

  const makeFile = (filePath, id) => writeFileSync(filePath, `${JSON.stringify({
    type: "session",
    version: 3,
    id,
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: tempRoot,
    contextSourceSessionId: "source-session",
  })}\n${JSON.stringify(userEntry(`${id}-user`, null, "injected"))}\n`);
  makeFile(activePath, "active-context-child");
  makeFile(archivedPath, "archived-context-child");
  const makeInfo = (path, id) => ({
    path,
    id,
    cwd: tempRoot,
    created: new Date("2026-01-01T00:00:00.000Z"),
    modified: new Date("2026-01-01T00:00:01.000Z"),
    messageCount: 1,
    firstMessage: "injected",
  });
  const activeInfo = makeInfo(activePath, "active-context-child");
  const archivedInfo = makeInfo(archivedPath, "archived-context-child");
  SessionManager.listAll = async (directoryOrProgress) => typeof directoryOrProgress === "string" ? [archivedInfo] : [activeInfo];
  resetSessionListState();
  t.after(() => {
    SessionManager.listAll = originalListAll;
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    resetSessionListState();
    rmSync(tempRoot, { recursive: true, force: true });
  });

  const active = await listAllSessions({ force: true });
  const archived = await listArchivedSessions({ force: true });
  assert.equal(active[0]?.contextSourceSessionId, "source-session");
  assert.equal(archived[0]?.contextSourceSessionId, "source-session");
});
