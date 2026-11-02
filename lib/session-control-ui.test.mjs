import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = mkdtempSync(join(tmpdir(), "reader-session-control-ui-"));
const previous = Object.fromEntries(["PI_CODING_AGENT_DIR", "PI_WEB_SESSION_WAIT_STATE_ROOT", "PI_WEB_SESSION_ACTIVITY_CONFIG", "PI_WEB_SESSION_ACTIVITY_FILE"].map((key) => [key, process.env[key]]));
process.env.PI_CODING_AGENT_DIR = root;
process.env.PI_WEB_SESSION_WAIT_STATE_ROOT = join(root, "waits");
process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "ui-test-device", name: "UI test" } });
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(root, "activity.json");
const priorSessions = globalThis.__piSessions;
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, interopDefault: true, moduleCache: false });
const { createSessionControlExtension } = await jiti.import("./session-control.ts");

test.after(() => {
  globalThis.__piSessions = priorSessions;
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function popup(id, method = "select", extra = {}) {
  return {
    id, runtimeGeneration: "worker-generation", method, title: "Choose the next step",
    createdAt: "2026-10-19T00:00:00.000Z",
    ...(method === "select" ? { options: ["Keep", "Other (manual input)"], responseSchema: { kind: "select", supported: true, allowFreeText: false, options: ["Keep", "Other (manual input)"] } }
      : method === "confirm" ? { message: "Confirm this exact action", responseSchema: { kind: "confirm", supported: true, allowFreeText: false } }
      : { responseSchema: { kind: "text", supported: true, allowFreeText: true } }),
    ...extra,
  };
}

function makeSession(id = "worker", requests = []) {
  const path = join(root, `${id}.jsonl`);
  writeFileSync(path, "");
  const listeners = new Set();
  const uiListeners = new Set();
  const calls = [];
  const state = { sessionId: id, runtimeGeneration: `${id}-generation`, runtimeStatus: "live", revision: 1, requests, running: true };
  const answers = new Map();
  const manager = {
    getHeader: () => ({ id, cwd: "/fixture" }), getEntries: () => [], getSessionFile: () => path,
    getSessionId: () => id, getSessionName: () => `${id} title`, buildSessionContext: () => ({ messages: [] }),
  };
  const snapshot = () => structuredClone({ sessionId: id, runtimeGeneration: state.runtimeGeneration, runtimeStatus: state.runtimeStatus, revision: state.revision, requests: state.requests });
  const session = {
    sessionId: id, sessionFile: path, cwd: "/fixture", inner: { sessionManager: manager, agent: { state: { messages: [] } } },
    state, calls, listeners, uiListeners,
    isAlive: () => state.runtimeStatus === "live", isRunning: () => state.running,
    getPendingUiRequestsSnapshot: snapshot,
    subscribeUiRequests(listener) { uiListeners.add(listener); listener(snapshot()); return () => uiListeners.delete(listener); },
    onEvent(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    emit(event) { for (const listener of listeners) listener(event); },
    publish(requests, runtimeStatus = state.runtimeStatus) {
      state.requests = requests; state.runtimeStatus = runtimeStatus; state.revision += 1;
      for (const listener of uiListeners) listener(snapshot());
    },
    async sendNativePeerMessage(message, options) {
      if (options?.beforeSubmit && !options.beforeSubmit()) throw new Error("notification_no_longer_pending");
      calls.push(message);
    },
    async send(command) {
      calls.push(command);
      if (command.type === "get_state") return { sessionId: id, isStreaming: false, isPromptRunning: state.running };
      if (command.type === "follow_up") return null;
      assert.equal(command.type, "extension_ui_response");
      const error = (code) => { throw Object.assign(new Error(code), { code }); };
      if (command.runtimeGeneration !== state.runtimeGeneration) error("ui_generation_mismatch");
      const prior = answers.get(command.id);
      if (prior) {
        if (JSON.stringify(prior.command) !== JSON.stringify(command)) error("ui_request_conflict");
        return { ...prior.receipt, status: "replayed" };
      }
      const request = state.requests.find((request) => request.id === command.id);
      if (!request) error("ui_request_unknown");
      if (request.expiresAt && request.expiresAt <= Date.now()) error("ui_request_expired");
      if (!command.cancelled && (request.method === "select" ? !request.options.includes(command.value) : request.method === "confirm" ? typeof command.confirmed !== "boolean" : typeof command.value !== "string")) error("ui_response_invalid");
      const receipt = { status: "accepted", id: command.id, runtimeGeneration: state.runtimeGeneration, resolution: command.cancelled ? "cancelled" : "answered" };
      answers.set(command.id, { command, receipt });
      const remaining = state.requests.filter((request) => request.id !== command.id);
      if (request.method === "select" && command.value === "Other (manual input)") remaining.push(popup("manual-input", "input", { title: "Enter your answer", placeholder: "Your answer" }));
      session.publish(remaining);
      return receipt;
    },
  };
  return session;
}

function harness(requests = []) {
  const owner = makeSession("owner");
  const worker = makeSession("worker", requests);
  globalThis.__piSessions = new Map([[owner.sessionId, owner], [worker.sessionId, worker]]);
  let definition;
  createSessionControlExtension().factory({ registerTool(value) { definition = value; } });
  const run = async (params, signal) => {
    const result = await definition.execute("ui-call", { target: "worker", ...params }, signal, undefined, { cwd: owner.cwd, sessionManager: owner.inner.sessionManager });
    return JSON.parse(result.content[0].text);
  };
  return { owner, worker, run, definition };
}

const answer = (requestId, fields = {}) => ({ action: "answer_ui", requestId, runtimeGeneration: "worker-generation", ...fields });

test("wait_for error recognizes a nested assistant error but not an aborted run", async () => {
  const { run, worker } = harness();
  const waiting = run({ action: "wait_for", until: "error", timeoutMs: 1000 });
  worker.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "aborted" }] });
  worker.emit({ type: "agent_end", messages: [{ role: "assistant", stopReason: "error", errorMessage: "provider failed" }] });
  const result = await waiting;
  assert.equal(result.timedOut, false);
  assert.equal(result.event.type, "agent_end");
  assert.equal(result.event.errorMessage, "provider failed");
  assert.equal(worker.listeners.size, 1, "the wait listener is removed; activity tracking remains");
});

