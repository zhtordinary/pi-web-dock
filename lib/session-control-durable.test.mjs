import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});

const durable = await jiti.import("../packages/pi-web-session-control/index.ts");

const scope = { callerSessionId: "caller-session", cwd: "/fixture/project" };

function request(overrides = {}) {
  return { idempotencyKey: "create-1", scope, initialMessage: "Open the durable session", ...overrides };
}

function contentFor(candidate) {
  return candidate.initialMessage === undefined
    ? durable.SESSION_CONTROL_INITIALIZATION_MESSAGE
    : candidate.initialMessage;
}

function withNoopAdmissionLock(host) {
  const lease = { assert() {} };
  return {
    ...host,
    withAdmissionLock: (_candidate, operation) => operation(lease),
  };
}

function runCreate(candidate, host) {
  return durable.createOrReuseDurableSession(candidate, withNoopAdmissionLock(host));
}

function factsFor(candidate = request(), overrides = {}) {
  const source = candidate.initialMessage === undefined ? "initialization" : "agent-message";
  const messageKind = source === "initialization" ? "generated-initialization" : "agent-initial-message";
  const messageDigest = durable.initialMessageDigest(contentFor(candidate));
  return {
    sessionId: "native-created",
    sessionFile: "/fixture/native-created.jsonl",
    persisted: true,
    visibleInSessionList: true,
    nativeListVisible: true,
    runtimeVisibleInReader: true,
    runtimeCreated: true,
    source,
    messageKind,
    messageDigest,
    nativeRecordValid: true,
    ...(source === "agent-message" ? { initialMessageDigest: messageDigest } : {}),
    ...overrides,
  };
}

function fakeManager(id = "native-session") {
  const entries = [];
  const calls = [];
  return {
    entries,
    calls,
    getSessionId: () => id,
    getSessionFile: () => `/fixture/${id}.jsonl`,
    getEntries: () => entries,
    appendCustomEntry: (customType, data) => {
      calls.push({ type: "custom", customType, data });
      entries.push({ type: "custom", customType, data });
      return "custom-entry";
    },
    appendCustomMessageEntry: (customType, content, display, details) => {
      calls.push({ type: "custom-message", customType, content, display, details });
      entries.push({ type: "custom_message", customType, content, display, details });
      return "message-entry";
    },
  };
}

test("native durable marker uses SDK custom-message append and preserves the Agent initial task", () => {
  const manager = fakeManager();
  const result = durable.appendDurableSessionCreate(manager, request());
  assert.equal(result.record.sessionId, "native-session");
  assert.equal(result.record.source, "agent-message");
  assert.equal(result.record.messageKind, "agent-initial-message");
  assert.equal(result.record.messageDigest, durable.initialMessageDigest("Open the durable session"));
  assert.deepEqual(manager.calls.map((call) => call.type), ["custom", "custom-message"]);
  assert.equal(manager.calls[1].customType, durable.SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE);
  assert.equal(manager.calls[1].content, "Open the durable session");
  assert.equal(manager.entries.length, 2);
  assert.equal(durable.findDurableSessionCreateRecord(manager.entries, scope, "create-1").messageDigest, result.record.messageDigest);
  assert.deepEqual(durable.validateDurableSessionCreateRecord(manager.entries, request()), result.record);
  assert.equal(durable.validateDurableSessionRecord(manager.entries, result.record), true);
});

test("an omitted initial message writes a generated initialization message through the SDK", () => {
  const manager = fakeManager();
  const candidate = { idempotencyKey: "init-1", scope };
  const result = durable.appendDurableSessionCreate(manager, candidate);
  assert.equal(result.record.source, "initialization");
  assert.equal(result.record.messageKind, "generated-initialization");
  assert.equal(result.record.messageDigest, durable.initialMessageDigest(durable.SESSION_CONTROL_INITIALIZATION_MESSAGE));
  assert.equal(result.messageEntryId, "message-entry");
  assert.deepEqual(manager.calls.map((call) => call.type), ["custom", "custom-message"]);
  assert.equal(manager.calls[1].content, durable.SESSION_CONTROL_INITIALIZATION_MESSAGE);
  assert.deepEqual(durable.validateDurableSessionCreateRecord(manager.entries, candidate), result.record);
  assert.equal(durable.validateDurableSessionRecord(manager.entries, result.record), true);
});

