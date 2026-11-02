import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, mkdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { after, test } from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const sealed = await createSealedPublicInputEnvironment("extension-usage");
after(() => sealed.restore());
const pkg = join(sealed.root, "package"); await mkdir(pkg);
const legacyLocator = { layout: "project-session-v1", directory: "fixture-usage", customType: "fixture-old-usage", stats: ["suggestionUsage", "seederUsage"] };
await writeFile(join(pkg, "package.json"), JSON.stringify({ name: "fixture-extension", pi: { extensions: [] }, piWeb: { usageAccounting: { version: 1, legacy: legacyLocator } } }));
const suggesterPkg = join(sealed.root, "suggester-package"); await mkdir(suggesterPkg);
const suggesterLocator = { layout: "project-session-v1", directory: "prompt-suggester", customType: "suggester-usage", stats: ["suggestionUsage", "seederUsage"] };
await writeFile(join(suggesterPkg, "package.json"), JSON.stringify({ name: "pi-prompt-suggester", pi: { extensions: [] }, piWeb: { usageAccounting: { version: 1, legacy: suggesterLocator } } }));
await writeFile(join(sealed.agentDir, "settings.json"), JSON.stringify({ packages: [pkg, suggesterPkg] }));
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { calculateSessionCost, extractReaderUsageRecords, priceTokenUsage, sessionCostRevision } = await jiti.import("./billing.ts");
const { sessionCostPresentation } = await jiti.import("./session-cost.ts");
const timestamp = "2026-08-27T00:00:00Z";
const tokenUsage = (input, output = 10) => ({ input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output, usageAvailable: true });
const event = (id, usage = tokenUsage(100), extra = {}) => ({ version: 1, extensionId: "fixture-extension", kind: "suggester", status: "settled", provider: "openai", model: "gpt-5.6-sol", timestamp, usageEvent: { version: 1, id, relation: "origin" }, usage, ...extra });
const sha = (value) => createHash("sha256").update(value).digest("hex");
const journalDir = (id) => join(sealed.agentDir, "session-extension-usage", sha(id));
const stats = (calls = 0, inputTokens = 0, outputTokens = 0) => ({ calls, inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: inputTokens + outputTokens, costTotal: 999 });
const baseline = (id, calls = 0, input = 0, output = 0, extensionId = "fixture-extension", locator = legacyLocator) => ({ version: 1, extensionId, legacy: { calls, input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output }, legacyLocator: locator });
const custom = (entry, id = "event", envelope = true) => ({ type: "custom", id, customType: "pi-extension-usage", timestamp, data: envelope ? { event: entry } : entry });
const header = (id, cwd) => ({ type: "session", id, cwd, timestamp });
async function writeJsonl(path, values) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, values.map(JSON.stringify).join("\n") + "\n"); }
async function journal(id, values, boundary = baseline(id)) {
  const dir = journalDir(id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "fixture-extension.legacy.json"), JSON.stringify(boundary));
  await writeJsonl(join(dir, "fixture-extension.jsonl"), values);
}
async function legacyFile(cwd, id, suggestionUsage, seederUsage = stats(), directory = legacyLocator.directory) {
  // Same layout as the extension: the project key hashes the physical cwd (macOS /var is a symlink).
  const canonical = await realpath(cwd);
  const project = `${basename(canonical)}-${sha(canonical).slice(0, 12)}`;
  const file = join(sealed.agentDir, directory, "projects", project, "sessions", id, "usage.json");
  await mkdir(dirname(file), { recursive: true }); await writeFile(file, JSON.stringify({ suggestionUsage, seederUsage })); return file;
}

 test("unifies priced main, recap, compaction and per-call extensions without duplicated copies", async () => {
  const cwd = join(sealed.root, "project-a"), parent = join(sealed.root, "case-a", "parent.jsonl"); await mkdir(cwd);
  const child = join(sealed.root, "case-a", "parent", "run", "child.jsonl");
  const first = event("first", tokenUsage(200)), second = event("second", tokenUsage(300, 20), { kind: "seeder" });
  assert.equal(custom(first).data.usage, undefined, "older hosts must ignore the envelope");
  const childEvent = event("child", tokenUsage(400, 30));
  const message = { type: "message", id: "main", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", usage: tokenUsage(100, 5) } };
  const recap = { type: "custom", id: "recap", customType: "session-recap-title:usage", timestamp, data: { provider: "openai", model: "gpt-5.6-sol", kind: "recap", usage: tokenUsage(20, 2) } };
  const compaction = { type: "compaction", id: "compact", timestamp, provider: "openai", model: "gpt-5.6-sol", usage: tokenUsage(30, 3) };
  await writeJsonl(parent, [header("parent-a", cwd), message, recap, compaction, custom(first)]);
  await writeJsonl(child, [header("child-a", cwd), custom(first, "older-copy", false), custom(childEvent, "child-event")]);
  await journal("parent-a", [{ ...first, status: "started", usage: { usageAvailable: false } }, first, second]);
  const result = await calculateSessionCost(parent, sealed.scriptPath);
  const expected = await Promise.all([message.message.usage, recap.data.usage, compaction.usage, first.usage, second.usage, childEvent.usage]
    .map((usage) => priceTokenUsage({ provider: "openai", model: "gpt-5.6-sol", timestamp, ...usage }, sealed.scriptPath)));
  const amount = expected.reduce((sum, row) => sum + row.cost.total, 0);
  assert.equal(result.totalCost.status, "calculated");
  assert.ok(Math.abs(result.totalCost.amount - amount) < 1e-9);
  assert.equal(result.extensionCosts.length, 1); assert.equal(result.extensionCosts[0].status, "calculated");
  assert.equal(result.extensionCosts[0].usage.totalTokens, 960);
  assert.ok(Math.abs(result.extensionCosts[0].amount - expected.slice(3).reduce((sum, row) => sum + row.cost.total, 0)) < 1e-9);
  assert.ok(Math.abs(result.mainCost.amount - [expected[0], expected[2]].reduce((sum, row) => sum + row.cost.total, 0)) < 1e-9);
  assert.ok(Math.abs(result.recapCost.amount - expected[1].cost.total) < 1e-9);
  assert.ok(Math.abs(result.parentCost.amount + result.childCost.amount - result.totalCost.amount) < 1e-9);
});

test("extension service tiers require response provenance", async () => {
  const cwd = join(sealed.root, "project-tier"), path = join(sealed.root, "case-tier", "session.jsonl"); await mkdir(cwd);
  const requested = event("requested-tier", tokenUsage(10), { serviceTier: "priority" });
  const observed = event("observed-tier", tokenUsage(10), { serviceTier: "priority", serviceTierSource: "response" });
  await writeJsonl(path, [header("parent-tier", cwd), custom(requested), custom(observed, "observed")]);
  const records = await extractReaderUsageRecords(path);
  assert.deepEqual(records.map((record) => record.usage.serviceTier), [undefined, "priority"]);
});

test("unpriced models and missing raw usage produce partial or unavailable amounts, never free calls", async () => {
  const cwd = join(sealed.root, "project-b"), path = join(sealed.root, "case-b", "session.jsonl"); await mkdir(cwd);
  const known = { type: "message", id: "main", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", usage: tokenUsage(100, 10) } };
  const unknownPrice = event("unpriced", tokenUsage(10), { model: "model-not-in-catalog" });
  const unknownUsage = event("no-usage", { usageAvailable: false });
  await writeJsonl(path, [header("parent-b", cwd), known, custom(unknownPrice), custom(unknownUsage, "missing")]);
  const result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "partial"); assert.ok(result.totalCost.amount > 0);
  assert.equal(result.extensionCosts[0].status, "unavailable");
  assert.ok(result.missingPriceModels.includes("openai/model-not-in-catalog"));
  assert.equal(result.missingPriceModels.includes("openai/gpt-5.6-sol"), false);
  assert.equal(result.pendingUsageCount, 1);
  assert.deepEqual(result.pendingUsageModels, ["openai/gpt-5.6-sol"]);
  assert.equal(result.extensionCosts[0].pendingUsageCount, 1);
  assert.deepEqual(result.extensionCosts[0].pendingUsageModels, ["openai/gpt-5.6-sol"]);
  await writeJsonl(path, [header("parent-b", cwd), custom(unknownUsage)]);
  const onlyUnknown = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(onlyUnknown.totalCost.status, "unavailable"); assert.equal(onlyUnknown.totalCost.amount, null);
  assert.deepEqual(onlyUnknown.missingPriceModels, []);
  assert.equal(onlyUnknown.pendingUsageCount, 1);
});

test("legacy baseline stays unpriced and aggregate coverage detects old processes writing after migration", async () => {
  const cwd = join(sealed.root, "project-c"), path = join(sealed.root, "case-c", "session.jsonl"); await mkdir(cwd);
  const id = "parent-c", modelCall = event("covered", tokenUsage(100, 10));
  const coverage = { version: 1, extensionId: "fixture-extension", type: "aggregate_coverage", id: "coverage-1", kind: "suggester", eventIds: ["covered"], usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110 } };
  await writeJsonl(path, [header(id, cwd), custom(modelCall)]);
  await journal(id, [modelCall, coverage]);
  const file = await legacyFile(cwd, id, stats(1, 100, 10));
  let result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "calculated"); assert.equal(result.extensionCosts[0].historicalIncomplete, false);
  const revision = await sessionCostRevision(path);
  await writeFile(file, JSON.stringify({ suggestionUsage: stats(2, 1300, 20), seederUsage: stats() }));
  assert.notEqual(await sessionCostRevision(path), revision);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "partial"); assert.equal(result.extensionCosts[0].historicalIncomplete, true);
  assert.equal(result.extensionCosts[0].usage, null);
  await writeFile(join(journalDir(id), "fixture-extension.legacy.json"), JSON.stringify(baseline(id, 1, 30, 3)));
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.extensionCosts[0].historicalIncomplete, true);
});

