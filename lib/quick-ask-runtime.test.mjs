import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { Agent } from "@earendil-works/pi-agent-core";
import { convertToLlm } from "@earendil-works/pi-coding-agent";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import { createJiti } from "jiti";
import { quickAskFixture, assistant, storage, log, context, deferred, tick, model } from "../test-support/quick-ask-fixture.mjs";
import { thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
const { hasActiveSessionLivenessProvider } = await createJiti(import.meta.url).import("./session-liveness.ts");

// The actual SDK Agent executes its tool loop while Side Ask uses the same real manager.
test("main tool execution, two side topics and interleaved SDK persistence do not steal each other's context or leaf", async () => {
  const h = await quickAskFixture();
  const entered = deferred();
  const release = deferred();
  let main;
  let unsubscribe;
  let toolCalls = 0;
  let modelCalls = 0;
  try {
    const agent = new Agent({ sessionId: h.manager.getSessionId(), convertToLlm,
      initialState: { model, messages: h.manager.buildSessionContext().messages, systemPrompt: "Main fixture", tools: [{
        name: "main-tool", description: "A real SDK tool-loop fixture", parameters: { type: "object", properties: {} },
        execute: async () => { toolCalls++; entered.resolve(); await release.promise; return { content: [{ type: "text", text: "main tool result" }], details: {} }; },
      }] },
      streamFn: () => {
        const stream = new AssistantMessageEventStream();
        const message = modelCalls++ === 0
          ? assistant("", model, { content: [{ type: "toolCall", id: "main-tool-call", name: "main-tool", arguments: {} }], stopReason: "toolUse" })
          : assistant("main final answer");
        stream.push({ type: "done", reason: message.stopReason, message });
        stream.end();
        return stream;
      },
    });
    unsubscribe = agent.subscribe((event) => { if (event.type === "message_end") h.manager.appendMessage(event.message); });
    h.state.mainRunning = true;
    main = agent.prompt("main running question");
    await entered.promise;
    const a = await h.start({ threadId: "a", question: "side A" });
    const b = await h.start({ threadId: "b", question: "side B" });
    const observers = await Promise.all([a, b].map((run) => h.get(`?runId=${run.id}&stream=1`)));
    await Promise.all(observers.map((response) => response.body.cancel()));
    assert.equal(agent.state.isStreaming, true);
    assert.equal(h.runs.every((run) => !run.options.signal.aborted), true);
    await h.post({ action: "stop", runId: a.id });
    h.runs[1].complete("side B final answer");
    await h.waitTerminal(b.id);
    release.resolve();
    await main;
    h.state.mainRunning = false;
    assert.equal(toolCalls, 1);
    assert.equal(modelCalls, 2);
    assert.equal(h.state.aborts, 0);
    const projection = JSON.stringify(h.manager.buildSessionContext().messages);
    assert.match(projection, /main tool result|main final answer/);
    assert.doesNotMatch(projection, /side A|side B/);
    assert.equal((await storage.readSessionQuickAsks(h.file))[0].data.answer, "side B final answer");
    const rows = (await readFile(h.file, "utf8")).trim().split("\n").map(JSON.parse).slice(1);
    assert.equal(new Set(rows.map((row) => row.id)).size, rows.length);
    for (let index = 1; index < rows.length; index++) assert.equal(rows[index].parentId, rows[index - 1].id);
    assert.equal(h.manager.getLeafId(), rows.at(-1).id);
    assert.equal(h.manager.getEntry(rows.at(-1).id).message.content[0].text, "main final answer");
  } finally {
    release.resolve();
    await main?.catch(() => {});
    unsubscribe?.();
    await h.cleanup();
  }
});

test("unobserved inference and its conversion keep the existing liveness registry active", async () => {
  const conversion = deferred();
  const h = await quickAskFixture({ materialized: () => conversion.promise });
  const active = () => hasActiveSessionLivenessProvider({ sessionId: h.manager.getSessionId(), sessionFile: h.file });
  try {
    assert.equal(active(), false);
    const run = await h.start();
    assert.equal(active(), true);
    const fork = h.side.fork({ threadId: "a", branchId: "main" });
    h.runs[0].complete();
    await h.waitTerminal(run.id);
    await tick();
    assert.equal(active(), true, "conversion is still host-owned after inference has committed");
    conversion.resolve({});
    await fork;
    assert.equal(active(), false);
    h.side.close();
    assert.equal(active(), false);
  } finally { conversion.resolve({}); await h.cleanup(); }
});

test("a fresh reader projection reports interrupted admission honestly and does not restart the model", async () => {
  const h = await quickAskFixture();
  try {
    const run = await h.start();
    h.runs[0].emit("live only progress");
    await tick();
    const cold = log.quickAskRunSnapshots(await storage.readQuickAskRecords(h.file));
    assert.equal(cold[0].id, run.id);
    assert.equal(cold[0].status, "interrupted");
    assert.equal(h.side.snapshot(run.id).status, "running");
    assert.equal(h.runs.length, 1);
  } finally { await h.cleanup(); }
});

test("cleanup errors are not main aborts or reasons to strand another topic", async () => {
  let released = 0;
  const h = await quickAskFixture({ associateProvider: () => ({ dispose() { released++; throw new Error("synthetic lease cleanup failure"); } }) });
  try {
    const a = await h.start({ threadId: "a" });
    const b = await h.start({ threadId: "b" });
    assert.equal((await h.post({ action: "stop", runId: a.id })).status, 200);
    assert.equal(released, 1);
    assert.equal(h.state.disposes, 1);
    assert.equal(h.state.aborts, 0);
    h.runs[1].complete();
    await h.waitTerminal(b.id);
    assert.equal(h.state.disposes, 2);
    assert.equal(h.owner.isAlive(), true);
  } finally { await h.cleanup(); }
});

test("hasActiveRun is true from admission until the run settles", async () => {
  const h = await quickAskFixture();
  try {
    assert.equal(h.side.hasActiveRun(), false);
    const run = await h.start();
    assert.equal(h.side.hasActiveRun(), true);
    h.runs[0].complete();
    await h.waitTerminal(run.id);
    await tick();
    assert.equal(h.side.hasActiveRun(), false);
  } finally { await h.cleanup(); }
});

test("the request carries the answer room plus the reasoning budget of the chosen level, and only the answer room otherwise", async () => {
  const h = await quickAskFixture({ getModel: (provider, id) => ({ ...model, provider, id, maxTokens: 128000 }) });
  try {
    const plain = await h.start({ threadId: "plain", thinkingLevel: "off" });
    assert.equal(h.runs[0].options.maxTokens, context.QUICK_ASK_ANSWER_TOKENS);
    assert.equal(h.runs[0].options.reasoning, undefined);
    h.runs[0].complete();
    await h.waitTerminal(plain.id);
    const deep = await h.start({ threadId: "deep", thinkingLevel: "high" });
    assert.equal(h.runs[1].options.reasoning, "high");
    assert.equal(h.runs[1].options.maxTokens, context.QUICK_ASK_ANSWER_TOKENS + thinkingBudgetForLevel("high"));
    h.runs[1].complete();
    await h.waitTerminal(deep.id);
  } finally { await h.cleanup(); }
});
