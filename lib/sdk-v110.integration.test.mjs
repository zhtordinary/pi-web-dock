import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import { createJiti } from "jiti";

// Mac contract: this file is only statically parsed/diff-checked on the author
// worktree. Debian runs it after the locked pi SDK 1.1.0 closure is installed;
// no test here calls a network provider or reads credentials.
const fixture = JSON.parse(await readFile(
  new URL("./__fixtures__/sdk-v110/events.json", import.meta.url),
  "utf8",
));
const runtimeSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
const hookSource = await readFile(new URL("../hooks/useAgentSession.ts", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { moduleCache: false });
const { agentEndErrorMessage, agentEndWasAborted, toClientAgentEvent } = await jiti.import("./agent-event-wire.ts");
const { scopeSubagentExtensions, subagentExtensionLoaderOptions } = await jiti.import("./subagents.ts");

function loadTurnLimitSeam() {
  const guardStart = runtimeSource.indexOf("interface TurnLimitGuard");
  const guardEnd = runtimeSource.indexOf("\nfunction getSubagentRuns", guardStart);
  assert.notEqual(guardStart, -1, "turn-limit seam must remain in the Reader runtime");
  assert.notEqual(guardEnd, -1, "turn-limit seam boundary must remain in the Reader runtime");

  const context = { AbortSignal, Promise, Set };
  vm.createContext(context);
  const source = [
    'const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";',
    runtimeSource.slice(guardStart, guardEnd),
    "globalThis.__readerSdk110Seams = { installTurnLimitGuard };",
  ].join("\n");
  vm.runInContext(stripTypeScriptTypes(source).replace(/\bexport\s+(?=function)/g, ""), context);
  return context.__readerSdk110Seams;
}

function makeTurnLimitInner({ queued = false, decision } = {}) {
  const listeners = new Set();
  const steerCalls = [];
  const clearQueueCalls = [];
  const agent = {
    finishTurn: async () => (typeof decision === "function" ? decision() : decision),
    steeringMode: "one-at-a-time",
    hasQueuedMessages: () => queued,
  };
  const inner = {
    agent,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(event) {
      for (const listener of listeners) listener(event);
    },
    clearQueue() {
      clearQueueCalls.push(true);
      return { steering: ["queued steering"], followUp: ["queued follow-up"] };
    },
    async steer(message) {
      steerCalls.push(message);
    },
  };
  return { inner, steerCalls, clearQueueCalls };
}

function turn(stopReason = "stop", toolResults = []) {
  return { message: { stopReason }, toolResults };
}

function makeExtension(path, source, tools) {
  return {
    path,
    sourceInfo: { source, origin: "package" },
    tools: new Map(tools.map((name) => [name, {}])),
  };
}

const extensionFixture = {
  extensions: [
    makeExtension("/fixture/kept/index.ts", "npm:reader-kept", ["kept_tool"]),
    makeExtension("/fixture/dropped/index.ts", "npm:reader-dropped", ["dropped_tool"]),
    { path: "<inline:reader-host>", sourceInfo: { source: "local", origin: "inline" }, tools: new Map([["Agent", {}]]) },
  ],
  errors: [],
  runtime: {
    pendingProviderRegistrations: [
      { extensionPath: "/fixture/kept/index.ts" },
      { extensionPath: "/fixture/dropped/index.ts" },
    ],
    pendingNativeProviderRegistrations: [
      { extensionPath: "/fixture/kept/index.ts" },
      { extensionPath: "/fixture/dropped/index.ts" },
    ],
    pendingVirtualModelRegistrations: [
      { extensionPath: "/fixture/kept/index.ts" },
      { extensionPath: "/fixture/dropped/index.ts" },
    ],
  },
};

test("projects the SDK 1.1 terminal split without treating agent_end as an aborted event", () => {
  const completed = toClientAgentEvent(fixture.agentEndCompleted);
  const retrying = toClientAgentEvent(fixture.agentEndRetryingError);
  const abortedMessage = toClientAgentEvent(fixture.agentEndAbortedMessage);
  const settled = toClientAgentEvent(fixture.agentSettledAborted);

  assert.deepEqual(completed, { type: "agent_end" });
  assert.deepEqual(retrying, { type: "agent_end", errorMessage: "provider failed" });
  assert.deepEqual(abortedMessage, { type: "agent_end", aborted: true });
  assert.deepEqual(settled, fixture.agentSettledAborted);
  assert.equal(Object.hasOwn(completed, "aborted"), false);
  assert.equal(agentEndErrorMessage(fixture.agentEndRetryingError), "provider failed");
  assert.equal(agentEndWasAborted(fixture.agentEndCompleted), false);
  assert.equal(agentEndWasAborted(fixture.agentSettledAborted), false, "settled is handled by the settled-event consumer");

  const agentEndStart = hookSource.indexOf('case "agent_end"');
  const settledStart = hookSource.indexOf('case "agent_settled"');
  const settledEnd = hookSource.indexOf('case "prompt_done"', settledStart);
  assert.ok(agentEndStart >= 0 && settledStart > agentEndStart && settledEnd > settledStart);
  const settledCase = hookSource.slice(settledStart, settledEnd);
  assert.match(settledCase, /if \(event\.aborted === true\) lastAgentAbortedRef\.current = true/);
  assert.doesNotMatch(hookSource.slice(agentEndStart, settledStart), /event\.aborted === true/);
});

test("keeps SDK 1.1 durationMs=0 on the Reader wire", () => {
  assert.deepEqual(toClientAgentEvent(fixture.toolEndWithZeroDuration), fixture.toolEndWithZeroDuration);
});

test("finishTurn keeps natural completion, queued/tool continuation, hard limit, and aborted branches distinct", async () => {
  const { installTurnLimitGuard } = loadTurnLimitSeam();

  {
    const { inner, steerCalls } = makeTurnLimitInner();
    const stored = {};
    const guard = installTurnLimitGuard(inner, 2, stored);
    const result = await inner.agent.finishTurn(turn());
    assert.equal(result, undefined);
    assert.equal(guard.reached(), false);
    assert.deepEqual(steerCalls, []);
    guard.dispose();
  }

  {
    const { inner, steerCalls } = makeTurnLimitInner({ queued: true });
    const stored = {};
    const guard = installTurnLimitGuard(inner, 2, stored);
    await inner.agent.finishTurn(turn());
    assert.deepEqual(steerCalls, []);
    await inner.agent.finishTurn(turn());
    assert.equal(guard.reached(), false);
    assert.equal(inner.agent.steeringMode, "all");
    assert.deepEqual(steerCalls, ["You have reached your turn limit. Wrap up immediately and provide your final answer now."]);
    guard.dispose();
  }

  {
    const { inner, steerCalls, clearQueueCalls } = makeTurnLimitInner();
    const stored = {};
    const guard = installTurnLimitGuard(inner, 2, stored);
    const toolResults = [{ toolCallId: "tool-1" }];
    await inner.agent.finishTurn(turn("stop", toolResults));
    await inner.agent.finishTurn(turn("stop", toolResults));
    assert.equal(guard.reached(), false, "the limit turn gives the agent one final wrap-up turn");
    const hardStop = await inner.agent.finishTurn(turn("stop", toolResults));
    assert.equal(hardStop?.action, "end");
    assert.equal(guard.reached(), true);
    assert.equal(stored.turnLimitReached, true);
    assert.deepEqual(steerCalls, ["You have reached your turn limit. Wrap up immediately and provide your final answer now."]);
    assert.equal(clearQueueCalls.length, 1);
    assert.deepEqual([...guard.undelivered()], ["queued steering", "queued follow-up"]);
    guard.dispose();
  }

  {
    const { inner, steerCalls, clearQueueCalls } = makeTurnLimitInner();
    const stored = {};
    const guard = installTurnLimitGuard(inner, 1, stored);
    inner.emit({ type: "tool_execution_end", toolCallId: "terminating-tool", result: { terminate: true } });
    const result = await inner.agent.finishTurn(turn("stop", [{ toolCallId: "terminating-tool" }]));
    assert.equal(result, undefined);
    assert.equal(guard.reached(), false);
    assert.deepEqual(steerCalls, []);
    assert.equal(clearQueueCalls.length, 0);
    guard.dispose();
  }

  {
    const { inner, steerCalls, clearQueueCalls } = makeTurnLimitInner();
    const stored = {};
    const guard = installTurnLimitGuard(inner, 1, stored);
    const signal = new AbortController();
    signal.abort();
    const result = await inner.agent.finishTurn(turn("stop", [{ toolCallId: "tool-2" }]), signal.signal);
    assert.equal(result, undefined);
    assert.equal(guard.reached(), false);
    assert.deepEqual(steerCalls, []);
    assert.equal(clearQueueCalls.length, 0);
    guard.dispose();
  }
});

test("scopes the final SDK extension/provider binding and drops pending registrations for omitted extensions", () => {
  // The full createAgentSessionServices/provider-dispose chain is intentionally
  // left to Debian's locked SDK closure. This is the Reader's real final
  // override seam: discovery stays intact while omitted extensions lose every
  // pending provider/native-provider/virtual-model registration.
  const override = scopeSubagentExtensions(["ext:reader-kept"]);
  const scoped = override(structuredClone(extensionFixture));
  assert.deepEqual(scoped.extensions.map((extension) => extension.path), [
    "/fixture/kept/index.ts",
    "<inline:reader-host>",
  ]);
  assert.deepEqual(scoped.runtime.pendingProviderRegistrations, [{ extensionPath: "/fixture/kept/index.ts" }]);
  assert.deepEqual(scoped.runtime.pendingNativeProviderRegistrations, [{ extensionPath: "/fixture/kept/index.ts" }]);
  assert.deepEqual(scoped.runtime.pendingVirtualModelRegistrations, [{ extensionPath: "/fixture/kept/index.ts" }]);

  const disabled = subagentExtensionLoaderOptions({ loadExtensions: false });
  assert.equal(disabled.noExtensions, true);
  assert.equal(Object.hasOwn(disabled, "extensionsOverride"), false);
  const selected = subagentExtensionLoaderOptions({ loadExtensions: true, extensions: ["ext:reader-kept"] });
  assert.equal(selected.noExtensions, false);
  assert.equal(typeof selected.extensionsOverride, "function");
  const selectedBase = selected.extensionsOverride(structuredClone(extensionFixture));
  assert.deepEqual(selectedBase.extensions.map((extension) => extension.path), [
    "/fixture/kept/index.ts",
    "<inline:reader-host>",
  ]);
});
