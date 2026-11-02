import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, Type } from "@earendil-works/pi-ai";
import { createAgentSessionFromServices, createAgentSessionServices, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const { createImageGenerationOutputExtension } = await createJiti(import.meta.url).import("./image-generation-output-extension.ts");

function imageFixture(pi) {
  pi.registerTool({
    name: "generate_image", label: "generate_image", description: "Return a synthetic image receipt without network access.",
    parameters: Type.Object({}),
    async execute(toolCallId) {
      const billing = { status: "confirmed", currency: "USD", source: "apimart-task", taskId: "fixture-task", amount: 0.015, startedAt: 1, toolCallId };
      const receipt = { id: "image-generation:fixture", provider: "apimart", model: "fixture", billing };
      pi.appendEntry("image-generation-usage", { version: 2, provider: receipt.provider, model: receipt.model,
        usage: { input: 0, output: 0, totalTokens: 0, usageAvailable: false }, billing,
        usageEvent: { version: 1, id: receipt.id, relation: "origin" } });
      return { content: [{ type: "text", text: "saved" }], details: { files: ["/tmp/generated.png"], imageGeneration: [receipt] } };
    },
  });
  pi.registerTool({
    name: "script", label: "script", description: "Call a tool through the native nested-tool pipeline.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _update, ctx) {
      const outcome = await ctx.executeTool("generate_image", {});
      assert.equal(outcome.isError, false);
      return { content: [{ type: "text", text: "script done" }], details: undefined };
    },
  });
}

for (const nested of [false, true]) {
  test(`records exact image output identities through the real SDK ${nested ? "nested" : "direct"} tool pipeline`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "reader-image-output-"));
    let session;
    try {
      const faux = fauxProvider({ models: [{ id: "faux-model" }] });
      const modelRuntime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: null, refreshOnCreate: false });
      modelRuntime.registerNativeProvider(faux.provider);
      const services = await createAgentSessionServices({ cwd: dir, agentDir: dir, modelRuntime, settingsManager: SettingsManager.inMemory(),
        resourceLoaderOptions: { noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
          extensionFactories: [createImageGenerationOutputExtension(), imageFixture] } });
      ({ session } = await createAgentSessionFromServices({ services, sessionManager: SessionManager.inMemory(dir), model: faux.getModel("faux-model") }));
      faux.setResponses([
        fauxAssistantMessage([fauxToolCall(nested ? "script" : "generate_image", {}, { id: "call_fixture|fc_fixture" })], { stopReason: "toolUse" }),
        fauxAssistantMessage([fauxText("done")]),
      ]);
      await session.prompt("synthetic image");
      const entries = session.sessionManager.getEntries();
      const outputs = entries.filter((entry) => entry.type === "custom" && entry.customType === "image-generation-output");
      assert.equal(outputs.length, 1);
      assert.deepEqual(outputs[0].data, { version: 1, toolCallId: nested ? "call_fixture|fc_fixture/1" : "call_fixture|fc_fixture", files: ["/tmp/generated.png"], usageIds: ["image-generation:fixture"] });
      assert.equal(entries.filter((entry) => entry.type === "custom" && entry.customType === "image-generation-usage").length, 1);
      if (nested) assert.ok(!session.agent.state.messages.some((message) => message.role === "toolResult" && message.toolName === "generate_image"));
    } finally {
      session?.dispose();
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test("recovery links saved files only to the original session's exact task receipts", async () => {
  let handler;
  const writes = [];
  createImageGenerationOutputExtension().factory({ on(_name, callback) { handler = callback; }, appendEntry(type, data) { writes.push({ type, data }); } });
  const billing = { status: "confirmed", currency: "USD", source: "apimart-task", taskId: "task-recovered", toolCallId: "call_fixture|fc_fixture/1", amount: 0.015, startedAt: 1 };
  const ctx = { sessionManager: { getSessionId: () => "session", getEntries: () => [{ type: "custom", customType: "image-generation-usage",
    data: { provider: "apimart", model: "m", billing, usageEvent: { id: "image-generation:recovered" } } }] } };
  const task = { state: "saved", provider: "apimart", model: "m", owner: { sessionId: "session" },
    files: ["/tmp/recovered.png"], billing: [{ id: "image-generation:recovered", taskId: "task-recovered" }] };
  const event = { toolName: "generation_task", toolCallId: "recover/1", input: { action: "recover" }, isError: false, details: { task, files: task.files } };
  await handler(event, ctx);
  assert.deepEqual(writes, [{ type: "image-generation-output", data: { version: 1, toolCallId: "call_fixture|fc_fixture/1", files: ["/tmp/recovered.png"], usageIds: ["image-generation:recovered"] } }]);
  await handler({ ...event, details: { ...event.details, files: ["/tmp/wrong.png"] } }, ctx);
  await handler({ ...event, details: { ...event.details, task: { ...task, owner: { sessionId: "other" } } } }, ctx);
  assert.equal(writes.length, 1);
});

test("metadata write failure and failed or unrelated tools do not change image delivery", async () => {
  let handler;
  let writes = 0;
  createImageGenerationOutputExtension().factory({
    on(name, callback) { assert.equal(name, "tool_result"); handler = callback; },
    appendEntry() { writes++; throw new Error("disk failure"); },
  });
  const details = { files: ["/tmp/result.png"], imageGeneration: [{ id: "image-generation:a", billing: { toolCallId: "call" } }] };
  await handler({ toolName: "generate_image", toolCallId: "call", isError: false, details });
  await handler({ toolName: "generate_image", toolCallId: "call", isError: true, details });
  await handler({ toolName: "read", toolCallId: "call", isError: false, details });
  assert.equal(writes, 1);
});