test("pending_ui and inspect preserve every concurrent request, full fields and exact large editor text", async () => {
  const editorText = "🙂 编辑\n".repeat(12_000);
  const requests = [popup("select-1"), popup("confirm-1", "confirm"), popup("editor-1", "editor", { prefill: editorText }), popup("input-1", "input", { placeholder: "Full placeholder" })];
  const { run } = harness(requests);
  const pending = await run({ action: "pending_ui" });
  assert.deepEqual(pending.pendingUi.requests, requests);
  assert.equal(pending.pendingUi.runtimeGeneration, "worker-generation");
  assert.equal(pending.pendingUi.requests[2].prefill, editorText);
  const inspected = await run({ action: "inspect" });
  assert.deepEqual(inspected.pendingUi, pending.pendingUi);
  assert.equal(inspected.systemPromptOmitted, true);
});

test("answer_ui validates request identity and exclusive response shape before sending", async () => {
  const { run, worker } = harness([popup("select-1")]);
  for (const params of [
    { action: "answer_ui", value: "Keep" },
    { action: "answer_ui", requestId: "select-1", value: "Keep" },
    answer("select-1"), answer("select-1", { value: "Keep", confirmed: true }),
    answer("select-1", { cancelled: false }), answer("select-1", { value: 7 }),
    { ...answer("select-1", { value: "Keep" }), target: "worker title" },
  ]) assert.ok((await run(params)).error);
  assert.equal(worker.calls.length, 0);
  const valid = await run(answer("select-1", { value: "Keep" }));
  assert.equal(valid.status, "accepted");
  assert.deepEqual(worker.calls[0], { type: "extension_ui_response", id: "select-1", runtimeGeneration: "worker-generation", value: "Keep" });
});

test("answer_ui returns runtime replay, conflict, stale, expiry, unknown and invalid outcomes", async () => {
  const { run } = harness([popup("select-1"), popup("expired", "input", { expiresAt: Date.now() - 1 })]);
  assert.equal((await run(answer("select-1", { value: "invented free text" }))).code, "ui_response_invalid");
  assert.equal((await run({ ...answer("select-1", { value: "Keep" }), runtimeGeneration: "old-generation" })).code, "ui_generation_mismatch");
  assert.equal((await run(answer("missing", { value: "Keep" }))).code, "ui_request_unknown");
  assert.equal((await run(answer("expired", { value: "late" }))).code, "ui_request_expired");
  assert.equal((await run(answer("select-1", { value: "Keep" }))).status, "accepted");
  assert.equal((await run(answer("select-1", { value: "Keep" }))).status, "replayed");
  assert.equal((await run(answer("select-1", { value: "Other (manual input)" }))).code, "ui_request_conflict");
});

