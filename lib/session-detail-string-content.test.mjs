import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() }, moduleCache: false });
const reader = await jiti.import("./session-reader.ts");
const readCache = await jiti.import("./session-read-cache.ts");
const { computeSessionStats } = await jiti.import("./session-stats.ts");
const { projectTreeForResponse } = await jiti.import("./project-tree.ts");
const { loadSessionTiming } = await jiti.import("./session-timing.server.ts");

// Older or third-party session files can store message content as a plain
// string. The session detail view must still open them (upstream Pi Web does).
test("session detail processing tolerates plain-string message content", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "pi-web-string-content-"));
  t.after(() => { readCache.invalidateSessionReadCache(); rmSync(root, { recursive: true, force: true }); });
  const timestamp = "2026-08-23T00:00:00.000Z";
  const message = (id, parentId, role, content) => ({ type: "message", id, parentId, timestamp, message: { role, content } });
  const entries = Array.from({ length: 120 }, (_, i) => message(`e${i}`, i ? `e${i - 1}` : null, i % 2 ? "assistant" : "user", `message ${i}`));
  const path = join(root, "session.jsonl");
  writeFileSync(path, [{ type: "session", version: 3, id: "string-content", timestamp, cwd: root }, ...entries]
    .map((entry) => JSON.stringify(entry)).join("\n") + "\n");

  const snapshot = readCache.getSessionReadSnapshot(path);
  const tree = projectTreeForResponse(readCache.getSessionReadTree(snapshot));
  const context = reader.buildSessionContext(snapshot.entries, snapshot.leafId, {
    deferThinking: true, deferToolResultImages: true, deferToolResultText: false, tail: 50, sessionId: "string-content",
  });
  const stats = computeSessionStats(snapshot.entries);
  const history = reader.buildSessionHistoryInfo(snapshot.entries, snapshot.leafId, context);
  reader.getQuestionAnalysisJobsForBranch(snapshot.entries, snapshot.leafId);
  reader.getQuestionDraftViewsForBranch(snapshot.entries, snapshot.leafId);
  await loadSessionTiming({ filePath: path, header: snapshot.header,
    branch: reader.getSessionBranchEntries(snapshot.entries, snapshot.leafId), entries: snapshot.entries });

  assert.ok(tree);
  assert.equal(context.messages.length, 50);
  assert.equal(context.hasMore, true);
  assert.equal(stats.assistantMessages, 60);
  assert.equal(stats.toolCalls, 0);
  assert.ok(history);
});
