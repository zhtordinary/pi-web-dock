import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { ModelRuntime, convertToLlm } from "@earendil-works/pi-coding-agent";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { quickAskFixture, assistant, storage, tick } from "../../../../../test-support/quick-ask-fixture.mjs";

for (const api of ["openai-responses", "openai-completions"]) {
  test(`${api}: real Agent and logical fork preserve the independently assembled wire prefix`, async () => {
    const model = { api, provider: "openai", id: "gpt-synthetic", baseUrl: "https://api.openai.com/v1",
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 200000, maxTokens: 4096 };
    const requests = [];
    const sdkBodies = new Map();
    let networkCalls = 0;
    const capture = async (context, options) => {
      let payload;
      const stream = (api === "openai-responses" ? streamResponses : streamCompletions)(model, context, {
        ...options, apiKey: "synthetic-fixture-not-a-real-key",
        fetch: async () => { networkCalls++; throw new Error("Fixture must not contact a provider"); },
        onPayload: async (body) => {
          payload = await options.onPayload?.(body, model) ?? body;
          sdkBodies.set(payload, structuredClone(body));
          throw new Error("Synthetic capture ends before transport");
        },
      });
      await stream.result();
      assert.ok(payload, "the actual SDK must assemble the wire payload");
      return payload;
    };
    const runtime = { getModel: () => model, streamSimple: (_model, context, options) => {
      const stream = new AssistantMessageEventStream();
      void capture(context, options).then((payload) => {
        requests.push({ payload, options, context });
        stream.push({ type: "done", reason: "stop", message: assistant("Synthetic side answer", model) });
        stream.end();
      }, (error) => stream.end(assistant("", model, { stopReason: "error", errorMessage: String(error) })));
      return stream;
    } };
    const h = await quickAskFixture({ model, createRuntime: async () => runtime });
    try {
      let parentPayload;
      let executedTools = 0;
      const agent = new Agent({ sessionId: h.manager.getSessionId(),
        initialState: { model, messages: h.manager.buildSessionContext().messages, systemPrompt: "Stable synthetic instructions", tools: [{
          name: "fixture-tool", description: "Declared but never executable in Side Ask", parameters: { type: "object", properties: {} },
          execute: async () => { executedTools++; throw new Error("Side Ask must not execute tools"); },
        }] }, convertToLlm,
        streamFn: (_model, context, options) => {
          const stream = new AssistantMessageEventStream();
          void capture(context, options).then((payload) => {
            parentPayload = payload;
            stream.push({ type: "done", reason: "stop", message: assistant("Parent answer", model) });
            stream.end();
          }, (error) => stream.end(assistant("", model, { stopReason: "error", errorMessage: String(error) })));
          return stream;
        },
      });
      const unsubscribe = agent.subscribe((event) => { if (event.type === "message_end") h.manager.appendMessage(event.message); });
      await agent.prompt("Synthetic parent question");
      unsubscribe();
      assert.ok(parentPayload);
      const parentMessages = JSON.stringify(agent.state.messages);
      for (const [question, threadId] of [["first", "a"], ["follow-up", "a"], ["other", "b"]]) {
        const run = await h.start({ question, threadId });
        await h.waitTerminal(run.id);
      }
      assert.equal(requests.length, 3);
      const key = api === "openai-responses" ? "input" : "messages";
      for (const { payload, options, context } of requests) {
        assert.equal(context.systemPrompt, undefined);
        assert.equal(context.tools, undefined);
        assert.equal(payload.prompt_cache_key, parentPayload.prompt_cache_key);
        assert.equal(payload.tool_choice, "none");
        assert.deepEqual(payload[key].slice(0, parentPayload[key].length), parentPayload[key]);
        assert.deepEqual(payload.tools, parentPayload.tools);
        assert.notEqual(options.sessionId, h.manager.getSessionId());
        assert.equal(options.toolChoice, "none");
        assert.equal(options.headers, undefined, "affinity uses the SDK cache key, not guessed gateway headers");
        // A strict gateway accepts the parent's request; the Side Ask may differ only by the value of the
        // SDK-generated cache key and by tool_choice.
        assert.deepEqual({ ...payload, prompt_cache_key: undefined }, { ...sdkBodies.get(payload), prompt_cache_key: undefined });
        for (const field of Object.keys(payload)) assert.ok(field === "tool_choice" || field in parentPayload, field);
      }
      assert.equal((await capture(requests[0].context, { ...requests[0].options, cacheRetention: "none" })).prompt_cache_key, undefined);
      assert.equal(requests[0].options.sessionId, requests[1].options.sessionId);
      assert.notEqual(requests[0].options.sessionId, requests[2].options.sessionId);
      assert.equal(JSON.stringify(agent.state.messages), parentMessages);
      assert.equal(executedTools, 0);
      assert.equal(networkCalls, 0);
      assert.equal((await storage.readSessionQuickAsks(h.file)).length, 3);
    } finally { await h.cleanup(); }
  });
}

test("registered stateful Provider sessions remain independent after browser detachment and explicit stop", {timeout: 10000}, async () => {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false,
    credentials: { read: async () => undefined, list: async () => [], write: async () => {}, remove: async () => {} } });
  const calls = [];
  let enterSecond; const secondEntered = new Promise(resolve => { enterSecond = resolve; });
  runtime.registerProvider("stateful-fixture", {
    api: "openai-responses", apiKey: "synthetic-fixture-not-a-real-key", baseUrl: "https://invalid.example/v1",
    models: [{ id: "stateful-model", name: "Stateful fixture", contextWindow: 200000, maxTokens: 4096,
      reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context, options) => {
      const stream = new AssistantMessageEventStream();
      calls.push({ model, context, options, stream });
      if (calls.length === 2) enterSecond();
      return stream;
    },
  });
  const model = runtime.getModel("stateful-fixture", "stateful-model");
  const h = await quickAskFixture({ model, createRuntime: async () => runtime });
  try {
    const browser = new AbortController();
    const firstResponse = await h.post({ action: "start", question: "first", threadId: "a" }, { signal: browser.signal });
    const first = (await firstResponse.json()).run;
    await h.side.whenReady(first.id);
    const second = await h.start({ question: "second", threadId: "b" });
    await secondEntered;
    browser.abort();
    assert.equal(calls.length, 2);
    assert.equal(calls[0].options.signal.aborted, false);
    assert.equal(calls[1].options.signal.aborted, false);
    assert.notEqual(calls[0].options.sessionId, calls[1].options.sessionId);
    for (const call of calls) assert.notEqual(call.options.sessionId, h.manager.getSessionId());
    assert.equal((await h.post({ action: "stop", runId: first.id })).status, 200);
    assert.equal(calls[0].options.signal.aborted, true);
    assert.equal(calls[1].options.signal.aborted, false);
    for (const [index, call] of calls.entries()) {
      call.stream.push({ type: "done", reason: "stop", message: assistant(index ? "second answer" : "late first", model) });
      call.stream.end();
    }
    await h.waitTerminal(second.id);
    await tick();
    const entries = await storage.readSessionQuickAsks(h.file);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].data.question, "second");
    assert.equal(calls[1].options.toolChoice, "none");
  } finally { await h.cleanup(); }
});