test("answer_ui never invents success from a missing or mismatched runtime receipt", async () => {
  const { run, worker } = harness([popup("select-1")]);
  for (const receipt of [null, { status: "accepted" }, { status: "accepted", id: "wrong-id", runtimeGeneration: "worker-generation", resolution: "answered" }]) {
    worker.send = async () => receipt;
    assert.match((await run(answer("select-1", { value: "Keep" }))).error, /matching accepted or replayed answer receipt/);
  }
});

test("ask_user_question manual choice opens and answers a fresh input request", async () => {
  const { run, worker } = harness([popup("ask-select")]);
  const selected = await run(answer("ask-select", { value: "Other (manual input)" }));
  assert.equal(selected.status, "accepted");
  assert.equal(selected.pendingUi.requests[0].id, "manual-input");
  const next = await run({ action: "wait_for", until: "ui_request", timeoutMs: 100 });
  assert.equal(next.event.id, "manual-input");
  assert.equal(worker.uiListeners.size, 0, "synchronous pending replay must detach the subscription");
  const text = "  Preserve whitespace\n第二行  ";
  const supplied = await run(answer(next.event.id, { value: text }));
  assert.equal(supplied.status, "accepted");
  assert.equal(worker.calls.at(-1).value, text);
  assert.equal(supplied.pendingUi.requests.length, 0);
});

test("confirm false, cancellation and empty editor text remain distinct exact answers", async () => {
  const { run, worker } = harness([popup("confirmation", "confirm"), popup("editor", "editor"), popup("cancel", "input")]);
  assert.equal((await run(answer("confirmation", { confirmed: false }))).resolution, "answered");
  assert.equal(worker.calls.at(-1).confirmed, false);
  assert.equal((await run(answer("editor", { value: "" }))).resolution, "answered");
  assert.equal(worker.calls.at(-1).value, "");
  assert.equal((await run(answer("cancel", { cancelled: true }))).resolution, "cancelled");
  assert.equal(worker.calls.at(-1).cancelled, true);
});

