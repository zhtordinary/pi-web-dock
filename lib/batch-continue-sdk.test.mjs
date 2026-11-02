import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createAgentSessionServices, createAgentSessionFromServices, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createInitialSystemMessage } from "@earendil-works/pi-ai/utils/transcript";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const activity = await jiti.import("./session-activity.ts");
const model = { provider: "fixture", id: "resume", api: "openai-completions", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

for (const status of ["unknown", "failed"]) test(`real SDK resumes a ${status} system-tail run once without another user message`, { timeout: 15000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), "reader-batch-resume-"));
  let services, wrapper;
  try {
    const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
    const manager = SessionManager.inMemory(root);
    manager.appendModelChange(model.provider, model.id);
    manager.appendMessage({ role: "user", content: "Finish the original task", timestamp: 1 });
    manager.appendMessage(createInitialSystemMessage("Keep original recovery policy", []));
    if (status === "failed") manager.appendMessage({ role: "assistant", api: model.api, provider: model.provider, model: model.id,
      content: [], stopReason: "error", errorMessage: "HTTP 503 fixture", usage, timestamp: 2 });
    services = await createAgentSessionServices({ cwd: root, agentDir: root, settingsManager,
      resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true } });
    const requests = [];
    services.modelRuntime.streamSimple = (_model, context) => {
      requests.push(structuredClone(context));
      const stream = new AssistantMessageEventStream();
      const message = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        content: [{ type: "text", text: "Original task resumed" }], stopReason: "stop", usage, timestamp: Date.now() };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    };
    const { session } = await createAgentSessionFromServices({ services, sessionManager: manager, model, tools: [] });
    wrapper = new AgentSessionWrapper(session);
    wrapper.start();
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    const run = activity.recordSessionRunStart(session.sessionId, root);
    if (status === "failed") activity.recordSessionRunError(session.sessionId, "HTTP 503 fixture", false, run.runId);
    else activity.recordSessionRunUnknown(session.sessionId, run.runId);
    const errors = [];
    const done = new Promise(resolve => wrapper.onEvent(event => {
      if (event.type === "prompt_error") errors.push(event.errorMessage);
      if (event.type === "prompt_done") resolve();
    }));
    await wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId });
    await done;
    assert.deepEqual(errors, []);
    assert.equal(requests.length, 1);
    assert.match(JSON.stringify(requests[0]), /Keep original recovery policy/);
    assert.equal(manager.getBranch().filter(entry => entry.type === "message" && entry.message.role === "user").length, 1);
    assert.equal(activity.getSessionRunRecords().find(record => record.sessionId === session.sessionId).status, "completed");
    await assert.rejects(wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId }), error => error.code === "retry_target_changed");
    assert.equal(requests.length, 1);
  } finally {
    await wrapper?.shutdown();
    services?.resourceLoader.getExtensions().runtime.invalidate();
    await rm(root, { recursive: true, force: true });
  }
});
