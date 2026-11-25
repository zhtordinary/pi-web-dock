import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { appendFileSync, closeSync, openSync, writeSync } from "node:fs";
import { mkdir, mkdtemp, open, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

test("creation history reads visible project sessions without executing or exposing commands", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-history-")));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, hidden: process.env.PI_WEB_HIDDEN_FILE, cache: process.env.XDG_CACHE_HOME };
  t.after(async () => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.hidden === undefined) delete process.env.PI_WEB_HIDDEN_FILE;
    else process.env.PI_WEB_HIDDEN_FILE = previous.hidden;
    if (previous.cache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous.cache;
    await rm(root, { recursive: true, force: true });
  });
  const agent = path.join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_WEB_HIDDEN_FILE = path.join(root, "hidden-state.json");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  const repo = path.join(root, "repo");
  const linked = path.join(root, "linked");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) {
    await execFileAsync("git", ["-C", repo, "config", key, value]);
  }
  await writeFile(path.join(repo, "README.md"), "test\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "feat/task", linked]);
  const sessionsDir = path.join(agent, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  const marker = path.join(root, "must-not-run");
  async function writeSession(id, structuredBinding = false, command = `git worktree add -b feat/task '${linked}' main; touch '${marker}'`) {
    const entries = [
      { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: repo },
      { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Fixture" }] } },
      { type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }] } },
      { type: "message", id: "result", parentId: "assistant", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 initial\n" }] } },
      ...(structuredBinding ? [{ type: "custom", id: "binding", parentId: "result", timestamp: "2026-01-02T00:00:02.000Z", customType: "pi-web:worktree-binding", data: { version: 1, action: "bind", relation: "task-root", projectRoot: repo, worktreePath: linked } }] : []),
      { type: "session_info", id: "name", parentId: "result", timestamp: "2026-01-02T00:00:03.000Z", name: `Session ${id}` },
    ];
    await writeFile(path.join(sessionsDir, `${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  const printedRevisionCommand = [
    `ROOT='${repo}'`,
    `printf 'baseline %s\\n' "$(git rev-parse origin/reader)"`,
    `git -C "$ROOT" worktree add -b feat/task '${linked}' main`,
    `touch '${marker}'`,
  ].join("\n");
  await writeSession("visible-session", true, printedRevisionCommand);
  await writeSession("hidden-session");
  await writeFile(path.join(sessionsDir, "structured-only.jsonl"), [
    { type: "session", version: 3, id: "structured-only", timestamp: "2026-01-01T00:00:00.000Z", cwd: repo },
    { type: "custom", id: "binding", timestamp: "2026-01-02T00:00:02.000Z", customType: "pi-web:worktree-binding", data: { version: 1, action: "bind", relation: "creator", projectRoot: repo, worktreePath: linked } },
    { type: "session_info", id: "name", timestamp: "2026-01-02T00:00:03.000Z", name: "Structured only" },
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  await writeFile(process.env.PI_WEB_HIDDEN_FILE, JSON.stringify({ sessions: ["hidden-session"], projects: [], devices: [], visibleSessions: [] }));
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { GET, DELETE } = await jiti.import("./route.ts");
  const { POST: bindWorktree } = await jiti.import("./bind/route.ts");
  const response = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.partial, false);
  assert.deepEqual(body.records.map((record) => [record.worktreePath, record.sessionId, record.source]), [[linked, "visible-session", "history"]]);
  assert.deepEqual(body.bindings.map((record) => [record.worktreePath, record.sessionId, record.relation, record.source]).sort(), [
    [linked, "structured-only", "creator", "structured"],
    [linked, "visible-session", "task-root", "structured"],
  ]);
  const bindRequest = (value = { cwd: repo, worktreePath: linked, sessionId: "visible-session", relation: "creator" }) => bindWorktree(new Request("http://localhost/api/worktrees/bind", {
    method: "POST",
    headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify(value),
  }));
  const wrongPath = await bindRequest({ cwd: repo, worktreePath: path.join(repo, "not-registered"), sessionId: "visible-session", relation: "creator" });
  assert.equal(wrongPath.status, 400);
  const missingSession = await bindRequest({ cwd: repo, worktreePath: linked, sessionId: "missing-session", relation: "creator" });
  assert.equal(missingSession.status, 404);
  const firstBind = await bindRequest();
  const firstBindBody = await firstBind.json();
  assert.equal(firstBind.status, 200, JSON.stringify(firstBindBody));
  assert.equal(firstBindBody.appended, true);
  const secondBind = await bindRequest();
  const secondBindBody = await secondBind.json();
  assert.equal(secondBind.status, 200, JSON.stringify(secondBindBody));
  assert.equal(secondBindBody.appended, false);
  const rebound = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
  const reboundBody = await rebound.json();
  assert.deepEqual(reboundBody.records.map((record) => record.sessionId), []);
  assert.deepEqual(reboundBody.bindings.filter((record) => record.sessionId === "visible-session").map((record) => record.relation).sort(), ["creator", "task-root"]);
  assert.equal(JSON.stringify(body).includes("must-not-run"), false);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const removal = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: repo, path: linked, force: true }),
  }));
  assert.equal(removal.status, 409, "a recorded creator or binding prevents removal even with force");
  assert.equal((await stat(linked)).isDirectory(), true);

  const guardedCommand = `p='${repo}'; w='${linked}'; test "$(git -C "$p" rev-parse refs/remotes/origin/reader)" = ${"a".repeat(40)} || exit 1; git -C "$p" worktree add -b feat/task "$w" main; touch '${marker}'`;
  await writeSession("large-session", true, guardedCommand);
  const largePath = path.join(sessionsDir, "large-session.jsonl");
  const largeFile = await open(largePath, "a");
  try {
    const padding = "x".repeat(1024 * 1024);
    for (let index = 0; index < 65; index++) {
      await largeFile.writeFile(`${JSON.stringify({ type: "message", id: `padding-${index}`, parentId: "name", timestamp: "2026-01-02T00:00:04.000Z", message: { role: "user", content: [{ type: "text", text: padding }] } })}\n`);
    }
  } finally {
    await largeFile.close();
  }
  const largeBefore = await stat(largePath);
  assert.ok(largeBefore.size > 64 * 1024 * 1024);
  let largeBody;
  let batches = 0;
  do {
    const largeResponse = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
    assert.equal(largeResponse.status, 200);
    largeBody = await largeResponse.json();
    batches++;
    if (largeBody.progress.running) assert.equal(largeBody.partial, true);
    assert.ok(batches < 100, "the bounded scan must make progress");
  } while (largeBody.progress.running);
  assert.ok(batches > 1, "a large session is read across several batches");
  assert.ok(batches < 10, "large scans should not require dozens of request round trips");
  assert.equal(largeBody.partial, false);
  assert.deepEqual(largeBody.records.map((record) => [record.worktreePath, record.sessionId]).sort(), [[linked, "large-session"]]);
  assert.deepEqual(largeBody.bindings.map((record) => [record.worktreePath, record.sessionId, record.relation, record.source]).sort(), [
    [linked, "large-session", "task-root", "structured"],
    [linked, "structured-only", "creator", "structured"],
    [linked, "visible-session", "creator", "structured"],
    [linked, "visible-session", "task-root", "structured"],
  ]);
  assert.equal(largeBody.records.find((record) => record.sessionId === "large-session").sessionName, "Session large-session");
  const largeAfter = await stat(largePath);
  assert.equal(largeAfter.size, largeBefore.size);
  assert.equal(largeAfter.mtimeMs, largeBefore.mtimeMs);
  assert.equal(JSON.stringify(largeBody).includes("must-not-run"), false);
  await assert.rejects(stat(marker), { code: "ENOENT" });

  globalThis.__piWorktreeAssociationScans?.delete(repo);
  const lookupStart = performance.now();
  const resumedResponse = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1&sessionId=large-session`));
  t.diagnostic(`65 MiB session cold indexed response: ${Math.round(performance.now() - lookupStart)} ms`);
  assert.equal(resumedResponse.status, 200);
  const resumed = await resumedResponse.json();
  assert.equal(resumed.partial, true, "a persisted hint cannot claim an unscanned history is complete");
  assert.deepEqual(resumed.records.filter((record) => record.sessionId === "large-session"), [], "a hint is not a verified record");
  assert.deepEqual(resumed.provisionalRecords.filter((record) => record.sessionId === "large-session").map((record) => record.worktreePath), [linked]);

  const missing = await GET(new Request("http://localhost/api/worktrees?cwd=%2Fnot-allowed&creationHistory=1"));
  assert.equal(missing.status, 400);
});

