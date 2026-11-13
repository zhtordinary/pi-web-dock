import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";
import { AssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";

const root = await mkdtemp(join(tmpdir(), "reader-compression-model-"));
const oldAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = root;
after(async () => {
  if (oldAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = oldAgentDir;
  await rm(root, { recursive: true, force: true });
});
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createCompactionModelExtension } = await jiti.import("./compaction-model-extension.ts");
const { parseCompactionModel, readCompactionModel } = await jiti.import("./compaction-model.ts");
const { readCompactionModelSetting, writeCompactionModelSetting, writeCompactionThinkingSetting } = await jiti.import("./compaction-model-settings.ts");
const { extractReaderUsageRecords, calculateCompactionCosts } = await jiti.import("./billing.ts");
const { getCompactionContextInfo } = await jiti.import("./session-context-usage.ts");
const sdk = await import("@earendil-works/pi-coding-agent");
const model = { provider: "fixture", id: "compressor", api: "openai-completions", baseUrl: "https://example.invalid/v1",
  reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const usage = { input: 30, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 50,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const selected = { provider: model.provider, modelId: model.id };

function fixture(options = {}) {
  const handlers = {};
  createCompactionModelExtension({ getRetrySettings: () => ({ enabled: false }) }).factory({
    on: (name, handler) => { handlers[name] = handler; },
  });
  const calls = [], notices = [];
  let responseIndex = 0;
  const controller = new AbortController();
  const event = { type: "session_before_compact", reason: options.reason ?? "manual", willRetry: options.reason === "overflow",
    signal: controller.signal, customInstructions: "Preserve exact paths", branchEntries: options.branchEntries ?? [],
    preparation: { firstKeptEntryId: "keep", messagesToSummarize: [{ role: "user", content: "Earlier task", timestamp: 1 }],
      turnPrefixMessages: options.split ? [{ role: "user", content: "Ongoing task", timestamp: 2 }] : [], isSplitTurn: Boolean(options.split),
      tokensBefore: 70000, previousSummary: options.previousSummary,
      fileOps: { read: new Set(["read.ts"]), written: new Set(), edited: new Set(["edit.ts"]) },
      settings: { enabled: true, reserveTokens: 16384, keepRecentTokens: 20000 } } };
  const ctx = { model: { ...model, id: "main" }, ui: { notify: (...notice) => notices.push(notice) },
    modelRegistry: { find: () => options.missing ? undefined : { ...model, ...(options.model ?? {}) },
      streamSimple: (active, context, streamOptions) => {
        calls.push({ model: active, context, options: streamOptions });
        const stream = new AssistantMessageEventStream();
        const response = { role: "assistant", api: model.api, provider: active.provider, model: active.id,
          content: [{ type: "text", text: options.empty ? "" : "## Goal\nContinue the task" }], usage,
          stopReason: options.stopReasons?.[responseIndex++] ?? options.stopReason ?? "stop", errorMessage: "fixture provider failure", timestamp: Date.now() };
        if (options.abort) controller.abort();
        stream.end(response);
        return stream;
      } },
  };
  return { event, ctx, calls, notices, controller, run: () => handlers.session_before_compact(event, ctx) };
}

test("validates selections and preserves unrelated global settings under writes", async () => {
  for (const value of [false, "fixture/model", [], {}, { provider: "fixture" }, { provider: "\nfixture", modelId: "m" }]) {
    assert.throws(() => parseCompactionModel(value));
  }
  assert.equal(parseCompactionModel(null), null);
  await writeFile(join(root, "settings.json"), JSON.stringify({ defaultModel: "main", compaction: { enabled: false, reserveTokens: 4000 } }));
  await writeCompactionModelSetting(selected);
  assert.deepEqual(await readCompactionModelSetting(), selected);
  await writeCompactionModelSetting(null);
  assert.deepEqual(JSON.parse(await readFile(join(root, "settings.json"), "utf8")), { defaultModel: "main", compaction: { enabled: false, reserveTokens: 4000 } });
});

test("selected compression thinking level reaches the model request", async () => {
  await writeCompactionModelSetting(selected);
  await writeCompactionThinkingSetting("max");
  const f = fixture({ model: { reasoning: true, thinkingLevelMap: { max: "max", xhigh: "xhigh" } } });
  const result = await f.run();
  assert.ok(result.compaction);
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].options.reasoning, "max");
  await writeCompactionThinkingSetting(null);
});

test("token-capped compression retries the same model without reasoning", async () => {
  await writeCompactionModelSetting(selected);
  await writeCompactionThinkingSetting("max");
  const f = fixture({ stopReasons: ["length", "stop"], model: { reasoning: true, thinkingLevelMap: { max: "max" } } });
  const result = await f.run();
  assert.ok(result.compaction);
  assert.equal(f.calls.length, 2);
  assert.equal(f.calls[0].options.reasoning, "max");
  assert.equal(f.calls[1].options.reasoning, undefined);
  await writeCompactionThinkingSetting(null);
});

test("Codex compression uses SSE for one-off summaries", async () => {
  await writeCompactionModelSetting(selected);
  const f = fixture({ model: { api: "openai-codex-responses" } });
  assert.ok((await f.run()).compaction);
  assert.equal(f.calls[0].options.transport, "sse");
  await writeCompactionModelSetting(null);
});

test("compression off and unsupported saved levels do not start unintended inference", async () => {
  await writeCompactionModelSetting(selected);
  await writeCompactionThinkingSetting("off");
  const off = fixture({ model: { reasoning: true } });
  assert.ok((await off.run()).compaction);
  assert.equal(off.calls[0].options.reasoning, undefined);
  await writeCompactionThinkingSetting("xhigh");
  for (const model of [{ reasoning: false }, { reasoning: true, thinkingLevelMap: { xhigh: null } }]) {
    const unsupported = fixture({ model });
    assert.deepEqual(await unsupported.run(), { cancel: true });
    assert.equal(unsupported.calls.length, 0);
    assert.match(unsupported.notices[0][0], /does not support thinking level/);
  }
  await writeCompactionThinkingSetting(null);
});

test("compression auto uses the selected model's default", async () => {
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { models: [{ id: "compressor", defaultThinkingLevel: "medium" }] } } }));
  await writeCompactionModelSetting(selected);
  await writeCompactionThinkingSetting("auto");
  const f = fixture({ model: { reasoning: true, thinkingLevelMap: { xhigh: "xhigh", max: "max" } } });
  assert.ok((await f.run()).compaction);
  assert.equal(f.calls[0].options.reasoning, "medium");
  await writeCompactionThinkingSetting(null);
  await rm(join(root, "models.json"));
});

