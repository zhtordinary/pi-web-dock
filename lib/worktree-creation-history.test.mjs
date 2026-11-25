import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";
import { join } from "node:path";

const jiti = createJiti(import.meta.url);
const {
  confirmedWorktreeCreationCommand,
  findWorktreeCreationEvidence,
  findWorktreeCreationRecords,
  inspectWorktreeCreationCommand,
} = await jiti.import("./worktree-creation-history.ts");
const home = process.platform === "win32" ? "C:\\Users\\fixture" : "/home/user";
const session = { id: "session-one", created: "2026-01-01T00:00:00.000Z", cwd: join(home, "repo") };
const worktree = join(session.cwd, ".worktrees", "task");
const shellHome = home.replaceAll("\\\\", "/");
const shellCwd = session.cwd.replaceAll("\\\\", "/");
const shellWorktree = worktree.replaceAll("\\\\", "/");

function history(command, { output = "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", error = false, callTime = "2026-01-02T00:00:00.000Z", resultId = "call-1", tool = "bash" } = {}) {
  return [
    { type: "message", id: "assistant", parentId: null, timestamp: callTime, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: tool, arguments: { command } }] } },
    { type: "message", id: "result", parentId: "assistant", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "toolResult", toolName: tool, toolCallId: resultId, isError: error, content: [{ type: "text", text: output }] } },
  ];
}

function find(entries) {
  return findWorktreeCreationRecords(entries, session, [worktree], home);
}

function evidence(entries) {
  return findWorktreeCreationEvidence(entries, session, [worktree], home);
}

function expected() {
  return [{ worktreePath: worktree, sessionId: session.id, createdAt: "2026-01-02T00:00:00.000Z" }];
}

test("finds a successful git worktree add from its paired tool result", () => {
  const command = `git -C '${shellCwd}' worktree add -b 'feat/task' '${shellWorktree}' main`;
  assert.deepEqual(find(history(command)), expected());
});

test("resolves relative worktree paths against the session cwd", () => {
  const direct = "git worktree add -b feat/task '.worktrees/task' main";
  const fromGitC = `git -C '${shellCwd}' worktree add -b feat/task '.worktrees/task' main`;
  assert.deepEqual(find(history(direct)), expected());
  assert.deepEqual(find(history(fromGitC)), expected());
});

test("resolves literal HOME and local variable assignments without executing shell", () => {
  const command = `set -euo pipefail\nroot="$HOME/repo"\ntree="$root/.worktrees/task"\nbranch='feat/task'\n[ ! -e "$tree" ]\ngit -C "$root" worktree add -b "$branch" "$tree" main`;
  assert.deepEqual(find(history(command)), expected());
  const dynamic = `root="${shellHome}/repo"; tree="$root/.worktrees/task"; tree=$(printf '%s' '${shellWorktree}-other'); git -C "$root" worktree add -b 'feat/task' "$tree" main`;
  assert.deepEqual(find(history(dynamic)), []);
});

test("resolves the repository root from a read-only git rev-parse assignment", () => {
  const command = `set -e\nrepo="$(git rev-parse --show-toplevel)"\ntask="$repo/.worktrees/task"\ngit -C "$repo" worktree add -b feat/task "$task" origin/main`;
  assert.deepEqual(find(history(command)), expected());
});

test("recognizes a git command after shell guards and a completed heredoc", () => {
  const guarded = `git fetch origin main && test -z "$(git branch --list feat/task)" && git worktree add -b feat/task "$HOME/repo/.worktrees/task" origin/main && git status`;
  const heredoc = `python3 - <<'PY'\nprint('not a shell command')\nPY\ngit worktree add -b feat/task '${shellWorktree}' main`;
  assert.deepEqual(find(history(guarded)), expected());
  assert.deepEqual(find(history(heredoc)), expected());
});

