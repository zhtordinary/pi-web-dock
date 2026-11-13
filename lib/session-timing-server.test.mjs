import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const { loadSessionTiming } = await createJiti(import.meta.url, { tsconfigPaths: true }).import("./session-timing.server.ts");
const base = Date.parse("2026-01-01T00:00:00.000Z");
const iso = (ms) => new Date(base + ms).toISOString();
const entry = (id, parentId, at, message) => ({ type: "message", id, parentId, timestamp: iso(at), message });
const user = (id, parentId, at) => entry(id, parentId, at, { role: "user", content: "task", timestamp: base + at });
const answer = (id, parentId, at, duration = 1_000) => entry(id, parentId, at + duration, {
  role: "assistant", content: [{ type: "text", text: "done" }], timestamp: base + at, durationMs: duration, stopReason: "stop",
});
const calls = (id, parentId, at, blocks) => entry(id, parentId, at + 1_000, {
  role: "assistant", content: blocks.map(({ id: callId, name = "subagent", arguments: args = {} }) => ({ type: "toolCall", id: callId, name, arguments: args })),
  timestamp: base + at, durationMs: 1_000, stopReason: "toolUse",
});
const result = (id, parentId, at, callId, name, details, duration = 100) => entry(id, parentId, at, {
  role: "toolResult", toolCallId: callId, toolName: name, content: [], timestamp: base + at, durationMs: duration, details,
});

async function fixture(t) {
  const directory = await mkdtemp(join(dirname(new URL(import.meta.url).pathname), "timing-server-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const filePath = join(directory, "parent.jsonl");
  await writeFile(filePath, JSON.stringify({ type: "session", id: "parent" }) + "\n");
  return { directory, filePath };
}

async function child(directory, name, id, entries, metadata) {
  const path = join(directory, "parent", name, "run-0", "session.jsonl");
  await mkdir(dirname(path), { recursive: true });
  const rows = [{ type: "session", id, timestamp: iso(0) }, ...(metadata ? [metadata] : []), ...entries];
  await writeFile(path, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return path;
}

test("follows nested child references beyond eight levels without losing parentage", async (t) => {
  const { directory, filePath } = await fixture(t);
  for (let index = 1; index <= 9; index += 1) {
    const at = 2_000 + (index - 1) * 4_000;
    const entries = index === 9
      ? [user(`u${index}`, null, at), answer(`a${index}`, `u${index}`, at)]
      : [
          user(`u${index}`, null, at),
          calls(`c${index}`, `u${index}`, at, [{ id: `s${index}` }]),
          result(`r${index}`, `c${index}`, at + 1_100, `s${index}`, "subagent", { runId: `run-${index + 1}` }),
          answer(`a${index}`, `r${index}`, at + 1_100),
        ];
    await child(directory, `run-${index}`, `child-${index}`, entries);
  }
  const branch = [
    user("u0", null, 0), calls("c0", "u0", 0, [{ id: "s0" }]),
    result("r0", "c0", 1_100, "s0", "subagent", { runId: "run-1" }), answer("a0", "r0", 1_100),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 9);
  assert.equal(timing.children.modelResponseMs, 17_000);
  assert.equal(timing.modelResponseMs, 19_000);
  assert.equal(timing.quality, "complete");
});

test("does not attribute another branch's child even when both branches share a user anchor", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "run-other", "other-child", [user("cu", null, 2_000), answer("ca", "cu", 2_000, 3_000)]);
  const shared = user("u", null, 0);
  const viewed = answer("viewed", "u", 0, 20_000);
  const other = [
    calls("other-call", "u", 0, [{ id: "s-other" }]),
    result("other-result", "other-call", 5_100, "s-other", "subagent", { runId: "run-other" }),
    answer("other-answer", "other-result", 5_100),
  ];
  const timing = await loadSessionTiming({ filePath, branch: [shared, viewed], entries: [shared, viewed, ...other] });
  assert.equal(timing.children.count, 0);
  assert.equal(timing.children.modelResponseMs, 0);
  assert.equal(timing.modelResponseMs, 20_000);
  assert.equal(timing.quality, "complete");
});

test("does not borrow a sibling branch's result for a shared tool call", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "other-run", "other-child", [user("cu", null, 2_000), answer("ca", "cu", 2_000)]);
  const shared = [user("u", null, 0), calls("call", "u", 0, [{ id: "shared-call" }])];
  const viewed = [result("view-result", "call", 1_100, "shared-call", "subagent", { runId: "unknown" }),
    answer("view-answer", "view-result", 5_000)];
  const other = [result("other-result", "call", 1_200, "shared-call", "subagent", { runId: "other-run" }),
    answer("other-answer", "other-result", 5_100)];
  const branch = [...shared, ...viewed];
  const timing = await loadSessionTiming({ filePath, branch, entries: [...branch, ...other] });
  assert.equal(timing.children.count, 0);
  assert.equal(timing.children.missingRecords, 1);
  assert.equal(timing.quality, "partial");
});

