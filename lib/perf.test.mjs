import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const perfUrl = pathToFileURL(fileURLToPath(new URL("./perf.ts", import.meta.url))).href;

function runPerf(envValue, body) {
  const env = { ...process.env };
  if (envValue === undefined) delete env.PI_WEB_PERF;
  else env.PI_WEB_PERF = envValue;
  const script = `
    const mod = await import(${JSON.stringify(perfUrl)});
    ${body}
  `;
  return execFileSync(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", script],
    { env, encoding: "utf8" },
  );
}

test("disabled diagnostics are a no-op", () => {
  const output = runPerf(undefined, `
    console.log(mod.isServerPerfEnabled() ? "enabled" : "disabled");
    console.log(mod.startServerPerf("GET /api/session-runs") === undefined ? "undefined" : "defined");
  `);
  assert.deepEqual(output.trim().split("\n"), ["disabled", "undefined"]);
});

test("enabled diagnostics expose coarse memory fields and preserve response", () => {
  const output = runPerf("1", `
    const perf = mod.startServerPerf("GET /api/session-runs");
    perf.span("local");
    const response = perf.attach(new Response("payload", {
      status: 207,
      headers: { "Cache-Control": "no-store" },
    }));
    console.log(JSON.stringify({
      status: response.status,
      body: await response.text(),
      cacheControl: response.headers.get("Cache-Control"),
      serverTiming: response.headers.get("Server-Timing"),
    }));
  `);
  const lines = output.trim().split("\n");
  const result = JSON.parse(lines.at(-1));
  const log = JSON.parse(lines.at(-2));
  assert.deepEqual(result, {
    status: 207,
    body: "payload",
    cacheControl: "no-store",
    serverTiming: result.serverTiming,
  });
  assert.match(result.serverTiming, /local;dur=/);
  assert.match(result.serverTiming, /total;dur=/);
  assert.equal(log.perf, true);
  assert.equal(log.route, "GET /api/session-runs");
  assert.match(log.requestId, /^[a-f0-9]{8}$/);
  assert.equal(typeof log.totalMs, "number");
  assert.equal(typeof log.phases.local, "number");
  for (const field of [
    "rssStartMiB",
    "rssEndMiB",
    "rssDeltaMiB",
    "heapUsedStartMiB",
    "heapUsedEndMiB",
    "heapUsedDeltaMiB",
  ]) {
    assert.equal(typeof log[field], "number", field);
  }
  assert.doesNotMatch(JSON.stringify(log), /payload|node_modules|\/home\//);
});
