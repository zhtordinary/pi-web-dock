import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createHash } from "node:crypto";
import ts from "typescript";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
const managed = source.slice(source.indexOf("async function handleManagedControl"));

test("managed control is live-only and cannot fall through to runtime start", () => {
  assert.match(source, /readerMcpControl/);
  assert.match(managed, /runtime_not_live/);
  assert.match(managed, /runtimeStartAttempted: false/);
  assert.doesNotMatch(managed, /startRpcSession/);
  assert.match(managed, /device_mismatch/);
  assert.match(managed, /cwd_mismatch/);
  assert.match(managed, /boot_changed/);
  assert.match(managed, /revision_conflict/);
});

test("managed control persists identity-bound receipts and rejects unsafe writes", () => {
  assert.match(managed, /reserveControlReceipt/);
  assert.match(managed, /updateControlReceipt/);
  assert.match(managed, /idempotency_conflict/);
  assert.match(managed, /confirmation_required/);
  assert.match(managed, /confirmation_reason_required/);
  assert.match(managed, /bindControlReceipt/);
  assert.match(managed, /redactLiveValue/);
  assert.match(managed, /expectedLeafId/);
  assert.match(managed, /clear_queue/);
  assert.match(managed, /requestedType === "stop"/);
  assert.match(managed, /expectedLeafId/);
  assert.doesNotMatch(managed, /delete command\.expectedLeafId/);
  assert.match(managed, /matchesExpectedLeaf/);
  assert.match(managed, /branch_position_changed/);

  const abortUpdateStart = managed.search(/if \(operation === "clear_queue".*?setting\)/);
  const abortUpdateEnd = managed.indexOf("      } else {", abortUpdateStart);
  assert.ok(abortUpdateStart >= 0);
  assert.ok(abortUpdateEnd > abortUpdateStart);
  assert.doesNotMatch(managed.slice(abortUpdateStart, abortUpdateEnd), /targetStopped:\s*false/);
});

test("an idempotency conflict returns before binding or sending a command", async () => {
  const guard = managed.indexOf("if (reserved.conflict || reserved.replayed)");
  const bind = managed.indexOf("existing.bindControlReceipt", guard);
  const send = managed.indexOf("existing.send(command)", guard);
  assert.ok(guard >= 0, "managed control must guard both conflicts and replays");
  assert.ok(bind > guard, "the guard must precede receipt binding");
  assert.ok(send > bind, "the guard must precede the Reader send call");

  let sendCalls = 0;
  const reserved = {
    conflict: true,
    replayed: false,
    receipt: { outcome: "conflict", error: { code: "idempotency_conflict", message: "conflict" } },
  };
  const response = reserved.conflict || reserved.replayed
    ? { status: 409, code: "idempotency_conflict", replayed: reserved.replayed }
    : (sendCalls++, { status: 200, code: "sent", replayed: false });
  assert.equal(response.status, 409);
  assert.equal(response.code, "idempotency_conflict");
  assert.equal(response.replayed, false);
  assert.equal(sendCalls, 0);
});

test("a stale expected leaf is rejected before binding or sending", () => {
  const staleGuard = managed.indexOf("code: \"branch_position_changed\"");
  const bind = managed.indexOf("existing.bindControlReceipt", staleGuard);
  const send = managed.indexOf("existing.send(command)", staleGuard);
  assert.ok(staleGuard >= 0);
  assert.ok(bind > staleGuard);
  assert.ok(send > bind);

  let sendCalls = 0;
  const currentLeaf = "leaf-current";
  const expectedLeaf = "leaf-stale";
  const response = currentLeaf === expectedLeaf
    ? (sendCalls++, { status: 200, code: "sent" })
    : { status: 409, code: "branch_position_changed" };
  assert.deepEqual(response, { status: 409, code: "branch_position_changed" });
  assert.equal(sendCalls, 0);
});


