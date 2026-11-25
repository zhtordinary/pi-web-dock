import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";
import test from "node:test";
import { WebSocketServer } from "ws";
import { createJiti } from "jiti";
import { cleanupSessionResources } from "@earendil-works/pi-ai";
import { normalizeContext } from "@earendil-works/pi-ai/utils/transcript";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false });
const {
  applyPromptCacheLineage,
  createPromptCacheLineageExtension,
  effectivePromptCacheKey,
  readPromptCacheLineage,
  PROMPT_CACHE_LINEAGE_MODEL,
  PROMPT_CACHE_LINEAGE_PROVIDER,
} = await jiti.import("./prompt-cache-lineage.ts");
const { createSideSession, forkSessionBranch, promoteSideSession } = await jiti.import("./session-fork.ts");
const { ModelRuntime, SessionManager, convertToLlm } = await jiti.import("@earendil-works/pi-coding-agent");
const { installCodexCacheAffinityTransport, loadCodexAffinityAdapter, patchCodexAffinitySource } = await jiti.import("./codex-cache-affinity.ts");
const { stream: streamCodex } = await loadCodexAffinityAdapter();

const MODEL = {
  provider: PROMPT_CACHE_LINEAGE_PROVIDER,
  api: "openai-codex-responses",
  id: PROMPT_CACHE_LINEAGE_MODEL,
  baseUrl: "http://127.0.0.1",
  reasoning: true,
  input: ["text"],
  contextWindow: 128_000,
  maxTokens: 2_048,
  cost: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
};
const TOKEN = `header.${Buffer.from(JSON.stringify({
  "https://api.openai.com/auth": { chatgpt_account_id: "fixture-account" },
})).toString("base64url")}.signature`;

