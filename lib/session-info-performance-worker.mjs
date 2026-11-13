import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { createJiti } from "jiti";

const [, , mode, sessionId, sessionFile, scriptPath, markerPath] = process.argv;
if (!["cold", "hot", "concurrent"].includes(mode) || !sessionId || !sessionFile || !scriptPath || !markerPath) {
  throw new Error("usage: worker <cold|hot|concurrent> <sessionId> <sessionFile> <pricing.py> <marker>");
}
process.env.PI_CONVERSATION_COST_SCRIPT = scriptPath;
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { GET } = await jiti.import("../app/api/sessions/[id]/cost/route.ts");
const { cacheSessionPath } = await jiti.import("./session-reader.ts");
cacheSessionPath(sessionId, sessionFile);

async function request() {
  const response = await GET(
    new Request(`http://benchmark/api/sessions/${encodeURIComponent(sessionId)}/cost`),
    { params: Promise.resolve({ id: sessionId }) },
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

async function markerCount() {
  return (await readFile(markerPath, "utf8").catch(() => "")).split("\n").filter(Boolean).length;
}

const before = await markerCount();
let requestCount = 0;
let bodies;
let wallMs;
if (mode === "hot") {
  await request();
  const start = performance.now();
  requestCount = 2;
  bodies = [await request()];
  wallMs = performance.now() - start;
} else {
  const start = performance.now();
  if (mode === "concurrent") {
    requestCount = 8;
    bodies = await Promise.all(Array.from({ length: requestCount }, request));
  } else {
    requestCount = 1;
    bodies = [await request()];
  }
  wallMs = performance.now() - start;
}
const after = await markerCount();
const canonical = bodies.map((body) => ({
  amount: body.amount,
  status: body.status,
  usage: body.usage,
  totalCost: body.totalCost,
  messageCostCount: Object.keys(body.messageCosts ?? {}).length,
}));
const resultHash = createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
process.stdout.write(JSON.stringify({ mode, requestCount, wallMs, pythonStarts: after - before, resultHash, canonical }));
