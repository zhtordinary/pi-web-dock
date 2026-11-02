import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createJiti } from "jiti";

const execFileAsync = promisify(execFile);

test("creation history reads visible project sessions without executing or exposing commands", async (t) => {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-web-worktree-history-")));
  const previous = { agent: process.env.PI_CODING_AGENT_DIR, hidden: process.env.PI_WEB_HIDDEN_FILE };
  t.after(async () => {
    if (previous.agent === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous.agent;
    if (previous.hidden === undefined) delete process.env.PI_WEB_HIDDEN_FILE;
    else process.env.PI_WEB_HIDDEN_FILE = previous.hidden;
    await rm(root, { recursive: true, force: true });
  });
  const agent = path.join(root, "agent");
  process.env.PI_CODING_AGENT_DIR = agent;
  process.env.PI_WEB_HIDDEN_FILE = path.join(root, "hidden-state.json");
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
  async function writeSession(id) {
    const entries = [
      { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd: repo },
      { type: "message", id: "user", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", message: { role: "user", content: [{ type: "text", text: "Fixture" }] } },
      { type: "message", id: "assistant", parentId: "user", timestamp: "2026-01-02T00:00:00.000Z", message: { role: "assistant", content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: { command: `git worktree add -b feat/task '${linked}' main; touch '${marker}'` } }] } },
      { type: "message", id: "result", parentId: "assistant", timestamp: "2026-01-02T00:00:01.000Z", message: { role: "toolResult", toolName: "bash", toolCallId: "call-1", isError: false, content: [{ type: "text", text: "Preparing worktree (new branch 'feat/task')\nHEAD is now at abc1234 initial\n" }] } },
      { type: "session_info", id: "name", parentId: "result", timestamp: "2026-01-02T00:00:02.000Z", name: `Session ${id}` },
    ];
    await writeFile(path.join(sessionsDir, `${id}.jsonl`), entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
  await writeSession("visible-session");
  await writeSession("hidden-session");
  await writeFile(process.env.PI_WEB_HIDDEN_FILE, JSON.stringify({ sessions: ["hidden-session"], projects: [], devices: [], visibleSessions: [] }));
  const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
  const { GET } = await jiti.import("./route.ts");
  const { allowFileRoot } = await jiti.import("@/lib/file-access");
  allowFileRoot(repo);
  allowFileRoot(linked);
  const response = await GET(new Request(`http://localhost/api/worktrees?cwd=${encodeURIComponent(repo)}&creationHistory=1`));
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.partial, false);
  assert.deepEqual(body.records.map((record) => [record.worktreePath, record.sessionId]), [[linked, "visible-session"]]);
  assert.equal(JSON.stringify(body).includes("must-not-run"), false);
  await assert.rejects(stat(marker), { code: "ENOENT" });
  const denied = await GET(new Request("http://localhost/api/worktrees?cwd=%2Fnot-allowed&creationHistory=1"));
  assert.equal(denied.status, 403);
});
