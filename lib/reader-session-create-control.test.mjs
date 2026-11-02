import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createJiti } from "jiti";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "reader-create-contract-"));
  const old = process.env.PI_WEB_CONTROL_RECEIPT_ROOT;
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = join(dir, "receipts");
  t.after(async () => { if (old === undefined) delete process.env.PI_WEB_CONTROL_RECEIPT_ROOT; else process.env.PI_WEB_CONTROL_RECEIPT_ROOT = old; await rm(dir, { recursive: true, force: true }); });
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { createManagedSessionControl } = await jiti.import("./reader-session-create-control.ts");
  const store = await jiti.import("./reader-control-receipts.ts");
  let boot = "process-a", creates = 0, validates = 0, fail = false, failValidation = false;
  const deps = { deviceId: () => "fixture-device", bootId: () => boot,
    validate: async () => { validates++; return failValidation ? { status: 409, body: { code: "stale_workspace_state" } } : { status: 200, body: { validated: true } }; },
    create: async (body, onCreated) => {
      creates++;
      const sessionId = `created-${creates}`;
      await onCreated({ deviceId: "fixture-device", sessionId, cwd: dir, toolNames: body.toolNames, strictToolAllowlist: body.strictToolAllowlist === true });
      if (fail) return { status: 500, body: { code: "create_runtime_state_failed", error: "fixture get_state failed after runtime creation" } };
      return { status: 200, body: { success: true, sessionId, sessionBootId: `process-fixture:${sessionId}`, model: { provider: "fixture", modelId: "fake-model" }, data: null } };
    } };
  const request = { type: "ensure_session", cwd: dir, toolNames: [], strictToolAllowlist: true, dryRun: false, confirm: true, expectedBootId: "process-a", confirmationReason: "isolated fake runtime only", idempotencyKey: "fixture-create-0001", requestFingerprint: "client-hint" };
  return { dir, request, deps, store, make: () => createManagedSessionControl(deps), creates: () => creates, validates: () => validates,
    reboot: () => { boot = "process-b"; }, fail: () => { fail = true; }, rejectValidation: () => { failValidation = true; } };
}

test("dry-run/default/denials validate without creating receipts or runtimes", async (t) => {
  const f = await fixture(t), create = f.make();
  for (const dryRun of [undefined, true]) {
    const result = await create({ ...f.request, dryRun });
    assert.equal(result.body.outcome, "dry_run");
    assert.equal(result.body.target.cwd, undefined);
    assert.equal(result.body.target.cwdRef, f.store.controlRequestFingerprint(f.dir));
    assert.equal(JSON.stringify(result.body).includes(f.dir), false);
  }
  for (const [change, code] of [[{ confirm: false }, "confirmation_required"], [{ deviceId: "other" }, "device_mismatch"], [{ expectedBootId: "old" }, "boot_changed"], [{ expectedRevision: "a-runtime-revision" }, "unsupported_create_revision"], [{ expectedQueueRevision: "queue" }, "unsupported_create_revision"], [{ toolNames: ["bash"] }, "invalid_managed_tool_allowlist"], [{ strictToolAllowlist: false }, "invalid_managed_tool_allowlist"], [{ dryRun: "false" }, "invalid_dry_run"], [{ type: "prompt", message: "bad" }, "invalid_create_field"]]) {
    assert.equal((await create({ ...f.request, ...change })).body.code, code);
  }
  assert.equal(f.creates(), 0);
  assert.deepEqual(await readdir(f.dir), []);
});