test("initialization cannot be silently upgraded to a concrete initial task under the same key", () => {
  const manager = fakeManager();
  durable.appendDurableSessionCreate(manager, { idempotencyKey: "upgrade", scope });
  assert.throws(
    () => durable.appendDurableSessionCreate(manager, request({ idempotencyKey: "upgrade", initialMessage: "a real task" })),
    /different scope or initialMessage/,
  );
  assert.equal(manager.calls.filter((call) => call.type === "custom-message").length, 1);
});

test("readback rejects a marker whose generated initialization message was changed", () => {
  const manager = fakeManager();
  const candidate = { idempotencyKey: "tampered", scope };
  const result = durable.appendDurableSessionCreate(manager, candidate);
  manager.entries.find((entry) => entry.type === "custom_message").content = "changed after append";
  assert.equal(durable.validateDurableSessionCreateRecord(manager.entries, candidate), undefined);
  assert.equal(durable.validateDurableSessionRecord(manager.entries, result.record), false);
});

test("legacy role-user create markers remain valid and are reused without a new user/custom entry", () => {
  const message = "legacy task";
  const legacy = [{
    id: "legacy-marker",
    type: "custom",
    customType: durable.SESSION_CONTROL_CREATE_CUSTOM_TYPE,
    data: {
      version: 3,
      idempotencyKey: "legacy",
      scope,
      source: "user-message",
      messageKind: "user-initial-message",
      messageDigest: durable.initialMessageDigest(message),
      initialMessageDigest: durable.initialMessageDigest(message),
      sessionId: "legacy-session",
    },
  }, {
    type: "message",
    id: "legacy-user",
    message: { role: "user", content: message },
  }];
  const mapped = durable.findLegacyDurableSessionCreateRecord(legacy, scope, "legacy");
  assert.equal(mapped.source, "agent-message");
  assert.equal(mapped.messageKind, "agent-initial-message");
  assert.equal(mapped.version, 3);
  assert.equal(durable.validateDurableSessionRecord(legacy, mapped), true);
  const manager = { ...fakeManager("legacy-session"), entries: legacy, getEntries: () => legacy };
  const before = manager.entries.length;
  const reused = durable.appendDurableSessionCreate(manager, request({ idempotencyKey: "legacy", initialMessage: message }));
  assert.equal(reused.record.version, 3);
  assert.equal(manager.entries.length, before);
});

test("same key is scoped by caller and cwd", () => {
  const manager = fakeManager();
  const result = durable.appendDurableSessionCreate(manager, request());
  assert.equal(durable.findDurableSessionCreateRecord(manager.entries, scope, "create-1")?.sessionId, result.record.sessionId);
  assert.equal(durable.findDurableSessionCreateRecord(manager.entries, { callerSessionId: "other", cwd: scope.cwd }, "create-1"), undefined);
  assert.equal(durable.findDurableSessionCreateRecord(manager.entries, { callerSessionId: scope.callerSessionId, cwd: "/other" }, "create-1"), undefined);
});

test("concurrent same scoped key creates coalesce without a second ledger", async () => {
  let creates = 0;
  let nativeFacts;
  const host = {
    findExisting: async () => nativeFacts,
    create: async (candidate) => {
      creates += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      nativeFacts = factsFor(candidate);
      return durable.createDurableSessionResult(candidate, nativeFacts, "created", false);
    },
  };
  const candidate = request({ idempotencyKey: "same-key", initialMessage: "same" });
  const [first, second] = await Promise.all([
    runCreate(candidate, host),
    runCreate(candidate, host),
  ]);
  assert.equal(creates, 1, "a second call rechecks native state after the first host operation");
  assert.equal(first.status, "created");
  assert.equal(second.status, "reused");
  assert.equal(first.success, true);
  assert.equal(second.success, true);
});

