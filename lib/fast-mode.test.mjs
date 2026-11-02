import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const rpcSource = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

const {
  applyFastModeToPayload,
  fastModeStatus,
  isFastModeDefault,
  isFastModeSupported,
  readSessionFastMode,
  setFastModeDefault,
  createFastModeExtension,
} = await jiti("./fast-mode.ts");

const responseModel = {
  provider: "CPA GPT",
  id: "gpt-5.6-luna",
  api: "openai-responses",
  samplingParams: { top_p: 0.8, service_tier: "priority" },
};

test("recognizes Fast-capable models and model defaults", () => {
  assert.equal(isFastModeSupported(responseModel), true);
  assert.equal(isFastModeSupported({ ...responseModel, provider: "Sub2API GPT" }), true);
  assert.equal(isFastModeSupported({ ...responseModel, provider: "third-party-openai" }), true);
  assert.equal(isFastModeSupported({ provider: "CPA GPT", id: "gpt-5.5", api: "openai-responses" }), true);
  assert.equal(isFastModeSupported({ provider: "CPA GPT", id: "vendor-GPT-preview", api: "openai-responses" }), true);
  assert.equal(isFastModeSupported({ provider: "Codex", id: "gpt-6-preview", api: "openai-codex-responses" }), true);
  assert.equal(isFastModeSupported({ provider: "CPA GPT", id: "claude-opus-4-6-thinking", api: "openai-responses" }), false);
  assert.equal(isFastModeSupported({ api: "openai-completions", id: "gpt-5.6-luna" }), false);
  assert.equal(isFastModeDefault(responseModel), true);
  assert.equal(isFastModeDefault({ ...responseModel, provider: "Sub2API GPT" }), true);
  assert.equal(isFastModeDefault({ provider: "Sub2API GPT", id: "gpt-5.5", api: "openai-responses", samplingParams: { service_tier: "priority" } }), true);
  assert.deepEqual(fastModeStatus("default", responseModel), {
    mode: "default",
    enabled: true,
    supported: true,
  });
  assert.deepEqual(fastModeStatus("standard", responseModel), {
    mode: "standard",
    enabled: false,
    supported: true,
  });
});

test("model Fast default preserves unrelated sampling parameters", () => {
  const disabled = setFastModeDefault(responseModel, false);
  assert.deepEqual(disabled.samplingParams, { top_p: 0.8 });

  const enabled = setFastModeDefault(disabled, true);
  assert.deepEqual(enabled.samplingParams, { top_p: 0.8, service_tier: "priority" });
});

test("session mode transforms only the request tier", () => {
  const payload = { model: "gpt-5.6-luna", service_tier: "priority", temperature: 0.2 };
  assert.deepEqual(applyFastModeToPayload(payload, "fast", responseModel), payload);
  assert.deepEqual(applyFastModeToPayload(payload, "default", responseModel), payload);
  assert.deepEqual(applyFastModeToPayload({ model: "gpt-5.6-luna", service_tier: "fast" }, "default", responseModel), {
    model: "gpt-5.6-luna",
    service_tier: "priority",
  });
  assert.deepEqual(applyFastModeToPayload(payload, "standard", responseModel), {
    model: "gpt-5.6-luna",
    temperature: 0.2,
  });
  assert.deepEqual(applyFastModeToPayload({ model: "other" }, "fast", { api: "anthropic-messages" }), { model: "other" });
});

test("the runtime extension has a stable name and applies the current session mode", () => {
  let handler;
  const extension = createFastModeExtension({ mode: "standard" });
  assert.equal(extension.name, "pi-web-fast-mode");
  assert.equal(extension.hidden, true);
  extension.factory({
    on(_event, next) {
      handler = next;
    },
  });
  assert.ok(handler);
  assert.deepEqual(handler({ payload: { service_tier: "priority", model: "gpt-5.6-luna" } }, { model: responseModel }), {
    model: "gpt-5.6-luna",
  });
});

test("RPC owns the Fast mode request and session state bridge", () => {
  assert.match(rpcSource, /createFastModeExtension\(fastModeState\)/);
  assert.match(rpcSource, /fastMode: this\.getFastModeStatus\(\)/);
  assert.match(rpcSource, /case "set_fast_mode":/);
  assert.match(rpcSource, /appendSessionFastMode\(this\.inner\.sessionManager, mode\)/);
});test("reads the newest valid persisted session mode", () => {
  assert.equal(readSessionFastMode([]), "default");
  assert.equal(readSessionFastMode([
    { type: "custom", customType: "pi-web:fast-mode", data: { version: 1, mode: "fast" } },
    { type: "custom", customType: "pi-web:fast-mode", data: { version: 1, mode: "standard" } },
  ]), "standard");
  assert.equal(readSessionFastMode([
    { type: "custom", customType: "pi-web:fast-mode", data: { version: 1, mode: "fast" } },
    { type: "custom", customType: "pi-web:fast-mode", data: { version: 2, mode: "standard" } },
  ]), "fast");
});