test("preserves local paths across a read-only git revision guard", () => {
  const prefix = `p='${shellCwd}'; w="$p/.worktrees/task";`;
  const create = `git -C "$p" worktree add -b feat/task "$w" main`;
  const guard = `test "$(git -C "$p" rev-parse refs/remotes/origin/reader)" = ${"a".repeat(40)}`;
  assert.deepEqual(find(history(`${prefix} ${guard} || exit 1; ${create}`)), expected());
  const compareRefs = `test "$(git -C "$p" rev-parse HEAD)" = "$(git -C "$p" rev-parse origin/main)"`;
  assert.deepEqual(find(history(`${prefix} ${compareRefs}; ${create}`)), expected());
  const preflight = `${prefix} test ! -e "$w" && test ! -L "$w" || { printf '%s\\n' 'target exists'; exit 1; }; if git -C "$p" show-ref --verify --quiet refs/heads/feat/task; then exit 1; fi; ${guard} || exit 1; ${create}; rc=$?; exit "$rc"`;
  assert.deepEqual(find(history(preflight)), expected());

  const unknownGuard = `test "$(printf '%s' other)" = other`;
  const mutatingGuard = `test "$(git -C "$p" rev-parse refs/remotes/origin/reader; w=/other)" = ${"a".repeat(40)}`;
  assert.deepEqual(find(history(`${prefix} ${unknownGuard}; ${create}`)), []);
  assert.deepEqual(find(history(`${prefix} ${mutatingGuard}; ${create}`)), []);
});

test("preserves local paths across a read-only git status command substitution", () => {
  const command = [
    "set -Eeuo pipefail",
    `ROOT='${shellCwd}'`,
    'TASK="$ROOT/.worktrees/task"',
    "BRANCH=feat/task",
    'test -z "$(git -C "$ROOT" status --porcelain=v1 --untracked-files=all)"',
    '! test -e "$TASK"',
    'git -C "$ROOT" worktree add -b "$BRANCH" "$TASK" origin/reader',
  ].join("\n");
  assert.deepEqual(find(history(command)), expected());
});

test("preserves a known worktree path across a read-only revision print", () => {
  const prefix = `ROOT='${shellCwd}';`;
  const create = 'TASK="$ROOT/.worktrees/task"; git -C "$ROOT" worktree add -b feat/task "$TASK" main';
  const printedRevision = `printf 'baseline %s\\n' "$(git rev-parse origin/reader)"`;
  assert.deepEqual(find(history(`${prefix} ${printedRevision}; ${create}`)), expected());
  for (const unsafe of [
    `printf -v ROOT '%s' "$(git rev-parse origin/reader)"`,
    `printf '%n' "$(git rev-parse origin/reader)"`,
    `printf '%s' "$(git rev-parse origin/reader; ROOT=/other)"`,
  ]) {
    const result = evidence(history(`${prefix} ${unsafe}; ${create}`));
    assert.deepEqual(result.records, [], unsafe);
    assert.equal(result.uncertain, true, unsafe);
  }
  for (const definition of ["printf() { ROOT=/other; }", "function printf\n{ ROOT=/other; }"]) {
    const overridden = `${definition}\n${prefix} ${printedRevision}; ${create}`;
    assert.deepEqual(evidence(history(overridden)).records, []);
    assert.equal(evidence(history(overridden)).uncertain, true);
  }
});

test("preserves variables across a redirected worktree existence guard", () => {
  const command = [
    "set -Eeuo pipefail",
    `ROOT='${shellCwd}'`,
    'TASK="$ROOT/.worktrees/task"',
    "BRANCH=feat/task",
    'if [ -e "$TASK" ]; then',
    '  printf \'target already exists\\n\' >&2',
    '  exit 1',
    'fi',
    'git -C "$ROOT" worktree add -b "$BRANCH" "$TASK" origin/reader',
  ].join("\n");
  assert.deepEqual(find(history(command)), expected());
});

test("only a verified Reader result yields a creator candidate", () => {
  const command = `git -C '${shellCwd}' worktree add -b feat/task '${shellWorktree}' main`;
  const result = { exitCode: 0, cancelled: false };
  assert.deepEqual(
    confirmedWorktreeCreationCommand(command, "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", result, [worktree], home, session.cwd),
    { path: worktree, branch: "feat/task" },
  );
  assert.equal(confirmedWorktreeCreationCommand(command, "Preparing worktree (new branch 'feat/task')\nfatal: failed\n", result, [worktree], home, session.cwd), undefined);
  assert.equal(confirmedWorktreeCreationCommand(command, "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", { exitCode: 1 }, [worktree], home, session.cwd), undefined);
  assert.equal(confirmedWorktreeCreationCommand(command, "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", result, [join(home, "repo", ".worktrees", "other")], home, session.cwd), undefined);
  const otherProject = `git -C '${join(home, "other-repo")}' worktree add -b feat/task '${shellWorktree}' main`;
  assert.equal(inspectWorktreeCreationCommand(otherProject, [worktree], home, session.cwd, session.cwd).uncertain, false);
  assert.equal(confirmedWorktreeCreationCommand(otherProject, "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", result, [worktree], home, session.cwd), undefined);
});