test("worktree removal ignores pi-subagents artifact JSONL", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-artifacts-")));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, hidden: process.env.PI_WEB_HIDDEN_FILE, cache: process.env.XDG_CACHE_HOME };
  t.after(async () => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.hidden === undefined) delete process.env.PI_WEB_HIDDEN_FILE;
    else process.env.PI_WEB_HIDDEN_FILE = previous.hidden;
    if (previous.cache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous.cache;
    await rm(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  const repo = path.join(root, "repo"), linked = path.join(root, "linked");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) await execFileAsync("git", ["-C", repo, "config", key, value]);
  await writeFile(path.join(repo, "README.md"), "test\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "feat/artifacts", linked]);
  const artifactDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "project", "subagent-artifacts");
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(artifactDir, "trace.jsonl"), "shared artifact\n");
  const { DELETE } = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false }).import("./route.ts");
  const response = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: repo, path: linked }),
  }));
  assert.equal(response.status, 200, await response.text());
  await assert.rejects(stat(linked), { code: "ENOENT" });
});

test("grouped scans yield and never publish a binding rewritten between slices", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-concurrent-")));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, hidden: process.env.PI_WEB_HIDDEN_FILE, cache: process.env.XDG_CACHE_HOME };
  t.after(async () => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.hidden === undefined) delete process.env.PI_WEB_HIDDEN_FILE;
    else process.env.PI_WEB_HIDDEN_FILE = previous.hidden;
    if (previous.cache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous.cache;
    globalThis.__piWorktreeAssociationScans?.delete(path.join(root, "repo"));
    await rm(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.PI_WEB_HIDDEN_FILE = path.join(root, "hidden.json");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  const repo = path.join(root, "repo"), linked = path.join(root, "linked");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) await execFileAsync("git", ["-C", repo, "config", key, value]);
  await writeFile(path.join(repo, "README.md"), "test\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "feat/task", linked]);
  const sessionsDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  const sessionPath = path.join(sessionsDir, "concurrent.jsonl");
  const row = (value) => JSON.stringify(value) + "\n";
  const prefix = row({ type: "session", version: 3, id: "concurrent", timestamp: "2026-01-01T00:00:00.000Z", cwd: repo })
    + row({ type: "custom", id: "binding", timestamp: "2026-01-01T00:00:01.000Z", customType: "pi-web:worktree-binding", data: { version: 1, action: "bind", relation: "task-root", projectRoot: repo, worktreePath: linked } });
  await writeFile(sessionPath, prefix);
  const file = await open(sessionPath, "a");
  try {
    const filler = row({ type: "message", id: "filler", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "x".repeat(1024 * 1024) } });
    for (let index = 0; index < 9; index++) await file.writeFile(filler);
  } finally { await file.close(); }
  const { GET } = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false }).import("./route.ts");
  const url = `http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`;
  const needle = '"action":"bind"';
  assert.notEqual(prefix.indexOf(needle), -1);
  const originalImmediate = globalThis.setImmediate;
  let rewritten = false;
  try {
    globalThis.setImmediate = (callback, ...args) => originalImmediate((...values) => {
      const scanned = globalThis.__piWorktreeAssociationScans?.get(repo)?.files.get(sessionPath);
      if (!rewritten && scanned && scanned.offset > 0 && scanned.offset < scanned.target.size) {
        const replacement = Buffer.from('"action":"noop"');
        const offset = Buffer.byteLength(prefix.slice(0, prefix.indexOf(needle)));
        const fd = openSync(sessionPath, "r+");
        try { writeSync(fd, replacement, 0, replacement.length, offset); } finally { closeSync(fd); }
        appendFileSync(sessionPath, row({ type: "session_info", id: "append", timestamp: "2026-01-01T00:00:03.000Z", name: "updated" }));
        rewritten = true;
      }
      callback(...values);
    }, ...args);
    let history, requests = 0;
    do {
      const response = await GET(new Request(url));
      assert.equal(response.status, 200);
      history = await response.json();
      assert.deepEqual(history.bindings, [], "a changed prefix cannot expose the old binding");
      assert.ok(++requests < 20);
    } while (history.progress.running);
    assert.equal(rewritten, true, "other work must run between grouped slices");
    assert.equal(history.partial, false);
    appendFileSync(sessionPath, row({ type: "custom", id: "rebind", timestamp: "2026-01-01T00:00:04.000Z", customType: "pi-web:worktree-binding", data: { version: 1, action: "bind", relation: "task-root", projectRoot: repo, worktreePath: linked } }));
    requests = 0;
    do {
      const response = await GET(new Request(url));
      assert.equal(response.status, 200);
      history = await response.json();
      assert.ok(++requests < 20);
    } while (history.progress.running);
    assert.equal(history.partial, false);
    assert.equal(history.bindings.length, 1, "a valid later binding must still be found");
  } finally { globalThis.setImmediate = originalImmediate; }
});