function routeFixture({ uiError, retryError, raceQueue = false, failPersistence = false, failAfterMutation = false, failFirstPersistence = false, terminalAbort = false, denyRequest = false, inactive = false, activeRun = true, sendRejection = false, bindingRejection = false, lookupRejection = false } = {}) {
  const receipts = new Map();
  const bindings = new Set();
  let queueRevision = "queue-1";
  let runtimeRevision = "runtime-1";
  let clearCalls = 0;
  let settingCalls = 0;
  let bindCalls = 0;
  let sendCalls = 0;
  let releaseCalls = 0;
  let persistenceCalls = 0;
  const session = {
    cwd: "/tmp/reader-managed-queue-fixture",
    inner: { sessionManager: {} },
    isAlive: () => !inactive,
    getActiveControlRunId: () => activeRun ? "fixture-run" : null,
    getLiveRuntimeIdentity: () => ({ bootId: "boot-1", revision: runtimeRevision }),
    getQueueIdentity: () => ({ revision: queueRevision, counts: { steering: 1, followUp: 1, total: 2 } }),
    bindControlReceipt: (id) => { bindCalls += 1; bindings.add(id); },
    releaseControlReceiptBinding: () => { releaseCalls++; },
    releaseRejectedControlReceiptBinding: (id) => { releaseCalls++; return bindings.delete(id); },
    hasControlReceiptLifecycleBinding: (id) => bindings.has(id),
    validateManagedSetting: () => {},
    sendManagedSetting: async (command, expected) => {
      assert.ok(["set_model", "set_tools"].includes(command.type));
      assert.equal(expected.bootId, "boot-1");
      assert.equal(expected.revision, runtimeRevision);
      settingCalls += 1;
      runtimeRevision = "runtime-setting-2";
      if (failAfterMutation) throw new Error("fixture response failed after setting mutation");
      return { bootId: "boot-1", revision: runtimeRevision, tools: [], strictToolAllowlist: true };
    },
    send: async (command) => {
      sendCalls++;
      if (sendRejection) throw new Error("invalid fixture images");
      if (command.type === "extension_ui_response") {
        if (uiError) throw Object.assign(new Error("request rejected"), {code:uiError});
        assert.equal(command.runtimeGeneration,"boot-1");
        return {status:"accepted",id:command.id,runtimeGeneration:command.runtimeGeneration,resolution:"answered"};
      }
      if (command.type === "retry_continue_only") {
        if (retryError) throw retryError;
        return null;
      }
      if (["prompt", "abort"].includes(command.type)) {
        if (terminalAbort && command.type === "abort") {
          const [key, receipt] = [...receipts].find(([, value]) => value.receiptId === command.readerControlReceiptId);
          receipts.set(key, { ...receipt, outcome: "aborted", targetStopped: true, runId: "actual-settled-run" });
        }
        return null;
      }
      assert.equal(command.type, "clear_queue");
      if (command.expectedQueueRevision !== queueRevision) {
        throw Object.assign(new Error("Reader queue revision changed"), { code: "queue_revision_conflict" });
      }
      clearCalls += 1;
      const previousQueueRevision = queueRevision;
      queueRevision = "queue-2";
      runtimeRevision = "runtime-2";
      if (failAfterMutation) throw new Error("fixture response failed after clearing queue");
      return { previousQueueRevision, queueRevision, clearedCounts: { steering: 1, followUp: 1, total: 2 } };
    },
  };
  const receiptKey = (input) => `${input.deviceId}:${input.sessionId}:${input.operation}:${input.idempotencyKey}`;
  const receiptApi = {
    publicControlReceipt: (receipt) => {
      const { idempotencyKey, cwd, ...safe } = receipt;
      return { ...safe, idempotencyKeyRef: createHash("sha256").update(String(idempotencyKey)).digest("hex"), cwdRef: createHash("sha256").update(String(cwd)).digest("hex") };
    },
    controlRequestFingerprint: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex"),
    validateControlIdempotencyKey: (value) => { assert.equal(typeof value, "string"); return value; },
    validateControlFingerprint: (value) => value,
    readControlReceipt: async (input) => receipts.get(receiptKey(input)) ?? null,
    reserveControlReceipt: async (input) => {
      const key = receiptKey(input);
      const previous = receipts.get(key);
      if (previous) return previous.requestFingerprint === input.requestFingerprint
        ? { receipt: previous, replayed: true, conflict: false }
        : { receipt: { ...previous, outcome: "conflict", error: { code: "idempotency_conflict" } }, replayed: false, conflict: true };
      const receipt = { ...input, receiptId: "receipt-1", outcome: "accepted" };
      receipts.set(key, receipt);
      if (raceQueue) queueRevision = "queue-raced";
      return { receipt, replayed: false, conflict: false };
    },
    updateControlReceipt: async (id, update) => {
      persistenceCalls++;
      if (failPersistence || (failFirstPersistence && persistenceCalls === 1)) throw new Error("fixture audit unavailable");
      const [key, previous] = [...receipts].find(([, receipt]) => receipt.receiptId === id);
      if (["completed", "aborted", "failed", "conflict"].includes(previous.outcome) && update.outcome !== previous.outcome) return previous;
      const next = { ...previous, ...update };
      receipts.set(key, next);
      return next;
    },
  };
  const dependencies = {
    "@/lib/queue-recall-store": new Proxy({}, { get: () => () => { throw new Error("managed control must not enter UI attachment recall"); } }),
    "next/server": { NextResponse: { json: (value, init) => Response.json(value, init) } },
    "@/lib/request-security": { isApiRequestAllowed: () => !denyRequest, hasJsonContentType: () => true },
    "@/lib/session-reader": { resolveSessionPath: () => { throw new Error("must not resolve a durable session"); } },
    "@/lib/rpc-manager": { getRpcSession: () => { if (lookupRejection) throw new Error("/tmp/private-fixture-error"); return session; }, assertRpcSessionRuntimeBinding: async () => { if (bindingRejection) throw new Error("/tmp/private-fixture-error"); } },
    "@/lib/session-tool-selection": {},
    "@/lib/branch-navigation": { matchesExpectedLeaf: () => true },
    "@/lib/activity-peers": { localDeviceIdentity: () => ({ id: "fixture" }), readActivityConfig: () => ({}) },
    "@/lib/paths": { samePath: (a, b) => a === b },
    "@/lib/live-agent-events": { redactLiveValue: (value) => (bindingRejection || lookupRejection) && typeof value === "string" ? "[projected-error]" : value },
    "@/lib/reader-control-receipts": receiptApi,
  };
  const testModule = { exports: {} };
  const compiled = ts.transpileModule(source + "\nmodule.exports.testReservationResponse = managedReservationResponse;", { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name) => {
    assert.ok(Object.hasOwn(dependencies, name), `unexpected dependency ${name}`);
    return dependencies[name];
  }, testModule, testModule.exports);
  const body = {
    type: "clear_queue", readerMcpControl: true, dryRun: false,
    deviceId: "fixture", cwd: session.cwd,
    expectedBootId: "boot-1", expectedRevision: "runtime-1", expectedQueueRevision: "queue-1",
    confirm: true, confirmationReason: "隔离队列契约测试", idempotencyKey: "queue-fixture-1",
  };
  return {
    receipts,
    reservationResponse: testModule.exports.testReservationResponse,
    calls: () => ({ clearCalls, bindCalls }),
    lifecycleCalls: () => ({ sendCalls, releaseCalls, persistenceCalls }),
    get: async () => {
      const response = await testModule.exports.GET(new Request("http://reader.invalid/api/agent/fixture"), { params: Promise.resolve({ id: "fixture-session" }) });
      return { status: response.status, body: await response.json() };
    },
    settingCalls: () => settingCalls,
    post: async (changes = {}) => {
      const response = await testModule.exports.POST(new Request("http://reader.invalid/api/agent/fixture", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, ...changes }),
      }), { params: Promise.resolve({ id: "fixture-session" }) });
      return { status: response.status, body: await response.json() };
    },
  };
}

