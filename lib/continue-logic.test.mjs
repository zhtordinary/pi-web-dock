import test from "node:test";
import assert from "node:assert/strict";

async function loadSubject() {
  return import("./continue-logic.ts");
}

function assistant(overrides = {}) {
  return {
    role: "assistant",
    content: [],
    model: "m",
    provider: "p",
    stopReason: "error",
    timestamp: 1,
    ...overrides,
  };
}

test("isTransientErrorMessage matches connection errors and rejects fatal errors", async () => {
  const { isTransientErrorMessage } = await loadSubject();
  assert.equal(isTransientErrorMessage("Connection error."), true);
  assert.equal(isTransientErrorMessage("Request timed out."), true);
  assert.equal(isTransientErrorMessage("upstream 503"), true);
  assert.equal(isTransientErrorMessage("API key invalid"), false);
  assert.equal(isTransientErrorMessage("Context window exceeded"), false);
  assert.equal(isTransientErrorMessage(""), false);
});

test("prefers explicit HTTP status over broad fallback words", async () => {
  const { extractHttpStatus, isTransientErrorMessage } = await loadSubject();
  assert.equal(extractHttpStatus("OpenAI API error (404): upstream route missing"), 404);
  assert.equal(extractHttpStatus('{"status": 429, "message": "slow down"}'), 429);
  assert.equal(extractHttpStatus('{"status_code": 404, "message": "not found"}'), 404);
  assert.equal(isTransientErrorMessage("OpenAI API error (404): upstream route missing"), false);
  assert.equal(isTransientErrorMessage("HTTP 401: invalid api key"), false);
  assert.equal(isTransientErrorMessage("HTTP 403: permission denied"), false);
  assert.equal(isTransientErrorMessage("HTTP 429: rate limit"), true);
  assert.equal(isTransientErrorMessage("HTTP 503: service unavailable"), true);
  assert.equal(isTransientErrorMessage("HTTP 418: timeout text"), false);
});

test("treats structured 409 upstream failures as transient but plain conflicts as fatal", async () => {
  const { isTransientErrorMessage, classifyAssistantMessage, nextSchedulerState } = await loadSubject();
  const upstream409 = 'OpenAI API error (409): {"message":"Upstream request failed","type":"upstream_error"}';
  const upstreamMessage = assistant({ errorMessage: upstream409 });
  assert.equal(isTransientErrorMessage(upstream409), true);
  assert.equal(classifyAssistantMessage(upstreamMessage), "transient");
  assert.equal(nextSchedulerState([
    { role: "user", content: "继续", timestamp: 1 },
    upstreamMessage,
  ], null)?.active, true);

  const conflict409 = "OpenAI API error (409): conflict";
  assert.equal(isTransientErrorMessage(conflict409), false);
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: conflict409 })), "fatal");
});

test("parses Retry-After hints without changing the fallback delay", async () => {
  const { retryAfterMsFromError, nextBackoffDelayMs, BACKOFF_START_MS } = await loadSubject();
  assert.equal(retryAfterMsFromError("Retry-After: 120"), 120_000);
  assert.equal(retryAfterMsFromError("retry_after: 1.5 minutes"), 90_000);
  assert.equal(retryAfterMsFromError("no retry hint"), null);
  assert.equal(nextBackoffDelayMs(0), BACKOFF_START_MS);
  assert.equal(nextBackoffDelayMs(0, "turn-1", "HTTP 429; Retry-After: 45"), 45_000);
  assert.equal(nextBackoffDelayMs(0, "turn-1", "HTTP 429; Retry-After: 5"), BACKOFF_START_MS);
});

