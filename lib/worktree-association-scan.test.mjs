import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdtempSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { createJiti } from "jiti";

const { scanWorktreeAssociations } = await createJiti(import.meta.url, { fsCache: false }).import("./worktree-association-scan.ts");
const stamp = "2026-01-01T00:00:00.000Z";
const line = (value) => JSON.stringify(value) + "\n";

test("association scanner typechecks with the project configuration", () => {
  const configPath = fileURLToPath(new URL("../tsconfig.json", import.meta.url));
  const config = ts.readConfigFile(configPath, ts.sys.readFile);
  assert.equal(config.error, undefined);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, fileURLToPath(new URL("..", import.meta.url)), { incremental: false }, configPath);
  const program = ts.createProgram([fileURLToPath(new URL("./worktree-association-scan.ts", import.meta.url))], parsed.options);
  const errors = [...parsed.errors, ...ts.getPreEmitDiagnostics(program)].filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error);
  assert.equal(errors.length, 0, ts.formatDiagnostics(errors, {
    getCanonicalFileName: (file) => file, getCurrentDirectory: () => process.cwd(), getNewLine: () => "\n",
  }));
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-association-scan-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "session.jsonl");
  const session = { id: "session-1", path, cwd: root, created: stamp, name: "Owner" };
  const linked = join(root, "linked");
  const header = line({ type: "session", version: 3, id: session.id, timestamp: stamp, cwd: root });
  const binding = (action) => line({ type: "custom", id: action, timestamp: stamp, customType: "pi-web:worktree-binding", data: { version: 1, action, relation: "task-root", projectRoot: root, worktreePath: linked } });
  const command = `git worktree add -b feat/task '${linked}' main`;
  const call = line({ type: "message", id: "call", timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command } }] } });
  const result = line({ type: "message", id: "result", timestamp: stamp, message: { role: "toolResult", toolCallId: "call-1", toolName: "bash", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 initial\n" }] } });
  const scan = (maxBytes = 128, options = {}) => scanWorktreeAssociations([session], root, [root, linked], { maxBytes, ...options });
  const complete = (maxBytes = 128) => {
    let result;
    let batches = 0;
    do {
      result = scan(maxBytes);
      assert.ok(++batches < 10_000, "bounded scan must advance");
      if (result.progress.running) assert.equal(result.partial, true);
    } while (result.progress.running);
    return { result, batches };
  };
  return { root, path, session, linked, header, binding, call, result, scan, complete };
}

test("scans in bounded batches and incrementally applies a binding release", (t) => {
  const f = fixture(t);
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "中文🙂".repeat(200) } });
  writeFileSync(f.path, f.header + f.call + filler + f.result + f.binding("bind"));
  const before = statSync(f.path);
  const first = f.scan();
  assert.equal(first.partial, true);
  assert.equal(first.progress.running, true);
  assert.ok(first.progress.processedBytes <= 128);
  assert.deepEqual(first.records, [], "unfinished histories never publish an unverified association");
  const finished = f.complete();
  assert.ok(finished.batches > 1);
  assert.equal(finished.result.partial, false);
  assert.deepEqual(finished.result.records.map((x) => [x.worktreePath, x.sessionId]), [[f.linked, f.session.id]]);
  assert.deepEqual(finished.result.bindings.map((x) => x.relation), ["task-root"]);
  const after = statSync(f.path);
  assert.equal(after.size, before.size);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(f.scan().progress.running, false, "unchanged history reuses its scan");

  appendFileSync(f.path, f.binding("release"));
  const checking = f.scan();
  assert.equal(checking.partial, true, "a changed prefix is not presented as current before verification");
  assert.deepEqual(checking.bindings, []);
  const updated = f.complete().result;
  assert.equal(updated.partial, false);
  assert.deepEqual(updated.bindings, []);
  assert.equal(updated.records.length, 1);
  appendFileSync(f.path, line({ type: "session_info", id: "rename", timestamp: stamp, name: "New name" }));
  assert.equal(f.complete().result.records[0].sessionName, "New name");
});