test("does not guess a legacy child's branch when another branch has an unfinished launch", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "unknown-legacy", "legacy-child", [user("cu", null, 2_000), answer("ca", "cu", 2_000, 3_000)]);
  const shared = user("u", null, 0);
  const branch = [shared, calls("call", "u", 0, [{ id: "current" }]),
    result("result", "call", 1_100, "current", "subagent", { runId: "unknown" }),
    answer("answer", "result", 6_000)];
  const otherCall = calls("other-call", "u", 0, [{ id: "other" }]);
  const timing = await loadSessionTiming({ filePath, branch, entries: [...branch, otherCall] });
  assert.equal(timing.children.count, 0);
  assert.equal(timing.children.missingRecords, 1);
  assert.equal(timing.quality, "partial");
});

test("counts every legacy record of a turn that launched an unidentified run", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "legacy-one", "child-one", [user("cu1", null, 2_000), answer("ca1", "cu1", 2_000)]);
  await child(directory, "legacy-two", "child-two", [user("cu2", null, 2_100), answer("ca2", "cu2", 2_100)]);
  const branch = [user("u", null, 0), calls("c", "u", 0, [{ id: "s" }]),
    result("r", "c", 1_100, "s", "subagent", { runId: "unknown" }), answer("a", "r", 5_000)];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  // Which launch wrote which record is unknown, but both records belong to this turn.
  assert.equal(timing.children.count, 2);
  assert.equal(timing.children.modelResponseMs, 2_000);
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "partial");
});

test("settles each unidentified launch of a turn with one of its legacy records beside management calls", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "dir-a", "child-a", [user("cu1", null, 2_000), answer("ca1", "cu1", 2_000, 3_000)]);
  await child(directory, "dir-b", "child-b", [user("cu2", null, 2_500), answer("ca2", "cu2", 2_500, 2_000)]);
  const branch = [
    user("u", null, 0), calls("c", "u", 0, [{ id: "list", arguments: { action: "list" } }, { id: "s1" }, { id: "s2" }]),
    result("r0", "c", 1_050, "list", "subagent", { mode: "management", results: [] }),
    result("r1", "r0", 1_100, "s1", "subagent", { mode: "single", runId: "gone-a" }),
    result("r2", "r1", 1_200, "s2", "subagent", { mode: "single", runId: "gone-b" }),
    answer("a", "r2", 6_000),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 2);
  assert.equal(timing.children.modelResponseMs, 5_000);
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "partial");
});

test("does not treat management calls that start no run as unconfirmed children", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "linked", "child", [user("cu", null, 2_000), answer("ca", "cu", 2_000, 3_000)]);
  const branch = [
    user("u", null, 0), calls("c", "u", 0, [{ id: "status", arguments: { action: "status" } }, { id: "run" }]),
    result("r0", "c", 1_050, "status", "subagent", { mode: "management", results: [] }),
    result("r1", "r0", 6_000, "run", "subagent", { mode: "single", runId: "linked" }, 5_000),
    answer("a", "r1", 6_000),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 1);
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "complete");
});

test("does not treat a status result with a run id as a child launch", async (t) => {
  const { filePath } = await fixture(t);
  const branch = [
    user("u", null, 0), calls("c", "u", 0, [{ id: "status", arguments: { action: "status" } }]),
    result("r", "c", 1_100, "status", "subagent", { mode: "single", runId: "foreign", results: [] }),
    answer("a", "r", 1_100),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 0);
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "complete");
});