const user = (content) => ({ role: "user", content, timestamp: Date.now() });
const assistant = (content) => ({ role: "assistant", content: [{ type: "text", text: content }], timestamp: Date.now() });
const tool = (name) => ({ name, description: `${name} fixture tool`, parameters: { type: "object", properties: {} } });
const readLines = async (path) => (await readFile(path, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
const headerOf = async (path) => (await readLines(path))[0];

function responseEvents(id, cachedTokens = 7, responseText = "fixture response") {
  const item = { type: "message", id: `msg_${id}`, role: "assistant", status: "completed",
    content: [{ type: "output_text", text: responseText, annotations: [] }] };
  return [
    { type: "response.created", response: { id, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } },
    { type: "response.content_part.added", item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", item_id: item.id, output_index: 0, content_index: 0, delta: responseText },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { id, status: "completed", output: [item],
      usage: { input_tokens: 20, output_tokens: 3, total_tokens: 23,
        input_tokens_details: { cached_tokens: cachedTokens }, output_tokens_details: { reasoning_tokens: 0 } } } },
  ];
}

function sse(events) {
  return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

function extensionPayloadHandler(lineageKey) {
  const handlers = new Map();
  createPromptCacheLineageExtension(lineageKey).factory({
    on(name, handler) { handlers.set(name, handler); },
  });
  const handler = handlers.get("before_provider_request");
  assert.equal(typeof handler, "function");
  return (payload, model) => handler({ type: "before_provider_request", payload }, { model });
}

async function decodeRequestBody(body, headers) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const encoded = new Headers(headers).get("content-encoding");
  const decoded = encoded === "zstd" ? zstdDecompressSync(bytes) : bytes;
  return JSON.parse(decoded.toString("utf8"));
}

async function startWebSocketFixture(t, { hold = false } = {}) {
  const server = createServer();
  const wss = new WebSocketServer({ noServer: true });
  const requests = [];
  const pendingResponses = [];
  const requestWaiters = [];
  const notifyRequest = () => {
    for (const waiter of requestWaiters.splice(0)) waiter();
  };
  server.on("upgrade", (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (webSocket) => wss.emit("connection", webSocket, request));
  });
  wss.on("connection", (socket, request) => {
    socket.on("message", (raw) => {
      const body = JSON.parse(raw.toString("utf8"));
      const requestInfo = { body, headers: request.headers, socket };
      requests.push(requestInfo);
      notifyRequest();
      const sendResponse = () => {
        if (socket.readyState !== 1) return;
        for (const event of responseEvents(`ws-${requests.length}`, 11, request.headers["x-client-request-id"] ?? `ws-${requests.length}`)) {
          socket.send(JSON.stringify(event));
        }
      };
      if (hold) pendingResponses.push(sendResponse);
      else sendResponse();
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  t.after(async () => {
    for (const client of wss.clients) client.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    waitForRequests(count) {
      if (requests.length >= count) return Promise.resolve();
      return new Promise((resolve) => requestWaiters.push(resolve));
    },
    release() {
      for (const sendResponse of pendingResponses.splice(0)) sendResponse();
    },
    closeSession(sessionId) {
      requests.find((request) => request.headers["x-client-request-id"] === sessionId)?.socket.close(1000, "test-close");
    },
  };
}

async function runCodexRequest({ sessionId, lineageKey, context, cacheRetention = "short", transport = "sse", baseUrl = MODEL.baseUrl, cachedTokens = 5, responseText = "fixture response", capture }) {
  const payloads = [];
  const onPayload = extensionPayloadHandler(lineageKey);
  const options = {
    apiKey: TOKEN,
    sessionId,
    cacheRetention,
    transport,
    maxRetries: 0,
    onPayload(payload, model) {
      const transformed = onPayload(payload, model);
      payloads.push(structuredClone(transformed));
      return transformed;
    },
  };
  if (transport === "sse") {
    options.fetch = async (_url, init) => {
      const headers = new Headers(init.headers);
      const body = await decodeRequestBody(init.body, headers);
      capture?.({ body, headers: Object.fromEntries(headers.entries()), payloads });
      return new Response(sse(responseEvents(`sse-${sessionId}`, cachedTokens, responseText)), {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    };
  }
  const result = await streamCodex({ ...MODEL, baseUrl }, context, options).result();
  assert.equal(result.stopReason, "stop", JSON.stringify(result));
  return { result, payloads };
}

function contextFor(messages, tools = [tool("read"), tool("bash")]) {
  return normalizeContext({
    systemPrompt: "Stable fixture instructions",
    tools,
    messages,
  });
}

function requestPrefix(body) {
  return {
    model: body.model,
    instructions: body.instructions,
    tools: body.tools,
    input: body.input,
  };
}

function resultText(result) {
  return result.content.filter((part) => part.type === "text").map((part) => part.text).join("");
}

test("the Codex adapter refuses upstream drift and leaves custom providers untouched", async () => {
  assert.throws(() => patchCodexAffinitySource("unexpected adapter"), /Unsupported Pi Codex/);
  let registered = false;
  const custom = {
    getRegisteredNativeProvider: () => ({ id: PROMPT_CACHE_LINEAGE_PROVIDER }),
    getRegisteredProviderConfig: () => undefined,
    registerNativeProvider: () => { registered = true; },
  };
  await installCodexCacheAffinityTransport(custom);
  assert.equal(registered, false);
  custom.getRegisteredNativeProvider = () => undefined;
  custom.getRegisteredProviderConfig = () => ({ streamSimple: () => {} });
  await installCodexCacheAffinityTransport(custom);
  assert.equal(registered, false);

  const sentinel = {};
  const base = { stream: () => sentinel, streamSimple: () => sentinel };
  let wrapped;
  const ordinary = {
    getRegisteredNativeProvider: () => undefined,
    getRegisteredProviderConfig: () => undefined,
    getProvider: () => base,
    getModel: () => MODEL,
    registerNativeProvider: (provider) => { wrapped = provider; },
  };
  await installCodexCacheAffinityTransport(ordinary);
  assert.equal(wrapped.streamSimple({ id: "another-model", api: "openai-codex-responses" }, {}, {}), sentinel);
  assert.equal(wrapped.stream({ id: "another-model", api: "openai-codex-responses" }, {}, {}), sentinel);
});

test("a real ModelRuntime preserves Codex auth composition while routing lineage", async () => {
  const credential = { type: "oauth", access: TOKEN, refresh: "fixture", expires: Date.now() + 3_600_000 };
  const credentials = {
    async read(provider) { return provider === PROMPT_CACHE_LINEAGE_PROVIDER ? credential : undefined; },
    async list() { return [{ providerId: PROMPT_CACHE_LINEAGE_PROVIDER, type: "oauth" }]; },
    async modify() { throw new Error("fixture credential writes are forbidden"); },
    async delete() { throw new Error("fixture credential writes are forbidden"); },
  };
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  assert.ok(runtime.getModel(PROMPT_CACHE_LINEAGE_PROVIDER, PROMPT_CACHE_LINEAGE_MODEL));
  await installCodexCacheAffinityTransport(runtime);
  const model = runtime.getModel(PROMPT_CACHE_LINEAGE_PROVIDER, PROMPT_CACHE_LINEAGE_MODEL);
  assert.ok(model);
  const seen = [];
  const result = await runtime.streamSimple(model, contextFor([user("runtime fixture")]), {
    apiKey: TOKEN, sessionId: "runtime-child", cacheRetention: "short", transport: "sse", maxRetries: 0,
    onPayload: extensionPayloadHandler("runtime-parent"),
    fetch: async (_url, init) => {
      seen.push(Object.fromEntries(new Headers(init.headers).entries()));
      return new Response(sse(responseEvents("runtime")), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(seen[0]["session-id"], "runtime-parent");
  assert.equal(seen[0]["x-client-request-id"], "runtime-child");
});

test("prompt cache lineage persists across sidebar Fork, Side, promotion, reopen and nested Fork", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-prompt-cache-lineage-"));
  const cwd = join(root, "project");
  const sessionDir = join(root, "sessions");
  await mkdir(cwd, { recursive: true });
  await mkdir(sessionDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const source = SessionManager.create(cwd, sessionDir);
  source.appendMessage(user("root question"));
  source.appendMessage(assistant("root answer"));
  const sourcePath = source.getSessionFile();
  const sourceBytes = await readFile(sourcePath);

  const fork = forkSessionBranch(sourcePath, undefined, "Root");
  const fork2 = forkSessionBranch(fork.path, undefined, null);
  const side = createSideSession(sourcePath, undefined, "Side");
  const sideManager = SessionManager.open(side.path);
  sideManager.appendMessage(user("side question"));
  sideManager.appendMessage(assistant("side answer"));
  const sideBytes = await readFile(side.path);
  const promoted = promoteSideSession(side.path, undefined, "Side");

  assert.notEqual(source.getSessionId(), fork.sessionId);
  assert.notEqual(fork.sessionId, fork2.sessionId);
  assert.notEqual(source.getSessionId(), side.sessionId);
  assert.notEqual(side.sessionId, promoted.sessionId);
  assert.notEqual(sourcePath, fork.path);
  assert.notEqual(fork.path, fork2.path);
  assert.notEqual(side.path, promoted.path);
  assert.deepEqual(await readFile(sourcePath), sourceBytes);
  assert.deepEqual(await readFile(side.path), sideBytes);

  const sourceHeader = await headerOf(sourcePath);
  const forkHeader = await headerOf(fork.path);
  const fork2Header = await headerOf(fork2.path);
  const sideHeader = await headerOf(side.path);
  const promotedHeader = await headerOf(promoted.path);
  const expectedKey = effectivePromptCacheKey(source.getSessionId(), sourceHeader);
  assert.equal(readPromptCacheLineage(sourceHeader), undefined);
  assert.equal(readPromptCacheLineage(forkHeader), expectedKey);
  assert.equal(readPromptCacheLineage(fork2Header), expectedKey);
  assert.equal(readPromptCacheLineage(sideHeader), expectedKey);
  assert.equal(readPromptCacheLineage(promotedHeader), expectedKey);
  assert.equal(readPromptCacheLineage(await headerOf(fork.path)), expectedKey, "reopen keeps durable lineage");

  const sourceContext = contextFor(convertToLlm(source.buildSessionContext().messages), [tool("read"), tool("bash"), tool("edit")]);
  const sideContext = contextFor(convertToLlm(sideManager.buildSessionContext().messages), [tool("read"), tool("bash")]);
  const promotedContext = contextFor(convertToLlm(SessionManager.open(promoted.path).buildSessionContext().messages), [tool("read"), tool("bash"), tool("edit")]);
  const captures = new Map();
  await runCodexRequest({ sessionId: source.getSessionId(), lineageKey: undefined, context: sourceContext,
    capture: (request) => captures.set("source", request) });
  await runCodexRequest({ sessionId: fork.sessionId, lineageKey: expectedKey, context: sourceContext,
    capture: (request) => captures.set("fork", request) });
  await runCodexRequest({ sessionId: fork2.sessionId, lineageKey: expectedKey, context: sourceContext,
    capture: (request) => captures.set("fork2", request) });
  await runCodexRequest({ sessionId: side.sessionId, lineageKey: expectedKey, context: sideContext,
    capture: (request) => captures.set("side", request) });
  await runCodexRequest({ sessionId: promoted.sessionId, lineageKey: expectedKey, context: promotedContext,
    capture: (request) => captures.set("promoted", request) });

  assert.equal(captures.get("source").body.prompt_cache_key, source.getSessionId());
  const childIds = { fork: fork.sessionId, fork2: fork2.sessionId, side: side.sessionId, promoted: promoted.sessionId };
  for (const name of ["fork", "fork2", "side", "promoted"]) {
    assert.equal(captures.get(name).body.prompt_cache_key, expectedKey);
    assert.notEqual(captures.get(name).body.prompt_cache_key, childIds[name]);
  }
  assert.deepEqual(requestPrefix(captures.get("source").body), requestPrefix(captures.get("fork").body));
  assert.deepEqual(requestPrefix(captures.get("fork").body), requestPrefix(captures.get("fork2").body));
  assert.deepEqual(captures.get("side").body.tools.map((entry) => entry.name), ["read", "bash"]);
  assert.match(JSON.stringify(captures.get("side").body.input), /\[Side chat\]/);
  assert.doesNotMatch(JSON.stringify(captures.get("promoted").body.input), /\[Side chat\]/);

  const corruptSource = SessionManager.create(cwd, sessionDir);
  corruptSource.appendMessage(user("corrupt root question"));
  corruptSource.appendMessage(assistant("corrupt root answer"));
  const corruptPath = corruptSource.getSessionFile();
  const corruptLines = await readLines(corruptPath);
  corruptLines[0].promptCacheLineage = `${expectedKey}${"x".repeat(64)}`;
  await writeFile(corruptPath, `${corruptLines.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  const corruptFork = forkSessionBranch(corruptPath, undefined, null);
  assert.equal(readPromptCacheLineage(await headerOf(corruptFork.path)), corruptSource.getSessionId(),
    "a malformed source lineage falls back to the source's own independent key");
  assert.notEqual(corruptFork.sessionId, corruptSource.getSessionId());

  await rm(sourcePath, { force: true });
  const reopenedFork = SessionManager.open(fork.path);
  assert.equal(readPromptCacheLineage(reopenedFork.getHeader()), expectedKey);
  const reopenedCapture = new Map();
  await runCodexRequest({ sessionId: reopenedFork.getSessionId(), lineageKey: readPromptCacheLineage(reopenedFork.getHeader()), context: sourceContext,
    capture: (request) => reopenedCapture.set("fork", request) });
  assert.equal(reopenedCapture.get("fork").body.prompt_cache_key, expectedKey);
  assert.equal(readPromptCacheLineage(await headerOf(fork2.path)), expectedKey, "later Fork does not inspect the missing source");
});

test("same cache lineage keeps concurrent SSE/WebSocket identities and cancellation independent", async (t) => {
  const fixture = await startWebSocketFixture(t);
  const lineageKey = "transport-lineage";
  const cancelledId = "transport-cancelled";
  const retainedId = "transport-retained";
  const websocketIds = ["transport-websocket-a", "transport-websocket-b"];
  t.after(() => {
    for (const sessionId of [cancelledId, retainedId, ...websocketIds]) cleanupSessionResources(sessionId);
  });
  const context = contextFor([user("concurrent transport question")], [tool("read")]);
  const sseCaptures = new Map();
  const [sseA, sseB] = await Promise.all([
    runCodexRequest({ sessionId: "transport-sse-a", lineageKey, context, responseText: "transport-sse-a",
      capture: (request) => sseCaptures.set("a", request) }),
    runCodexRequest({ sessionId: "transport-sse-b", lineageKey, context, responseText: "transport-sse-b",
      capture: (request) => sseCaptures.set("b", request) }),
  ]);
  assert.equal(sseA.result.stopReason, "stop");
  assert.equal(sseB.result.stopReason, "stop");
  assert.match(resultText(sseA.result), /transport-sse-a/);
  assert.match(resultText(sseB.result), /transport-sse-b/);
  assert.equal(sseCaptures.get("a").body.prompt_cache_key, lineageKey);
  assert.equal(sseCaptures.get("b").body.prompt_cache_key, lineageKey);
  assert.equal(sseCaptures.get("a").headers["session-id"], lineageKey);
  assert.equal(sseCaptures.get("b").headers["session-id"], lineageKey);
  assert.notEqual(sseCaptures.get("a").headers["x-client-request-id"], sseCaptures.get("b").headers["x-client-request-id"]);

  let cancelFetchStarted;
  const cancelStarted = new Promise((resolve) => { cancelFetchStarted = resolve; });
  const cancelController = new AbortController();
  let cancelledCapture;
  const cancelled = streamCodex(MODEL, context, {
    apiKey: TOKEN,
    sessionId: cancelledId,
    cacheRetention: "short",
    transport: "sse",
    maxRetries: 0,
    signal: cancelController.signal,
    onPayload(payload, model) {
      return applyPromptCacheLineage(payload, lineageKey, model);
    },
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      cancelledCapture = { body: await decodeRequestBody(init.body, headers), headers: Object.fromEntries(headers.entries()) };
      cancelFetchStarted();
      await new Promise((resolve, reject) => {
        if (init.signal.aborted) reject(new Error("Request was aborted"));
        else init.signal.addEventListener("abort", () => reject(new Error("Request was aborted")), { once: true });
      });
      return new Response(sse(responseEvents(`sse-${cancelledId}`)), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  const retained = streamCodex(MODEL, context, {
    apiKey: TOKEN,
    sessionId: retainedId,
    cacheRetention: "short",
    transport: "sse",
    maxRetries: 0,
    onPayload(payload, model) {
      return applyPromptCacheLineage(payload, lineageKey, model);
    },
    fetch: async (_url, init) => new Response(sse(responseEvents(`sse-${retainedId}`)), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
  }).result();
  await cancelStarted;
  cancelController.abort();
  const cancelledResult = await cancelled;
  assert.ok(["aborted", "error"].includes(cancelledResult.stopReason), JSON.stringify(cancelledResult));
  const retainedResult = await retained;
  assert.equal(retainedResult.stopReason, "stop");
  assert.equal(cancelledCapture.body.prompt_cache_key, lineageKey);

  const websocketModel = { ...MODEL, baseUrl: fixture.baseUrl };
  const websocketResults = await Promise.all(websocketIds.map((sessionId) => streamCodex(websocketModel, context, {
    apiKey: TOKEN,
    sessionId,
    cacheRetention: "short",
    transport: "websocket-cached",
    maxRetries: 0,
    onPayload(payload, model) {
      return applyPromptCacheLineage(payload, lineageKey, model);
    },
  }).result()));
  assert.deepEqual(websocketResults.map((result) => result.stopReason), ["stop", "stop"]);
  assert.match(resultText(websocketResults[0]), /transport-websocket-a/);
  assert.match(resultText(websocketResults[1]), /transport-websocket-b/);
  const websocketRequests = new Map(fixture.requests.map((request) => [request.headers["x-client-request-id"], request]));
  for (const sessionId of websocketIds) {
    assert.equal(websocketRequests.get(sessionId)?.body.prompt_cache_key, lineageKey);
    assert.equal(websocketRequests.get(sessionId)?.headers["session-id"], lineageKey);
  }
  assert.notEqual(websocketRequests.get(websocketIds[0])?.socket, websocketRequests.get(websocketIds[1])?.socket);
  fixture.closeSession(websocketIds[0]);
  assert.notEqual(websocketRequests.get(websocketIds[0])?.socket.readyState, 1);
  assert.equal(websocketRequests.get(websocketIds[1])?.socket.readyState, 1);
});

test("Prompt Cache affinity preserves real usage, disabled cache, request identity and session isolation", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-prompt-cache-wire-"));
  const usageCwd = join(root, "project");
  const usageDir = join(root, "sessions");
  await mkdir(usageCwd, { recursive: true });
  await mkdir(usageDir, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = await startWebSocketFixture(t);
  const sessionId = "child-session-wire";
  const lineageKey = "source-session-wire";
  t.after(() => cleanupSessionResources(sessionId));
  const context = contextFor([user("wire question")], [tool("read")]);
  const captures = [];
  const request = await runCodexRequest({ sessionId, lineageKey, context, cachedTokens: 5,
    capture: (value) => captures.push(value) });
  assert.equal(request.result.usage.cacheRead, 5);
  assert.equal(captures[0].body.prompt_cache_key, lineageKey);
  assert.equal(captures[0].headers["session-id"], lineageKey);
  assert.equal(captures[0].headers["x-client-request-id"], sessionId);
  assert.deepEqual(requestPrefix(captures[0].body), requestPrefix(request.payloads[0]));

  const disabled = [];
  await runCodexRequest({ sessionId, lineageKey, context, cacheRetention: "none",
    capture: (value) => disabled.push(value) });
  assert.equal(Object.hasOwn(disabled[0].body, "prompt_cache_key"), false);
  assert.equal(disabled[0].headers["session-id"], undefined);

  const overridden = [];
  await streamCodex(MODEL, context, {
    apiKey: TOKEN, sessionId, cacheRetention: "short", transport: "sse", maxRetries: 0,
    onPayload(payload, model) {
      return { ...applyPromptCacheLineage(payload, lineageKey, model), prompt_cache_key: "different-key" };
    },
    fetch: async (_url, init) => {
      const headers = new Headers(init.headers);
      overridden.push(Object.fromEntries(headers.entries()));
      return new Response(sse(responseEvents("overridden")), { status: 200, headers: { "content-type": "text/event-stream" } });
    },
  }).result();
  assert.equal(overridden[0]["session-id"], sessionId);
  assert.equal(overridden[0]["x-client-request-id"], sessionId);
  const unicode = [];
  await runCodexRequest({ sessionId, lineageKey: "缓存血缘", context, capture: (value) => unicode.push(value) });
  assert.equal(unicode[0].body.prompt_cache_key, "缓存血缘");
  assert.equal(unicode[0].headers["session-id"], sessionId);

  const websocketModel = { ...MODEL, baseUrl: fixture.baseUrl };
  const wsPayloads = [];
  const wsResult = await streamCodex(websocketModel, context, {
    apiKey: TOKEN,
    sessionId,
    cacheRetention: "short",
    transport: "websocket",
    maxRetries: 0,
    onPayload(payload, model) {
      const transformed = applyPromptCacheLineage(payload, lineageKey, model);
      wsPayloads.push(structuredClone(transformed));
      return transformed;
    },
  }).result();
  assert.equal(wsResult.stopReason, "stop");
  assert.equal(fixture.requests.at(-1).body.prompt_cache_key, lineageKey);
  assert.equal(fixture.requests.at(-1).headers["session-id"], lineageKey);
  assert.equal(fixture.requests.at(-1).headers["x-client-request-id"], sessionId);
  assert.equal(wsPayloads.at(-1).prompt_cache_key, lineageKey);

  const malformed = { promptCacheLineage: `${lineageKey}${"x".repeat(64)}` };
  assert.equal(readPromptCacheLineage(malformed), undefined);
  const otherProviderPayload = { prompt_cache_key: "other-session" };
  assert.deepEqual(applyPromptCacheLineage(otherProviderPayload, lineageKey, { provider: "openai", id: PROMPT_CACHE_LINEAGE_MODEL }), otherProviderPayload);
  assert.deepEqual(applyPromptCacheLineage({}, lineageKey, MODEL), {});
  const independent = "independent-session";
  const independentCapture = [];
  const independentRequest = await runCodexRequest({ sessionId: independent, lineageKey: undefined, context, cachedTokens: 0,
    capture: (value) => independentCapture.push(value) });
  assert.equal(independentCapture[0].body.prompt_cache_key, independent);
  assert.equal(independentRequest.result.usage.cacheRead, 0);
  assert.equal(request.result.usage.input, 15);
  assert.equal(request.result.usage.cacheRead, 5);
  const billedHit = SessionManager.create(usageCwd, usageDir);
  billedHit.appendMessage(user("hit"));
  billedHit.appendMessage(request.result);
  const billedMiss = SessionManager.create(usageCwd, usageDir);
  billedMiss.appendMessage(user("miss"));
  billedMiss.appendMessage(independentRequest.result);
  const hitAssistant = (await readLines(billedHit.getSessionFile())).at(-1).message;
  const missAssistant = (await readLines(billedMiss.getSessionFile())).at(-1).message;
  assert.equal(hitAssistant.usage.input, request.result.usage.input);
  assert.equal(hitAssistant.usage.cacheRead, request.result.usage.cacheRead);
  assert.deepEqual(hitAssistant.usage.cost, request.result.usage.cost);
  assert.equal(missAssistant.usage.input, independentRequest.result.usage.input);
  assert.equal(missAssistant.usage.cacheRead, 0);
  assert.equal(missAssistant.usage.cost.cacheRead, independentRequest.result.usage.cost.cacheRead);
  assert.notEqual(hitAssistant.usage.cacheRead, missAssistant.usage.cacheRead);

  for (const id of [sessionId, independent]) cleanupSessionResources(id);
  assert.ok(captures.length > 0);
  assert.ok(disabled.length > 0);
});