test("same key from another caller does not reuse the first caller", async () => {
  let creates = 0;
  const host = {
    findExisting: async () => undefined,
    create: async (candidate) => {
      creates += 1;
      return durable.createDurableSessionResult(candidate, factsFor(candidate, { sessionId: `created-${creates}` }), "created", false);
    },
  };
  const first = await runCreate(request({ idempotencyKey: "same" }), host);
  const second = await runCreate(request({ idempotencyKey: "same", scope: { callerSessionId: "other", cwd: scope.cwd } }), host);
  assert.equal(first.success, true);
  assert.equal(second.success, true);
  assert.equal(creates, 2);
});

test("replayed native identity is reused and mismatched initial content is rejected", async () => {
  const original = request({ idempotencyKey: "replay", initialMessage: "original" });
  const host = {
    findExisting: async () => factsFor(original, { sessionId: "native-existing" }),
    create: async () => { throw new Error("must not create"); },
  };
  const reused = await runCreate(original, host);
  assert.deepEqual({ status: reused.status, success: reused.success, reused: reused.reused }, { status: "reused", success: true, reused: true });
  const conflict = await runCreate(request({ idempotencyKey: "replay", initialMessage: "changed" }), host);
  assert.equal(conflict.status, "idempotency-conflict");
  assert.equal(conflict.success, false);
  assert.equal(conflict.reused, false);
});

test("an existing created session missing its first user turn is recovered before reuse", async () => {
  const candidate = request({ idempotencyKey: "missing-user-turn" });
  let recoveries = 0;
  const result = await runCreate(candidate, {
    findExisting: async () => factsFor(candidate, { sessionId: "native-existing", initialUserMessageSent: false }),
    create: async () => { throw new Error("must not create"); },
    recover: async (facts, input) => {
      recoveries += 1;
      assert.equal(facts.initialUserMessageSent, false);
      return durable.createDurableSessionResult(input, factsFor(input, { sessionId: facts.sessionId, initialUserMessageSent: true }), "reused", true);
    },
  });
  assert.equal(recoveries, 1);
  assert.equal(result.status, "reused");
  assert.equal(result.success, true);
  assert.equal(result.initialUserMessageSent, true);
});

test("an omitted initial message is durable and list-visible without invoking a model", async () => {
  const candidate = { idempotencyKey: "init", scope };
  const result = await runCreate(
    candidate,
    {
      findExisting: async () => undefined,
      create: async (input) => durable.createDurableSessionResult(input, factsFor(input), "created", false),
    },
  );
  assert.equal(result.success, true);
  assert.equal(result.status, "created");
  assert.equal(result.persisted, true);
  assert.equal(result.nativeListVisible, true);
  assert.equal(result.durability, "durable");
  assert.equal(result.source, "initialization");
  assert.equal(result.messageKind, "generated-initialization");
  assert.equal(result.messageDigest, durable.initialMessageDigest(durable.SESSION_CONTROL_INITIALIZATION_MESSAGE));
});

test("same initialization key with a later concrete initial task conflicts from native facts", async () => {
  const initialization = { idempotencyKey: "upgrade-native", scope };
  let creates = 0;
  const host = {
    findExisting: async () => factsFor(initialization, { sessionId: "native-init" }),
    create: async () => { creates += 1; throw new Error("must not create"); },
  };
  const result = await runCreate(
    request({ idempotencyKey: initialization.idempotencyKey, initialMessage: "real task" }),
    host,
  );
  assert.equal(result.status, "idempotency-conflict");
  assert.equal(result.success, false);
  assert.equal(creates, 0);
});