test("ui_request wait subscribes until a real popup; peer questions and notifications do not satisfy it", async () => {
  const { run, worker } = harness();
  let completed = false;
  const waiting = run({ action: "wait_for", until: "ui_request", timeoutMs: 1000 }).then((value) => { completed = true; return value; });
  assert.equal(worker.uiListeners.size, 1);
  worker.emit({ type: "peer_message", kind: "question", message: "Question from another agent" });
  worker.emit({ type: "extension_ui_request", id: "old", method: "input", runtimeGeneration: "old-generation", replay: true });
  worker.publish([popup("notice", "notify"), popup("custom", "custom", { responseSchema: { supported: false } })]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(completed, false);
  worker.publish([popup("actual-input", "input")]);
  const result = await waiting;
  assert.equal(result.timedOut, false);
  assert.equal(result.event.id, "actual-input");
  assert.equal(result.event.runtimeGeneration, "worker-generation");
  assert.equal(worker.uiListeners.size, 0);
});

test("ui_request waits clean up after timeout, abort and closed runtime without polling", async () => {
  const { run, worker } = harness();
  const timedOut = await run({ action: "wait_for", until: "ui_request", timeoutMs: 100 });
  assert.equal(timedOut.timedOut, true);
  assert.equal(worker.uiListeners.size, 0);
  const controller = new AbortController();
  const pending = run({ action: "wait_for", until: "ui_request", timeoutMs: 1000 }, controller.signal);
  controller.abort();
  assert.equal((await pending).aborted, true);
  assert.equal(worker.uiListeners.size, 0);
  const closing = run({ action: "wait_for", until: "ui_request", timeoutMs: 1000 });
  worker.publish([], "closed");
  const closed = await closing;
  assert.equal(closed.runtimeClosed, true);
  assert.equal(closed.state, null);
  assert.equal(worker.uiListeners.size, 0);
  assert.equal(worker.calls.filter((call) => call.type === "get_state").length, 2, "only terminal snapshots read state; no idle polling");
});

test("register_wait rejects unknown remote devices, self, taskId and synthetic popup results", async () => {
  const { run } = harness();
  const continuation = { target: { deviceId: "ui-test-device", sessionId: "owner" }, authorizedScope: ["resume_prior_work"], message: "Inspect the pending UI for the approved supervision task." };
  assert.match((await run({ action: "register_wait", condition: "ui_request", targetDeviceId: "remote-device", continuation })).error, /Unknown trusted Reader device/);
  assert.match((await run({ action: "register_wait", condition: "ui_request", target: "owner", continuation })).error, /another session/);
  assert.match((await run({ action: "register_wait", condition: "ui_request", taskId: "task", continuation })).error, /do not support taskId/);
  assert.match((await run({ action: "report_result", event: { type: "ui_request" } })).error, /only by the live popup runtime/);
});

test("late ui_request registration replays only live pending popups into its own durable wait", async () => {
  const { run, owner } = harness([popup("already-open", "input")]);
  owner.state.running = false;
  const continuation = { target: { deviceId: "ui-test-device", sessionId: "owner", sessionFile: owner.sessionFile }, authorizedScope: ["resume_prior_work"], message: "Inspect the pending UI for the approved supervision task." };
  const registered = await run({ action: "register_wait", waitId: "late-ui-wait", condition: "ui_request", continuation });
  assert.equal(registered.registered, true);
  assert.equal(registered.status, "completed");
  assert.equal(registered.runtimeGeneration, "worker-generation");
  assert.equal(registered.pendingUi.requests[0].id, "already-open");
  const again = await run({ action: "register_wait", waitId: "late-ui-wait-two", condition: "ui_request", continuation });
  assert.equal(again.status, "completed", "an earlier popup event must not deduplicate a new subscription's replay");
  assert.notEqual(registered.lastEventId, again.lastEventId);
});

test("session_control supervises a real wrapper through durable notification and two-step manual UI", async (t) => {
  const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
  const { drainLocalOwnerOutboxes } = await jiti.import("./session-waits.ts");
  const { run, owner } = harness();
  const sessionId = "real-worker";
  const sessionFile = join(root, `${sessionId}.jsonl`);
  writeFileSync(sessionFile, "");
  const manager = {
    getSessionId: () => sessionId, getSessionFile: () => sessionFile, getCwd: () => "/fixture",
    getHeader: () => ({ id: sessionId, cwd: "/fixture" }), getSessionName: () => sessionId,
    getEntries: () => [], getLeafId: () => null, buildSessionContext: () => ({ messages: [] }),
  };
  const wrapper = new AgentSessionWrapper({
    sessionId, sessionFile, sessionManager: manager,
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    pendingMessageCount: 0, autoRetryEnabled: false, autoCompactionEnabled: false,
    agent: { state: { messages: [] }, abort() {} }, extensionRunner: {},
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
    getContextUsage: () => null, getSteeringMessages: () => [], getFollowUpMessages: () => [],
    settingsManager: { getDefaultThinkingLevel: () => "off" },
  });
  globalThis.__piSessions.set(sessionId, wrapper);
  t.after(async () => { wrapper.destroy(); await wrapper.waitUntilDisposed(); });
  const control = (params) => run({ target: sessionId, ...params });
  const continuation = { target: { deviceId: "ui-test-device", sessionId: "owner", sessionFile: owner.sessionFile }, authorizedScope: ["resume_prior_work"], message: "Inspect the pending UI for the approved supervision task." };
  const registered = await control({ action: "register_wait", waitId: "real-wrapper-ui", condition: "ui_request", continuation });
  assert.equal(registered.status, "waiting");
  owner.state.running = false;
  const ui = wrapper.createExtensionUiContext();
  const program = (async () => {
    const selected = await ui.select("审查下一步", ["继续", "手动输入"]);
    if (selected !== "手动输入") return selected;
    return ui.input("输入答复", "完整答复");
  })();
  await drainLocalOwnerOutboxes();
  await new Promise((resolve) => setImmediate(resolve));
  await drainLocalOwnerOutboxes();
  const notification = owner.calls.find((call) => call.customType === "pi-web:session-peer" && call.content.includes("UI request notification"));
  assert.ok(notification, "native popup event must wake the owner through the existing durable outbox");
  assert.match(notification.content, /notification only, not authorization/);
  const first = await control({ action: "wait_for", until: "ui_request", timeoutMs: 100 });
  assert.equal(first.event.method, "select");
  const generation = first.state.pendingUi.runtimeGeneration;
  assert.equal(first.event.runtimeGeneration, generation);
  const selected = await control({ action: "answer_ui", requestId: first.event.id, runtimeGeneration: generation, value: "手动输入" });
  assert.equal(selected.status, "accepted");
  const second = await control({ action: "wait_for", until: "ui_request", timeoutMs: 100 });
  assert.equal(second.event.method, "input");
  assert.notEqual(second.event.id, first.event.id);
  const response = "只复用已有审查，不新增模型调用。";
  const supplied = await control({ action: "answer_ui", requestId: second.event.id, runtimeGeneration: generation, value: response });
  assert.equal(supplied.status, "accepted");
  assert.equal(await program, response);
  assert.equal(supplied.pendingUi.requests.length, 0);
  const replay = await control({ action: "answer_ui", requestId: second.event.id, runtimeGeneration: generation, value: response });
  assert.equal(replay.status, "replayed");
});