test("concurrent duplicates create once; terminal replay preserves real ID and exact request binding", async (t) => {
  const f = await fixture(t), create = f.make();
  const results = await Promise.all(Array.from({ length: 12 }, () => create(f.request)));
  const done = results.find((r) => r.body.outcome === "completed");
  assert.ok(done); assert.equal(f.creates(), 1);
  assert.equal(done.body.receipt.error, undefined);
  assert.equal(done.body.sessionBootId, "process-fixture:created-1");
  const admitted = results.filter((r) => r.body.receipt);
  assert.equal(new Set(admitted.map((r) => r.body.receipt.receiptId)).size, 1);
  // The shared receipt lock is deliberately bounded. Under saturation, a
  // request can be denied before reservation; that is not a second creation
  // or a fabricated receipt, and an explicit later replay returns the same ID.
  for (const denied of results.filter((r) => !r.body.receipt)) {
    assert.equal(denied.status, 503, JSON.stringify(denied));
    assert.equal(denied.body.accepted, false);
    assert.equal(denied.body.runtimeStartAttempted, false);
    assert.equal(denied.body.writeSideEffects, false);
  }
  const replay = await f.make()(f.request);
  assert.equal(replay.body.sessionId, "created-1"); assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.sessionBootId, "process-fixture:created-1");
  assert.equal(replay.body.receipt.createdSessionBinding.cwd, undefined);
  assert.equal(replay.body.receipt.createdSessionBinding.cwdRef, f.store.controlRequestFingerprint(f.dir));
  assert.equal(replay.body.receipt.idempotencyKey, undefined);
  assert.equal(replay.body.receipt.cwd, undefined);
  assert.equal(replay.body.receipt.createdSessionBinding.strictToolAllowlist, true);
  assert.equal(replay.body.runtimeStartAttempted, false);
  for (const changed of [{ confirmationReason: "different authorization" }, { expectedBootId: "different-expected-process" }, { expectedRevision: "unexpected-runtime-revision" }, { expectedQueueRevision: "unexpected-queue" }, { cwd: `${f.dir}-other` }, { toolNames: ["ls"] }, { toolNames: undefined, strictToolAllowlist: undefined }, { provider: "other", modelId: "other" }]) {
    const conflict = await create({ ...f.request, ...changed });
    assert.equal(conflict.status, 409); assert.equal(conflict.body.code, "idempotency_conflict");
  }
  f.reboot(); f.rejectValidation();
  assert.equal((await f.make()({ ...f.request, expectedBootId: "process-a" })).body.sessionId, "created-1");
  assert.equal(f.creates(), 1, "replay does not revalidate a disappeared target or reopen the saved session");
  const raw = JSON.stringify(await f.store.readControlReceipt({ deviceId: "fixture-device", sessionId: "new", receiptId: done.body.receipt.receiptId }));
  assert.ok(!raw.includes("isolated fake runtime only"));
  assert.equal(done.body.receipt.audit.kind, "creation");
});

test("invalid caller control keys and fingerprints are input errors before receipt storage or runtime creation", async (t) => {
  const f = await fixture(t), create = f.make();
  for (const change of [{ idempotencyKey: "bad" }, { idempotencyKey: 3 }, { requestFingerprint: "invalid\0fingerprint" }, { requestFingerprint: {} }]) {
    const result = await create({ ...f.request, ...change });
    assert.equal(result.status, 400);
    assert.equal(result.body.code, "invalid_control_identity");
    assert.equal(result.body.runtimeStartAttempted, false);
    assert.equal(result.body.writeSideEffects, false);
  }
  assert.equal(f.creates(), 0); assert.equal(f.validates(), 0);
  assert.deepEqual(await readdir(f.dir), []);
});

test("fresh Node process replays completed creation from the original receipt store", async (t) => {
  const f = await fixture(t), done = await f.make()(f.request);
  const code = `import {createJiti} from 'jiti';const {createManagedSessionControl}=await createJiti(import.meta.url,{moduleCache:false}).import(${JSON.stringify(new URL("./reader-session-create-control.ts", import.meta.url).pathname)});const r=await createManagedSessionControl({deviceId:()=>"fixture-device",bootId:()=>"different-process",validate:async()=>{throw Error("replay validated mutable target")},create:async()=>{throw Error("duplicate create")}})(${JSON.stringify(f.request)});process.stdout.write(JSON.stringify(r));`;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], { cwd: process.cwd(), env: process.env, encoding: "utf8", timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const replay = JSON.parse(child.stdout);
  assert.equal(replay.body.receipt.receiptId, done.body.receipt.receiptId);
  assert.equal(replay.body.sessionId, "created-1"); assert.equal(replay.body.replayed, true);
});