test("legacy prompt-suggester totals use the approved model estimate without recounting covered events", async () => {
  const cwd = join(sealed.root, "project-suggester"), path = join(sealed.root, "case-suggester", "session.jsonl"); await mkdir(cwd);
  const id = "suggester-legacy", first = event("suggester-first", tokenUsage(200, 20), { extensionId: "pi-prompt-suggester", provider: "CPA GPT", model: "gpt-5.6-luna" });
  const second = event("suggester-second", tokenUsage(300, 30), { extensionId: "pi-prompt-suggester", provider: "CPA GPT", model: "gpt-5.6-luna" });
  const coverage = (eventId, input, output, idSuffix) => ({ version: 1, extensionId: "pi-prompt-suggester", type: "aggregate_coverage", id: `coverage-${idSuffix}`, kind: "suggester", eventIds: [eventId], usage: { input, output, cacheRead: 0, cacheWrite: 0, totalTokens: input + output } });
  const boundary = baseline(id, 13, 1000, 100, "pi-prompt-suggester", suggesterLocator);
  const dir = journalDir(id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-prompt-suggester.legacy.json"), JSON.stringify(boundary));
  await writeJsonl(join(dir, "pi-prompt-suggester.jsonl"), [first, second, coverage(first.usageEvent.id, 200, 20, "first"), coverage(second.usageEvent.id, 300, 30, "second")]);
  await legacyFile(cwd, id, stats(16, 1900, 190), stats(), suggesterLocator.directory);
  const session = join(sealed.root, "case-suggester", "session.jsonl");
  await writeJsonl(session, [header(id, cwd)]);

  const historical = await priceTokenUsage({ provider: "CPA GPT", model: "gpt-5.6-luna", timestamp, ...tokenUsage(1400, 140) }, sealed.scriptPath);
  const modern = await Promise.all([first, second].map((row) => priceTokenUsage({ provider: row.provider, model: row.model, timestamp: row.timestamp, ...row.usage }, sealed.scriptPath)));
  const result = await calculateSessionCost(session, sealed.scriptPath);
  assert.equal(result.totalCost.status, "calculated");
  assert.equal(result.totalCost.missingPriceModels.includes("unknown/unknown"), false);
  assert.deepEqual(result.extensionCosts[0].models, ["CPA GPT/gpt-5.6-luna"]);
  assert.equal(result.extensionCosts[0].historicalIncomplete, true);
  assert.equal(result.extensionCosts[0].historicalEstimated, true);
  assert.equal(result.extensionCosts[0].usage, null);
  assert.ok(Math.abs(result.extensionCosts[0].amount - (historical.cost.total + modern.reduce((sum, row) => sum + row.cost.total, 0))) < 1e-12);
  assert.equal(result.totalCost.usage.totalTokens, 2090);

  const untimedId = "suggester-legacy-no-time", untimed = join(sealed.root, "case-suggester", "untimed.jsonl");
  await writeJsonl(untimed, [{ type: "session", id: untimedId, cwd }]);
  const untimedBoundary = baseline(untimedId, 1, 100, 10, "pi-prompt-suggester", suggesterLocator);
  const untimedDir = journalDir(untimedId); await mkdir(untimedDir, { recursive: true });
  await writeFile(join(untimedDir, "pi-prompt-suggester.legacy.json"), JSON.stringify(untimedBoundary));
  await legacyFile(cwd, untimedId, stats(1, 100, 10), stats(), suggesterLocator.directory);
  const noTimestamp = await calculateSessionCost(untimed, sealed.scriptPath);
  assert.equal(noTimestamp.totalCost.status, "unavailable");
  assert.deepEqual(noTimestamp.totalCost.missingPriceModels, []);
  assert.equal(noTimestamp.totalCost.pendingUsageCount, 1);

  const missingBaselineId = "suggester-legacy-no-baseline", missingBaselinePath = join(sealed.root, "case-suggester", "no-baseline.jsonl");
  await writeJsonl(missingBaselinePath, [header(missingBaselineId, cwd), { type: "custom", customType: "suggester-usage", timestamp, data: { usage: {} } }]);
  await legacyFile(cwd, missingBaselineId, stats(1, 100, 10), stats(), suggesterLocator.directory);
  const noBaseline = await calculateSessionCost(missingBaselinePath, sealed.scriptPath);
  assert.equal(noBaseline.totalCost.status, "unavailable");
  assert.deepEqual(noBaseline.totalCost.missingPriceModels, []);
  assert.equal(noBaseline.totalCost.pendingUsageCount, 1);
  assert.equal(noBaseline.extensionCosts[0].historicalEstimated, false);
});

test("old sidecars and old custom entries are never priced using the current model", async () => {
  const cwd = join(sealed.root, "project-d"), path = join(sealed.root, "case-d", "session.jsonl"); await mkdir(cwd);
  const id = "parent-d";
  const old = { type: "custom", id: "old", customType: "fixture-old-usage", timestamp, data: { kind: "suggester", usage: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 110, costTotal: 12345 } } };
  await writeJsonl(path, [header(id, cwd), old]); await legacyFile(cwd, id, stats(1, 100, 10));
  const result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "unavailable"); assert.equal(result.totalCost.amount, null);
  assert.equal(result.extensionCosts[0].historicalIncomplete, true);
  assert.ok((await extractReaderUsageRecords(path)).every((record) => record.usage.usageAvailable === false));
});

