import assert from "node:assert/strict";
import { closeSync, existsSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const root = await mkdtemp(join(tmpdir(), "reader-peer-native-test-"));
process.env.PI_CODING_AGENT_DIR = root;
// Run records stay in this process too: a parallel test file holding the shared
// activity lock when a run starts would fail that run before the model answers.
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(root, "session-activity.json");
process.env.PI_WEB_SUBPROJECTS_FILE = join(root, "subprojects.json");
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "native-test", name: "Native test" } });
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false, fsCache: false });
const { AgentSessionWrapper, ensureInitialUserPrompt, getRpcSessionInfos } = await jiti.import("./rpc-manager.ts");
const { createSessionControlExtension } = await jiti.import("./session-control.ts");
const durable = await jiti.import("../packages/pi-web-session-control/index.ts");
const messages = await jiti.import("./session-messages.ts");
const subprojects = await jiti.import("./subproject-state.ts");
const wrappers = new Set();
test.after(async () => {
  for (const wrapper of wrappers) await wrapper.shutdown();
  await rm(root, { recursive: true, force: true });
});
const userCount = manager => manager.getEntries().filter(e => e.type === "message" && e.message.role === "user").length;
const peers = manager => manager.getEntries().filter(e => e.type === "custom_message" && e.customType === "pi-web:session-peer");
const replyRoot = join(root, "session-control-messages");
function peer(id, content = "same body") {
  return { customType: "pi-web:session-peer", content, display: true, details: { source: "session-control", messageId: id } };
}
async function waitFor(predicate) {
  const deadline = Date.now() + 15_000;
  while (!predicate()) { if (Date.now() > deadline) throw new Error("native test timed out"); await delay(5); }
}
async function fixture(t, label, suppliedManager) {
  const cwd = await mkdtemp(join(root, label + "-"));
  const model = fauxProvider({ provider: "native-peer-" + label, models: [{ id: label }] });
  const runtime = await ModelRuntime.create({ authPath: join(cwd, "test-auth.json"), modelsPath: null, refreshOnCreate: false });
  runtime.registerNativeProvider(model.provider);
  const settingsManager = SettingsManager.inMemory();
  const manager = suppliedManager ?? SessionManager.create(cwd, join(cwd, "sessions"));
  const resourceLoader = new DefaultResourceLoader({ cwd: manager.getCwd(), agentDir: root, settingsManager,
    extensionFactories: [createSessionControlExtension()], noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await resourceLoader.reload();
  const { session } = await createAgentSession({ cwd: manager.getCwd(), agentDir: root, modelRuntime: runtime, model: model.getModel(label), tools: ["session_control"], sessionManager: manager, settingsManager, resourceLoader });
  const wrapper = new AgentSessionWrapper(session);
  wrappers.add(wrapper); wrapper.start(); wrapper.beginExtensionBinding(); await wrapper.waitUntilReady();
  assert.ok(session.getAllTools().some(tool => tool.name === "session_control"), "SDK registered the real extension");
  session.setActiveToolsByName(["session_control"]);
  assert.ok(session.getActiveToolNames().includes("session_control"), `registered collaboration tool missing: ${session.getActiveToolNames()}`);
  globalThis.__piSessions ??= new Map(); globalThis.__piSessions.set(manager.getSessionId(), wrapper);
  t.after(async () => { await wrapper.shutdown(); wrappers.delete(wrapper); globalThis.__piSessions?.delete(manager.getSessionId()); });
  let tool;
  createSessionControlExtension().factory({ registerTool(value) { tool = value; } });
  const call = async (id, params) => JSON.parse((await tool.execute(id, params, undefined, undefined,
    { cwd: manager.getCwd(), sessionManager: manager })).content[0].text);
  return { manager, wrapper, session, model, call };
}

for (const action of ["prompt", "follow_up", "steer"]) {
  test(`real registered ${action}: receiving model can reply from its own context, with zero fabricated users`, async t => {
    const A = await fixture(t, "sender-" + action);
    const B = await fixture(t, "receiver-" + action);
    let modelReplyRef;
    let returnedReceipt;
    A.model.setResponses([() => fauxAssistantMessage([fauxText("answer received")]), () => fauxAssistantMessage([fauxText("human answered")])]);
    B.model.setResponses([
      context => {
        const content = JSON.stringify(context.messages);
        assert.doesNotMatch(content, /Session collaboration message|Sender identity and return route/);
        modelReplyRef = /replyRef=([a-f0-9]{64})/.exec(content)?.[1];
        assert.ok(modelReplyRef, "the receiving model, not the test caller, can address this reply");
        return fauxAssistantMessage([fauxToolCall("session_control", { action: "reply", messageId: modelReplyRef, workStatus: "completed", message: "verified reply from receiver" })], { stopReason: "toolUse" });
      },
      context => {
        const result = context.messages.findLast(message => message.role === "toolResult");
        returnedReceipt = JSON.parse(result.content.find(block => block.type === "text").text);
        return fauxAssistantMessage([fauxText("reply sent")]);
      },
    ]);
    const request = await A.call("roundtrip-" + action, { action, target: B.manager.getSessionId(), kind: "question", message: "Please report the test result." });
    assert.equal(request.accepted, true);
    try {
      await waitFor(() => !A.wrapper.isRunning() && !B.wrapper.isRunning() && returnedReceipt);
    } catch (error) {
      const tail = B.manager.getEntries().filter(entry => entry.type === "message").slice(-4).map(entry => entry.message);
      throw new Error(`${error.message}; receiver transcript: ${JSON.stringify(tail)}`);
    }
    assert.equal(returnedReceipt.accepted, true);
    assert.equal(modelReplyRef, request.messageId);
    assert.equal(peers(B.manager).length, 1);
    assert.equal(peers(A.manager).length, 1);
    assert.equal(peers(A.manager)[0].details.inReplyTo, request.messageId);
    assert.equal(userCount(A.manager), 0); assert.equal(userCount(B.manager), 0);
    assert.equal(peers(B.manager)[0].details.uiContent, "Please report the test result.");
    const reopened = SessionManager.open(B.manager.getSessionFile(), B.manager.getSessionDir());
    assert.equal(userCount(reopened), 0); assert.equal(peers(reopened)[0].details.messageId, request.messageId);
    await A.wrapper.send({ type: "prompt", message: "genuine human input" });
    await waitFor(() => !A.wrapper.isRunning());
    assert.equal(userCount(A.manager), 1, "human control remains the human path");
  });
}

for (const action of ["prompt", "follow_up"]) {
  test(`a fresh peer ${action} after Stop All starts a new turn for another authorized caller`, async t => {
    const A = await fixture(t, `stopped-continuation-sender-${action}`);
    const B = await fixture(t, `stopped-continuation-receiver-${action}`);
    let modelCalls = 0;
    B.model.setResponses([() => { modelCalls += 1; return fauxAssistantMessage([fauxText("fresh continuation result")]); }]);

    const stopped = await B.wrapper.stopAllExecution();
    assert.equal(stopped.stopped, true);
    const receipt = await A.call(`stopped-continuation-${action}`, {
      action,
      target: B.manager.getSessionId(),
      message: "start a fresh continuation",
    });
    assert.equal(receipt.accepted, true);
    await waitFor(() => !B.wrapper.isRunning() && modelCalls === 1);
    assert.equal(peers(B.manager).length, 1);
    assert.equal(userCount(B.manager), 0, "peer continuation must remain outside the human user path");
    assert.match(JSON.stringify(B.manager.getEntries()), /fresh continuation result/);
  });
}

test("queued same-text peers clear by exact identity and retain a durable receiver outcome", async t => {
  const A = await fixture(t, "queue-sender");
  const B = await fixture(t, "queue-receiver");
  let release, modelStarted = false, modelCalls = 0;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  B.model.setResponses([async () => { modelCalls++; modelStarted = true; await held; return fauxAssistantMessage([fauxText("existing work done")]); }]);
  await B.wrapper.sendNativePeerMessage(peer("existing-work"), { triggerTurn: true });
  await waitFor(() => modelStarted);
  const first = await A.call("queued-one", { action: "follow_up", target: B.manager.getSessionId(), message: "identical peer task" });
  const second = await A.call("queued-two", { action: "follow_up", target: B.manager.getSessionId(), message: "identical peer task" });
  assert.equal(first.accepted, true); assert.equal(second.accepted, true); assert.notEqual(first.messageId, second.messageId);
  assert.equal(B.wrapper.getQueueIdentity().counts.total, 2);
  await B.wrapper.send({ type: "clear_queue" });
  for (const receipt of [first, second]) assert.equal(messages.sessionMessageStatus(replyRoot, receipt.messageId, A.manager.getSessionId()).message.receiverStatus, "cleared");
  const replay = await A.call("queued-one", { action: "follow_up", target: B.manager.getSessionId(), message: "identical peer task" });
  assert.equal(replay.duplicate, true); assert.equal(replay.receiverStatus, "cleared");
  release(); await waitFor(() => !B.wrapper.isRunning());
  assert.equal(modelCalls, 1); assert.equal(peers(B.manager).length, 1); assert.equal(userCount(B.manager), 0);
});

test("clearing a deferred peer during MCP preparation prevents SDK delivery", async t => {
  const B = await fixture(t, "deferred-peer-clear");
  let compacting = true, enter, release, submissions = 0;
  Object.defineProperty(B.session, "isCompacting", { configurable: true, get: () => compacting });
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  const prepare = B.wrapper.prepareMcpForInput.bind(B.wrapper);
  B.wrapper.prepareMcpForInput = async (...args) => { enter(); await gate; return prepare(...args); };
  const send = B.session.sendCustomMessage.bind(B.session);
  B.session.sendCustomMessage = (...args) => { submissions++; return send(...args); };
  const pending = B.wrapper.sendNativePeerMessage(peer("deferred-peer-clear"), { delivery: "follow_up" });
  void pending.catch(() => {});
  await waitFor(() => B.wrapper.deferredCompactionPrompts.length === 1);
  compacting = false;
  const flush = B.wrapper.flushDeferredCompactionPrompts();
  try {
    await entered;
    await B.wrapper.send({ type: "clear_queue" });
  } finally {
    release();
  }
  await flush;
  await assert.rejects(pending, /removed by clear_queue/);
  assert.equal(submissions, 0);
  assert.equal(peers(B.manager).length, 0);
});

test("resolved SDK deferral alone is not transport acceptance", async t => {
  const B = await fixture(t, "deferred-receiver");
  const original = B.session.sendCustomMessage;
  B.session.sendCustomMessage = async () => undefined;
  let accepted = false;
  const pending = B.wrapper.sendNativePeerMessage(peer("no-sdk-admission"), { triggerTurn: true }).then(() => { accepted = true; });
  void pending.catch(() => {});
  await delay(30);
  assert.equal(accepted, false);
  B.wrapper.destroy();
  await assert.rejects(pending, /no longer|available/i);
  B.session.sendCustomMessage = original;
  assert.equal(peers(B.manager).length, 0);
});

for (const race of ["settings", "stop"]) {
  test(`native admission revalidates ${race} after asynchronous preparation`, async t => {
    const B = await fixture(t, "race-" + race);
    let release, preparing = false, requests = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const original = B.wrapper.refreshRemoteClaudeHostBinding;
    B.wrapper.refreshRemoteClaudeHostBinding = async () => { preparing = true; await gate; };
    B.model.setResponses([() => { requests++; return fauxAssistantMessage([fauxText("must not run")]); }]);
    const pending = B.wrapper.sendNativePeerMessage(peer("race-" + race), { triggerTurn: true });
    void pending.catch(() => {});
    await waitFor(() => preparing);
    if (race === "settings") B.wrapper.managedSettingPending = true;
    else await B.wrapper.send({ type: "abort" });
    release();
    await assert.rejects(pending, /pending|Stop|busy|abort/i);
    B.wrapper.managedSettingPending = false; B.wrapper.refreshRemoteClaudeHostBinding = original;
    assert.equal(requests, 0); assert.equal(userCount(B.manager), 0); assert.equal(peers(B.manager).length, 0);
  });
}

test("a supplied create question is persisted as a real user turn and starts the model", async t => {
  const cwd = await mkdtemp(join(root, "create-question-cwd-"));
  const allocation = SessionManager.create(cwd, join(root, "sessions", "creation-question"));
  closeSync(openSync(allocation.getSessionFile(), "wx"));
  const manager = SessionManager.open(allocation.getSessionFile(), allocation.getSessionDir(), cwd);
  const initialMessage = "请检查这个新会话是否能正常开始。";
  durable.appendDurableSessionCreate(manager, { idempotencyKey: "real-create-question", scope: { callerSessionId: "creator", cwd }, initialMessage });
  const B = await fixture(t, "created-question", manager);
  B.model.setResponses([() => fauxAssistantMessage([fauxText("已收到首个用户问题")])]);
  assert.equal(userCount(manager), 0);
  assert.equal(await ensureInitialUserPrompt(B.wrapper, initialMessage), true);
  await waitFor(() => userCount(manager) === 1 && !B.wrapper.isRunning());
  assert.equal(await ensureInitialUserPrompt(B.wrapper, initialMessage), false);
  const userContents = manager.getEntries()
    .filter(entry => entry.type === "message" && entry.message.role === "user")
    .map(entry => Array.isArray(entry.message.content)
      ? entry.message.content.filter(block => block.type === "text").map(block => block.text).join("")
      : entry.message.content);
  assert.deepEqual(userContents, [initialMessage]);
  assert.match(JSON.stringify(manager.getEntries()), /已收到首个用户问题/);
});

test("explicit custom-only creation is listed by the SDK and real Reader, while unintentional metadata stays a draft", async t => {
  const cwd = await mkdtemp(join(root, "create-cwd-"));
  const allocation = SessionManager.create(cwd, join(root, "sessions", "creation-test"));
  closeSync(openSync(allocation.getSessionFile(), "wx"));
  const manager = SessionManager.open(allocation.getSessionFile(), allocation.getSessionDir(), cwd);
  const request = { idempotencyKey: "real-create", scope: { callerSessionId: "creator", cwd } };
  durable.appendDurableSessionCreate(manager, request);
  const B = await fixture(t, "created-native", manager);
  assert.equal(existsSync(manager.getSessionFile()), true);
  assert.equal((await SessionManager.list(cwd, manager.getSessionDir())).some(info => info.id === manager.getSessionId()), true);
  assert.equal(getRpcSessionInfos().some(info => info.id === manager.getSessionId()), true);
  assert.equal(userCount(manager), 0); assert.equal(B.wrapper.isRunning(), false);
  const reopened = SessionManager.open(manager.getSessionFile(), manager.getSessionDir());
  assert.equal(durable.hasDurableSessionCreation(reopened.getEntries(), manager.getSessionId()), true);
  const draftAllocation = SessionManager.create(cwd, join(root, "draft-test"));
  closeSync(openSync(draftAllocation.getSessionFile(), "wx"));
  const draftManager = SessionManager.open(draftAllocation.getSessionFile(), draftAllocation.getSessionDir(), cwd);
  draftManager.appendCustomEntry("unrelated-extension-setting", { enabled: true });
  await fixture(t, "anonymous-draft", draftManager);
  assert.equal(getRpcSessionInfos().some(info => info.id === draftManager.getSessionId()), false);

  for (const name of ["archived_sessions", "deleted_sessions"]) await mkdir(join(root, name), { recursive: true });
  subprojects.resetSubprojectStateForTests();
  const project = subprojects.createSubproject("native-create-project", "Created");
  assert.ok(existsSync(join(root, "subprojects.json")), "subproject fixture state stays in its temporary root");
  subprojects.assignSession("native-create-project", manager.getSessionId(), project.id);
  subprojects.pruneOrphanedSubprojectAssignments();
  assert.equal(subprojects.assignmentForSession(manager.getSessionId(), "native-create-project")?.subprojectId, project.id);
});

test("native exact retraction retains surviving queue item identity and stale CAS cannot remove it", async t => {
  const B = await fixture(t, "retract-identity");
  let release, started = false;
  const held = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  B.model.setResponses([async () => { started = true; await held; return fauxAssistantMessage([fauxText("held work done")]); }]);
  await B.wrapper.sendNativePeerMessage(peer("held-work"), { triggerTurn: true });
  await waitFor(() => started);
  await B.wrapper.sendNativePeerMessage(peer("retract-first", "same text"), { delivery: "follow_up" });
  await B.wrapper.sendNativePeerMessage(peer("retain-second", "same text"), { delivery: "follow_up" });
  const before = B.wrapper.queueIdentityTracker.snapshot([]);
  assert.equal(before.followUp.length, 2);
  const originalRevision = B.wrapper.getQueueIdentity().revision;
  const result = await B.wrapper.retractFollowUp("retract-first", { expectedQueueRevision: originalRevision });
  assert.equal(result.retracted, true);
  const after = B.wrapper.queueIdentityTracker.snapshot([]);
  assert.deepEqual(after.followUp.map(item => item.itemId), [before.followUp[1].itemId]);
  assert.notEqual(result.queueRevision, originalRevision);
  await assert.rejects(B.wrapper.retractFollowUp("retain-second", { expectedQueueRevision: originalRevision }), { code: "queue_revision_conflict" });
  assert.equal(B.wrapper.getQueueIdentity().counts.total, 1);
  await B.wrapper.send({ type: "clear_queue" });
  release(); await waitFor(() => !B.wrapper.isRunning());
  assert.equal(peers(B.manager).length, 1);
});
