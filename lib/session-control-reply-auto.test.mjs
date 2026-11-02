import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const testAgentDir = mkdtempSync(join(tmpdir(), "reader-reply-auto-test-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
const previousActivityConfig = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
process.env.PI_CODING_AGENT_DIR = testAgentDir;
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "test-device", name: "Test" } });

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createSessionControlExtension } = await jiti.import("./session-control.ts");

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

test.after(() => {
  restoreEnv("PI_CODING_AGENT_DIR", previousAgentDir);
  restoreEnv("PI_WEB_SESSION_ACTIVITY_CONFIG", previousActivityConfig);
  rmSync(testAgentDir, { recursive: true, force: true });
});

function makeSession(id, { running = false, streaming = false, bash = false, compacting = false, pendingUser = false } = {}) {
  const sessionFile = join(testAgentDir, `${id}.jsonl`);
  writeFileSync(sessionFile, "");
  const state = { running, streaming, bash, compacting, pendingUser };
  const calls = [];
  const manager = {
    getHeader: () => ({ id, cwd: "/test-project" }),
    getEntries: () => [],
    getSessionFile: () => sessionFile,
    getSessionName: () => `${id} title`,
    getSessionId: () => id,
  };
  return {
    id,
    state,
    calls,
    sessionId: id,
    sessionFile,
    cwd: "/test-project",
    inner: {
      sessionManager: manager,
      get isStreaming() { return state.streaming; },
      get isBashRunning() { return state.bash; },
      get isCompacting() { return state.compacting; },
    },
    isAlive: () => true,
    isRunning: () => state.running,
    hasPendingUserInteraction: () => state.pendingUser,
    sendNativePeerMessage: async (message, options) => { calls.push({ message, options }); },
  };
}

function registerDefinition() {
  let definition;
  createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
  assert.ok(definition, "session_control must register a tool");
  return definition;
}

async function run(definition, callId, session, params) {
  const result = await definition.execute(callId, params, undefined, undefined, {
    cwd: session.cwd,
    sessionManager: session.inner.sessionManager,
  });
  return JSON.parse(result.content[0].text);
}

function persisted(messageId) {
  return JSON.parse(readFileSync(join(testAgentDir, "session-control-messages", `${messageId}.json`), "utf8"));
}

async function createRequest(definition, author, worker, callId, extra = {}) {
  return run(definition, callId, author, {
    action: "follow_up",
    target: worker.id,
    kind: "request",
    responseRequired: true,
    message: `Request ${callId}`,
    ...extra,
  });
}

async function reply(definition, worker, author, callId, request, extra = {}) {
  return run(definition, callId, worker, {
    action: "reply",
    target: author.id,
    messageId: request.messageId,
    workStatus: "completed",
    message: `Reply ${callId}`,
    ...extra,
  });
}