test("late journal settlement, invalid records and symlinks cannot silently produce zero cost", async () => {
  const cwd = join(sealed.root, "project-e"), path = join(sealed.root, "case-e", "session.jsonl"); await mkdir(cwd);
  const id = "parent-e", row = event("late", tokenUsage(100, 10));
  await writeJsonl(path, [header(id, cwd)]); await journal(id, [{ ...row, status: "started", usage: { usageAvailable: false } }, row]);
  let result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "calculated"); assert.ok(result.totalCost.amount > 0);
  const journalPath = join(journalDir(id), "fixture-extension.jsonl");
  await writeFile(journalPath, `${JSON.stringify(row)}\n{broken\n`);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "partial");
  const badId = "parent-unsafe", badPath = join(sealed.root, "case-e", "unsafe.jsonl");
  await writeJsonl(badPath, [header(badId, cwd)]); await mkdir(journalDir(badId), { recursive: true });
  const target = join(sealed.root, "not-usage.jsonl"); await writeFile(target, "do not read");
  await symlink(target, join(journalDir(badId), "fixture-extension.jsonl"));
  result = await calculateSessionCost(badPath, sealed.scriptPath);
  assert.equal(result.totalCost.status, "unavailable"); assert.equal(await readFile(target, "utf8"), "do not read");
  const hardId = "parent-hardlink", hardPath = join(sealed.root, "case-e", "hardlink.jsonl");
  await writeJsonl(hardPath, [header(hardId, cwd)]); await mkdir(journalDir(hardId), { recursive: true });
  await link(target, join(journalDir(hardId), "fixture-extension.jsonl"));
  result = await calculateSessionCost(hardPath, sealed.scriptPath);
  assert.equal(result.totalCost.status, "unavailable"); assert.equal(await readFile(target, "utf8"), "do not read");
});