test("uses deterministic bounded jitter for different unattended turns", async () => {
  const { nextBackoffDelayMs, BACKOFF_START_MS, BACKOFF_MAX_MS } = await loadSubject();
  const first = nextBackoffDelayMs(0, "turn-1");
  const same = nextBackoffDelayMs(0, "turn-1");
  const second = nextBackoffDelayMs(0, "turn-2");
  assert.equal(first, same);
  assert.ok(first >= BACKOFF_START_MS * 0.9);
  assert.ok(first <= BACKOFF_START_MS * 1.1);
  assert.ok(second >= BACKOFF_START_MS * 0.9);
  assert.ok(second <= BACKOFF_START_MS * 1.1);
  assert.ok(nextBackoffDelayMs(50, "turn-1") <= BACKOFF_MAX_MS);
});

test("classifies empty error assistant as transient for 502/503/timeout", async () => {
  const { classifyAssistantMessage } = await loadSubject();
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: 'OpenAI API error (502): {"message":"Upstream service temporarily unavailable"}' })), "transient");
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: 'OpenAI API error (503): {"message":"Service temporarily unavailable"}' })), "transient");
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: "Request timed out." })), "transient");
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: "Our servers are currently overloaded. Please try again later." })), "transient");
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: "stream_read_error" })), "transient");
  const eof500 = 'OpenAI API error (500): {"message":"Post \"https://cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse\": EOF","type":"server_error","code":"internal_server_error"}';
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: eof500 })), "transient");
});

test("classifies context overflow separately", async () => {
  const { classifyAssistantMessage } = await loadSubject();
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: "Error Code context_too_large: Your input exceeds the context window" })), "overflow");
  assert.equal(classifyAssistantMessage(assistant({ stopReason: "length", errorMessage: "output length" })), "overflow");
});

test("classifies unknown errors as fatal but still schedules manual-Continue failures", async () => {
  const { classifyAssistantMessage, nextSchedulerState } = await loadSubject();
  const notFound = assistant({ errorMessage: "OpenAI API error (404): model not found" });
  assert.equal(classifyAssistantMessage(notFound), "fatal");
  assert.equal(classifyAssistantMessage(assistant({ errorMessage: "invalid api key" })), "fatal");
  assert.equal(nextSchedulerState([
    { role: "user", content: "检查项目", timestamp: 1 },
    notFound,
  ], null)?.active, true);
});

test("retries failed output but never auto-treats aborted or successful turns", async () => {
  const { classifyAssistantMessage } = await loadSubject();
  assert.equal(classifyAssistantMessage(assistant({ stopReason: "aborted", errorMessage: "Request aborted" })), "none");
  assert.equal(classifyAssistantMessage(assistant({ stopReason: "error", errorMessage: "502", content: [{ type: "text", text: "partial output" }] })), "transient");
  assert.equal(classifyAssistantMessage(assistant({ stopReason: "toolUse", content: [{ type: "toolCall", toolCallId: "1", toolName: "bash", input: {} }] })), "none");
  assert.equal(classifyAssistantMessage(undefined), "none");
});

test("disconnect error with partial thinking and toolCall uses manual Continue retry path", async () => {
  const {
    classifyAssistantMessage,
    continueRetryIndex,
    continueRetryMode,
    hasPreviousContinueWithoutOutput,
    nextSchedulerState,
  } = await loadSubject();
  const failed = assistant({
    stopReason: "error",
    errorMessage: "stream error: stream disconnected before completion: stream closed before response.completed",
    content: [
      { type: "thinking", thinking: "planning" },
      { type: "toolCall", toolCallId: "call-1", toolName: "bash", input: {} },
    ],
  });
  const automaticTail = [
    { role: "user", content: "检查项目", timestamp: 1 },
    failed,
  ];
  assert.equal(classifyAssistantMessage(failed), "transient");
  assert.equal(nextSchedulerState(automaticTail, null)?.active, true);
  assert.equal(continueRetryIndex(automaticTail), 0);
  assert.equal(continueRetryMode(automaticTail), "continue");
  assert.equal(hasPreviousContinueWithoutOutput(automaticTail), false);

  const manualTail = [
    ...automaticTail,
    { role: "user", content: "继续", timestamp: 2 },
  ];
  assert.equal(continueRetryMode(manualTail), "continue");
});

