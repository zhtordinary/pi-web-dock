import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const testAgentDir = mkdtempSync(join(tmpdir(), "reader-control-test-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
test.after(() => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  rmSync(testAgentDir, { recursive: true, force: true });
});
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const { createSessionControlExtension, projectInspectState } = await jiti.import("./session-control.ts");

function registerDefinition() {
  let definition;
  createSessionControlExtension().factory({
    registerTool(value) {
      definition = value;
    },
  });
  assert.ok(definition, "session_control must register a tool");
  return definition;
}

test("session_control exposes scenario actions and static routing guidance", () => {
  const definition = registerDefinition();
  const schema = JSON.stringify(definition.parameters);
  assert.match(schema, /create_session/);
  for (const action of [
    "list_sessions",
    "inspect",
    "pending_ui",
    "answer_ui",
    "read_context",
    "read_history",
    "wait_for",
    "prompt",
    "steer",
    "follow_up",
    "retract_follow_up",
    "abort",
    "reply",
    "message_status",
  ]) {
    assert.match(schema, new RegExp(`\\\"${action}\\\"`));
  }
  assert.ok(definition.promptSnippet.includes("another AI/session"));
  assert.match(definition.promptSnippet, /user-authorized task/);
  assert.doesNotMatch(definition.promptSnippet, /only.*explicit user request/i);
  assert.match(definition.promptGuidelines[0], /Do not call/);
  assert.match(definition.promptGuidelines[2], /replyRef/);
  assert.match(definition.promptGuidelines[2], /Use follow_up for a deliberately queued new instruction/);
  assert.match(definition.description, /Git shows WIP/);
  assert.match(definition.description, /use reply with the visible replyRef/);
  assert.equal(definition.promptGuidelines.length, 4);
  assert.match(definition.promptGuidelines[3], /peer kind=question is a message, not a popup/);
  assert.match(definition.promptGuidelines[3], /Never infer permission/);
  assert.match(schema, /messageId/);
  assert.match(schema, /first user question/);
  assert.match(schema, /starts the model/);
  assert.match(schema, /workStatus/);
  assert.match(schema, /Only for action=reply/);
  assert.match(definition.description, /transport acceptance/);
});

test("create_session persists a native initial message through the durable protocol", async () => {
  const creates = [];
  const { createSessionControlExtension } = await jiti.import("./session-control.ts");
  let definition;
  createSessionControlExtension({
    createSession: async (request) => {
      creates.push(request);
      return {
        sessionId: "new-parent",
        sessionFile: "/fixture/new-parent.jsonl",
        persisted: true,
        visibleInSessionList: true,
        nativeListVisible: true,
        runtimeVisibleInReader: true,
        runtimeCreated: true,
        source: "agent-message",
        messageKind: "agent-initial-message",
        messageDigest: "digest",
        success: true,
        status: "created",
        idempotencyKey: request.idempotencyKey,
        scope: request.scope,
        initialMessageDigest: "digest",
        reused: false,
        durability: "durable",
      };
    },
  }).factory({ registerTool(value) { definition = value; } });
  const context = {
    cwd: "/fixture/project",
    sessionManager: {
      getSessionId: () => "caller",
      getSessionFile: () => "/fixture/caller.jsonl",
      getHeader: () => ({ id: "caller", cwd: "/fixture/project" }),
    },
  };
  const created = JSON.parse((await definition.execute("create", {
    action: "create_session",
    idempotencyKey: "create-1",
    initialMessage: "Open the new parent",
  }, undefined, undefined, context)).content[0].text);
  assert.deepEqual(created, {
    success: true,
    sessionId: "new-parent",
    sessionFile: "/fixture/new-parent.jsonl",
    persisted: true,
    visibleInSessionList: true,
    nativeListVisible: true,
    runtimeVisibleInReader: true,
    runtimeCreated: true,
    source: "agent-message",
    messageKind: "agent-initial-message",
    messageDigest: "digest",
    idempotencyKey: "create-1",
    initialMessageDigest: "digest",
    scope: { callerSessionId: "caller", cwd: "/fixture/project" },
    reused: false,
    durability: "durable",
    cwd: "/fixture/project",
    status: "created",
  });
  assert.deepEqual(creates, [{
    idempotencyKey: "create-1",
    scope: { callerSessionId: "caller", cwd: "/fixture/project" },
    initialMessage: "Open the new parent",
  }]);
  const rejected = JSON.parse((await definition.execute("create-mismatch", { action: "create_session", cwd: "/other" }, undefined, undefined, context)).content[0].text);
  assert.match(rejected.error, /only supports the calling session cwd/);
  assert.equal(creates.length, 1);
});

test("create_session persists generated initialization and derives an idempotency key from the real tool call", async () => {
  const creates = [];
  const { createSessionControlExtension } = await jiti.import("./session-control.ts");
  let definition;
  createSessionControlExtension({
    createSession: async (request) => {
      creates.push(request);
      return {
        sessionId: "initialized-parent",
        sessionFile: "/fixture/initialized-parent.jsonl",
        persisted: true,
        visibleInSessionList: true,
        nativeListVisible: true,
        runtimeVisibleInReader: true,
        runtimeCreated: true,
        source: "initialization",
        messageKind: "generated-initialization",
        messageDigest: "initialization-digest",
        success: true,
        status: "created",
        idempotencyKey: request.idempotencyKey,
        scope: request.scope,
        reused: false,
        durability: "durable",
      };
    },
  }).factory({ registerTool(value) { definition = value; } });
  const context = {
    cwd: "/fixture/project",
    sessionManager: {
      getSessionId: () => "caller",
      getSessionFile: () => "/fixture/caller.jsonl",
      getHeader: () => ({ id: "caller", cwd: "/fixture/project" }),
    },
  };
  const created = JSON.parse((await definition.execute("tool-call-42", { action: "create_session" }, undefined, undefined, context)).content[0].text);
  assert.equal(created.source, "initialization");
  assert.equal(created.status, "created");
  assert.equal(created.persisted, true);
  assert.equal(created.nativeListVisible, true);
  assert.equal(created.durability, "durable");
  assert.equal(created.messageKind, "generated-initialization");
  assert.equal(creates.length, 1);
  assert.match(creates[0].idempotencyKey, /^tool-call:[0-9a-f]{64}$/);
  assert.deepEqual(creates[0].scope, { callerSessionId: "caller", cwd: "/fixture/project" });
  assert.equal(Object.hasOwn(creates[0], "initialMessage"), false);
});

test("registered tool retracts an accepted follow_up through an authorized controller", async t => {
  const prior = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = prior; });
  const calls = [];
  const retractions = [];
  const makeSession = id => {
    const path = join(testAgentDir, `${id}-retract.jsonl`);
    writeFileSync(path, "");
    const manager = { getHeader: () => ({ id, cwd: "/test-project" }), getEntries: () => [], getSessionFile: () => path, getSessionName: () => `${id} title`, getSessionId: () => id };
    return {
      sessionId: id,
      sessionFile: path,
      cwd: "/test-project",
      inner: { sessionManager: manager },
      isAlive: () => true,
      isRunning: () => false,
      sendNativePeerMessage: async (message, options) => { calls.push({ id, message, options }); },
      retractFollowUp: async (messageId, options) => {
        retractions.push({ id, messageId, options });
        return { retracted: true, receiverStatus: "cleared", previousQueueRevision: "rev-1", queueRevision: "rev-2" };
      },
    };
  };
  const author = makeSession("author-retract");
  const worker = makeSession("worker-retract");
  const observer = makeSession("observer-retract");
  globalThis.__piSessions = new Map([[author.sessionId, author], [worker.sessionId, worker], [observer.sessionId, observer]]);
  const definition = registerDefinition();
  const run = async (id, params, session) => JSON.parse((await definition.execute(id, params, undefined, undefined, { cwd: session.cwd, sessionManager: session.inner.sessionManager })).content[0].text);

  const sent = await run("retract-send", { action: "follow_up", target: worker.sessionId, replyTo: observer.sessionId, message: "queue this", kind: "request" }, author);
  assert.equal(sent.accepted, true);
  const retracted = await run("retract-call", { action: "retract_follow_up", target: worker.sessionId, messageId: sent.messageId, expectedQueueRevision: "rev-1" }, author);
  assert.equal(retracted.retracted, true);
  assert.deepEqual(retractions, [{ id: worker.sessionId, messageId: sent.messageId, options: { sessionMessageRoot: join(testAgentDir, "session-control-messages"), expectedQueueRevision: "rev-1" } }]);
  assert.equal(calls.length, 1);

  const controller = await run("retract-controller", { action: "retract_follow_up", target: worker.sessionId, messageId: sent.messageId }, observer);
  assert.equal(controller.retracted, true);
  assert.equal(retractions.length, 2);
});

