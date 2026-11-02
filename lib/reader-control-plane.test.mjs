import assert from "node:assert/strict";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

test("managed configuration uses the durable receipt store and preserves exact CAS/replay semantics", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "reader-config-contract-"));
  const oldRoot = process.env.PI_WEB_CONTROL_RECEIPT_ROOT;
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = join(dir, "receipts");
  t.after(async () => {
    if (oldRoot === undefined) delete process.env.PI_WEB_CONTROL_RECEIPT_ROOT;
    else process.env.PI_WEB_CONTROL_RECEIPT_ROOT = oldRoot;
    await rm(dir, { recursive: true, force: true });
  });
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  const { createControlPlane, ControlPlaneError } = await jiti.import("./reader-control-plane.ts");
  const { controlRequestFingerprint } = await jiti.import("./reader-control-receipts.ts");
  let bootId = "boot-a", revision = "revision-1", value = "automatic", writes = 0;
  let failUnknown = false, resourceUnavailable = false;
  const inspect = () => ({ revision, value: { codemode: value }, impact: { runtime: "new_sessions" }, supportedOperations: ["set_codemode"] });
  const deps = {
    deviceId: () => "test-device", bootId: () => bootId, globalCwd: () => dir,
    authorizeCwd: async (cwd) => cwd === dir,
    inspectSettings: async () => inspect(),
    validateSettingsChange: (input) => {
      if (resourceUnavailable) throw new ControlPlaneError("resource_missing", "Resource was removed after the original write", 404);
      if (!["automatic", "always"].includes(input.changes.codemode)) throw new ControlPlaneError("invalid_request", "Invalid Code mode", 400);
    },
    mutateSettings: async (input) => {
      if (input.expectedRevision !== revision) throw new ControlPlaneError("revision_conflict", "stale settings", 409);
      if (failUnknown) throw new Error("unclassified failure");
      writes++; value = input.changes.codemode; revision = `revision-${writes + 1}`;
      return { ...inspect(), changed: true };
    },
  };
  let plane = createControlPlane(deps);
  const target = { area: "tools_settings", scope: "global", deviceId: "test-device" };
  const request = { ...target, operation: "set_codemode", changes: { codemode: "always" }, dryRun: false, confirm: true, confirmationReason: "isolated fixture only", idempotencyKey: "fixture-write-001", expectedBootId: bootId, expectedRevision: revision };
  assert.equal((await plane.dispatch("GET", target)).body.revision, "revision-1");
  const opaque = await plane.dispatch("GET", { ...target, cwd: dir });
  assert.equal(opaque.body.cwd, undefined);
  assert.equal(opaque.body.cwdRef, controlRequestFingerprint(dir));
  const missing = await plane.dispatch("GET", { ...target, receiptId: "missing-isolated-receipt" });
  assert.equal(missing.body.outcome, "unknown"); assert.equal(missing.body.code, "receipt_not_found");
  assert.equal(missing.body.receipt, null); assert.equal(writes, 0);
  const dry = await plane.dispatch("POST", { ...request, cwd: dir, dryRun: true });
  assert.equal(dry.body.snapshot.cwd, undefined);
  assert.equal(dry.body.snapshot.cwdRef, controlRequestFingerprint(dir));
  assert.equal((await plane.dispatch("POST", { ...request, dryRun: true })).body.outcome, "dry_run");
  assert.equal((await plane.dispatch("POST", { ...request, dryRun: true, changes: { codemode: "invalid" } })).status, 400);
  assert.deepEqual(await readdir(dir), [], "GET/dry-run do not create receipt state");
  assert.equal((await plane.dispatch("POST", { ...request, confirm: false })).status, 403);
  assert.equal((await plane.dispatch("POST", { ...request, deviceId: "other" })).status, 403);
  assert.equal((await plane.dispatch("POST", { ...request, cwd: "/" })).status, 403);
  assert.equal((await plane.dispatch("POST", { ...request, expectedBootId: "old" })).status, 409);
  assert.equal((await plane.dispatch("POST", { ...request, payload: {} })).status, 400);
  assert.equal(writes, 0);
  const done = await plane.dispatch("POST", request, "adapter-fixture");
  assert.equal(done.status, 200); assert.equal(done.body.outcome, "completed");
  assert.equal(done.body.receipt.audit.scope, "global");
  assert.equal(done.body.receipt.idempotencyKey, undefined);
  assert.equal(done.body.receipt.cwd, undefined);
  assert.equal(JSON.stringify(done.body).includes(dir), false, "no absolute path in configuration response");
  assert.equal(writes, 1);
  const raw = JSON.stringify(await (await jiti.import("./reader-control-receipts.ts")).readControlReceipt({ deviceId: done.body.receipt.deviceId, sessionId: done.body.receipt.sessionId, receiptId: done.body.receipt.receiptId }));
  assert.ok(!raw.includes("isolated fixture only"));
  assert.ok(!raw.includes('"codemode":"always"'));
  // New façade instance and a new process boot both observe the same terminal
  // receipt without requiring the now-stale configuration revision to match.
  plane = createControlPlane(deps); bootId = "boot-b"; resourceUnavailable = true;
  const replay = await plane.dispatch("POST", request);
  assert.equal(replay.body.replayed, true);
  assert.equal(replay.body.receipt.receiptId, done.body.receipt.receiptId);
  assert.equal(writes, 1);
  assert.equal((await plane.dispatch("POST", { ...request, changes: { codemode: "automatic" } })).status, 409);
  assert.equal(writes, 1);
  const found = await plane.dispatch("GET", { ...target, idempotencyKey: request.idempotencyKey, operation: request.operation });
  assert.equal(found.body.receipt.receiptId, done.body.receipt.receiptId);
  resourceUnavailable = false;
  const stale = await plane.dispatch("POST", { ...request, idempotencyKey: "fixture-write-002", expectedBootId: bootId });
  assert.equal(stale.status, 409); assert.equal(stale.body.receipt.outcome, "failed");
  assert.equal(writes, 1);
  failUnknown = true;
  const unknown = await plane.dispatch("POST", { ...request, idempotencyKey: "fixture-write-003", expectedRevision: revision, expectedBootId: bootId });
  assert.equal(unknown.body.outcome, "unknown");
  assert.equal(unknown.body.receipt.nextAction, "inspect_configuration_before_retry");
  failUnknown = false;
  const unknownReplay = await plane.dispatch("POST", { ...request, idempotencyKey: "fixture-write-003", expectedRevision: revision, expectedBootId: bootId });
  assert.equal(unknownReplay.body.outcome, "unknown"); assert.equal(unknownReplay.body.success, false); assert.equal(unknownReplay.status, 202); assert.equal(writes, 1);
  const diskFailurePlane = createControlPlane({ ...deps, mutateSettings: async (input) => {
    const result = await deps.mutateSettings(input);
    await writeFile(join(dir, "receipts", "receipts.json"), "invalid fixture store");
    return result;
  } });
  const uncertain = await diskFailurePlane.dispatch("POST", { ...request, idempotencyKey: "fixture-write-004", expectedRevision: revision, expectedBootId: bootId });
  assert.equal(writes, 2, "the business mutation happened before the audit failure");
  assert.equal(uncertain.status, 503); assert.equal(uncertain.body.accepted, true);
  assert.equal(uncertain.body.outcome, "unknown"); assert.equal(uncertain.body.receiptPersistence, "unknown");
  assert.ok(uncertain.body.receiptId);
  assert.equal(uncertain.body.receipt.outcome, "accepted", "do not invent a durable terminal receipt");
});

test("control-plane input budget cancels oversized and stalled streams", async () => {
  const { readControlPlaneJson } = await createJiti(import.meta.url, { moduleCache: false }).import("./reader-control-plane.ts");
  let cancelled = false;
  const large = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(32769)); }, cancel() { cancelled = true; } });
  await assert.rejects(readControlPlaneJson(new Request("http://localhost/", { method: "POST", body: large, duplex: "half" })), { code: "request_too_large" });
  assert.equal(cancelled, true);
  cancelled = false;
  const stalled = new ReadableStream({ cancel() { cancelled = true; } });
  await assert.rejects(readControlPlaneJson(new Request("http://localhost/", { method: "POST", body: stalled, duplex: "half" }), 10), { code: "request_timeout" });
  assert.equal(cancelled, true);
});