test("finds last assistant message and classifies it", async () => {
  const { lastAssistantClassification } = await loadSubject();
  const msgs = [
    { role: "user", content: "hi" },
    assistant({ timestamp: 1, errorMessage: "502" }),
    { role: "user", content: "继续" },
    assistant({ timestamp: 2, errorMessage: "timeout" }),
  ];
  const last = lastAssistantClassification(msgs);
  assert.equal(last.kind, "transient");
  assert.equal(last.msg.timestamp, 2);
});

test("detects manual user messages but not the continue message itself", async () => {
  const { lastUserMessageIsManual } = await loadSubject();
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "继续" }]), false);
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "  继续  " }]), false);
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "换个方案" }]), true);
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "继续" }, { role: "assistant", content: [] }]), false);
  // user message with image blocks and no text is manual
  assert.equal(lastUserMessageIsManual([{ role: "user", content: [{ type: "image", data: "x", mimeType: "image/png" }] }]), true);
});

test("recognizes a previous continue with no effective assistant output", async () => {
  const { hasPreviousContinueWithoutOutput } = await loadSubject();
  assert.equal(hasPreviousContinueWithoutOutput([
    { role: "user", content: "继续" },
    { role: "custom", customType: "honcho-memory-context", content: "memory", display: true },
    assistant({ errorMessage: "Request timed out." }),
  ]), true);
  assert.equal(hasPreviousContinueWithoutOutput([
    { role: "user", content: "继续" },
    assistant({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
  ]), false);
  assert.equal(hasPreviousContinueWithoutOutput([
    { role: "user", content: "继续" },
    { role: "toolResult", toolCallId: "1", content: [], isError: true },
    assistant({ errorMessage: "Request timed out." }),
  ]), true);
  assert.equal(hasPreviousContinueWithoutOutput([{ role: "user", content: "先换个方案" }]), false);
});

test("uses the latest continue when earlier continue attempts had no output", async () => {
  const { hasPreviousContinueWithoutOutput } = await loadSubject();
  assert.equal(hasPreviousContinueWithoutOutput([
    { role: "user", content: "继续" },
    assistant({ errorMessage: "timeout" }),
    { role: "user", content: "继续" },
    assistant({ errorMessage: "timeout" }),
  ]), true);
});
test("selects retry mode for user and failed-assistant tails", async () => {
  const { continueRetryMode } = await loadSubject();
  assert.equal(continueRetryMode([
    assistant({ errorMessage: "overloaded" }),
    { role: "user", content: "继续" },
  ]), "continue");
  assert.equal(continueRetryMode([
    { role: "user", content: "继续" },
    assistant({ errorMessage: "overloaded" }),
  ]), "continue");
  assert.equal(continueRetryMode([
    { role: "user", content: "继续" },
    assistant({ stopReason: "stop", content: [{ type: "text", text: "done" }] }),
  ]), "none");
});

test("system loadout messages do not hide interrupted user or tool-result turns", async () => {
  const { continueRetryIndex, continueRetryMode } = await loadSubject();
  const system = { role: "system", content: "", sections: { task: "keep these instructions" }, timestamp: 2 };
  for (const anchor of [
    { role: "user", content: "resume my task", timestamp: 1 },
    { role: "toolResult", toolCallId: "tool-1", content: [], timestamp: 1 },
  ]) {
    for (const tail of [[system], [system, assistant({ errorMessage: "HTTP 503" })], [system, assistant({ errorMessage: "HTTP 503" }), system]]) {
      const messages = [anchor, ...tail];
      assert.equal(continueRetryIndex(messages), 0);
      assert.equal(continueRetryMode(messages), "continue");
    }
  }
});

test("system metadata cannot turn completed, canceled or empty histories into retries", async () => {
  const { continueRetryMode } = await loadSubject();
  const system = { role: "system", content: "instructions" };
  for (const stopReason of ["stop", "aborted"]) {
    assert.equal(continueRetryMode([
      { role: "user", content: "task" },
      assistant({ stopReason, errorMessage: "", content: [{ type: "text", text: "done" }] }),
      system,
    ]), "none");
  }
  assert.equal(continueRetryMode([system]), "none");
});

test("custom display messages do not block retry mode", async () => {
  const { continueRetryIndex, continueRetryMode } = await loadSubject();
  const messages = [
    { role: "user", content: "你是哪个模型？" },
    assistant({ errorMessage: "Request timed out." }),
    { role: "custom", customType: "honcho-memory-context", content: "memory", display: true },
  ];
  assert.equal(continueRetryIndex(messages), 0);
  assert.equal(continueRetryMode(messages), "continue");
});

test("bare failed assistant tail is retryable without a user continue", async () => {
  const { continueRetryMode } = await loadSubject();
  // A session that never inserted user:继续 (unattended auto-retry path) must
  // still be retryable by removing the failed assistant and resuming the
  // previous user turn.
  assert.equal(continueRetryMode([
    { role: "user", content: "你是哪个模型？" },
    assistant({ errorMessage: "Our servers are currently overloaded. Please try again later." }),
  ]), "continue");
  assert.equal(continueRetryMode([
    { role: "user", content: "你是哪个模型？" },
    assistant({ stopReason: "aborted", errorMessage: "Request aborted" }),
  ]), "none");
  assert.equal(continueRetryMode([
    { role: "user", content: "你是哪个模型？" },
    assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }),
  ]), "none");
});