test("retry-only POST distinguishes accepted requests from typed and generic preflight rejection", async () => {
  const command = { type: "retry_continue_only", readerMcpControl: false, idempotencyKey: undefined, expectedRunId: "observed-run" };
  const accepted = await routeFixture().post(command);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.success, true);
  for (const options of [
    { retryError: Object.assign(new Error("Run changed"), { code: "retry_target_changed" }) },
    { sendRejection: true },
    { bindingRejection: true },
  ]) {
    const rejected = await routeFixture(options).post(command);
    assert.equal(rejected.status, 500);
    assert.equal(rejected.body.accepted, false);
    assert.equal(rejected.body.code, options.retryError ? "retry_target_changed" : "retry_rejected");
  }
});

test("managed clear queue records completion and replays before evaluating stale preconditions", async () => {
  const fixture = routeFixture();
  const first = await fixture.post();
  assert.equal(first.status, 200);
  assert.equal(first.body.receipt.outcome, "completed");
  assert.equal(first.body.data.queueRevision, "queue-2");
  assert.deepEqual(fixture.calls(), { clearCalls: 1, bindCalls: 0 });
  const replay = await fixture.post();
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receipt.receiptId, first.body.receipt.receiptId);
  assert.equal(replay.body.receipt.outcome, "completed");
  const conflict = await fixture.post({ expectedQueueRevision: "queue-2" });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  assert.deepEqual(fixture.calls(), { clearCalls: 1, bindCalls: 0 });
});

