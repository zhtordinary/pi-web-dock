import assert from "node:assert/strict";
import { createJiti } from "jiti";
import test from "node:test";
import { streamSimple, resetOpenAICodexWebSocketDebugStats } from "@earendil-works/pi-ai/api/openai-codex-responses";

const { createQuickAskProviderSessionId, withQuickAskCacheAffinity } = await createJiti(import.meta.url).import("./quick-ask-session.ts");
const parent = "01912345-1234-7123-8123-123456789abc";
const model = { api: "openai-codex-responses", provider: "openai-codex", id: "fixture-model", baseUrl: "https://example.invalid",
  reasoning: false, input: ["text"], contextWindow: 200000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const claims = Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-fixture" } })).toString("base64url");
const fakeCredential = `e30.${claims}.e30`;

async function captureRequest(onPayload) {
  const sideId = createQuickAskProviderSessionId({ parentSessionId: parent, threadId: "fixture-topic",
    branchId: "fixture-branch", provider: model.provider, model: model.id });
  const original = globalThis.WebSocket;
  let websocketHeaders, httpHeaders, payload;
  globalThis.WebSocket = class {
    constructor(_url, options) {
      websocketHeaders = new Headers(options.headers);
      throw new Error("offline fixture: no WebSocket connection");
    }
  };
  try {
    const stream = streamSimple(model, { messages: [{ role: "user", content: [{ type: "text", text: "synthetic" }], timestamp: 1 }] }, {
      sessionId: sideId, apiKey: fakeCredential, transport: "auto", maxRetries: 0,
      onPayload: (body, requestModel) => {
        payload = onPayload(body, requestModel, sideId);
        return payload;
      },
      fetch: async (_url, init) => {
        httpHeaders = init.headers;
        throw new Error("offline fixture: no HTTP connection");
      },
    });
    await stream.result();
  } finally {
    globalThis.WebSocket = original;
    resetOpenAICodexWebSocketDebugStats(sideId);
  }
  assert.ok(websocketHeaders, "must observe the actual SDK WebSocket handshake");
  assert.ok(httpHeaders, "must observe the actual SDK SSE fallback request");
  return { sideId, websocketHeaders, httpHeaders, payload };
}

test("Codex Side Ask routes HTTP and WebSocket cache affinity to the parent without sharing its request identity", async () => {
  const { sideId, websocketHeaders, httpHeaders, payload } = await captureRequest(
    (body, requestModel, id) => withQuickAskCacheAffinity(body, parent, id, requestModel));
  assert.equal(payload.prompt_cache_key, parent);
  assert.equal(websocketHeaders.get("session-id"), parent);
  assert.equal(httpHeaders.get("session-id"), parent);
  assert.equal(websocketHeaders.get("x-client-request-id"), sideId.slice(0, 64));
  assert.equal(httpHeaders.get("x-client-request-id"), sideId.slice(0, 64));
  assert.equal(JSON.parse(JSON.stringify(payload)).prompt_cache_key, parent);
});

test("unmarked custom cache keys do not change other Codex session routing", async () => {
  const { sideId, websocketHeaders, httpHeaders } = await captureRequest(
    (body) => ({ ...body, prompt_cache_key: "unrelated-custom-cache-key" }));
  assert.equal(websocketHeaders.get("session-id"), sideId.slice(0, 64));
  assert.equal(httpHeaders.get("session-id"), sideId.slice(0, 64));
});

test("invalid or mismatched cache-route markers cannot change request headers", async () => {
  for (const route of ["other-session", "invalid\r\nheader"]) {
    const { sideId, websocketHeaders, httpHeaders } = await captureRequest((body) => {
      const routed = { ...body, prompt_cache_key: parent };
      Object.defineProperty(routed, Symbol.for("pi-web:side-ask-cache-route"), { value: route });
      return routed;
    });
    assert.equal(websocketHeaders.get("session-id"), sideId.slice(0, 64));
    assert.equal(httpHeaders.get("session-id"), sideId.slice(0, 64));
  }
});