test("a chain of failed assistants strips back to the last real turn", async () => {
  const { continueRetryIndex, continueRetryMode } = await loadSubject();
  // Regression: repeated unattended retries append one empty failed assistant
  // per attempt; slicing only the last one left another assistant at the tail
  // and Agent.continue() threw "Cannot continue from message role: assistant".
  const chain = [
    { role: "user", content: "你好" },
    assistant({ timestamp: 2, errorMessage: "Request timed out." }),
    assistant({ timestamp: 3, errorMessage: "Request timed out." }),
    assistant({ timestamp: 4, errorMessage: "Request timed out." }),
  ];
  assert.equal(continueRetryIndex(chain), 0);
  assert.equal(continueRetryMode(chain), "continue");
  // Trailing custom entries must not hide the chain.
  const withCustom = [...chain, { role: "custom", customType: "plan-mode-state", content: "{}", display: true }];
  assert.equal(continueRetryIndex(withCustom), 0);
  assert.equal(continueRetryMode(withCustom), "continue");
  // An aborted assistant stops the walk: never auto-retry user cancellation.
  const aborted = [
    { role: "user", content: "你好" },
    assistant({ timestamp: 2, errorMessage: "Request timed out." }),
    assistant({ stopReason: "aborted", errorMessage: "Request aborted" }),
  ];
  assert.equal(continueRetryIndex(aborted), 2);
  assert.equal(continueRetryMode(aborted), "none");
  // A completed assistant below the chain must not be retried.
  const completed = [
    { role: "user", content: "你好" },
    assistant({ stopReason: "stop", timestamp: 2, content: [{ type: "text", text: "ok" }] }),
    assistant({ timestamp: 3, errorMessage: "Request timed out." }),
  ];
  assert.equal(continueRetryIndex(completed), 1);
  assert.equal(continueRetryMode(completed), "none");
});

test("backoff doubles from 30s to a 9min cap", async () => {
  const { nextBackoffDelayMs, BACKOFF_START_MS, BACKOFF_MAX_MS, MAX_AUTO_ATTEMPTS } = await loadSubject();
  assert.equal(BACKOFF_START_MS, 30_000);
  assert.equal(nextBackoffDelayMs(0), 30_000);
  assert.equal(nextBackoffDelayMs(1), 60_000);
  assert.equal(nextBackoffDelayMs(2), 120_000);
  assert.equal(nextBackoffDelayMs(3), 240_000);
  assert.equal(nextBackoffDelayMs(4), 480_000);
  assert.equal(nextBackoffDelayMs(5), 540_000);
  assert.equal(nextBackoffDelayMs(50), BACKOFF_MAX_MS);
  assert.equal(BACKOFF_MAX_MS, 540_000);
  assert.equal(MAX_AUTO_ATTEMPTS, 100);
});