test("an orphaned started request stays unpriced until a late settlement is available", async () => {
  const cwd = join(sealed.root, "project-orphaned-start"), path = join(sealed.root, "case-orphaned-start", "session.jsonl"); await mkdir(cwd);
  const id = "orphaned-start", settled = event("orphaned-call", tokenUsage(100, 10));
  const started = { ...settled, status: "started", usage: { usageAvailable: false } };
  await writeJsonl(path, [header(id, cwd)]);
  await journal(id, [started]);
  let result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "unavailable");
  assert.equal(result.totalCost.amount, null);
  assert.equal(result.pendingUsageCount, 1);
  await journal(id, [started, settled]);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "calculated");
  assert.ok(result.totalCost.amount > 0);
  assert.equal(result.pendingUsageCount, 0);
});

test("suggester unknown stays in the ledger while its recorded-cost presentation is quiet", async () => {
  const cwd = join(sealed.root, "project-quiet-suggester"), path = join(sealed.root, "case-quiet-suggester", "session.jsonl"); await mkdir(cwd);
  const id = "quiet-suggester", dir = journalDir(id);
  const settled = event("quiet-call", tokenUsage(100, 10), { extensionId: "pi-prompt-suggester" });
  const started = { ...settled, status: "started", usage: { usageAvailable: false } };
  const main = { type: "message", id: "main", timestamp, message: { role: "assistant", provider: "openai", model: "gpt-5.6-sol", usage: tokenUsage(100, 10) } };
  await writeJsonl(path, [header(id, cwd), main]);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-prompt-suggester.legacy.json"), JSON.stringify(baseline(id, 0, 0, 0, "pi-prompt-suggester", suggesterLocator)));
  const journalPath = join(dir, "pi-prompt-suggester.jsonl");
  await writeJsonl(journalPath, [started]);
  const originalJournal = await readFile(journalPath, "utf8");
  let result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "partial");
  assert.equal(result.pendingUsageCount, 1, "the API retains the incomplete event");
  assert.deepEqual(sessionCostPresentation(result.totalCost, result.extensionCosts), {
    pendingUsageCount: 0, recordedOnly: true, onlySuggesterPending: true,
  });
  assert.equal(await readFile(journalPath, "utf8"), originalJournal);
  const beforeAmount = result.totalCost.amount;
  await writeJsonl(journalPath, [started, settled]);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.pendingUsageCount, 0);
  assert.ok(result.totalCost.amount > beforeAmount);
  assert.equal((await extractReaderUsageRecords(path)).filter((record) => record.extensionId === "pi-prompt-suggester").length, 1);
  assert.equal(sessionCostPresentation(result.totalCost, result.extensionCosts).recordedOnly, false);
});

