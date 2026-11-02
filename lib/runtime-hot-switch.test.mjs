import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createJiti } from "jiti";
const { createFastModeExtension } = await createJiti(import.meta.url).import("./fast-mode.ts");
const model = id => ({ id, name: id, api: "openai-responses", provider: "synthetic", reasoning: true, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 10000, maxTokens: 1000 });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

test("the installed Pi request projection picks up model and reasoning after an in-flight tool without restarting", async () => {
  let entered, release;
  const toolStarted = new Promise(done => { entered = done; });
  const toolGate = new Promise(done => { release = done; });
  const requests = [];
  const agent = new Agent({ initialState: { model: model("gpt-old"), thinkingLevel: "low", tools: [{ name: "pause", label: "pause", description: "synthetic", parameters: { type: "object", properties: {} }, execute: async () => { entered(); await toolGate; return { content: [{ type: "text", text: "done" }], details: {} }; } }], messages: [] }, streamFn: (currentModel, _context, options) => {
    requests.push({ id: currentModel.id, reasoning: options.reasoning });
    const stream = createAssistantMessageEventStream();
    const first = requests.length === 1;
    queueMicrotask(() => stream.push({ type: "done", reason: first ? "toolUse" : "stop", message: { role: "assistant", content: first ? [{ type: "toolCall", id: "pause-id", name: "pause", arguments: {} }] : [{ type: "text", text: "finished" }], api: currentModel.api, provider: currentModel.provider, model: currentModel.id, usage, stopReason: first ? "toolUse" : "stop", timestamp: Date.now() } }));
    return stream;
  } });
  const entries = [];
  const session = {
    agent,
    get model() { return agent.state.model; },
    get thinkingLevel() { return agent.state.thinkingLevel; },
    _modelRuntime: { checkAuth: async () => true },
    settingsManager: { getModelThinkingLevel: () => "high", getDefaultThinkingLevel: () => "low" },
    sessionManager: { buildSessionProjection: () => ({ messages: agent.state.messages }), appendModelChange: (...args) => entries.push(args), appendThinkingLevelChange() {} },
    getAvailableThinkingLevels: () => ["off", "low", "high"],
    _getThinkingLevelForModelSwitch: AgentSession.prototype._getThinkingLevelForModelSwitch,
    setThinkingLevel: AgentSession.prototype.setThinkingLevel,
    _emit() {}, _extensionRunner: { emit: async () => {} }, _emitModelSelect: async () => {},
  };
  AgentSession.prototype._installAgentRequestProjection.call(session);
  const running = agent.prompt("synthetic test");
  await toolStarted;
  await AgentSession.prototype.setModel.call(session, model("gpt-new"));
  assert.deepEqual(requests, [{ id: "gpt-old", reasoning: "low" }]);
  release();
  await running;
  assert.deepEqual(requests, [{ id: "gpt-old", reasoning: "low" }, { id: "gpt-new", reasoning: "high" }]);
  assert.deepEqual(entries, [["synthetic", "gpt-new"]]);
});

test("Fast mode updates subsequent provider payloads without rewriting the previous payload", () => {
  const state = { mode: "standard" };
  let listener;
  createFastModeExtension(state).factory({ on: (_name, callback) => { listener = callback; } });
  const old = listener({ payload: { service_tier: "priority", marker: "old" } }, { model: model("gpt-test") });
  state.mode = "fast";
  const next = listener({ payload: { marker: "next" } }, { model: model("gpt-test") });
  assert.equal(old.service_tier, undefined);
  assert.equal(next.service_tier, "priority");
  assert.equal(old.service_tier, undefined);
});
