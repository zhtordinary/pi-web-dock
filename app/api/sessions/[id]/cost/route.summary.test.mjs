import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../../../../../test-support/sealed-public-inputs.mjs";

// Exercise the real handler, read cache and shared billing with synthetic files only.
test("summary: eight rotating sessions avoid transcript reads even with the read cache cleared", async (t) => {
  const sealed = await createSealedPublicInputEnvironment("cost-summary");
  const directory = await mkdtemp(join(tmpdir(), "pi-web-cost-summary-"));
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { GET } = await jiti.import("./route.ts");
  const { cacheSessionPath } = await jiti.import("../../../../../lib/session-reader.ts");
  const { invalidateSessionReadCache } = await jiti.import("../../../../../lib/session-read-cache.ts");
  const original = { openSync: fs.openSync, closeSync: fs.closeSync, readSync: fs.readSync, createReadStream: fs.createReadStream, parse: JSON.parse };
  const tracked = new Set();
  let metrics;
  fs.openSync = function (path, ...args) {
    const fd = original.openSync.call(this, path, ...args);
    if (String(path).startsWith(directory + "/")) tracked.add(fd);
    return fd;
  };
  fs.closeSync = function (fd, ...args) {
    tracked.delete(fd);
    return original.closeSync.call(this, fd, ...args);
  };
  fs.readSync = function (fd, ...args) {
    const count = original.readSync.call(this, fd, ...args);
    if (metrics && tracked.has(fd)) metrics.historyBytes += count;
    return count;
  };
  fs.createReadStream = function (path, ...args) {
    const stream = original.createReadStream.call(this, path, ...args);
    if (String(path).startsWith(directory + "/")) stream.on("data", (chunk) => {
      if (metrics) metrics.historyBytes += Buffer.byteLength(chunk);
    });
    return stream;
  };
  JSON.parse = function (value, ...args) {
    if (metrics) {
      metrics.jsonParse += 1;
      if (typeof value === "string" && value.includes('"id":"cost-measure-')) metrics.historyParse += 1;
    }
    return original.parse.call(this, value, ...args);
  };
  syncBuiltinESMExports();
  try {
    const ids = [];
    let fixtureBytes = 0;
    for (let session = 0; session < 8; session++) {
      const id = `cost-measure-${session}`;
      ids.push(id);
      const file = join(directory, `${id}.jsonl`);
      const rows = [{ type: "session", version: 3, id, cwd: directory },
        { type: "model_change", id: `${id}-model`, parentId: null, provider: "openai", modelId: "gpt-5.5" }];
      let parentId = `${id}-model`;
      for (let index = 0; index < 2000; index++) {
        const entryId = `${id}-${index}`;
        rows.push({ type: "message", id: entryId, parentId, message: { role: "user", content: "x".repeat(1024) } });
        parentId = entryId;
      }
      rows.push({ type: "message", id: `${id}-answer`, parentId, timestamp: "2026-08-26T18:00:00.000Z", message: {
        role: "assistant", provider: "openai", model: "gpt-5.5", content: [{ type: "text", text: "done" }],
        usage: { input: 100, output: 10, totalTokens: 110 },
      } });
      const text = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
      fixtureBytes += Buffer.byteLength(text);
      await writeFile(file, text);
      cacheSessionPath(id, file);
    }
    async function measure(label, view, rounds, clearEach = false) {
      invalidateSessionReadCache();
      metrics = { label, requests: rounds * ids.length, historyBytes: 0, historyParse: 0, jsonParse: 0 };
      const start = performance.now();
      const cpu = process.cpuUsage();
      const rssStart = process.memoryUsage().rss;
      let rssPeak = rssStart;
      const responses = [];
      for (let round = 0; round < rounds; round++) for (const id of ids) {
        if (clearEach) invalidateSessionReadCache();
        const response = await GET(new Request(`http://localhost/api/sessions/${id}/cost${view === "summary" ? "?view=summary" : ""}`), { params: Promise.resolve({ id }) });
        assert.equal(response.status, 200);
        responses.push(response);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
      }
      const cpuUsed = process.cpuUsage(cpu);
      const result = { ...metrics, wallMs: Math.round(performance.now() - start), cpuMs: Math.round((cpuUsed.user + cpuUsed.system) / 1000), rssStart, rssPeak };
      metrics = undefined;
      const bodies = await Promise.all(responses.map((response) => response.json()));
      t.diagnostic(JSON.stringify(result));
      assert.deepEqual(bodies.map((body) => body.amount), Array(rounds * ids.length).fill(0.0008), "unchanged canonical prices");
      return { result, bodies };
    }
    t.diagnostic(`synthetic fixture: 8 sessions, 2003 JSONL rows each, ${fixtureBytes} bytes`);
    await measure("cold-summary", "summary", 1);
    const full = await measure("warm-full-4-rounds", "full", 4);
    const summary = await measure("warm-summary-4-rounds", "summary", 4);
    const cleared = await measure("warm-summary-read-cache-cleared-each-request", "summary", 4, true);
    assert.ok(full.result.historyBytes >= fixtureBytes * 4, "control must reproduce four-entry cache thrashing");
    assert.equal(summary.result.historyBytes, 0, "summary must not read transcript on billing-cache hits");
    assert.equal(summary.result.historyParse, 0);
    assert.equal(cleared.result.historyBytes, 0, "not a replacement transcript cache");
    assert.equal(cleared.result.historyParse, 0);
    assert.equal("contextUsage" in summary.bodies[0], false);
    assert.equal("compactionContexts" in summary.bodies[0], false);
    assert.equal("messageCosts" in summary.bodies[0], false);
    assert.equal("imageGenerationCosts" in summary.bodies[0], false);
    assert.equal("compactionCosts" in summary.bodies[0], false);
    assert.ok(full.bodies[0].contextUsage, "default full API remains intact");
  } finally {
    metrics = undefined;
    fs.openSync = original.openSync;
    fs.closeSync = original.closeSync;
    fs.readSync = original.readSync;
    fs.createReadStream = original.createReadStream;
    JSON.parse = original.parse;
    syncBuiltinESMExports();
    invalidateSessionReadCache();
    await rm(directory, { recursive: true, force: true });
    await sealed.restore();
  }
});
