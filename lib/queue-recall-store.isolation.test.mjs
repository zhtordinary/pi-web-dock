import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createJiti } from "jiti";
import { createSealedPublicInputEnvironment } from "../test-support/sealed-public-inputs.mjs";
const environment = await createSealedPublicInputEnvironment("queue-recall-isolation");
const jiti = createJiti(import.meta.url, { interopDefault: true, tsconfigPaths: true });
const store = await jiti.import("./queue-recall-store.ts");
const route = await jiti.import("../app/api/sessions/[id]/queue-recovery/route.ts");
test.after(() => environment.restore());
function root(t) {
  const previous = process.env.PI_WEB_QUEUE_RECALL_ROOT;
  const path = mkdtempSync(join(environment.root, "store-"));
  process.env.PI_WEB_QUEUE_RECALL_ROOT = path;
  t.after(() => { if (previous === undefined) delete process.env.PI_WEB_QUEUE_RECALL_ROOT; else process.env.PI_WEB_QUEUE_RECALL_ROOT = previous; });
  return path;
}
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? files(join(directory, entry.name)) : entry.name.endsWith(".json") ? [join(directory, entry.name)] : []);
}
function capture(sessionId, operationId = crypto.randomUUID()) {
  const expected = { bootId: `boot-${sessionId}`, queueRevision: 1 };
  const queue = { ...expected, steering: [{ itemId: "image", role: "user", text: `draft-${sessionId}`, hasImages: true, imageCount: 1, images: [{ data: "AAAA", mimeType: "image/png" }] }], followUp: [] };
  store.prepareQueueRecall(sessionId, operationId, expected, queue);
  store.commitQueueRecall(sessionId, operationId, expected, { clearedQueue: queue, queueSnapshot: { ...expected, queueRevision: 2, steering: [], followUp: [] }, steering: [], followUp: [] });
  return { operationId, expected };
}
async function list(sessionId) {
  return route.GET(new Request(`http://localhost/api/sessions/${sessionId}/queue-recovery`, { headers: { host: "localhost" } }), { params: Promise.resolve({ id: sessionId }) });
}

test("a corrupted A record cannot block B discovery or B's next recoverable clear", async t => {
  const directory = root(t);
  const a = capture("A"), b = capture("B");
  const aPath = files(directory).find(path => JSON.parse(readFileSync(path, "utf8")).operationId === a.operationId);
  writeFileSync(aPath, "{truncated payload");
  const response = await list("B");
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.recoveries.map(entry => entry.operationId), [b.operationId]);
  assert.deepEqual(body.warnings, []);
  assert.doesNotThrow(() => capture("B", "next-clear"));
  const corrupt = await (await list("A")).json();
  assert.equal(corrupt.recoveries.length, 0);
  assert.equal(corrupt.warnings.length, 1, "corruption must not be reported as an ordinary empty inbox");
  assert.equal(readFileSync(aPath, "utf8"), "{truncated payload", "preserve damaged evidence for repair");
});

test("unattributable corrupt legacy files produce an explicit warning alongside healthy session copies", async t => {
  const directory = root(t);
  const b = capture("B");
  const legacy = join(directory, "f".repeat(64) + ".json");
  writeFileSync(legacy, "{legacy bytes without readable ownership");
  const body = await (await list("B")).json();
  assert.deepEqual(body.recoveries.map(entry => entry.operationId), [b.operationId]);
  assert.match(body.warnings[0], /legacy.*session/i);
  const absent = await (await list("no-records")).json();
  assert.equal(absent.recoveries.length, 0);
  assert.equal(absent.warnings.length, 1);
  assert.equal(readFileSync(legacy, "utf8"), "{legacy bytes without readable ownership");
});

test("valid legacy records remain readable and retain their anti-replay tombstone after acknowledgement", async t => {
  const directory = root(t);
  const a = capture("legacy-A");
  const current = files(directory).find(path => JSON.parse(readFileSync(path, "utf8")).operationId === a.operationId);
  const name = createHash("sha256").update(JSON.stringify(["legacy-A", a.operationId])).digest("hex") + ".json";
  const legacy = join(directory, name);
  // Emulate a pre-upgrade flat record, without depending on the new layout.
  const { renameSync } = await import("node:fs");
  if (current !== legacy) renameSync(current, legacy);
  const body = await (await list("legacy-A")).json();
  assert.equal(body.recoveries[0].operationId, a.operationId);
  assert.deepEqual(body.warnings, []);
  assert.equal(store.readQueueRecoveryCopy("legacy-A", a.operationId).queue.steering[0].images[0].data, "AAAA");
  await store.confirmQueueRecoveryCopySaved("legacy-A", a.operationId, a.expected);
  assert.equal(JSON.parse(readFileSync(legacy, "utf8")).status, "acknowledged");
  assert.throws(() => store.readQueueRecallResult("legacy-A", a.operationId, a.expected), { code: "queue_recall_acknowledged" });
});


test("a corrupt reservation number cannot consume the capacity budget of every other session", t => {
  const directory = root(t);
  capture("A");
  const path = files(directory)[0];
  const saved = JSON.parse(readFileSync(path, "utf8"));
  saved.reservedBytes = Number.MAX_SAFE_INTEGER;
  writeFileSync(path, JSON.stringify(saved));
  assert.doesNotThrow(() => capture("B"));
  assert.equal(JSON.parse(readFileSync(path, "utf8")).reservedBytes, Number.MAX_SAFE_INTEGER, "capacity accounting does not overwrite damaged evidence");
});