test("registered session_control reply auto policy selects target activity and preserves safety boundaries", async t => {
  const previousSessions = globalThis.__piSessions;
  const author = makeSession("author");
  const worker = makeSession("worker");
  const supervisor = makeSession("supervisor");
  globalThis.__piSessions = new Map([[author.id, author], [worker.id, worker], [supervisor.id, supervisor]]);
  t.after(() => { globalThis.__piSessions = previousSessions; });
  const definition = registerDefinition();

  const activeRequest = await createRequest(definition, author, worker, "active-request");
  author.state.running = true;
  const activeReply = await reply(definition, worker, author, "active-reply", activeRequest);
  assert.equal(activeReply.replyDelivery, "steer");
  assert.equal(activeReply.replyDeliveryRequested, "auto");
  assert.equal(activeReply.replyDeliverySource, "auto_active");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "steer");

  author.state.running = false;
  const idleRequest = await createRequest(definition, author, worker, "idle-request");
  const idleReply = await reply(definition, worker, author, "idle-reply", idleRequest);
  assert.equal(idleReply.replyDelivery, "follow_up");
  assert.equal(idleReply.replyDeliverySource, "auto_idle");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "follow_up");

  author.state.streaming = true;
  const streamingRequest = await createRequest(definition, author, worker, "streaming-request");
  const streamingReply = await reply(definition, worker, author, "streaming-reply", streamingRequest);
  assert.equal(streamingReply.replyDelivery, "steer");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "steer");
  author.state.streaming = false;

  const thirdPartyRequest = await createRequest(definition, author, worker, "third-party-request", { replyTo: supervisor.id });
  supervisor.state.running = true;
  const thirdPartyReply = await run(definition, "third-party-reply", worker, {
    action: "reply",
    target: supervisor.id,
    messageId: thirdPartyRequest.messageId,
    workStatus: "completed",
    message: "Reply to supervisor",
  });
  assert.equal(thirdPartyReply.replyDelivery, "steer");
  assert.equal(supervisor.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(supervisor.calls.at(-1).options.delivery, "steer");
  supervisor.state.running = false;

  const legacyRequest = await createRequest(definition, author, worker, "legacy-request");
  const legacyPath = join(testAgentDir, "session-control-messages", `${legacyRequest.messageId}.json`);
  const legacyStored = JSON.parse(readFileSync(legacyPath, "utf8"));
  delete legacyStored.replyDelivery;
  delete legacyStored.replyDeliveryRequested;
  delete legacyStored.replyDeliverySource;
  writeFileSync(legacyPath, JSON.stringify(legacyStored));
  author.state.running = true;
  const legacyReply = await reply(definition, worker, author, "legacy-reply", legacyRequest);
  assert.equal(legacyReply.replyDelivery, "steer");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "steer");
  author.state.running = false;

  for (const [name, flags] of [["bash", { running: true, bash: true }], ["compaction", { running: true, compacting: true }], ["pending-user", { running: true, pendingUser: true }]]) {
    author.state.running = flags.running;
    author.state.bash = flags.bash ?? false;
    author.state.compacting = flags.compacting ?? false;
    author.state.pendingUser = flags.pendingUser ?? false;
    const request = await createRequest(definition, author, worker, `${name}-request`);
    const response = await reply(definition, worker, author, `${name}-reply`, request);
    assert.equal(response.replyDelivery, "steer", name);
    assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer", name);
    assert.equal(author.calls.at(-1).options.delivery, "steer", name);
  }
  author.state.running = false;
  author.state.bash = false;
  author.state.compacting = false;
  author.state.pendingUser = false;

  const explicitFollowRequest = await createRequest(definition, author, worker, "explicit-follow-request", { replyDelivery: "follow_up" });
  author.state.running = true;
  const explicitFollowReply = await reply(definition, worker, author, "explicit-follow-reply", explicitFollowRequest);
  assert.equal(explicitFollowReply.replyDelivery, "follow_up");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "follow_up");

  const explicitSteerRequest = await createRequest(definition, author, worker, "explicit-steer-request", { replyDelivery: "steer" });
  author.state.running = false;
  const explicitSteerReply = await reply(definition, worker, author, "explicit-steer-reply", explicitSteerRequest);
  assert.equal(explicitSteerReply.replyDelivery, "steer");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "steer");
  const explicitDowngrade = await reply(definition, worker, author, "explicit-steer-downgrade", explicitSteerRequest, { replyDelivery: "follow_up" });
  assert.equal(explicitDowngrade.replyDelivery, "follow_up");
  assert.equal(explicitDowngrade.replyDeliverySource, "recipient_downgrade");
  assert.equal(author.calls.at(-1).message.customType, "pi-web:session-peer");
  assert.equal(author.calls.at(-1).options.delivery, "follow_up");

  const upgradeRequest = await createRequest(definition, author, worker, "upgrade-request");
  const beforeUpgrade = author.calls.length;
  const upgrade = await reply(definition, worker, author, "upgrade-reply", upgradeRequest, { replyDelivery: "steer" });
  assert.match(upgrade.error, /cannot upgrade/);
  assert.equal(author.calls.length, beforeUpgrade);

  const dedupRequest = await createRequest(definition, author, worker, "dedup-request");
  author.state.running = true;
  const firstDedup = await reply(definition, worker, author, "dedup-reply", dedupRequest);
  const sendsAfterFirst = author.calls.length;
  author.state.running = false;
  const secondDedup = await reply(definition, worker, author, "dedup-reply", dedupRequest);
  assert.equal(firstDedup.replyDelivery, "steer");
  assert.equal(secondDedup.duplicate, true);
  assert.equal(secondDedup.replyDelivery, "steer");
  assert.equal(secondDedup.replyDeliverySource, "auto_active");
  assert.equal(author.calls.length, sendsAfterFirst);

  const status = await run(definition, "status-active-request", author, { action: "message_status", messageId: activeRequest.messageId });
  assert.equal(status.replies[0].replyDeliveryRequested, "auto");
  assert.equal(status.replies[0].replyDelivery, "steer");
  assert.equal(status.replies[0].replyDeliverySource, "auto_active");
  assert.equal(author.calls.some(call => call.message?.type === "abort"), false);
  const activeStored = persisted(activeRequest.messageId);
  assert.equal(activeStored.replyDeliveryRequested, "auto");
  assert.equal(activeStored.replyDelivery, undefined);
  assert.equal(activeStored.replyDeliverySource, "default_auto");
});

test("registered reply can resolve the model-visible sole pending request without messageId", async t => {
  const previousSessions = globalThis.__piSessions;
  const author = makeSession("reply-author");
  const worker = makeSession("reply-worker");
  globalThis.__piSessions = new Map([[author.id, author], [worker.id, worker]]);
  t.after(() => { globalThis.__piSessions = previousSessions; });
  const definition = registerDefinition();
  const request = await createRequest(definition, author, worker, "model-visible-ref");
  const workerReceivedCount = worker.calls.length;
  const response = await run(definition, "model-auto-reply", worker, {
    action: "reply",
    target: author.id,
    workStatus: "completed",
    message: "Completed from the peer request",
  });
  assert.equal(response.error, undefined);
  assert.equal(response.accepted, true);
  assert.equal(worker.calls.length, workerReceivedCount);
  assert.equal(author.calls.at(-1).message.details.inReplyTo, request.messageId);
});