test("an unindexed session leaves verified associations available but removal fails closed", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-unknown-session-")));
  const previous = process.env.PI_CODING_AGENT_DIR, oldCache = process.env.XDG_CACHE_HOME;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    if (oldCache === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = oldCache;
    await rm(root, { recursive: true, force: true });
  });
  process.env.PI_CODING_AGENT_DIR = path.join(root, "agent");
  process.env.XDG_CACHE_HOME = path.join(root, "cache");
  const sessionsDir = path.join(process.env.PI_CODING_AGENT_DIR, "sessions", "project");
  await mkdir(sessionsDir, { recursive: true });
  await writeFile(path.join(sessionsDir, "unreadable-session.jsonl"), "not valid session metadata\n");
  const repo = path.join(root, "repo"), linked = path.join(root, "linked");
  await execFileAsync("git", ["init", "-b", "main", repo]);
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.invalid"], ["commit.gpgsign", "false"]]) {
    await execFileAsync("git", ["-C", repo, "config", key, value]);
  }
  await writeFile(path.join(repo, "README.md"), "test\n");
  await execFileAsync("git", ["-C", repo, "add", "README.md"]);
  await execFileAsync("git", ["-C", repo, "commit", "-m", "initial"]);
  await execFileAsync("git", ["-C", repo, "worktree", "add", "-b", "feat/unknown", linked]);
  const stamp = "2026-01-01T00:00:00.000Z";
  const valid = [
    { type: "session", version: 3, id: "valid", timestamp: stamp, cwd: repo },
    { type: "custom", id: "binding", timestamp: stamp, customType: "pi-web:worktree-binding", data: { version: 1, action: "bind", relation: "task-root", projectRoot: repo, worktreePath: linked } },
  ];
  await writeFile(path.join(sessionsDir, "valid.jsonl"), valid.map((row) => JSON.stringify(row)).join("\n") + "\n");
  const ambiguousCommand = [
    `ROOT='${repo}'`,
    'TASK="$(printf \'%s\' "$ROOT/.worktrees/task")"',
    'git -C "$ROOT" worktree add -b feat/unknown "$TASK" main',
  ].join("\n");
  await writeFile(path.join(sessionsDir, "ambiguous.jsonl"), [
    { type: "session", version: 3, id: "ambiguous", timestamp: stamp, cwd: repo },
    { type: "message", id: "assistant", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "ambiguous-call", name: "bash", arguments: { command: ambiguousCommand } }] } },
    { type: "message", id: "result", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "ambiguous-call", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/unknown')\nHEAD is now at abc1234 initial\n" }] } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");
  const { GET, DELETE } = await createJiti(import.meta.url, { tsconfigPaths: true, moduleCache: false }).import("./route.ts");
  const history = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
  assert.equal(history.status, 200);
  const result = await history.json();
  assert.equal(result.partial, true, "an unreadable session cannot produce a complete association list");
  assert.equal(result.failure, "unavailable");
  assert.deepEqual(result.bindings.map((binding) => binding.sessionId), ["valid"], "independently verified associations remain visible");
  const response = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: repo, path: linked }),
  }));
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /session inventory is incomplete/);
  assert.equal((await stat(linked)).isDirectory(), true);
  await rm(path.join(sessionsDir, "unreadable-session.jsonl"));
  await rm(path.join(sessionsDir, "valid.jsonl"));
  globalThis.__piWorktreeAssociationScans?.delete(repo);
  const uncertainResponse = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
  assert.equal(uncertainResponse.status, 200);
  const uncertain = await uncertainResponse.json();
  assert.equal(uncertain.partial, true);
  assert.equal(uncertain.unknown, true);
  assert.equal(uncertain.state, "unknown");
  assert.deepEqual(uncertain.records, []);
  const uncertainDelete = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: repo, path: linked }),
  }));
  assert.equal(uncertainDelete.status, 409);
  assert.match((await uncertainDelete.json()).error, /worktree creation history is incomplete/);
  await rm(path.join(sessionsDir, "ambiguous.jsonl"));
  globalThis.__piWorktreeAssociationScans?.delete(repo);
  const deletedDir = path.join(process.env.PI_CODING_AGENT_DIR, "deleted_sessions", "project");
  await mkdir(deletedDir, { recursive: true });
  await writeFile(path.join(deletedDir, "recoverable.jsonl"), JSON.stringify({ type: "session", id: "recoverable", cwd: linked, timestamp: "2026-01-01T00:00:00Z" }) + "\n");
  const deletedReference = await DELETE(new Request("http://localhost/api/worktrees", {
    method: "DELETE", headers: { Host: "localhost", "Content-Type": "application/json" },
    body: JSON.stringify({ cwd: repo, path: linked }),
  }));
  assert.equal(deletedReference.status, 409, "recoverable deleted sessions are not treated as absent");
  assert.match((await deletedReference.json()).error, /session uses this directory/);
  assert.equal((await stat(linked)).isDirectory(), true);
});