test("inspect projects status without returning prompt or extension payloads", () => {
  const projected = projectInspectState({
    sessionId: "session-1",
    sessionFile: "/tmp/session-1.jsonl",
    isStreaming: true,
    messageCount: 12,
    model: { id: "model-1", provider: "provider-1", secret: "x".repeat(100_000) },
    contextUsage: { percent: 12.5, contextWindow: 256_000, tokens: 32_000, raw: "x".repeat(100_000) },
    queuedMessages: { steering: ["x"], followUp: [] },
    systemPrompt: "x".repeat(100_000),
    extensionWidgets: [{ lines: ["x".repeat(100_000)] }],
    tools: [{ description: "x".repeat(100_000) }],
  });

  assert.equal(projected.systemPrompt, undefined);
  assert.equal(projected.extensionWidgets, undefined);
  assert.equal(projected.tools, undefined);
  assert.equal(projected.systemPromptOmitted, true);
  assert.deepEqual(projected.model, { id: "model-1", provider: "provider-1" });
  assert.deepEqual(projected.contextUsage, { percent: 12.5, contextWindow: 256_000, tokens: 32_000 });
  assert.deepEqual(projected.queuedMessageCounts, { steering: 1, followUp: 0 });
  assert.ok(JSON.stringify(projected).length < 2_000);
});