test("known binding survives a post-create state-read failure; unknown and crash reservations never create twice", async (t) => {
  const f = await fixture(t); f.fail();
  const uncertain = await f.make()(f.request);
  assert.equal(uncertain.body.outcome, "unknown");
  assert.equal(uncertain.body.code, "create_runtime_state_failed");
  assert.equal(uncertain.body.receipt.createdSessionId, "created-1");
  assert.equal(uncertain.body.receipt.error.code, "create_runtime_state_failed");
  f.reboot();
  const replay = await f.make()(f.request);
  assert.equal(replay.body.outcome, "unknown");
  assert.equal(replay.body.code, "prior_attempt_unknown");
  assert.equal(replay.body.receipt.createdSessionId, "created-1");
  assert.equal(replay.body.receipt.error.code, "create_runtime_state_failed");
  assert.equal(f.creates(), 1);
  const body = { type: "ensure_session", cwd: f.dir, toolNames: [], strictToolAllowlist: true };
  const fingerprint = f.store.controlRequestFingerprint({ deviceId: "fixture-device", operation: "create_session", body, confirmationReason: f.request.confirmationReason, expectedBootId: f.request.expectedBootId, expectedRevision: null, expectedQueueRevision: null });
  await f.store.reserveControlReceipt({ deviceId: "fixture-device", sessionId: "new", operation: "create_session", idempotencyKey: "fixture-crash-before-id", requestFingerprint: fingerprint, cwd: f.dir, bootId: "dead-process" });
  const recovered = await f.make()({ ...f.request, idempotencyKey: "fixture-crash-before-id" });
  assert.equal(recovered.body.outcome, "unknown"); assert.equal(recovered.body.receipt.createdSessionId, undefined);
  assert.equal(f.creates(), 1);
});

test("a possibly completed native start with no returned ID stays unknown and is never repeated", async (t) => {
  const f = await fixture(t);
  const loaded = await createJiti(import.meta.url, { moduleCache: false }).import("./reader-session-create-control.ts");
  let nativeStartMayHaveOccurred = false;
  const create = loaded.createManagedSessionControl({ ...f.deps, create: async () => {
    // This fixture models the native start side effect, then loses its response
    // before the real session ID can be bound. It never starts a real runtime.
    nativeStartMayHaveOccurred = true;
    return { status: 500, body: { code: "create_runtime_start_failed", error: "fixture lost response after native start" } };
  } });

  const first = await create(f.request);
  assert.equal(nativeStartMayHaveOccurred, true);
  assert.equal(first.body.outcome, "unknown");
  assert.equal(first.body.runtimeStartAttempted, true);
  assert.equal(first.body.receipt.createdSessionId, undefined);
  assert.equal(first.body.receipt.error.code, "create_runtime_start_failed");
  assert.equal(JSON.stringify(first.body).includes("fixture lost response"), false);

  f.reboot();
  const replay = await create(f.request);
  assert.equal(replay.body.outcome, "unknown");
  assert.equal(replay.body.code, "prior_attempt_unknown");
  assert.equal(replay.body.receipt.createdSessionId, undefined);
  assert.equal(replay.body.replayed, true);
  assert.equal(nativeStartMayHaveOccurred, true, "idempotent replay must not call the native-start fixture again");
});