test("only one session per project retains a partially read JSON line", (t) => {
  const f = fixture(t);
  const secondPath = join(f.root, "second.jsonl");
  const second = { ...f.session, id: "session-2", path: secondPath };
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(4096) } });
  writeFileSync(f.path, f.header + filler);
  writeFileSync(secondPath, line({ type: "session", version: 3, id: second.id, timestamp: stamp, cwd: f.root }) + filler);
  for (let i = 0; i < 10; i++) {
    const history = scanWorktreeAssociations([f.session, second], f.root, [f.root, f.linked], { maxBytes: 256 });
    assert.equal(history.partial, true);
    const cache = globalThis.__piWorktreeAssociationScans.get(f.root);
    assert.ok([...cache.files.values()].filter((file) => file.lineBytes > 0).length <= 1);
  }
});

test("changing the registered worktrees invalidates the cached projection", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.header + f.call + f.result + f.binding("bind"));
  assert.equal(f.complete().result.bindings.length, 1);
  const removed = scanWorktreeAssociations([f.session], f.root, [f.root], { maxBytes: 4096 });
  assert.equal(removed.partial, false);
  assert.deepEqual(removed.records, []);
  assert.deepEqual(removed.bindings, []);
  assert.equal(f.complete().result.bindings.length, 1);
});

test("adding or removing a worktree reuses scanned history and projects newly registered evidence", (t) => {
  const f = fixture(t);
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(16 * 1024) } });
  writeFileSync(f.path, f.header + f.call + f.result + f.binding("bind") + filler);
  let initial;
  do {
    initial = scanWorktreeAssociations([f.session], f.root, [f.root], { maxBytes: 1024 });
  } while (initial.progress.running);
  assert.equal(initial.partial, false);
  assert.equal(initial.unknown, false);
  assert.equal(initial.state, "complete");
  assert.deepEqual(initial.records, []);
  assert.deepEqual(initial.bindings, []);

  const added = scanWorktreeAssociations([f.session], f.root, [f.root, f.linked], { maxBytes: 1 });
  assert.equal(added.partial, false, "a path change must not rescan the already verified session");
  assert.deepEqual(added.records.map((record) => record.worktreePath), [f.linked]);
  assert.deepEqual(added.bindings.map((record) => record.worktreePath), [f.linked]);

  const removed = scanWorktreeAssociations([f.session], f.root, [f.root], { maxBytes: 1 });
  assert.equal(removed.partial, false);
  assert.deepEqual(removed.records, []);
  assert.deepEqual(removed.bindings, []);
});

test("the current session is scanned first on a cold project", (t) => {
  const f = fixture(t);
  const earlierPath = join(f.root, "a-session.jsonl"), laterPath = join(f.root, "z-session.jsonl");
  const earlier = { ...f.session, id: "earlier", path: earlierPath };
  const later = { ...f.session, path: laterPath };
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(16 * 1024) } });
  writeFileSync(earlierPath, line({ type: "session", version: 3, id: earlier.id, timestamp: stamp, cwd: f.root }) + filler);
  writeFileSync(laterPath, f.header + f.call + f.result);
  const result = scanWorktreeAssociations([earlier, later], f.root, [f.root, f.linked], { maxBytes: 2048, prioritySessionId: later.id });
  assert.equal(result.partial, true, "other session histories are still scanned in the background");
  assert.equal(result.priorityPending, false);
  assert.deepEqual(result.records.map((record) => record.sessionId), [later.id]);
});

test("ambiguous reused tool call IDs never make a path-independent scan complete", (t) => {
  const f = fixture(t);
  const ambiguous = f.call.replaceAll(f.linked, join(f.root, "another-worktree"));
  writeFileSync(f.path, f.header + f.call + ambiguous + f.result);
  const result = f.complete().result;
  assert.equal(result.partial, true);
  assert.equal(result.failure, "unavailable");
  assert.deepEqual(result.records, []);
});