test("loads an archived child and a resumed run from the mirrored session path", async (t) => {
  const root = await mkdtemp(join(dirname(new URL(import.meta.url).pathname), "timing-server-archive-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(root, "agent");
  const parent = join(agentDir, "sessions", "project", "parent.jsonl");
  const activeChild = join(agentDir, "sessions", "project", "parent", "run-1", "run-0", "session.jsonl");
  const archivedChild = join(agentDir, "archived_sessions", "project", "parent", "run-1", "run-0", "session.jsonl");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  try {
    await mkdir(dirname(parent), { recursive: true });
    await mkdir(dirname(archivedChild), { recursive: true });
    await writeFile(parent, JSON.stringify({ type: "session", id: "parent" }) + "\n");
    await writeFile(archivedChild, [
      { type: "session", id: "child", timestamp: iso(0), parentSession: parent },
      user("cu1", null, 2_000), answer("ca1", "cu1", 2_000, 1_000),
      user("cu2", "ca1", 12_000), answer("ca2", "cu2", 12_000, 2_000),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const notification = {
      type: "custom_message", id: "n2", parentId: "r2", timestamp: iso(15_000),
      customType: "subagent-notify", content: "", display: false,
      details: { runs: [{ runId: "run-2", sessionValue: activeChild, durationMs: 2_000 }] },
    };
    const branch = [
      user("u1", null, 0), calls("c1", "u1", 0, [{ id: "s1" }]),
      result("r1", "c1", 1_100, "s1", "subagent", { runId: "run-1" }), answer("a1", "r1", 1_100),
      user("u2", "a1", 10_000), calls("c2", "u2", 10_000, [{ id: "s2" }]),
      result("r2", "c2", 11_100, "s2", "subagent", { runId: "run-2" }), notification,
      answer("a2", "r2", 15_000),
    ];
    const timing = await loadSessionTiming({ filePath: parent, branch, entries: branch });
    assert.equal(timing.children.count, 1);
    assert.equal(timing.children.modelResponseMs, 3_000);
    assert.equal(timing.children.missingRecords, 0);
    assert.equal(timing.quality, "complete");
  } finally {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(root, { recursive: true, force: true });
  }
});

test("follows the replacement run a steering request starts", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "replacement", "child", [user("cu", null, 2_000), answer("ca", "cu", 2_000, 3_000)]);
  const branch = [
    user("u", null, 0), calls("c", "u", 0, [{ id: "steer", arguments: { action: "steer" } }]),
    result("r", "c", 1_100, "steer", "subagent", { mode: "management", results: [], steering: { state: "recovered", replacementRunId: "replacement" } }),
    answer("a", "r", 6_000),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 1);
  assert.equal(timing.children.modelResponseMs, 3_000);
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "complete");
});

test("does not count a failed subagent call without a run as a missing child", async (t) => {
  const { filePath } = await fixture(t);
  const failed = result("r", "c", 1_100, "failed", "subagent", {});
  failed.message.isError = true;
  const branch = [user("u", null, 0), calls("c", "u", 0, [{ id: "failed" }]), failed, answer("a", "r", 1_100)];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.missingRecords, 0);
  assert.equal(timing.quality, "complete");
});

test("keeps a missing identified run distinct from an unrelated legacy child", async (t) => {
  const { directory, filePath } = await fixture(t);
  await child(directory, "unknown-legacy", "legacy-child", [user("cu", null, 2_000), answer("ca", "cu", 2_000, 3_000)]);
  const branch = [
    user("u", null, 0), calls("c", "u", 0, [{ id: "missing" }, { id: "legacy" }]),
    result("r1", "c", 1_100, "missing", "subagent", { runId: "gone" }),
    result("r2", "r1", 1_200, "legacy", "subagent", {}),
    answer("a", "r2", 6_000),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 1);
  assert.equal(timing.children.modelResponseMs, 3_000);
  assert.equal(timing.children.missingRecords, 1);
  assert.equal(timing.quality, "partial");
});