test("managed clear queue dry run returns queue CAS without a durable reservation", async () => {
  const fixture = routeFixture();
  const dryRun = await fixture.post({ dryRun: true, expectedQueueRevision: undefined, confirm: false });
  assert.equal(dryRun.status, 200);
  assert.equal(dryRun.body.outcome, "dry_run");
  assert.equal(dryRun.body.queueRevision, "queue-1");
  assert.equal(dryRun.body.queueCounts.total, 2);
  assert.equal(fixture.receipts.size, 0);
  assert.deepEqual(fixture.calls(), { clearCalls: 0, bindCalls: 0 });
});

test("managed clear queue rejects absent/stale CAS and wrong device/cwd or missing confirmation before mutation", async () => {
  for (const [changes, status, code] of [
    [{ expectedQueueRevision: undefined }, 400, "queue_revision_required"],
    [{ expectedQueueRevision: "old-queue" }, 409, "queue_revision_conflict"],
    [{ deviceId: "other" }, 409, "device_mismatch"],
    [{ cwd: "/tmp/other" }, 409, "cwd_mismatch"],
    [{ confirm: false }, 403, "confirmation_required"],
    [{ confirmationReason: "" }, 400, "managed_control_rejected"],
  ]) {
    const fixture = routeFixture();
    const result = await fixture.post(changes);
    assert.equal(result.status, status);
    assert.equal(result.body.code, code);
    assert.equal(fixture.receipts.size, 0);
    assert.deepEqual(fixture.calls(), { clearCalls: 0, bindCalls: 0 });
  }
});

test("a queue mutation racing durable reservation leaves a persistent conflict and never clears", async () => {
  const fixture = routeFixture({ raceQueue: true });
  const first = await fixture.post();
  assert.equal(first.status, 409);
  assert.equal(first.body.code, "queue_revision_conflict");
  assert.equal(first.body.queueRevision, "queue-raced");
  assert.equal(first.body.receipt.outcome, "conflict");
  const replay = await fixture.post();
  assert.equal(replay.status, 409);
  assert.equal(replay.body.code, "queue_revision_conflict");
  assert.equal(replay.body.replayed, true);
  assert.deepEqual(fixture.calls(), { clearCalls: 0, bindCalls: 0 });
});


test("managed live settings complete synchronously and replay durable receipts before stale CAS", async () => {
  const fixture = routeFixture();
  const fields = { type: "set_tools", toolNames: [], idempotencyKey: "live-setting-1" };
  const first = await fixture.post(fields);
  assert.equal(first.status, 200);
  assert.equal(first.body.receipt.outcome, "completed");
  assert.equal(first.body.receipt.revision, "runtime-setting-2");
  assert.deepEqual(fixture.calls(), { clearCalls: 0, bindCalls: 0 });
  const replay = await fixture.post(fields);
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replayed, true);
  const conflict = await fixture.post({ ...fields, toolNames: ["ls"] });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.body.code, "idempotency_conflict");
  for (const changes of [{ cwd: undefined }, { deviceId: undefined }, { expectedBootId: undefined }, { expectedRevision: undefined }]) {
    const rejected = await routeFixture().post({ ...fields, ...changes });
    assert.equal(rejected.status, 400);
  }
});