test("model-default bridge is removed on shutdown or reload", async () => {
  const handlers = {};
  let listener, removed = false;
  createCompactionModelExtension({ getRetrySettings: () => ({ enabled: false }) }).factory({
    events: { on: (_name, callback) => { listener = callback; return () => { removed = true; }; } },
    on: (name, handler) => { handlers[name] = handler; },
  });
  await writeFile(join(root, "models.json"), JSON.stringify({ providers: { fixture: { models: [{ id: "compressor", defaultThinkingLevel: "low" }] } } }));
  const request = { provider: "fixture", modelId: "compressor", levels: ["off", "low", "max"] };
  listener(request);
  assert.equal(request.level, "low");
  handlers.session_shutdown();
  assert.equal(removed, true);
  await rm(join(root, "models.json"));
});

test("follow mode leaves SDK inference untouched", async () => {
  await writeCompactionModelSetting(null);
  const f = fixture();
  assert.equal(await f.run(), undefined);
  assert.equal(f.calls.length, 0);
});

for (const reason of ["manual", "threshold", "overflow"]) test(`${reason} uses independent inference without changing the session model`, async () => {
  await writeCompactionModelSetting(selected);
  const f = fixture({ reason, split: true, previousSummary: "Previous checkpoint" });
  const result = await f.run();
  assert.equal(result.compaction.firstKeptEntryId, "keep");
  assert.equal(result.compaction.tokensBefore, 70000);
  assert.equal(f.ctx.model.id, "main");
  assert.equal(f.calls.length, 2);
  assert.equal(result.compaction.usage.totalTokens, 100);
  assert.deepEqual(readCompactionModel(result.compaction.details), selected);
  assert.deepEqual(result.compaction.details.readFiles, ["read.ts"]);
  assert.deepEqual(result.compaction.details.modifiedFiles, ["edit.ts"]);
  for (const call of f.calls) {
    assert.equal(call.model.id, "compressor");
    assert.equal(call.options.cacheRetention, "none");
    assert.ok(call.options.sessionId);
    assert.equal(call.options.signal, f.controller.signal);
  }
  assert.match(JSON.stringify(f.calls[0].context), /Previous checkpoint/);
  assert.match(JSON.stringify(f.calls[0].context), /Preserve exact paths/);
});

