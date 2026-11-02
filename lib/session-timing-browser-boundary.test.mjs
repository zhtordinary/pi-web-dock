import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const root = dirname(new URL(import.meta.url).pathname);
const clientEntry = join(root, "session-timing.ts");
const serverEntry = join(root, "session-timing.server.ts");

function imports(source) {
  return [...source.matchAll(/(?:from|import\s*\()\s*["']([^"']+)["']/g)].map((match) => match[1]);
}

async function assertBrowserSafe(entry, seen = new Set()) {
  if (seen.has(entry)) return;
  seen.add(entry);
  const source = await readFile(entry, "utf8");
  for (const specifier of imports(source)) {
    assert.ok(!specifier.startsWith("node:"), `${entry} imports Node builtin ${specifier}`);
    if (!specifier.startsWith(".")) continue;
    const target = join(dirname(entry), specifier);
    const resolved = target.endsWith(".ts") || target.endsWith(".tsx") || target.endsWith(".mjs") ? target : `${target}.ts`;
    await assertBrowserSafe(resolved, seen);
  }
}

const base = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(base + ms).toISOString();
const line = (value) => JSON.stringify(value);
const message = (id, parentId, at, body) => line({ type: "message", id, parentId, timestamp: iso(at), message: body });
const userBody = (at) => ({ role: "user", content: "task", timestamp: base + at });
const answerBody = (start, duration) => ({ role: "assistant", content: [{ type: "text", text: "done" }], timestamp: base + start, durationMs: duration, stopReason: "stop" });

async function writeSession(path, rows) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, rows.join("\n") + "\n");
}

test("client timing import closure excludes filesystem loaders", async () => {
  await assertBrowserSafe(clientEntry);
  const clientSource = await readFile(clientEntry, "utf8");
  const serverSource = await readFile(serverEntry, "utf8");
  assert.doesNotMatch(clientSource, /node:fs\/promises/);
  assert.match(serverSource, /node:fs\/promises/);
  assert.match(serverSource, /export async function loadSessionTiming/);
});