test("session_control keeps live and persisted reads explicitly separated", async () => {
  const source = await readFile(new URL("./session-control.ts", import.meta.url), "utf8");
  assert.match(source, /source: "live-memory"/);
  assert.match(source, /source: "persisted-jsonl"/);
  assert.match(source, /session\.onEvent/);
  assert.match(source, /MAX_PAGE_SIZE = 100/);
  assert.match(source, /ambiguous target/);
});


test("registered tool sends identity, routes a reverse reply, and rejects offline targets", async t => {
  const prior = globalThis.__piSessions;
  t.after(() => { globalThis.__piSessions = prior; });
  const calls = [];
  const makeSession = id => {
    const path = join(testAgentDir, id + ".jsonl");
    writeFileSync(path, "");
    const manager = { getHeader: () => ({ id, cwd: "/test-project" }), getEntries: () => [], getSessionFile: () => path, getSessionName: () => id + " title", getSessionId: () => id };
    return {
      sessionId: id,
      sessionFile: path,
      cwd: "/test-project",
      inner: { sessionManager: manager },
      isAlive: () => true,
      isRunning: () => false,
      sendNativePeerMessage: async (message, options) => { calls.push({ id, message, options }); },
    };
  };
  const author = makeSession("author"), worker = makeSession("worker");
  globalThis.__piSessions = new Map([["author", author], ["worker", worker]]);
  const definition = registerDefinition();
  const run = async (id, params, session) => JSON.parse((await definition.execute(id, params, undefined, undefined, { cwd: session.cwd, sessionManager: session.inner.sessionManager })).content[0].text);
  const initial = await run("send-1", { action: "follow_up", target: "worker", message: "Check patch", kind: "request" }, author);
  assert.equal(initial.accepted, true);
  assert.equal(initial.transport, "accepted");
  assert.equal(calls[0].message.customType, "pi-web:session-peer");
  assert.equal(calls[0].message.details.uiContent, "Check patch");
  assert.ok(calls[0].message.content.includes(`replyRef=${initial.messageId}`));
  assert.equal(calls[0].message.display, true);
  assert.equal(calls[0].message.details.source, "session-control");
  assert.equal(calls[0].message.details.sender.title, "author title");
  assert.equal(calls[0].message.details.sender.project, "/test-project");
  assert.equal(calls[0].options.triggerTurn, true);
  const messagePath = join(testAgentDir, "session-control-messages", `${initial.messageId}.json`);
  const legacy = JSON.parse(readFileSync(messagePath, "utf8"));
  legacy.replyTo = "";
  writeFileSync(messagePath, JSON.stringify(legacy));
  const reply = await run("reply-1", { action: "reply", target: "author", messageId: initial.messageId, message: "Tests passed", workStatus: "completed" }, worker);
  assert.equal(reply.target, "author");
  assert.equal(calls[1].message.customType, "pi-web:session-peer");
  assert.equal(calls[1].message.details.uiContent, "Tests passed");
  assert.match(calls[1].message.content, /Agent peer reply/);
  assert.equal(calls[1].message.details.source, "session-control");
  assert.equal(calls[1].message.details.inReplyTo, initial.messageId);
  assert.equal(calls[1].options.triggerTurn, true);
  const status = await run("status-1", { action: "message_status", messageId: initial.messageId }, author);
  assert.equal(status.replies[0].workStatus, "completed");
  const forged = await run("reply-2", { action: "reply", messageId: initial.messageId, message: "Forged", workStatus: "completed" }, author);
  assert.match(forged.error, /original recipient/);
  const offline = await run("offline", { action: "follow_up", target: "missing", message: "Hello" }, author);
  assert.ok(offline.error);
  assert.equal(calls.length, 2);
});