for (const options of [{ missing: true }, { empty: true }, { stopReason: "length" }, { stopReason: "error" }, { abort: true }, { model: { contextWindow: 100 } }]) {
  test(`failed compression cancels rather than silently falling back: ${JSON.stringify(options)}`, async () => {
    await writeCompactionModelSetting(selected);
    const f = fixture(options);
    assert.deepEqual(await f.run(), { cancel: true });
    assert.ok(f.controller.signal.aborted || f.notices.length > 0);
    if (options.missing || options.model) assert.equal(f.calls.length, 0);
  });
}

test("Reader file metadata survives iterative compaction and returning to follow mode", async () => {
  await writeCompactionModelSetting(null);
  const f = fixture({ branchEntries: [{ type: "compaction", details: { piWebCompaction: { version: 1, ...selected }, readFiles: ["old.ts"], modifiedFiles: ["old-edit.ts"] } }] });
  assert.equal(await f.run(), undefined);
  assert.ok(f.event.preparation.fileOps.read.has("old.ts"));
  assert.ok(f.event.preparation.fileOps.edited.has("old-edit.ts"));
});

test("stored attribution drives billing but context percentage keeps the main window", async () => {
  const entry = { type: "compaction", id: "summary", summary: "Checkpoint", firstKeptEntryId: "keep", tokensBefore: 70000,
    usage, details: { piWebCompaction: { version: 1, ...selected } } };
  const entries = [{ type: "session", id: "session", cwd: root }, { type: "model_change", provider: "fixture", modelId: "main" }, entry];
  const path = join(root, "billing.jsonl");
  await writeFile(path, entries.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const records = await extractReaderUsageRecords(path);
  assert.equal(records[0].model, "compressor");
  assert.equal(records[0].provider, "fixture");
  assert.equal(records[0].usageKind, "compaction");
  assert.equal((await calculateCompactionCosts(path, null)).summary.model, "compressor");
  const contexts = getCompactionContextInfo(entries, { getModel: (_provider, id) => ({ contextWindow: id === "main" ? 200000 : 128000 }) });
  assert.equal(contexts.summary.model, "compressor");
  assert.equal(contexts.summary.contextWindow, 200000);
});

test("real SDK persists the Reader hook result and preserves its main-model selection", async () => {
  await writeCompactionModelSetting(selected);
  const settingsManager = sdk.SettingsManager.inMemory({ packages: [], compaction: { enabled: false, keepRecentTokens: 10 } });
  const sessionManager = sdk.SessionManager.inMemory(root);
  sessionManager.appendModelChange("fixture", "main");
  sessionManager.appendMessage({ role: "user", content: "earlier history ".repeat(200), timestamp: 1 });
  sessionManager.appendMessage({ role: "user", content: "recent question ".repeat(20), timestamp: 2 });
  const f = fixture();
  const realExtension = createCompactionModelExtension(settingsManager);
  const services = await sdk.createAgentSessionServices({ cwd: root, agentDir: root, settingsManager,
    resourceLoaderOptions: { noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [{ ...realExtension, factory: (pi) => realExtension.factory({
        on: (event, handler) => pi.on(event, (input, ctx) => handler(input, { ...ctx, modelRegistry: f.ctx.modelRegistry })),
      }) }] } });
  const { session } = await sdk.createAgentSessionFromServices({ services, sessionManager, model: { ...model, id: "main" }, tools: [] });
  try {
    await session.bindExtensions({ mode: "rpc" });
    await session.compact();
    const checkpoint = sessionManager.getBranch().find((entry) => entry.type === "compaction");
    assert.ok(checkpoint);
    assert.deepEqual(readCompactionModel(checkpoint.details), selected);
    assert.equal(session.model.id, "main");
    assert.equal(sessionManager.getBranch().filter((entry) => entry.type === "model_change").length, 1);
    assert.equal(checkpoint.fromHook, true);
    assert.equal(checkpoint.usage.totalTokens, 50);
  } finally { session.dispose(); services.resourceLoader.getExtensions().runtime.invalidate(); }
});