test("native runtime failure remains a persisted, non-success result", async () => {
  const candidate = request({ idempotencyKey: "runtime-failure", initialMessage: "persist before runtime" });
  const result = await runCreate(
    candidate,
    {
      findExisting: async () => undefined,
      create: async (input) => durable.createDurableSessionResult(input, factsFor(input, {
        runtimeVisibleInReader: false,
        runtimeCreated: false,
      }), "persisted-runtime-failed", false, "SDK runtime setup failed"),
    },
  );
  assert.equal(result.success, false);
  assert.equal(result.status, "persisted-runtime-failed");
  assert.equal(result.persisted, true);
  assert.equal(result.nativeListVisible, true);
  assert.equal(result.visibleInSessionList, true);
  assert.match(result.error, /runtime setup failed/);
});

test("native readback validation failure is reported instead of reusing a digest-only file", async () => {
  const candidate = request({ idempotencyKey: "bad-readback" });
  const result = await runCreate(candidate, {
    findExisting: async () => factsFor(candidate, { nativeRecordValid: false }),
    create: async () => { throw new Error("must not create over an invalid native record"); },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "recovery-failed");
  assert.equal(result.persisted, true);
  assert.match(result.error, /readback validation/);
});

test("native host exceptions remain failed without inventing durable facts", async () => {
  const result = await runCreate(request({ idempotencyKey: "native-exception", initialMessage: "must not claim durable" }), {
    findExisting: async () => undefined,
    create: async () => { throw new Error("native append failed"); },
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "failed");
  assert.equal(result.persisted, false);
  assert.equal(result.visibleInSessionList, false);
  assert.match(result.error, /native append failed/);
});

test("recovery exceptions retain the native persisted facts", async () => {
  const candidate = request({ idempotencyKey: "recovery-exception", initialMessage: "recover me" });
  const result = await runCreate(candidate, {
    findExisting: async () => factsFor(candidate, {
      sessionId: "persisted-native",
      runtimeVisibleInReader: false,
      runtimeCreated: false,
    }),
    create: async () => { throw new Error("must not create"); },
    recover: async () => { throw new Error("runtime reopen failed"); },
  });
  assert.equal(result.status, "recovery-failed");
  assert.equal(result.persisted, true);
  assert.equal(result.nativeListVisible, true);
  assert.equal(result.sessionId, "persisted-native");
  assert.match(result.error, /runtime reopen failed/);
});

test("admission lock failure fails closed before native create", async () => {
  let creates = 0;
  const result = await durable.createOrReuseDurableSession(request({ idempotencyKey: "lock-failure" }), {
    withAdmissionLock: async () => { throw new Error("admission lock unavailable"); },
    findExisting: async () => undefined,
    create: async () => { creates += 1; throw new Error("must not create"); },
  });
  assert.equal(result.status, "failed");
  assert.equal(result.success, false);
  assert.equal(result.persisted, false);
  assert.equal(result.visibleInSessionList, false);
  assert.equal(creates, 0);
  assert.match(result.error, /admission lock unavailable/);
});

test("lease failure after native create preserves facts and cannot report success", async () => {
  const candidate = request({ idempotencyKey: "lease-failure-after-create" });
  const observed = factsFor(candidate, { sessionId: "native-after-lease-failure" });
  const created = durable.createDurableSessionResult(candidate, observed, "created", false);
  const result = await durable.createOrReuseDurableSession(candidate, {
    withAdmissionLock: async (_candidate, operation) => {
      const operationResult = await operation({ assert() {} });
      throw new durable.DurableSessionAdmissionError("lock release failed", operationResult);
    },
    findExisting: async () => undefined,
    create: async () => created,
  });
  assert.equal(result.success, false);
  assert.equal(result.status, "persisted-runtime-failed");
  assert.equal(result.durability, "none");
  assert.equal(result.sessionId, "native-after-lease-failure");
  assert.equal(result.persisted, true);
  assert.match(result.error, /lock release failed/);
});
