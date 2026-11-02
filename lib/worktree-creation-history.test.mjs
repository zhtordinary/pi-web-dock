import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { findWorktreeCreationRecords } = await jiti.import("./worktree-creation-history.ts");
const session = { id: "session-one", created: "2026-01-01T00:00:00.000Z" };
const worktree = "/home/user/repo/.worktrees/task";
const home = "/home/user";

function history(command, { output = "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n", error = false, callTime = "2026-01-02T00:00:00.000Z", resultId = "call-1", tool = "bash" } = {}) {
  return [
    { type: "message", id: "assistant", parentId: null, timestamp: callTime, message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: tool, arguments: { command } }] } },
    { type: "message", id: "result", parentId: "assistant", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "toolResult", toolName: tool, toolCallId: resultId, isError: error, content: [{ type: "text", text: output }] } },
  ];
}

function find(entries) {
  return findWorktreeCreationRecords(entries, session, [worktree], home);
}

function expected() {
  return [{ worktreePath: worktree, sessionId: session.id, createdAt: "2026-01-02T00:00:00.000Z" }];
}

test("finds a successful git worktree add from its paired tool result", () => {
  const command = `git -C '/home/user/repo' worktree add -b 'feat/task' '${worktree}' main`;
  assert.deepEqual(find(history(command)), expected());
});

test("resolves literal HOME and local variable assignments without executing shell", () => {
  const command = `set -euo pipefail\nroot="$HOME/repo"\ntree="$root/.worktrees/task"\nbranch='feat/task'\n[ ! -e "$tree" ]\ngit -C "$root" worktree add -b "$branch" "$tree" main`;
  assert.deepEqual(find(history(command, { output: `Creating ${worktree}\nPreparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n` })), expected());
  assert.deepEqual(find(history(command)), []);
});

test("recognizes a git command after shell guards and a completed heredoc", () => {
  const guarded = `git fetch origin main && test -z "$(git branch --list feat/task)" && git worktree add -b feat/task "$HOME/repo/.worktrees/task" origin/main && git status`;
  const heredoc = `python3 - <<'PY'\nprint('not a shell command')\nPY\ngit worktree add -b feat/task '${worktree}' main`;
  assert.deepEqual(find(history(guarded, { output: `Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 baseline\n${worktree}\n` })), expected());
  assert.deepEqual(find(history(heredoc)), expected());
});

test("does not attribute failed, unpaired or inherited history", () => {
  const command = `git worktree add -b feat/task '${worktree}' main`;
  assert.deepEqual(find(history(command, { error: true })), []);
  assert.deepEqual(find(history(command, { resultId: "other-call" })), []);
  assert.deepEqual(find(history(command, { output: "Preparing worktree\nfatal: failed\n" })), []);
  assert.deepEqual(find(history(command, { output: "Preparing worktree (new branch 'feat/other')\nHEAD is now at abc1234 baseline\n" })), []);
  assert.deepEqual(find(history(command, { callTime: "2025-12-31T23:59:59.000Z" })), []);
  assert.deepEqual(find(history(command).slice(0, 1)), []);
});

test("does not infer a creation from mentions, uncertain expansion or multiple adds", () => {
  const commands = [
    `echo "git worktree add -b feat/task '${worktree}' main"`,
    `git worktree add -b feat/task "$UNKNOWN/repo/.worktrees/task" main`,
    `git worktree add -b feat/task '${worktree}-other' main`,
    `git worktree add -b feat/task '${worktree}' main && git worktree add -b feat/other /other main`,
    `python3 - <<'PY'\ngit worktree add -b feat/task '${worktree}' main\nPY`,
    `# git worktree add -b feat/task '${worktree}' main`,
    `git worktree add -b feat/task .worktrees/task main`,
  ];
  for (const command of commands) assert.deepEqual(find(history(command)), [], command);
  assert.deepEqual(find(history(`git worktree add -b feat/task '${worktree}' main && git status`)), expected());
});

test("supports normalized tool calls as well as native Pi transcript entries", () => {
  const entries = history(`git worktree add -b feat/task '${worktree}' main`);
  entries[0].message.content = [{ type: "toolCall", toolCallId: "call-1", toolName: "bash", input: { command: `git worktree add -b feat/task '${worktree}' main` } }];
  assert.deepEqual(find(entries), expected());
});