test("reads a successful Reader bash execution without executing its command", () => {
  const command = [
    `ROOT='${shellCwd}'`,
    'TASK="$ROOT/.worktrees/task"',
    'git -C "$ROOT" worktree add -b feat/task "$TASK" main',
  ].join("\n");
  const entries = [{
    type: "message", id: "bash", parentId: null, timestamp: "2026-01-02T00:00:00.000Z",
    message: { role: "bashExecution", command, output: "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", exitCode: 0 },
  }];
  assert.deepEqual(find(entries), expected());
});

test("keeps an unresolvable potential creation explicitly uncertain", () => {
  const command = [
    `ROOT='${shellCwd}'`,
    'TASK="$(printf \'%s\' "$ROOT/.worktrees/task")"',
    'git -C "$ROOT" worktree add -b feat/task "$TASK" main',
  ].join("\n");
  const result = evidence(history(command));
  assert.deepEqual(result.records, []);
  assert.equal(result.uncertain, true);
});

test("keeps grouped potential creation explicitly uncertain", () => {
  for (const command of [
    `{ git -C '${shellCwd}' worktree add -b feat/task '${shellWorktree}' main; }`,
    `if { git -C '${shellCwd}' worktree add -b feat/task '${shellWorktree}' main; }; then true; fi`,
    `( git -C '${shellCwd}' worktree add -b feat/task '${shellWorktree}' main )`,
  ]) {
    const result = evidence(history(command));
    assert.deepEqual(result.records, [], command);
    assert.equal(result.uncertain, true, command);
  }
});

test("a failed potential creation does not create a record or unknown state", () => {
  const command = `git worktree add -b feat/task '${shellWorktree}' main`;
  const result = evidence(history(command, { error: true }));
  assert.deepEqual(result.records, []);
  assert.equal(result.uncertain, false);
});

test("does not attribute failed, unpaired or inherited history", () => {
  const command = `git worktree add -b feat/task '${shellWorktree}' main`;
  assert.deepEqual(find(history(command, { error: true })), []);
  assert.deepEqual(find(history(command, { resultId: "other-call" })), []);
  assert.deepEqual(find(history(command, { output: "Preparing worktree\nfatal: failed\n" })), []);
  assert.deepEqual(find(history(command, { output: "Preparing worktree (new branch 'feat/other')\nHEAD is now at abc1234 baseline\n" })), []);
  assert.deepEqual(find(history(command, { callTime: "2025-12-31T23:59:59.000Z" })), []);
  assert.deepEqual(find(history(command).slice(0, 1)), []);
});

test("does not infer a creation from mentions, uncertain expansion or multiple adds", () => {
  const commands = [
    `echo "git worktree add -b feat/task '${shellWorktree}' main"`,
    `git worktree add -b feat/task "$UNKNOWN/repo/.worktrees/task" main`,
    `git worktree add -b feat/task '${shellWorktree}-other' main`,
    `git worktree add -b feat/task '${shellWorktree}' main && git worktree add -b feat/other /other main`,
    `python3 - <<'PY'\ngit worktree add -b feat/task '${shellWorktree}' main\nPY`,
    `# git worktree add -b feat/task '${shellWorktree}' main`,
    `git worktree add -b feat/task .worktrees/other main`,
  ];
  for (const command of commands) assert.deepEqual(find(history(command)), [], command);
  assert.deepEqual(find(history(`git worktree add -b feat/task '${shellWorktree}' main && git status`)), expected());
});

test("supports normalized tool calls as well as native Pi transcript entries", () => {
  const entries = history(`git worktree add -b feat/task '${shellWorktree}' main`);
  entries[0].message.content = [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: `git worktree add -b feat/task '${shellWorktree}' main` } }];
  assert.deepEqual(find(entries), expected());
});