test("a real queue clear followed by an audit failure stays unknown without fabricating a durable terminal receipt", async () => {
  const fixture = routeFixture({ failPersistence: true });
  const result = await fixture.post();
  assert.equal(result.status, 503);
  assert.equal(result.body.outcome, "unknown");
  assert.equal(result.body.accepted, true);
  assert.equal(result.body.receiptId, "receipt-1");
  assert.equal(result.body.receiptPersistence, "unknown");
  assert.equal(result.body.receipt, undefined);
  assert.deepEqual(fixture.calls(), { clearCalls: 1, bindCalls: 0 });
});

test("an observed abort terminal receipt replays as success while a cleared prompt does not", async () => {
  const fixture = routeFixture();
  const stopped = fixture.reservationResponse({ replayed: true, conflict: false, receipt: { operation: "abort", outcome: "aborted", targetStopped: true } });
  assert.equal(stopped.status, 200);
  assert.equal((await stopped.json()).success, true);
  const cleared = fixture.reservationResponse({ replayed: true, conflict: false, receipt: { operation: "prompt", outcome: "aborted" } });
  assert.equal(cleared.status, 409);
  assert.equal((await cleared.json()).success, false);
});


test("managed live settings require explicit boolean execution intent", async () => {
  for (const type of ["set_model", "set_tools"]) {
    const omitted = routeFixture();
    const dryRun = await omitted.post({ type, dryRun: undefined, toolNames: [], provider: "fixture", modelId: "fixture-model" });
    assert.equal(dryRun.status, 200);
    assert.equal(dryRun.body.outcome, "dry_run");
    assert.equal(omitted.receipts.size, 0);
    assert.deepEqual(omitted.calls(), { clearCalls: 0, bindCalls: 0 });
    for (const value of ["false", "true", null, 0]) {
      const fixture = routeFixture();
      const result = await fixture.post({ type, dryRun: value, toolNames: [], provider: "fixture", modelId: "fixture-model" });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, "invalid_dry_run");
      assert.equal(fixture.receipts.size, 0);
    }
  }
});

test("managed runtime receipts redact raw keys and cwd on success, replay and conflict", async () => {
  const fixture = routeFixture();
  for (const result of [await fixture.post(), await fixture.post(), await fixture.post({ expectedQueueRevision: "changed" })]) {
    assert.equal(result.body.receipt.idempotencyKey, undefined);
    assert.equal(result.body.receipt.cwd, undefined);
    assert.match(result.body.receipt.idempotencyKeyRef, /^[a-f0-9]{64}$/);
    assert.match(result.body.receipt.cwdRef, /^[a-f0-9]{64}$/);
  }
});

test("abort acknowledgement stays running until the real target settlement is recorded", async () => {
  const pending = routeFixture();
  const accepted = await pending.post({ type: "abort" });
  assert.equal(accepted.body.receipt.outcome, "running");
  assert.equal(accepted.body.receipt.targetStopped, undefined);
  assert.equal(accepted.body.receipt.completedAt, undefined);
  const terminal = await routeFixture({ terminalAbort: true }).post({ type: "abort" });
  assert.equal(terminal.body.receipt.outcome, "aborted");
  assert.equal(terminal.body.receipt.targetStopped, true);
  assert.equal(terminal.body.receipt.runId, "actual-settled-run");
  const unproven = pending.reservationResponse({ replayed: true, conflict: false, receipt: { operation: "abort", outcome: "aborted" } });
  assert.equal(unproven.status, 409);
  assert.equal((await unproven.json()).success, false);
});

test("accepted asynchronous prompt followed by an audit failure is unknown and keeps its lifecycle binding", async () => {
  for (const options of [{ failFirstPersistence: true }, { failPersistence: true }]) {
    const fixture = routeFixture(options);
    const result = await fixture.post({ type: "prompt", message: "fixture only" });
    assert.equal(result.status, 503);
    assert.equal(result.body.outcome, "unknown");
    assert.equal(result.body.accepted, true);
    assert.equal(result.body.runtimeStartAttempted, false);
    assert.equal(result.body.writeSideEffects, "unknown");
    assert.equal(fixture.lifecycleCalls().sendCalls, 1);
    assert.equal(fixture.lifecycleCalls().releaseCalls, 0);
    const original = [...fixture.receipts.values()][0];
    assert.notEqual(original.outcome, "failed");
    assert.notEqual(original.outcome, "unknown", "a provisional POST must not freeze the live lifecycle as terminal unknown");
  }
});

