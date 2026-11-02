// Isolated synthetic read-cache cost/context workload; never resolves user session paths.
// Run on Debian: node --expose-gc lib/session-read-cache.benchmark.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";
import { createJiti } from "jiti";
const require = createRequire(import.meta.url);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, fsCache: false });
const sdk = await import("@earendil-works/pi-coding-agent");
const timing = await jiti.import("./session-timing.ts");
let readBytes = 0;
const instrumentedFs = { ...fs, readSync: (...args) => {
  const count = fs.readSync(...args);
  readBytes += count;
  return count;
} };
const mod = { exports: {} };
new Function("require", "module", "exports", ts.transpileModule(fs.readFileSync(new URL("./session-read-cache.ts", import.meta.url), "utf8"), {
  compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText)(name => name === "node:fs" ? instrumentedFs : name === "@earendil-works/pi-coding-agent" ? sdk : name === "./session-timing" ? timing : require(name), mod, mod.exports);
const { getSessionReadSnapshot: read, getSessionReadAgentContext, getSessionReadBranch, invalidateSessionReadCache } = mod.exports;
const root = fs.mkdtempSync(join(tmpdir(), "reader-cache-benchmark-"));
const stamp = "2026-01-01T00:00:00.000Z";
const files = [];
function row(id, parentId) {
  return JSON.stringify({ type: "message", id, parentId, timestamp: stamp, message: { role: "user", content: "synthetic " + "x".repeat(1024) } }) + "\n";
}
function run(name, count, append) {
  invalidateSessionReadCache();
  global.gc?.();
  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  let parsedRows = 0;
  let parseCpuUs = 0;
  const parse = JSON.parse;
  JSON.parse = (...args) => {
    const start = process.cpuUsage();
    try { return parse(...args); } finally {
      const cpu = process.cpuUsage(start);
      parseCpuUs += cpu.user + cpu.system;
      parsedRows++;
    }
  };
  readBytes = 0;
  const cpuStart = process.cpuUsage();
  const start = performance.now();
  try {
    for (let round = 0; round < 4; round++) {
      for (let index = 0; index < count; index++) {
        if (append && round > 0) fs.appendFileSync(files[index], row(`r${round}`, round === 1 ? "e1999" : `r${round - 1}`));
        const snapshot = read(files[index]);
        getSessionReadAgentContext(snapshot);
        getSessionReadBranch(snapshot);
        heapPeak = Math.max(heapPeak, process.memoryUsage().heapUsed);
      }
    }
  } finally { JSON.parse = parse; }
  const cpu = process.cpuUsage(cpuStart);
  global.gc?.();
  const cacheEntries = globalThis.__piSessionReadCache.size;
  assert.ok(cacheEntries <= 4);
  console.log(JSON.stringify({ name, sessions: count, rounds: 4, fileBytes: fs.statSync(files[0]).size, readBytes, parsedRows, parseCpuUs, cpuUs: cpu.user + cpu.system, elapsedMs: performance.now() - start, heapStart, heapPeak, heapRetained: process.memoryUsage().heapUsed, cacheEntries }));
}
try {
  for (let index = 0; index < 8; index++) {
    const path = join(root, `synthetic-${index}.jsonl`);
    let data = JSON.stringify({ type: "session", version: 3, id: `synthetic-${index}`, cwd: root, timestamp: stamp }) + "\n";
    for (let entry = 0; entry < 2000; entry++) data += row(`e${entry}`, entry === 0 ? null : `e${entry - 1}`);
    fs.writeFileSync(path, data);
    files.push(path);
  }
  run("within-four-unchanged", 4, false);
  run("eight-session-cost-read-rotation", 8, false);
  run("within-four-append", 4, true);
} finally {
  invalidateSessionReadCache();
  fs.rmSync(root, { recursive: true, force: true });
}
