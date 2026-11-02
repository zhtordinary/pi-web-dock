import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { BranchNavigation, canWriteBranch } from "../lib/branch-navigation.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const route = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");

test("runtime bootstrap requests metadata without downloading a transcript page", () => {
  assert.match(source, /new URLSearchParams\(\{ metadataOnly: "1" \}\)/);
  assert.match(source, /metadataOnly: "1", leafId/);
  assert.doesNotMatch(source, /sessions\/.*context\?/);
  assert.doesNotMatch(source, /fullHistory/);
  assert.doesNotMatch(source, /loadFullHistory|loadHistoryStep|loadEarlierHistory/);
});

test("metadata bootstrap route never builds legacy context or returns message bodies", () => {
  const metadataStart = route.indexOf('if (metadataOnly)');
  const metadataEnd = route.indexOf('    const deferThinking', metadataStart);
  assert.ok(metadataStart >= 0 && metadataEnd > metadataStart);
  const metadataBlock = route.slice(metadataStart, metadataEnd);
  assert.doesNotMatch(metadataBlock, /buildSessionContext|buildFullSessionContext|context\.messages\.push/);
  assert.match(metadataBlock, /context: \{ messages: \[\], entryIds: \[\]/);
});


import vm from "node:vm";
import ts from "typescript";
const syntax = ts.createSourceFile("useAgentSession.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
function actual(name, context) {
  let callback;
  function visit(node) { if (ts.isVariableDeclaration(node) && node.name.getText(syntax) === name) callback = node.initializer.arguments[0]; ts.forEachChild(node, visit); }
  visit(syntax); assert.ok(callback);
  context.pendingUnattendedRef ??= { current: null };
  context.unattendedOverrideRef ??= { current: null };
  context.unattendedWriteRef ??= { current: null };
  context.isNew ??= false;
  context.newSessionPromotedRef ??= { current: false };
  if (name === "ensureEventsConnected" || name === "toggleUnattended") context.flushPendingUnattended ??= actual("flushPendingUnattended", context);
  return vm.runInNewContext(ts.transpileModule(`(${callback.getText(syntax)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}
test("session read retry reloads metadata, history/index and live state without initializing runtime", async () => {
  const calls = [], state = { running: false };
  const context = {
    sessionIdRef: { current: "s" },
    loadSession: async sid => calls.push(["metadata", sid]),
    reader: { retry: async () => calls.push(["history-and-index"]) },
    loadAgentState: async sid => { calls.push(["state", sid]); return state; },
    restoreLoadedRunState: (sid, value) => calls.push(["restore", sid, value]),
  };
  await actual("retrySessionRead", context)();
  assert.deepEqual(calls, [["metadata", "s"], ["history-and-index"], ["state", "s"], ["restore", "s", state]]);
  context.sessionIdRef.current = null;calls.length = 0;
  await actual("retrySessionRead", context)();assert.deepEqual(calls, []);
});

test("failed reads recover on online, focus or foreground visibility and remove their listeners", () => {
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(syntax) === "useEffect" && node.arguments[1]?.getText(syntax) === "[error, history.error, retrySessionRead]") effect = node.arguments[0];
    ts.forEachChild(node, visit);
  }
  visit(syntax);assert.ok(effect);
  for (const failed of [false, true]) {
    const listeners = new Map(), calls = [], context = { error: failed ? "offline" : null, history: { error: null },
      document: { visibilityState: "visible", addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) },
      window: { addEventListener: (name, cb) => listeners.set(name, cb), removeEventListener: name => listeners.delete(name) },
      retrySessionRead: () => calls.push("retry"),
    };
    const cleanup = vm.runInNewContext(ts.transpileModule(`(${effect.getText(syntax)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context)();
    if (!failed) { assert.equal(listeners.size, 0); continue; }
    for (const name of ["online", "focus", "visibilitychange"]) listeners.get(name)();
    assert.equal(calls.length, 3);
    context.document.visibilityState = "hidden";listeners.get("online")();assert.equal(calls.length, 3);
    cleanup();assert.equal(listeners.size, 0);
  }
});

test("explicit send initialization acquires runtime ownership before connecting SSE", async () => {
  const calls = [];
  const context = { sendAgentCommandR: async (sid, command) => calls.push([sid, command.type]),
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
    eventConnectionRef: { current: { ensureRuntimeConnected: async sid => calls.push([sid, "native-events"]) } } };
  await actual("ensureEventsConnected", context)("s");
  assert.deepEqual(calls, [["s", "initialize_runtime"], ["s", "native-events"]]);
});
test("ownership rejection does not open a cold SSE retry loop", async () => {
  const context = { sendAgentCommandR: async () => { throw new Error("session_owned_elsewhere"); },
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
    eventConnectionRef: { current: { ensureRuntimeConnected: assert.fail } } };
  await assert.rejects(actual("ensureEventsConnected", context)("s"), /session_owned_elsewhere/);
});
test("cold unattended inspection never writes settings, including read failure", async () => {
  for (const failure of [false, true]) {
    const calls = [], values = [];
    const context = { branchScopeRef: { current: "scope" }, sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" },
      sendAgentCommandR: async (sid, command) => { calls.push(command.type); if (failure) throw new Error("offline"); return { enabled: true, configured: true }; },
      syncUnattendedEnabledRef: { current: value => values.push(value) }, syncUnattendedStateRef: { current() {} }, console: { error() {} } };
    await actual("syncServerUnattendedState", context)("s");
    assert.deepEqual(calls, ["get_unattended"]); assert.deepEqual(values, failure ? [] : [true]);
  }
});
test("unconfigured read snapshots cannot override the fresh default or a draft choice", async () => {
  for (const pending of [null, false]) {
    const calls = [], values = [];
    const context = { branchScopeRef: { current: "scope" }, sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" },
      pendingUnattendedRef: { current: pending },
      sendAgentCommandR: async (_sid, command) => { calls.push(command.type); return { enabled: false, configured: false, state: null }; },
      syncUnattendedEnabledRef: { current: value => values.push(value) }, syncUnattendedStateRef: { current() {} }, console: { error() {} } };
    await actual("syncServerUnattendedState", context)("s");
    assert.deepEqual(calls, ["get_unattended"]);
    assert.deepEqual(values, []);
  }
});
test("configured on and off snapshots are adopted without writing defaults", async () => {
  for (const enabled of [false, true]) {
    const values = [], calls = [];
    const context = { branchScopeRef: { current: "scope" }, sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" },
      sendAgentCommandR: async (_sid, command) => { calls.push(command.type); return { enabled, configured: true }; },
      syncUnattendedEnabledRef: { current: value => values.push(value) }, syncUnattendedStateRef: { current() {} }, console: { error() {} } };
    await actual("syncServerUnattendedState", context)("s");
    assert.deepEqual(calls, ["get_unattended"]); assert.deepEqual(values, [enabled]);
  }
});
test("unconfigured scheduler events never turn the default into a saved off choice", () => {
  const values = [], states = [];
  const handle = actual("handleAgentEvent", { syncUnattendedEnabledRef: { current: value => values.push(value) }, syncUnattendedStateRef: { current: value => states.push(value) } });
  handle({ type: "unattended_state", enabled: false, configured: false, state: null });
  assert.deepEqual(values, []); assert.deepEqual(states, [null]);
  handle({ type: "unattended_state", enabled: false, configured: true, state: null });
  assert.deepEqual(values, [false]);
});
test("draft off is retained locally and written before input opens its native events", async () => {
  const calls = [], pendingUnattendedRef = { current: null };
  const context = { pendingUnattendedRef, unattended: true, toggleUnattendedLocal: () => calls.push("local-toggle"), addNotice: assert.fail,
    sendAgentCommandR: async (_sid, command) => calls.push([command.type, command.enabled]),
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: null }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
    eventConnectionRef: { current: { ensureRuntimeConnected: async () => calls.push("events") } } };
  actual("toggleUnattended", context)();
  assert.equal(pendingUnattendedRef.current, false); assert.deepEqual(calls, ["local-toggle"]);
  context.sessionIdRef.current = "s";
  await actual("ensureEventsConnected", context)("s");
  assert.deepEqual(calls, ["local-toggle", ["initialize_runtime", undefined], ["set_unattended", false], "events"]);
  assert.equal(pendingUnattendedRef.current, null);
});
test("a reclaimed draft retains its explicit off choice for the replacement runtime", () => {
  const pendingUnattendedRef = { current: null }, unattendedOverrideRef = { current: null };
  const context = { pendingUnattendedRef, unattendedOverrideRef, isNew: true, newSessionPromotedRef: { current: false },
    unattended: true, sessionIdRef: { current: null }, toggleUnattendedLocal() {}, sendAgentCommandR: assert.fail, addNotice: assert.fail };
  actual("toggleUnattended", context)();
  assert.equal(unattendedOverrideRef.current, false);
  pendingUnattendedRef.current = null;
  context.sessionIdRef.current = "expired";
  assert.equal(actual("applyNewSessionResponse", context)({ sessionId: "replacement" }, null, null, null), "replacement");
  assert.equal(pendingUnattendedRef.current, false, "the replacement must confirm the same draft preference before sending");
});
test("a failed draft preference write prevents sending and remains retryable", async () => {
  const pendingUnattendedRef = { current: false };
  const context = { pendingUnattendedRef,
    sendAgentCommandR: async (_sid, command) => { if (command.type === "set_unattended") throw new Error("offline"); },
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
    eventConnectionRef: { current: { ensureRuntimeConnected: assert.fail } } };
  await assert.rejects(actual("ensureEventsConnected", context)("s"), /offline/);
  assert.equal(pendingUnattendedRef.current, false);
});
test("a newer draft toggle wins while its previous preference write is pending", async () => {
  let release, started;
  const writing = new Promise(resolve => { started = resolve; });
  const writes = [], pendingUnattendedRef = { current: false };
  const context = { pendingUnattendedRef, unattended: false, toggleUnattendedLocal() {}, addNotice: assert.fail,
    sendAgentCommandR: async (_sid, command) => { if (command.type === "set_unattended") { writes.push(command.enabled); if (writes.length === 1) await new Promise(resolve => { release = resolve; started(); }); } },
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
    eventConnectionRef: { current: { ensureRuntimeConnected() {} } } };
  const initializing = actual("ensureEventsConnected", context)("s");
  await writing;
  assert.equal(typeof release, "function");
  actual("toggleUnattended", context)();
  assert.deepEqual(writes, [false], "one writer must finish before the next choice is sent");
  release(); await initializing;
  assert.deepEqual(writes, [false, true]);
  assert.equal(pendingUnattendedRef.current, null);
});
test('late initialization cannot connect events after peer or generation scope changes', async () => {
  let resolve;
  const context = { sendAgentCommandR: () => new Promise(done => { resolve = done; }),
    sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null }, runtimeAvailableRef: { current: false }, setRuntimeAvailable: assert.fail,
    eventConnectionRef: { current: { ensureRuntimeConnected: assert.fail } } };
  const pending = actual("ensureEventsConnected", context)("s");
  context.remotePeerRef.current = "other"; context.branchScopeRef.current = "other:s";
  resolve({}); await assert.rejects(pending, /conversation changed/);
});

for (const phase of ["current", "preview", "unknown", "pending"]) {
  test(`initialization confirms the runtime branch before send without bypassing ${phase} ownership`, async () => {
    const branch = new BranchNavigation(); branch.reset("scope"); branch.observeRuntime("answer");
    if (phase === "preview") await branch.preview("older", async () => true);
    if (phase === "unknown") branch.markUnconfirmed(new Error("unconfirmed navigation"));
    const validation = { current: true };
    const context = { branchRef: { current: branch }, canWriteBranch, sessionViewValidationPendingRef: validation,
      sendAgentCommandR: async () => ({ branchPosition: { leafId: "runtime-leaf", pending: phase === "pending" } }),
      sessionHookMountedRef: { current: true }, sessionIdRef: { current: "s" }, branchScopeRef: { current: "scope" }, remotePeerRef: { current: null },
      runtimeAvailableRef: { current: false }, setRuntimeAvailable() {},
      eventConnectionRef: { current: { ensureRuntimeConnected: async () => {
        assert.equal(canWriteBranch(branch.state), phase === "current");
        assert.equal(validation.current, phase !== "current");
      } } },
    };
    await actual("ensureEventsConnected", context)("s");
    if (phase === "current") assert.equal(branch.state.runtimeLeafId, "runtime-leaf");
    if (phase === "preview") assert.equal(branch.state.viewedLeafId, "older");
    if (phase === "unknown" || phase === "pending") assert.equal(branch.state.phase, "unknown");
  });
}