test("rejected admission releases its transient binding and synchronous writes report their completed receipt", async () => {
  const fixture = routeFixture({ sendRejection: true });
  const result = await fixture.post({ type: "prompt", message: "fixture" });
  assert.equal(result.status, 503); assert.equal(result.body.outcome, "unknown");
  assert.equal(fixture.lifecycleCalls().releaseCalls, 1);
  const clear = await routeFixture().post();
  assert.equal(clear.body.outcome, "completed"); assert.equal(clear.body.receipt.outcome, "completed");
  const projected = await routeFixture({ bindingRejection: true }).post();
  assert.equal(projected.body.error, "[projected-error]");
});

test("outer POST and runtime GET errors use the common public projection before returning", async () => {
  const fixture = routeFixture({ lookupRejection: true });
  for (const result of [await fixture.post(), await fixture.get()]) {
    assert.equal(result.status, 500); assert.equal(result.body.error, "[projected-error]");
    assert.equal(JSON.stringify(result.body).includes("/tmp/private-fixture-error"), false);
  }
  assert.equal(fixture.receipts.size, 0);
});

test("tools GET checks the actual live runtime binding before reading its settings", async () => {
  const toolsSource = await readFile(new URL("./tools/route.ts", import.meta.url), "utf8");
  for (const rejectBinding of [true, false]) {
    let bindingChecks = 0, snapshotReads = 0;
    const session = { cwd: "/tmp/fixture-tools", isAlive: () => true, getManagedSettingsSnapshot: () => { snapshotReads++; return { tools: [], revision: "fixture" }; } };
    const dependencies = {
    "@/lib/queue-recall-store": new Proxy({}, { get: () => () => { throw new Error("managed control must not enter UI attachment recall"); } }),
      "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
      "@/lib/rpc-manager": { getRpcSession: () => session, assertRpcSessionRuntimeBinding: async (actual) => { assert.equal(actual, session); bindingChecks++; if (rejectBinding) throw new Error("stale named binding"); } },
      "@/lib/request-security": { isApiRequestAllowed: () => true },
      "@/lib/activity-peers": { localDeviceIdentity: () => ({ id: "fixture" }), readActivityConfig: () => ({}) },
      "@/lib/paths": { samePath: (a, b) => a === b },
      "@/lib/reader-control-receipts": { controlRequestFingerprint: (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex") },
    };
    const toolsModule = { exports: {} };
    const compiled = ts.transpileModule(toolsSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    new Function("require", "module", "exports", compiled)((name) => { assert.ok(Object.hasOwn(dependencies, name)); return dependencies[name]; }, toolsModule, toolsModule.exports);
    const response = await toolsModule.exports.GET(new Request("http://reader.invalid/api/agent/id/tools?deviceId=fixture&cwd=%2Ftmp%2Ffixture-tools"), { params: Promise.resolve({ id: "owned" }) });
    const body = await response.json();
    assert.equal(bindingChecks, 1);
    assert.equal(response.status, rejectBinding ? 409 : 200);
    assert.equal(snapshotReads, rejectBinding ? 0 : 1);
    assert.equal(body.runtimeStartAttempted, false);
    assert.equal(body.writeSideEffects, false);
    if (rejectBinding) { assert.equal(body.code, "runtime_binding_invalid"); assert.equal(body.tools, undefined); }
    else { assert.equal(body.cwd, undefined); assert.match(body.cwdRef, /^[a-f0-9]{64}$/); }
  }
});

test("receipt GET reports pending terminal persistence as unknown without changing stored state", async () => {
  const receiptSource = await readFile(new URL("./receipt/route.ts", import.meta.url), "utf8");
  let reads = 0;
  let allowed = true;
  let readFailure = false;
  let ownerMissing = false;
  let ownerAlive = false, pending = true, ownerBoot = "new-runtime";
  const stored = { receiptId: "fixture-receipt", operation: "abort", outcome: "running", bootId: "old-runtime", cwd: "/tmp/private", idempotencyKey: "fixture-key" };
  const dependencies = {
    "@/lib/queue-recall-store": new Proxy({}, { get: () => () => { throw new Error("managed control must not enter UI attachment recall"); } }),
    "next/server": { NextResponse: { json: (body, init) => Response.json(body, init) } },
    "@/lib/activity-peers": { localDeviceIdentity: () => ({ id: "fixture" }), readActivityConfig: () => ({}) },
    "@/lib/rpc-manager": { getRpcSession: () => ownerMissing ? undefined : ({ isAlive: () => ownerAlive,
      getLiveRuntimeIdentity: () => ({ bootId: ownerBoot }), hasPendingControlReceiptPersistence: () => pending }) },
    "@/lib/request-security": { isApiRequestAllowed: () => allowed },
    "@/lib/live-agent-events": { redactLiveValue: (value) => typeof value === "string" ? "[projected-error]" : value },
    "@/lib/reader-control-receipts": {
      readControlReceipt: async () => { reads++; if (readFailure) throw new Error("/tmp/private-fixture-error"); return stored; }, validateControlIdempotencyKey: (v) => v,
      publicControlReceipt: (r) => ({ receiptId: r.receiptId, outcome: r.outcome, nextAction: r.nextAction }),
    },
  };
  const receiptModule = { exports: {} };
  const compiled = ts.transpileModule(receiptSource, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  new Function("require", "module", "exports", compiled)((name) => dependencies[name], receiptModule, receiptModule.exports);
  const res = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  const body = await res.json();
  assert.equal(reads, 1); assert.equal(stored.outcome, "running");
  assert.equal(body.outcome, "unknown"); assert.equal(body.receipt.outcome, "unknown");
  assert.equal(body.receiptPersistence, "pending"); assert.equal(body.storedOutcome, "running");
  assert.equal(body.runtimeStartAttempted, false); assert.equal(body.writeSideEffects, false);
  allowed = false;
  const denied = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal(denied.status, 403); assert.equal(reads, 1);
  allowed = true; readFailure = true;
  const unavailable = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal(unavailable.status, 503);
  const failed = await unavailable.json();
  assert.equal(failed.code, "receipt_store_unavailable"); assert.equal(failed.outcome, "unknown");
  assert.equal(JSON.stringify(failed).includes("private-fixture"), false);
  readFailure = false; ownerMissing = true;
  const orphan = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  const orphanBody = await orphan.json(); assert.equal(orphanBody.outcome, "unknown");
  assert.equal(orphanBody.runtimeOwner, "unavailable"); assert.equal(stored.outcome, "running");
  ownerMissing = false; ownerAlive = true; pending = false;
  const oldBoot = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal((await oldBoot.json()).outcome, "unknown", "an alive replacement runtime cannot prove the old receipt is running");
  ownerBoot = "old-runtime";
  const bound = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal((await bound.json()).outcome, "running");
  stored.outcome = "completed"; ownerBoot = "new-runtime";
  const historical = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt?receiptId=fixture-receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal((await historical.json()).outcome, "completed", "durable historical terminal facts remain authoritative");
  const beforeInvalid = reads;
  const invalid = await receiptModule.exports.GET(new Request("http://reader.invalid/api/agent/id/receipt"), { params: Promise.resolve({ id: "id" }) });
  assert.equal(invalid.status, 400); assert.equal(reads, beforeInvalid);
});

test("managed get_state cannot wake persisted sessions and idle abort is rejected before receipt reservation", async () => {
  const inactive = routeFixture({ inactive: true });
  const state = await inactive.post({ type: "get_state" });
  assert.equal(state.status, 400); assert.equal(state.body.code, "unsupported_operation");
  assert.equal(inactive.lifecycleCalls().sendCalls, 0); assert.equal(inactive.receipts.size, 0);
  const idle = routeFixture({ activeRun: false });
  const aborted = await idle.post({ type: "abort" });
  assert.equal(aborted.status, 409); assert.equal(aborted.body.code, "no_active_run");
  assert.equal(idle.lifecycleCalls().sendCalls, 0); assert.equal(idle.receipts.size, 0);
  const untrusted = routeFixture({ denyRequest: true });
  assert.equal((await untrusted.post()).status, 403); assert.equal(untrusted.receipts.size, 0);
});

test("unknown managed writes replay the original accepted receipt without repeating the mutation", async () => {
  for (const type of ["clear_queue", "set_model", "set_tools"]) {
    const fixture = routeFixture({ failAfterMutation: true });
    const changes = { type, provider: "fixture", modelId: "fixture-model", toolNames: [] };
    const first = await fixture.post(changes);
    assert.equal(first.status, 503);
    assert.equal(first.body.outcome, "unknown");
    assert.equal(first.body.accepted, true);
    assert.equal(first.body.receipt.outcome, "unknown");
    const stored = structuredClone([...fixture.receipts.values()][0]);
    const replay = await fixture.post(changes);
    assert.equal(replay.status, 202);
    assert.equal(replay.body.outcome, "unknown");
    assert.equal(replay.body.success, false);
    assert.equal(replay.body.accepted, true);
    assert.equal(replay.body.replayed, true);
    assert.equal(replay.body.code, "control_outcome_unknown");
    assert.equal(replay.body.nextAction, "inspect_runtime_before_retry");
    assert.deepEqual(replay.body.receipt, first.body.receipt);
    assert.deepEqual([...fixture.receipts.values()][0], stored);
    assert.deepEqual(fixture.calls(), { clearCalls: type === "clear_queue" ? 1 : 0, bindCalls: 0 });
    assert.equal(fixture.settingCalls(), type === "clear_queue" ? 0 : 1);
  }
});

for (const code of ["ui_request_unknown","ui_request_expired","ui_request_conflict","ui_generation_mismatch","ui_response_invalid"]) {
  test(`managed UI ${code} cannot become a completed receipt`,async()=>{
    const fixture=routeFixture({uiError:code});
    const result=await fixture.post({type:"answer_question",questionId:"q",runtimeGeneration:"boot-1",confirmed:true});
    assert.equal(result.status,409);assert.equal(result.body.accepted,false);assert.equal(result.body.code,code);assert.equal(result.body.receipt.outcome,"conflict");
  });
}
test("managed UI receipt carries actual resolver result and replays without another send",async()=>{
 const fixture=routeFixture();const command={type:"answer_question",questionId:"q",runtimeGeneration:"boot-1",confirmed:false};
 const first=await fixture.post(command);assert.equal(first.status,200);assert.equal(first.body.data.status,"accepted");assert.equal(first.body.receipt.outcome,"completed");
 const second=await fixture.post(command);assert.equal(second.body.replayed,true);assert.equal(fixture.lifecycleCalls().sendCalls,1);
});


test("managed popup answer cannot leave an admission binding that blocks later queue clear", async () => {
  const fixture = routeFixture();
  const answer = { type: "answer_question", questionId: "q", runtimeGeneration: "boot-1", confirmed: true, idempotencyKey: "answer-before-clear" };
  const first = await fixture.post(answer);
  assert.equal(first.status, 200);
  assert.equal(first.body.receipt.outcome, "completed");
  assert.equal(first.body.data.resolution, "answered");
  assert.equal(fixture.calls().bindCalls, 0, "a UI resolver is not a pending model admission");
  const replay = await fixture.post(answer);
  assert.equal(replay.body.replayed, true);
  assert.equal(fixture.lifecycleCalls().sendCalls, 1);
  const cleared = await fixture.post({ idempotencyKey: "clear-after-answer" });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.body.receipt.outcome, "completed");
  assert.deepEqual(fixture.calls(), { clearCalls: 1, bindCalls: 0 });
});

test("popup receipt write failure remains unknown without inventing a model lifecycle owner", async () => {
  const fixture = routeFixture({ failFirstPersistence: true });
  const answer = { type: "answer_question", questionId: "q", runtimeGeneration: "boot-1", confirmed: false, idempotencyKey: "answer-receipt-failure" };
  const first = await fixture.post(answer);
  assert.equal(first.status, 503);
  assert.equal(first.body.outcome, "unknown");
  assert.equal(fixture.calls().bindCalls, 0);
  assert.equal(fixture.lifecycleCalls().sendCalls, 1);
  const replay = await fixture.post(answer);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.outcome, "unknown");
  assert.equal(fixture.lifecycleCalls().sendCalls, 1, "unknown acknowledgement must not answer twice");
});