test("links pi-subagents runs on the viewed branch and fills a gone record from its completion notice", async () => {
  const directory = await mkdtemp(join(root, "timing-subagents-"));
  try {
    const parent = join(directory, "parent.jsonl");
    await writeFile(parent, line({ type: "session", id: "parent" }) + "\n");
    const linked = join(directory, "parent", "r-linked", "run-0", "session.jsonl");
    await writeSession(linked, [
      line({ type: "session", id: "child-linked", parentSession: parent, timestamp: iso(1_000) }),
      message("cu", null, 1_000, userBody(1_000)),
      message("ca", "cu", 9_000, answerBody(1_000, 8_000)),
    ]);
    // An async run's session sits under a directory other than its run id; only the notice names it.
    const asyncRun = join(directory, "parent", "d-async", "run-0", "session.jsonl");
    await writeSession(asyncRun, [
      line({ type: "session", id: "child-async", parentSession: parent, timestamp: iso(1_100) }),
      message("su", null, 1_100, userBody(1_100)),
      message("sa", "su", 5_100, answerBody(1_100, 4_000)),
    ]);
    // Started during another branch's turn, so it is outside the viewed branch's timing.
    await writeSession(join(directory, "parent", "r-other", "run-0", "session.jsonl"), [
      line({ type: "session", id: "child-other", parentSession: parent, timestamp: iso(40_000) }),
      message("ou", null, 40_000, userBody(40_000)),
      message("oa", "ou", 42_000, answerBody(40_000, 2_000)),
    ]);
    const branch = [
      { type: "message", id: "pu", parentId: null, timestamp: iso(0), message: userBody(0) },
      { type: "message", id: "pa1", parentId: "pu", timestamp: iso(1_000), message: { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "subagent", arguments: {} }, { type: "toolCall", id: "s2", name: "subagent", arguments: {} }], timestamp: base, durationMs: 1_000, stopReason: "toolUse" } },
      { type: "message", id: "pt2", parentId: "pa1", timestamp: iso(1_100), message: { role: "toolResult", toolCallId: "s2", toolName: "subagent", content: [], timestamp: base + 1_100, durationMs: 100, details: { mode: "single", runId: "r-async", asyncId: "r-async", results: [] } } },
      { type: "message", id: "pt1", parentId: "pt2", timestamp: iso(10_000), message: { role: "toolResult", toolCallId: "s1", toolName: "subagent", content: [], timestamp: base + 10_000, durationMs: 9_000, details: { mode: "single", runId: "r-linked", results: [{ sessionFile: linked }] } } },
      { type: "message", id: "pa2", parentId: "pt1", timestamp: iso(11_000), message: answerBody(10_000, 1_000) },
      { type: "custom_message", id: "pn", parentId: "pa2", timestamp: iso(20_000), customType: "subagent-notify", content: "", display: false, details: { runs: [
        { runId: "r-async", status: "completed", durationMs: 4_000, sessionValue: asyncRun },
        { runId: "r-gone", status: "completed", durationMs: 5_000 },
      ] } },
    ];
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const { loadSessionTiming } = await jiti.import("./session-timing.server.ts");
    const timing = await loadSessionTiming({ filePath: parent, header: { timestamp: iso(0) }, branch });
    assert.deepEqual(timing.children, { count: 3, agentTotalMs: 17_000, modelResponseMs: 12_000, missingRecords: 1 });
    assert.deepEqual(timing.parent, { agentTotalMs: 3_000, modelResponseMs: 2_000 });
    assert.equal(timing.effectiveMs, 16_000);
    assert.equal(timing.agentTotalMs, 20_000);
    assert.equal(timing.modelResponseMs, 14_000);
    assert.equal(timing.quality, "partial");
    assert.equal(timing.scope, "session");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("attributes an older pi-subagents record by when it started", async () => {
  const directory = await mkdtemp(join(root, "timing-legacy-"));
  try {
    const parent = join(directory, "parent.jsonl");
    await writeFile(parent, line({ type: "session", id: "parent" }) + "\n");
    await writeSession(join(directory, "parent", "d-legacy", "run-0", "session.jsonl"), [
      line({ type: "session", id: "child-legacy" }),
      message("lu", null, 2_000, userBody(2_000)),
      message("la", "lu", 6_000, answerBody(2_000, 4_000)),
    ]);
    const branch = [
      { type: "message", id: "pu", parentId: null, timestamp: iso(0), message: userBody(0) },
      { type: "message", id: "pa1", parentId: "pu", timestamp: iso(1_000), message: { role: "assistant", content: [{ type: "toolCall", id: "s1", name: "subagent", arguments: {} }], timestamp: base, durationMs: 1_000, stopReason: "toolUse" } },
      { type: "message", id: "pt", parentId: "pa1", timestamp: iso(1_100), message: { role: "toolResult", toolCallId: "s1", toolName: "subagent", content: [], timestamp: base + 1_100, durationMs: 100, details: { mode: "single", runId: "r-legacy", asyncId: "r-legacy" } } },
      { type: "message", id: "pa2", parentId: "pt", timestamp: iso(2_200), message: answerBody(1_200, 1_000) },
      { type: "custom_message", id: "pn", parentId: "pa2", timestamp: iso(7_000), customType: "subagent-notify", content: "", display: false },
      { type: "message", id: "pa3", parentId: "pn", timestamp: iso(8_000), message: answerBody(7_000, 1_000) },
    ];
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const { loadSessionTiming } = await jiti.import("./session-timing.server.ts");
    const timing = await loadSessionTiming({ filePath: parent, header: null, branch });
    // The record settles the turn's unidentified launch; its attribution is inferred, so timing stays partial.
    assert.deepEqual(timing.children, { count: 1, agentTotalMs: 4_000, modelResponseMs: 4_000, missingRecords: 0 });
    assert.equal(timing.quality, "partial");
    assert.deepEqual(timing.turns.map((turn) => turn.agentTotalMs), [3_200 + 4_000]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("links Reader Agent children by the session id on the viewed branch and propagates malformed records", async () => {
  const directory = await mkdtemp(join(root, "timing-agent-"));
  try {
    const parent = join(directory, "parent.jsonl");
    await writeFile(parent, line({ type: "session", id: "parent" }) + "\n");
    // Started from a tool call on another branch, during that branch's own turn.
    await writeSession(join(directory, "parent", "a", "session.jsonl"), [
      line({ type: "session", id: "child-a" }),
      line({ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentToolCallId: "call-a" }, id: "meta-a", parentId: null, timestamp: iso(40_000) }),
      message("a-u", "meta-a", 41_000, userBody(41_000)),
      message("a-a", "a-u", 43_000, answerBody(41_000, 2_000)),
    ]);
    await writeSession(join(directory, "parent", "b", "session.jsonl"), [
      line({ type: "session", id: "child-b" }),
      line({ type: "custom", customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentToolCallId: "call-b" }, id: "meta-b", parentId: null, timestamp: iso(1_000) }),
      "malformed",
      message("b-u", "meta-b", 2_000, userBody(2_000)),
      message("b-a", "b-u", 5_000, answerBody(2_000, 3_000)),
    ]);
    const branch = [
      { type: "message", id: "pu", parentId: null, timestamp: iso(0), message: userBody(0) },
      { type: "message", id: "pa1", parentId: "pu", timestamp: iso(1_000), message: { role: "assistant", content: [{ type: "toolCall", id: "call-b", name: "Agent", arguments: {} }], timestamp: base, durationMs: 1_000, stopReason: "toolUse" } },
      { type: "message", id: "pt", parentId: "pa1", timestamp: iso(6_000), message: { role: "toolResult", toolCallId: "call-b", toolName: "Agent", content: [], timestamp: base + 6_000, durationMs: 5_000, details: { kind: "pi-web-subagent", sessionId: "child-b", status: "completed", runInBackground: false, createdAt: iso(1_000), completedAt: iso(6_000) } } },
      { type: "message", id: "pa2", parentId: "pt", timestamp: iso(7_000), message: answerBody(6_000, 1_000) },
    ];
    const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
    const { loadSessionTiming } = await jiti.import("./session-timing.server.ts");
    const timing = await loadSessionTiming({ filePath: parent, header: null, branch });
    assert.deepEqual(timing.children, { count: 1, agentTotalMs: 3_000, modelResponseMs: 3_000, missingRecords: 0 });
    assert.deepEqual(timing.parent, { agentTotalMs: 4_000, modelResponseMs: 2_000 });
    assert.equal(timing.agentTotalMs, 7_000);
    assert.equal(timing.quality, "partial");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
