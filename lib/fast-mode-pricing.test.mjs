import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { createFastModeExtension } = await jiti.import("./fast-mode.ts");
const { extractReaderUsageRecords, calculateSessionCost, calculateCompactionCosts } = await jiti.import("./billing.ts");

function extension() {
  const handlers = new Map();
  createFastModeExtension({ mode: "fast" }).factory({ on: (name, fn) => handlers.set(name, fn) });
  return handlers;
}
const assistant = (id) => ({ role: "assistant", provider: "openai", api: "openai-responses", model: "gpt-5.5", responseId: id, usage: { input: 100, output: 10 }, content: [], timestamp: 1 });

test("Fast captures terminal response tier by identity, including downgrade, without changing tokens", () => {
  const handlers = extension();
  for (const [id, tier] of [["fast", "priority"], ["downgraded", "default"]]) {
    handlers.get("provider_stream_event")({ provider: "openai", api: "openai-responses", data: { type: "response.completed", response: { id, service_tier: tier } } });
  }
  const original = assistant("downgraded");
  const result = handlers.get("message_end")({ message: original }).message;
  assert.equal(result.service_tier, "default");
  assert.equal(result.response_service_tier, "default");
  assert.deepEqual(result.usage, original.usage);
  assert.equal(original.service_tier, undefined);
  assert.equal(handlers.get("message_end")({ message: assistant("fast") }).message.service_tier, "priority");
  assert.equal(handlers.get("message_end")({ message: assistant("missing") }), undefined);
  assert.equal(handlers.get("message_end")({ message: assistant("fast") }), undefined);
});

test("Codex raw done and all supported terminal events preserve the observed tier", () => {
  for (const type of ["response.done", "response.completed", "response.incomplete", "response.failed"]) {
    for (const tier of ["priority", "default"]) {
      const handlers = extension();
      const message = { ...assistant("codex"), provider: "openai-codex", api: "openai-codex-responses" };
      handlers.get("provider_stream_event")({ provider: message.provider, api: message.api, data: { type, response: { id: message.responseId, service_tier: tier } } });
      assert.equal(handlers.get("message_end")({ message: { ...message, api: "openai-responses" } }), undefined);
      assert.equal(handlers.get("message_end")({ message }).message.service_tier, tier);
      handlers.get("provider_stream_event")({ provider: message.provider, api: message.api, data: { type, response: { id: message.responseId, service_tier: tier } } });
      handlers.get("session_shutdown")();
      assert.equal(handlers.get("message_end")({ message }), undefined);
    }
  }
});

test("provider identity, nonterminal events, and run cleanup prevent tier leakage", () => {
  const handlers = extension();
  const event = { provider: "openai", api: "openai-responses", data: { type: "response.created", response: { id: "id", service_tier: "priority" } } };
  handlers.get("provider_stream_event")(event);
  assert.equal(handlers.get("message_end")({ message: assistant("id") }), undefined);
  event.data.type = "response.completed";
  handlers.get("provider_stream_event")(event);
  assert.equal(handlers.get("message_end")({ message: { ...assistant("id"), provider: "another" } }), undefined);
  handlers.get("agent_end")();
  assert.equal(handlers.get("message_end")({ message: assistant("id") }), undefined);
});