test("unknown create receipt keeps safe correlated failure metadata but omits the raw downstream error", async (t) => {
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const f = await fixture(t), loaded = await jiti.import("./reader-session-create-control.ts");
  const diagnostics = await jiti.import("./reader-create-diagnostics.ts");
  let createCalls = 0;
  let passedCorrelationId;
  const create = loaded.createManagedSessionControl({ ...f.deps, create: async (_body, _onCreated, context) => {
    createCalls++;
    passedCorrelationId = context.correlationId;
    const raw = Object.assign(new Error("private path /Users/example/project token=fixture-secret"), { code: "ENOENT" });
    return { status: 500, body: {
      code: "create_runtime_start_failed",
      error: raw.message,
      failureDiagnostic: diagnostics.readerCreateFailureDiagnostic(context.correlationId, "runtime_start", raw),
    } };
  } });
  const first = await create(f.request);
  assert.equal(first.status, 202);
  assert.equal(first.body.success, false);
  assert.equal(first.body.accepted, true);
  assert.equal(first.body.outcome, "unknown");
  assert.equal(first.body.code, "create_runtime_start_failed");
  assert.equal(first.body.receipt.error.code, "create_runtime_start_failed");
  assert.equal(first.body.receipt.createdSessionId, undefined);
  assert.equal(first.body.sessionId, undefined);
  assert.equal(passedCorrelationId, first.body.receipt.receiptId);
  assert.deepEqual(first.body.receipt.error.diagnostic, {
    correlationId: first.body.receipt.receiptId,
    stage: "runtime_start",
    category: "resource_missing",
  });
  assert.equal(JSON.stringify(first.body).includes("/Users/example/project"), false);
  assert.equal(JSON.stringify(first.body).includes("fixture-secret"), false);
  const stored = await f.store.readControlReceipt({ deviceId: "fixture-device", sessionId: "new", receiptId: first.body.receipt.receiptId });
  assert.deepEqual(stored.error.diagnostic, first.body.receipt.error.diagnostic);

  f.reboot();
  const replay = await create(f.request);
  assert.equal(replay.body.outcome, "unknown");
  assert.equal(replay.body.code, "prior_attempt_unknown");
  assert.equal(replay.body.receipt.error.code, "create_runtime_start_failed");
  assert.deepEqual(replay.body.receipt.error.diagnostic, first.body.receipt.error.diagnostic);
  assert.equal(createCalls, 1);
});

test("create diagnostic categories and receipt correlation are allow-listed", async () => {
  const { readerCreateFailureDiagnostic, isReaderCreateFailureDiagnostic } = await createJiti(import.meta.url, { moduleCache: false }).import("./reader-create-diagnostics.ts");
  const correlationId = "01234567-89ab-4cde-8fab-0123456789ab";
  const unknownCode = Object.assign(new Error("private token and path"), { code: "PRIVATE_TOKEN_VALUE" });
  const diagnostic = readerCreateFailureDiagnostic(correlationId, "runtime_start", unknownCode);
  assert.deepEqual(diagnostic, { correlationId, stage: "runtime_start", category: "unclassified" });
  assert.equal(JSON.stringify(diagnostic).includes("PRIVATE_TOKEN_VALUE"), false);
  assert.equal(isReaderCreateFailureDiagnostic(diagnostic, correlationId), true);
  assert.equal(isReaderCreateFailureDiagnostic(diagnostic, "different-receipt"), false);
  assert.equal(isReaderCreateFailureDiagnostic({ ...diagnostic, message: "private token and path" }, correlationId), false);
});

test("malformed downstream diagnostics are discarded and cannot turn an unknown create into success", async (t) => {
  const f = await fixture(t), loaded = await createJiti(import.meta.url, { moduleCache: false }).import("./reader-session-create-control.ts");
  const create = loaded.createManagedSessionControl({ ...f.deps, create: async (_body, _onCreated, context) => ({
    status: 500,
    body: {
      code: "create_runtime_start_failed",
      error: "private path and token must not be persisted",
      failureDiagnostic: { correlationId: context.correlationId, stage: "runtime_start", category: "unclassified", message: "private path and token" },
    },
  }) });
  const result = await create(f.request);
  assert.equal(result.status, 202);
  assert.equal(result.body.success, false);
  assert.equal(result.body.outcome, "unknown");
  assert.deepEqual(result.body.receipt.error.diagnostic, {
    correlationId: result.body.receipt.receiptId,
    stage: "runtime_start",
    category: "unclassified",
  });
  assert.equal(JSON.stringify(result.body).includes("private path"), false);
  assert.equal(JSON.stringify(result.body).includes("token"), false);
});