test("shutdown-unknown usage stays pending and a late settlement replaces it without double counting", async () => {
  const cwd = join(sealed.root, "project-shutdown"), path = join(sealed.root, "case-shutdown", "session.jsonl"); await mkdir(cwd);
  const id = "parent-shutdown", settled = event("shutdown-call", tokenUsage(100, 10));
  const started = { ...settled, status: "started", usage: { usageAvailable: false } };
  const unknown = { ...started, status: "unknown", reason: "shutdown" };
  let records, result;
  for (const reason of ["shutdown", "aborted", "request_failed"]) {
    const unresolved = { ...unknown, reason };
    await writeJsonl(path, [header(id, cwd), custom(unresolved)]);
    await journal(id, [started, unresolved]);
    records = await extractReaderUsageRecords(path);
    assert.equal(records.length, 1);
    assert.equal(records[0].usage.usageAvailable, false);
    result = await calculateSessionCost(path, sealed.scriptPath);
    assert.equal(result.pendingUsageCount, 1);
    assert.equal(result.totalCost.amount, null);
  }

  await journal(id, [started, unknown, settled]);
  records = await extractReaderUsageRecords(path);
  assert.equal(records.length, 1);
  assert.equal(records[0].usage.usageAvailable, true);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.pendingUsageCount, 0);
  assert.equal(result.totalCost.status, "calculated");
  assert.ok(result.totalCost.amount > 0);

  await journal(id, [started, settled, unknown]);
  records = await extractReaderUsageRecords(path);
  assert.equal(records.length, 1);
  assert.equal(records[0].usage.usageAvailable, true);

  await journal(id, [started, unknown, { ...started, status: "not_sent" }]);
  assert.deepEqual(await extractReaderUsageRecords(path), []);

  const child = join(sealed.root, "case-shutdown", "session", "run", "child.jsonl");
  await writeJsonl(child, [header("child-shutdown", cwd), custom(settled)]);
  await journal(id, [started, unknown]);
  result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.pendingUsageCount, 0);
  assert.equal(result.totalCost.status, "calculated");
  assert.equal(result.totalCost.usage.totalTokens, settled.usage.totalTokens);
});