test("an uncertain creation keeps confirmed bindings visible and blocks a complete absence claim", (t) => {
  const f = fixture(t);
  const command = [
    `ROOT='${f.root}'`,
    'TASK="$(printf \'%s\' "$ROOT/.worktrees/task")"',
    'git -C "$ROOT" worktree add -b feat/task "$TASK" main',
  ].join("\n");
  const call = line({ type: "message", id: "ambiguous-call", timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: "ambiguous-call", name: "bash", arguments: { command } }] } });
  const result = line({ type: "message", id: "ambiguous-result", timestamp: stamp, message: { role: "toolResult", toolCallId: "ambiguous-call", toolName: "bash", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 initial\n" }] } });
  const confirmedCommand = [`ROOT='${f.root}'`, `printf 'baseline %s\\n' "$(git rev-parse origin/reader)"`, `git -C "$ROOT" worktree add -b feat/task '${f.linked}' main`].join("\n");
  const confirmedCall = line({ type: "message", id: "call", timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: confirmedCommand } }] } });
  writeFileSync(f.path, f.header + f.binding("bind") + confirmedCall + f.result + call + result);
  const history = f.complete().result;
  assert.equal(history.partial, true);
  assert.equal(history.unknown, true);
  assert.equal(history.state, "unknown");
  assert.deepEqual(history.bindings.map((binding) => binding.relation), ["task-root"]);
  assert.deepEqual(history.records.map((record) => record.worktreePath), [f.linked], "an unrelated ambiguity must not hide a confirmed creation");
});

test("grouped potential creation remains unknown rather than appearing unassociated", (t) => {
  const f = fixture(t);
  const command = `{ git -C '${f.root}' worktree add -b feat/task '${f.linked}' main; }`;
  const call = line({ type: "message", id: "grouped-call", timestamp: stamp, message: { role: "assistant", content: [{ type: "toolCall", id: "grouped-call", name: "bash", arguments: { command } }] } });
  const result = line({ type: "message", id: "grouped-result", timestamp: stamp, message: { role: "toolResult", toolCallId: "grouped-call", toolName: "bash", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/task')\\nHEAD is now at abc1234 initial\\n" }] } });
  writeFileSync(f.path, f.header + call + result);
  const history = f.complete().result;
  assert.equal(history.partial, true);
  assert.equal(history.unknown, true);
  assert.equal(history.state, "unknown");
  assert.deepEqual(history.records, []);
  assert.deepEqual(history.bindings, []);
});

test("a missing session remains incomplete rather than appearing unassociated", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.header + f.binding("bind"));
  assert.equal(f.complete().result.bindings.length, 1);
  rmSync(f.path);
  const missing = f.scan();
  assert.equal(missing.partial, true);
  assert.equal(missing.progress.running, false);
  assert.deepEqual(missing.bindings, []);
});

test("detects an in-place prefix rewrite followed by an append", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.header + f.binding("bind") + line({ type: "session_info", id: "old", name: "old" }));
  assert.equal(f.complete().result.bindings.length, 1);
  const inode = statSync(f.path).ino;
  writeFileSync(f.path, f.header + f.binding("release") + line({ type: "session_info", id: "new", name: "new and longer" }));
  assert.equal(statSync(f.path).ino, inode);
  const checking = f.scan();
  assert.equal(checking.partial, true);
  assert.deepEqual(checking.bindings, []);
  const updated = f.complete().result;
  assert.equal(updated.partial, false);
  assert.deepEqual(updated.bindings, []);
});

test("rechecks an earlier prefix if it changes during incremental verification", (t) => {
  const f = fixture(t);
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(4096) } });
  const initial = f.header + f.binding("bind") + filler;
  writeFileSync(f.path, initial);
  assert.equal(f.complete(512).result.bindings.length, 1);
  const appended = line({ type: "session_info", id: "append", name: "updated" });
  appendFileSync(f.path, appended);
  const checking = f.scan(512);
  assert.equal(checking.partial, true);
  assert.equal(checking.progress.running, true);
  const changed = initial.replace('"action":"bind"', '"action":"noop"');
  assert.equal(Buffer.byteLength(changed), Buffer.byteLength(initial));
  writeFileSync(f.path, changed + appended + filler);
  const finished = f.complete(512).result;
  assert.equal(finished.partial, false);
  assert.deepEqual(finished.bindings, []);
});