test("receipt disk failure after business creation is unknown and retains the reservation ID", async (t) => {
  const f = await fixture(t);
  const create = (await createJiti(import.meta.url, { moduleCache: false }).import("./reader-session-create-control.ts")).createManagedSessionControl({ ...f.deps, create: async (body, onCreated) => {
    const result = await f.deps.create(body, onCreated);
    await writeFile(f.store.controlReceiptStorePath(), "corrupt isolated fixture receipt store");
    return result;
  } });
  const result = await create(f.request);
  assert.equal(result.status, 503); assert.equal(result.body.outcome, "unknown");
  assert.equal(result.body.receiptPersistence, "unknown"); assert.ok(result.body.receiptId);
  assert.equal(result.body.receipt.createdSessionId, "created-1");
  assert.equal(f.creates(), 1);
  assert.equal((await create(f.request)).status, 503); assert.equal(f.creates(), 1);
});

test("indexed store has no lifetime creation cap and retains unresolved and oldest creation identities", async (t) => {
  const f = await fixture(t), create = f.make();
  const original = await create(f.request);
  const unresolved = await f.store.reserveControlReceipt({ deviceId: "fixture-device", sessionId: "ordinary", operation: "prompt",
    idempotencyKey: "fixture-unresolved-original", requestFingerprint: "fixture", cwd: f.dir });
  for (let i = 1; i < 530; i++) {
    const next = await create({ ...f.request, idempotencyKey: `fixture-create-pressure-${i}` });
    assert.equal(next.body.outcome, "completed");
  }
  assert.equal(f.creates(), 530);
  const replay = await create(f.request);
  assert.equal(replay.body.sessionId, "created-1");
  assert.equal(replay.body.receipt.receiptId, original.body.receipt.receiptId);
  assert.equal(f.creates(), 530);
  assert.equal((await f.store.readControlReceipt({ deviceId: "fixture-device", sessionId: "ordinary", receiptId: unresolved.receipt.receiptId })).outcome, "accepted");
  await f.store.updateControlReceipt(unresolved.receipt.receiptId, { outcome: "unknown" });
  assert.equal((await create({ ...f.request, idempotencyKey: "fixture-create-after-unknown" })).body.outcome, "completed");
  assert.equal((await f.store.readControlReceipt({ deviceId: "fixture-device", sessionId: "ordinary", receiptId: unresolved.receipt.receiptId })).outcome, "unknown");
  assert.equal((await create(f.request)).body.sessionId, "created-1");
  assert.equal(f.creates(), 531);
});

test("public receipt bounds nested errors and exposes only fingerprint references", async (t) => {
  const f = await fixture(t), done = await f.make()(f.request);
  const original = await f.store.readControlReceipt({ deviceId: "fixture-device", sessionId: "new", receiptId: done.body.receipt.receiptId });
  const view = f.store.publicControlReceipt({ ...original, clientRequestFingerprint: "token=private-hint", error: { code: "fixture", message: "failed at /home/private/project token=fixture-secret" }, response: { apiKey: "fixture-key", path: "/Users/private/project" } });
  const raw = JSON.stringify(view);
  assert.equal(view.clientRequestFingerprint, undefined); assert.match(view.clientRequestFingerprintRef, /^[a-f0-9]{64}$/);
  for (const value of ["private-hint", "fixture-secret", "fixture-key", "/home/private", "/Users/private"]) assert.equal(raw.includes(value), false);
});