test("scheduler keeps turn key and exposes retry deadline", async () => {
  const { nextSchedulerState } = await loadSubject();
  const messages = [
    { role: "user", content: "你是哪个模型？", timestamp: 10 },
    assistant({ timestamp: 11, errorMessage: "Request timed out." }),
  ];
  const first = nextSchedulerState(messages, null);
  assert.equal(first.active, true);
  assert.equal(typeof first.nextRetryAt, "number");
  const second = nextSchedulerState([
    messages[0],
    assistant({ timestamp: 12, errorMessage: "Request timed out." }),
  ], first);
  assert.equal(second, null);
});

test("error keys are stable per error and differ across errors", async () => {
  const { errorKey } = await loadSubject();
  const a = assistant({ timestamp: 5, errorMessage: "502 boom" });
  const b = assistant({ timestamp: 5, errorMessage: "502 boom" });
  const c = assistant({ timestamp: 6, errorMessage: "502 boom" });
  assert.equal(errorKey(a), errorKey(b));
  assert.notEqual(errorKey(a), errorKey(c));
});

test("user prompt alone after stripped assistant is retryable via continue", async () => {
  const { continueRetryMode } = await loadSubject();
  assert.equal(continueRetryMode([{ role: "user", content: "你是哪个模型？" }]), "continue");
  assert.equal(continueRetryMode([
    { role: "user", content: "hi" },
    assistant({ stopReason: "stop", content: [{ type: "text", text: "ok" }] }),
    { role: "user", content: "你是哪个模型？" },
  ]), "continue");
});

test("manual user tail detection does not classify active scheduled turn as manual cancellation", async () => {
  const { lastUserMessageIsManual, CONTINUE_TEXT } = await loadSubject();
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "你是哪个模型？", timestamp: 10 }], CONTINUE_TEXT, "user:10:你是哪个模型？"), false);
  assert.equal(lastUserMessageIsManual([{ role: "user", content: "换个方案", timestamp: 20 }], CONTINUE_TEXT, "user:10:你是哪个模型？"), true);
});

test("maximum unattended attempts stop retry without changing the error tail", async () => {
  const { MAX_AUTO_ATTEMPTS, nextSchedulerState } = await loadSubject();
  const current = {
    active: false,
    reason: "error",
    attempt: MAX_AUTO_ATTEMPTS,
    nextDelayMs: null,
    errorMessage: "invalid api key",
    nextRetryAt: null,
    key: "user:1:hello",
  };
  const next = nextSchedulerState([
    { role: "user", content: "hello", timestamp: 1 },
    assistant({ errorMessage: "invalid api key" }),
  ], current);
  assert.deepEqual(next, {
    active: false,
    reason: "limit",
    attempt: MAX_AUTO_ATTEMPTS,
    nextDelayMs: null,
    errorMessage: "invalid api key",
    nextRetryAt: null,
    key: null,
  });
});

test("aborted assistant cancels scheduled retry with manual reason", async () => {
  const { nextSchedulerState } = await loadSubject();
  const current = {
    active: true,
    reason: "error",
    attempt: 1,
    nextDelayMs: 30000,
    errorMessage: "502",
    nextRetryAt: Date.now() + 30000,
    key: "user:1:hello",
  };
  const msgs = [
    { role: "user", content: "hello", timestamp: 1 },
    assistant({ stopReason: "aborted", errorMessage: "Operation aborted" }),
  ];
  const next = nextSchedulerState(msgs, current);
  assert.deepEqual(next, {
    active: false,
    reason: "manual",
    attempt: 0,
    nextDelayMs: null,
    errorMessage: null,
    nextRetryAt: null,
    key: null,
  });
});