test("concurrent appends keep the result incomplete until a stable prefix is verified", (t) => {
  const f = fixture(t);
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(4096) } });
  writeFileSync(f.path, f.header + f.binding("bind") + filler);
  assert.equal(f.complete(512).result.partial, false);
  for (let index = 0; index < 4; index++) {
    appendFileSync(f.path, line({ type: "session_info", id: `append-${index}`, name: `name-${index}` }));
    const progress = f.scan(512);
    assert.equal(progress.partial, true);
    assert.equal(progress.progress.running, true);
  }
  const finished = f.complete(512).result;
  assert.equal(finished.partial, false);
  assert.equal(finished.bindings.length, 1);
  assert.equal(finished.bindings[0].sessionName, "name-3");
});

test("detects rewrites while a bounded initial scan is still in progress", (t) => {
  const f = fixture(t);
  const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(4096) } });
  writeFileSync(f.path, f.header + f.binding("bind") + filler);
  assert.equal(f.scan(256).progress.running, true);
  writeFileSync(f.path, f.header + f.binding("release") + filler + filler);
  const finished = f.complete(256).result;
  assert.equal(finished.partial, false);
  assert.deepEqual(finished.bindings, []);
});

test("replacement, truncation and an appended unterminated line invalidate the cached result", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.header + f.binding("bind"));
  assert.equal(f.complete().result.bindings.length, 1);
  writeFileSync(f.path + ".new", f.header + f.binding("release"));
  renameSync(f.path + ".new", f.path);
  assert.deepEqual(f.complete().result.bindings, []);
  writeFileSync(f.path, f.header + f.binding("bind").trimEnd());
  assert.equal(f.complete().result.bindings.length, 1);
  appendFileSync(f.path, "invalid\n" + f.binding("release"));
  const invalid = f.complete().result;
  assert.equal(invalid.partial, true, "a damaged line must not be reported as a complete scan");
  assert.equal(invalid.progress.running, false);
  writeFileSync(f.path, f.header + f.binding("release"));
  const repaired = f.scan(4096, { retry: true });
  assert.equal(repaired.partial, false);
  assert.deepEqual(repaired.bindings, []);
});

test("reports an oversized individual entry as incomplete and retries after it changes", (t) => {
  const f = fixture(t);
  const tooLarge = line({ type: "message", id: "large", timestamp: stamp, message: { role: "user", content: "x".repeat(32 * 1024 * 1024) } });
  writeFileSync(f.path, f.header + tooLarge + f.binding("bind"));
  const result = f.complete(4 * 1024 * 1024).result;
  assert.equal(result.partial, true);
  assert.equal(result.progress.running, false);
  assert.equal(result.failure, "entry_too_large");
  assert.deepEqual(result.bindings, []);
  writeFileSync(f.path, f.header + f.binding("bind"));
  const retry = f.complete().result;
  assert.equal(retry.partial, false);
  assert.equal(retry.bindings.length, 1);
});

test("scans a single session over 256 MiB without dropping its later associations", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, f.header);
  const fd = openSync(f.path, "a");
  try {
    const filler = line({ type: "message", id: "filler", timestamp: stamp, message: { role: "user", content: "x".repeat(1024 * 1024) } });
    for (let i = 0; i < 258; i++) writeSync(fd, filler);
    writeSync(fd, f.call + f.result + f.binding("bind"));
  } finally { closeSync(fd); }
  const before = statSync(f.path);
  assert.ok(before.size > 256 * 1024 * 1024);
  const { result, batches } = f.complete(4 * 1024 * 1024);
  assert.ok(batches > 1);
  assert.equal(result.partial, false);
  assert.equal(result.records.length, 1);
  assert.equal(result.bindings.length, 1);
  assert.equal(statSync(f.path).size, before.size);
  assert.equal(statSync(f.path).mtimeMs, before.mtimeMs);
});