test("conflicting settled and not-sent events remain incomplete in either order", async () => {
  const cwd = join(sealed.root, "project-terminal-conflict"), path = join(sealed.root, "case-terminal-conflict", "session.jsonl"); await mkdir(cwd);
  const id = "parent-terminal-conflict", settled = event("conflict", tokenUsage(100, 10));
  const notSent = { ...settled, status: "not_sent", usage: { usageAvailable: false } };
  await writeJsonl(path, [header(id, cwd)]);
  for (const events of [[settled, notSent], [notSent, settled]]) {
    await journal(id, events);
    const result = await calculateSessionCost(path, sealed.scriptPath);
    assert.equal(result.totalCost.status, "partial");
    assert.ok(result.totalCost.amount > 0);
    assert.equal(result.pendingUsageCount, 1);
  }
});

test("an oversized header disables the revision cache instead of hiding later extension usage", async () => {
  const cwd = join(sealed.root, "project-f"), path = join(sealed.root, "case-f", "session.jsonl"); await mkdir(cwd);
  const id = "parent-f";
  await writeJsonl(path, [{ ...header(id, cwd), padding: "x".repeat(17000) }]);
  const first = await sessionCostRevision(path), second = await sessionCostRevision(path);
  assert.notEqual(first, second);
  await journal(id, [event("later", tokenUsage(100, 10))]);
  const result = await calculateSessionCost(path, sealed.scriptPath);
  assert.equal(result.totalCost.status, "calculated"); assert.ok(result.totalCost.amount > 0);
});

test("zero-token calls do not trigger historical accounting or generate unknown records", async () => {
  const cwd = join(sealed.root, "project-zero"), sessionPath = join(sealed.root, "case-zero", "session.jsonl"); await mkdir(cwd);
  const id = "suggester-zero-calls";
  const boundary = baseline(id, 0, 0, 0, "pi-prompt-suggester", suggesterLocator);
  const dir = journalDir(id); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "pi-prompt-suggester.legacy.json"), JSON.stringify(boundary));
  await legacyFile(cwd, id, stats(5, 0, 0), stats(), suggesterLocator.directory);
  await writeJsonl(sessionPath, [header(id, cwd)]);

  const result = await calculateSessionCost(sessionPath, sealed.scriptPath);
  assert.equal(result.totalCost.missingPriceModels.includes("unknown/unknown"), false);
  assert.equal(result.totalCost.models.includes("unknown/unknown"), false);
  assert.equal(result.parentCost.models.includes("unknown/unknown"), false);
  const suggester = result.extensionCosts.find((c) => c.id === "pi-prompt-suggester");
  if (suggester) {
    assert.equal(suggester.historicalIncomplete, false);
    assert.equal(suggester.models.includes("unknown/unknown"), false);
  }
});
