import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("context injection accepts a live transient source before JSONL persistence", () => {
  assert.match(source, /getRpcSession\(contextSourceSessionId\)/);
  assert.match(source, /if \(!liveSourceSession\?\.isAlive\(\)\) \{/);
  assert.match(source, /resolveSessionPath\(contextSourceSessionId\)/);
});

test("strict tool allow-list is explicit and does not alter the default path", () => {
  assert.match(source, /strictToolAllowlist/);
  assert.match(source, /strictToolAllowlist requires an explicit toolNames allow-list/);
  assert.match(source, /strictToolAllowlist !== undefined \? \{ strictToolAllowlist \} : \{\}/);
});

test("explicit creation initializes the default after identity is durable, without changing validation-only reads", () => {
  const create = source.indexOf("await startRpcSession");
  const identity = source.indexOf("if (onCreated) await onCreated");
  const initialize = source.indexOf("session.initializeUnattendedDefault()");
  const state = source.indexOf('const state = await session.send');
  assert.ok(create >= 0 && identity > create && initialize > identity && state > initialize);
  assert.ok(source.indexOf("if (validateOnly)") < initialize);
});

test("managed creation persists identity through the original business path", () => {
  assert.match(source, /createManagedSessionControl/);
  assert.match(source, /createSession\(body, undefined, true\)/);
  assert.match(source, /createSession\(body, onCreated, false, correlationId\)/);
  assert.match(source, /if \(validateOnly\)/);
  assert.ok(source.indexOf("if (validateOnly)") < source.indexOf("await startRpcSession"));
  assert.ok(source.indexOf("if (onCreated) await onCreated") < source.indexOf('const state = await session.send'));
  assert.match(source, /isApiRequestAllowed/);
  assert.match(source, /readControlPlaneJson/);
});

test("managed creation returns the session-scoped boot identity for follow-up controls", () => {
  assert.match(source, /sessionBootId: session\.getLiveRuntimeIdentity\(\)\.bootId/);
});

test("managed creation failures retain a safe route-stage classification", () => {
  assert.match(source, /failureStage = "runtime_start"/);
  assert.match(source, /failureStage = "binding_persistence"/);
  assert.match(source, /failureStage = "runtime_state_read"/);
  assert.match(source, /runtime_start: "create_runtime_start_failed"/);
  assert.match(source, /binding_persistence: "create_binding_persistence_failed"/);
  assert.match(source, /runtime_state_read: "create_runtime_state_failed"/);
});

test("managed creation returns only receipt-correlated failure metadata", () => {
  assert.match(source, /create: async \(body, onCreated, \{ correlationId \}\)/);
  assert.match(source, /createSession\(body, onCreated, false, correlationId\)/);
  assert.match(source, /readerCreateFailureDiagnostic\(correlationId, failureStage, error\)/);
  assert.match(source, /\.\.\.\(failureDiagnostic \? \{ failureDiagnostic \} : \{\}\)/);
});