test("Historical Pi fast-mode events without a response tier are priced at the regular rate; an observed tier still wins", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-history-"));
  try {
    const file = join(root, "session.jsonl");
    const script = join(root, "prices.py");
    await writeFile(script, `def price_usages(items):\n    return [{'cost': {'input': 1, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 1}, 'rates': {'serviceTier': item.get('serviceTier', '')}} for item in items]\n`);
    const entries = [
      { type: "session", id: "history" },
      { type: "message", id: "root", parentId: null, message: { role: "user", content: "start" } },
      { type: "custom", id: "fast", parentId: "root", customType: "pi-web:fast-mode", data: { version: 1, mode: "fast" } },
      { type: "message", id: "reply", parentId: "fast", message: { ...assistant("history"), model: "gpt-5.5", service_tier: "priority" } },
      { type: "custom", id: "default", parentId: "fast", customType: "pi-web:fast-mode", data: { version: 1, mode: "default" } },
      { type: "message", id: "defaulted", parentId: "default", message: { ...assistant("defaulted"), model: "gpt-5.5", service_tier: "priority" } },
      { type: "message", id: "downgraded", parentId: "default", message: { ...assistant("downgrade"), model: "gpt-5.5", response_service_tier: "default" } },
    ];
    await writeFile(file, entries.map(JSON.stringify).join("\n") + "\n");
    const records = await extractReaderUsageRecords(file);
    // No recorded tier -> no tier (regular price), whatever the Fast selection was; a reported tier is kept.
    assert.deepEqual(records.map(row => row.serviceTier || ""), ["", "", "default"]);
    const priced = await calculateSessionCost(file, script);
    assert.equal(priced.cost.amount, 3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("A requested tier without response evidence does not change the rate", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-request-tier-"));
  try {
    const file = join(root, "session.jsonl");
    const entries = [
      { type: "session", id: "request-tier" },
      { type: "custom", id: "fast-root", parentId: null, customType: "pi-web:fast-mode", data: { version: 1, mode: "fast" } },
      { type: "message", id: "request-message", parentId: "fast-root", message: { ...assistant("request-only"), request_service_tier: "priority" } },
      { type: "custom", id: "request-custom", parentId: "fast-root", data: { model: "gpt-5.5", request_service_tier: "priority", usage: { input: 10 } } },
      { type: "compaction", id: "request-compaction", parentId: "fast-root", model: "gpt-5.5", request_service_tier: "priority", usage: { input: 10 } },
    ];
    await writeFile(file, entries.map(JSON.stringify).join("\n") + "\n");
    const records = await extractReaderUsageRecords(file);
    assert.deepEqual(records.map(row => row.serviceTier || ""), ["", "", ""]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CPA gateway priority falls back to the base estimate", async () => {
  const root = await mkdtemp(join(tmpdir(), "cpa-priority-base-"));
  try {
    const file = join(root, "session.jsonl");
    const script = join(root, "prices.py");
    await writeFile(script, `def price_usages(items):\n    return [{'cost': {'input': 1, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 1}, 'rates': {'serviceTier': item.get('serviceTier', '')}} for item in items]\n`);
    const entries = [
      { type: "session", id: "cpa-priority" },
      { type: "message", id: "request-only", timestamp: "2026-10-28T00:00:00Z", message: { ...assistant("request-only"), provider: "CPA GPT", model: "gpt-5.6-luna", service_tier: "priority" } },
      { type: "message", id: "response-priority", timestamp: "2026-10-28T00:00:01Z", message: { ...assistant("response-priority"), provider: "CPA GPT", model: "gpt-5.6-luna", service_tier: "priority", response_service_tier: "priority" } },
    ];
    await writeFile(file, entries.map(JSON.stringify).join("\n") + "\n");
    const records = await extractReaderUsageRecords(file);
    assert.deepEqual(records.map(row => row.serviceTier || ""), ["", "priority"]);
    const priced = await calculateSessionCost(file, script);
    assert.equal(priced.cost.status, "calculated");
    assert.equal(priced.cost.amount, 2);
    assert.deepEqual(priced.messageCosts, { "request-only": 1, "response-priority": 1 });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Reader forwards observed tier through normalization and Python batch for messages, custom usage and compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "fast-pricing-"));
  try {
    const file = join(root, "session.jsonl");
    const script = join(root, "prices.py");
    await writeFile(script, `def price_usages(items):\n    return [None if item.get('serviceTier') == 'priority' else {'cost': {'input': 1, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 1}, 'rates': {'serviceTier': item.get('serviceTier', '')}} for item in items]\n`);
    const captured = (id, tier) => {
      const handlers = extension();
      const message = { ...assistant(id), provider: "openai-codex", api: "openai-codex-responses" };
      handlers.get("provider_stream_event")({ provider: message.provider, api: message.api, data: { type: "response.done", response: { id, service_tier: tier } } });
      return handlers.get("message_end")({ message }).message;
    };
    const entries = [
      { type: "session", id: "test" },
      { type: "message", id: "fast", timestamp: "2026-10-11T00:00:00Z", message: captured("fast", "priority") },
      { type: "message", id: "standard", timestamp: "2026-10-11T00:00:01Z", message: { ...captured("standard", "default"), request_service_tier: "priority" } },
      { type: "custom", id: "recap", data: { model: "gpt-5.5", response_service_tier: "priority", usage: { input: 10 } } },
      { type: "compaction", id: "compact", model: "gpt-5.5", response_service_tier: "priority", usage: { input: 10 } },
    ];
    await writeFile(file, entries.map(JSON.stringify).join("\n") + "\n");
    const records = await extractReaderUsageRecords(file);
    assert.deepEqual(records.map(row => row.usage.serviceTier), ["priority", "default", "priority", "priority"]);
    const priced = await calculateSessionCost(file, script);
    assert.equal(priced.cost.status, "partial");
    assert.equal(priced.cost.amount, 1);
    assert.deepEqual(priced.messageCosts, { standard: 1 });
    const compaction = await calculateCompactionCosts(file, script);
    assert.equal(compaction.compact.status, "partial");

    // An older adapter may accept serviceTier but silently return standard pricing.
    await writeFile(script, `def price_usages(items):\n    return [{'cost': {'input': 99, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0, 'total': 99}, 'rates': {}} for item in items]\n`);
    const older = await calculateSessionCost(file, script);
    assert.equal(older.cost.status, "partial");
    assert.equal(older.cost.amount, 0);
    assert.deepEqual(older.messageCosts, {});
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
