import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";

const execFileAsync = promisify(execFile);
const worker = fileURLToPath(new URL("./session-info-performance-worker.mjs", import.meta.url));

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

async function runWorker(mode, sessionId, sessionFile, script, marker) {
  const { stdout } = await execFileAsync(process.execPath, [worker, mode, sessionId, sessionFile, script, marker], { timeout: 120_000 });
  return JSON.parse(stdout);
}

function inputIdentity(file, script, replacements, extra) {
  const hash = createHash("sha256");
  return Promise.all([readFile(file, "utf8"), readFile(script, "utf8")]).then(([session, pricing]) => {
    const normalize = (value) => replacements.reduce((text, [from, to]) => text.split(from).join(to), value);
    hash.update(normalize(session)).update(normalize(pricing)).update(extra);
    return hash.digest("hex");
  });
}

async function makeSession(root, id, count) {
  const file = join(root, `${id}.jsonl`);
  const rows = [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: "/tmp/pi-reader-performance-project" },
    { type: "model_change", id: `${id}-model`, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", provider: "openai", modelId: "gpt-5.5" },
  ];
  let parentId = `${id}-model`;
  for (let index = 0; index < count; index += 1) {
    const entryId = `${id}-assistant-${index}`;
    rows.push({
      type: "message",
      id: entryId,
      parentId,
      timestamp: new Date(1_735_689_600_000 + index * 1000).toISOString(),
      message: {
        role: "assistant",
        provider: "openai",
        model: "gpt-5.5",
        content: [{ type: "text", text: "synthetic" }],
        usage: { input: index + 1, output: 2, cacheRead: 0, cacheWrite: 0, totalTokens: index + 3 },
      },
    });
    parentId = entryId;
  }
  await writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n", "utf8");
  return file;
}

test("records reproducible cold, hot, and concurrent session-cost measurements", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-session-info-benchmark-"));
  const marker = join(root, "python-starts.log");
  const script = join(root, "pricing-wrapper.py");
  const sealed = await createSealedPublicInputEnvironment("session-info-performance");
  t.after(() => sealed.restore());
  try {
    await writeFile(script, [
      "import importlib.util",
      `spec = importlib.util.spec_from_file_location("shared_session_cost", ${JSON.stringify(sealed.scriptPath)})`,
      "shared = importlib.util.module_from_spec(spec)",
      "spec.loader.exec_module(shared)",
      `open(${JSON.stringify(marker)}, "a", encoding="utf-8").write("start\\n")`,
      "def price_usages(items):",
      "    return shared.price_usages(items)",
    ].join("\n"), "utf8");
    const sessions = {
      short: await makeSession(root, "benchmark-short", 32),
      long: await makeSession(root, "benchmark-long", 1200),
    };
    const identity = await inputIdentity(
      sessions.long,
      script,
      [[root, "<task-temp>"], [sealed.root, "<sealed-public-inputs>"], [sealed.fixtureRoot, "<sealed-public-inputs>"]],
      JSON.stringify(sealed.manifest),
    );
    const environment = {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      python: execFileSync("python3", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
      commit: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
      inputSha256: identity,
      longRecords: 1200,
      pricingScript: "sealed shared public pricing fixture via stdin batch adapter",
      priceManifest: sealed.manifest,
    };
    const measurements = {};
    for (const [name, file] of Object.entries(sessions)) {
      measurements[name] = {};
      for (const mode of ["cold", "hot", "concurrent"]) {
        const samples = [];
        for (let repeat = 0; repeat < 3; repeat += 1) {
          const sample = await runWorker(mode, `benchmark-${name}`, file, script, marker);
          samples.push(sample);
          assert.equal(sample.resultHash, samples[0].resultHash, `${name}/${mode}: result changed across repeats`);
        }
        measurements[name][mode] = {
          samples,
          medianWallMs: median(samples.map((sample) => sample.wallMs)),
          medianPythonStarts: median(samples.map((sample) => sample.pythonStarts)),
          medianRequestCount: median(samples.map((sample) => sample.requestCount)),
          resultHash: samples[0].resultHash,
        };
      }
    }
    const result = { environment, measurements };
    t.diagnostic(JSON.stringify(result));
    const output = process.env.PI_SESSION_INFO_BENCHMARK_OUTPUT;
    if (output) await writeFile(output, JSON.stringify(result, null, 2) + "\n", "utf8");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