test("uses distinct recorded windows for a missing Reader Agent resumed in a later turn", async (t) => {
  const { filePath } = await fixture(t);
  const first = [
    user("u1", null, 0), calls("c1", "u1", 0, [{ id: "first", name: "Agent" }]),
    result("r1", "c1", 3_000, "first", "Agent", { kind: "pi-web-subagent", sessionId: "gone", createdAt: iso(1_000), completedAt: iso(3_000) }, 2_000),
    answer("a1", "r1", 3_000),
  ];
  const second = [
    user("u2", "a1", 10_000), calls("c2", "u2", 10_000, [{ id: "resume", name: "Agent", arguments: { resume: "gone" } }]),
    result("r2", "c2", 13_000, "resume", "Agent", { kind: "pi-web-subagent", sessionId: "gone", createdAt: iso(1_000), completedAt: iso(13_000) }, 2_000),
    answer("a2", "r2", 13_000),
  ];
  const branch = [...first, ...second];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 1);
  assert.equal(timing.children.missingRecords, 1);
  assert.equal(timing.children.agentTotalMs, 4_000);
  assert.equal(timing.agentTotalMs, 8_000);
  assert.deepEqual(timing.turns.map((turn) => turn.agentTotalMs), [4_000, 4_000]);
  assert.equal(timing.quality, "partial");
});

test("associates background completion windows with the correct missing Reader runs", async (t) => {
  const { filePath } = await fixture(t);
  const notification = (id, parentId, end) => ({
    type: "custom_message", id, parentId, timestamp: iso(end), customType: "pi-web:subagent-notification", content: "", display: false,
    details: { kind: "pi-web-subagent", sessionId: "gone", createdAt: iso(1_000), completedAt: iso(end) },
  });
  const branch = [
    user("u1", null, 0), calls("c1", "u1", 0, [{ id: "first", name: "Agent" }]),
    result("r1", "c1", 1_100, "first", "Agent", { kind: "pi-web-subagent", sessionId: "gone" }),
    answer("a1", "r1", 1_100), notification("n1", "a1", 5_000),
    user("u2", "n1", 10_000), calls("c2", "u2", 10_000, [{ id: "resume", name: "Agent", arguments: { resume: "gone" } }]),
    result("r2", "c2", 11_100, "resume", "Agent", { kind: "pi-web-subagent", sessionId: "gone" }),
    answer("a2", "r2", 11_100), notification("n2", "a2", 15_000),
  ];
  const timing = await loadSessionTiming({ filePath, branch, entries: branch });
  assert.equal(timing.children.count, 1);
  assert.equal(timing.children.missingRecords, 1);
  assert.equal(timing.children.agentTotalMs, 8_000);
  assert.equal(timing.modelResponseMs, 4_000);
  assert.equal(timing.quality, "partial");
});

test("attributes a resumed Reader Agent to each launch and excludes later work from an old leaf", async (t) => {
  const { directory, filePath } = await fixture(t);
  const metadata = { type: "custom", id: "meta", parentId: null, timestamp: iso(1_000), customType: "pi-web:subagent", data: { version: 1, parentSessionId: "parent", parentToolCallId: "first" } };
  await child(directory, "reader", "child", [
    user("cu1", "meta", 2_000), answer("ca1", "cu1", 2_000),
    user("cu2", "ca1", 12_000), answer("ca2", "cu2", 12_000),
  ], metadata);
  const first = [
    user("u1", null, 0), calls("c1", "u1", 0, [{ id: "first", name: "Agent" }]),
    result("r1", "c1", 4_000, "first", "Agent", { kind: "pi-web-subagent", sessionId: "child" }),
    answer("a1", "r1", 4_000),
  ];
  const second = [
    user("u2", "a1", 10_000), calls("c2", "u2", 10_000, [{ id: "resume", name: "Agent", arguments: { resume: "child" } }]),
    result("r2", "c2", 14_000, "resume", "Agent", { kind: "pi-web-subagent", sessionId: "child" }),
    answer("a2", "r2", 14_000),
  ];
  const entries = [...first, ...second];
  const full = await loadSessionTiming({ filePath, branch: entries, entries });
  assert.equal(full.children.count, 1);
  assert.equal(full.children.modelResponseMs, 2_000);
  assert.deepEqual(full.turns.map((turn) => turn.modelResponseMs), [3_000, 3_000]);
  assert.equal(full.quality, "complete");

  const old = await loadSessionTiming({ filePath, branch: first, entries });
  assert.equal(old.children.count, 1);
  assert.equal(old.children.modelResponseMs, 1_000);
  assert.equal(old.modelResponseMs, 3_000);
  assert.equal(old.quality, "complete");
});
