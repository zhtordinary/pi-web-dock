import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const { mergeAssociatedWorktreeSessions, preferredWorktreePath } = await createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true }).import("./WorktreeGraphOverlay.tsx");
const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const graph = await readFile(new URL("./WorktreeGraphOverlay.tsx", import.meta.url), "utf8");
const docs = await readFile(new URL("../docs/worktrees.md", import.meta.url), "utf8");

test("new session from the worktree graph reuses the selected checkout", () => {
  const start = appShell.indexOf("const handleWorktreeGraphNewSession");
  const end = appShell.indexOf("const handleOpenTalkMapForSession", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  assert.match(handler, /handleNewActivitySession\(wt\.path/);
  assert.doesNotMatch(handler, /addWorktree|fetch\([^\n]*worktrees/);
  assert.match(graph, /worktreeGraph\.newSessionFromMain/);
  assert.match(graph, /worktreeGraph\.newSessionFromWorktree/);
  assert.match(graph, /worktreeGraph\.newSessionReuseHint/);
});

test("worktree documentation keeps physical creation separate from session creation", () => {
  assert.match(docs, /New session.*never create another Git worktree/s);
  assert.match(docs, /New worktree\.\.\./);
  assert.match(docs, /DevSpace, task/);
});

test("worktree inspector lists sessions by cwd with an explicit empty state", () => {
  assert.match(graph, /session-runs\?scope=local/);
  assert.match(graph, /sameWorktreePath\(item\.session\.cwd, selectedPath\)/);
  assert.match(graph, /data-testid="worktree-associated-sessions"/);
  assert.match(graph, /worktreeGraph\.noAssociatedSessions/);
  assert.match(graph, /worktreeGraph\.sessionId/);
  assert.match(graph, /item\.id\.slice\(0, 8\)/);
  assert.match(graph, /sessionActivity\.status\.\$\{item\.status\}/);
  assert.match(docs, /cwd.*matches the selected worktree path/);
});

test("associated session rows open the exact local or remote session", () => {
  assert.match(graph, /onOpenSession\(item\.id, selectedWorktree\.path\)/);
  assert.match(graph, /data-worktree-associated-session=\{item\.id\}/);
  assert.match(graph, /type="button"/);
  assert.match(appShell, /onOpenSession=\{handleWorktreeGraphOpenSession\}/);
  const start = appShell.indexOf("const handleWorktreeGraphOpenSession");
  const end = appShell.indexOf("const handleOpenTalkMapForSession", start);
  assert.ok(start >= 0 && end > start);
  const handler = appShell.slice(start, end);
  assert.match(handler, /loadLocalSession\(sessionId\)/);
  assert.match(handler, /openRemoteSession\(device, sessionId/);
});

test("opening the graph prefers the current session worktree", () => {
  assert.match(graph, /preferredWorktreePath\(graph\?\.worktrees \?\? \[\], currentWorktreePath, currentSessionId, creationHistory\)/);
  assert.match(graph, /sameWorktreePath\(w\.path, sessionPreferredPath\)/);
  assert.match(graph, /currentWorktreePath && sameWorktreePath\(currentWorktreePath, wt\.path\)/);
  assert.match(appShell, /openWorktreeGraph\(topBarProjectPath, device, \{ id: topBarSession\?\.id \?\? null, cwd: topBarSession\?\.cwd \?\? null \}\)/);
  assert.match(appShell, /currentSessionId=\{worktreeGraphSessionId \?\? topBarSessionId\}/);
});

test("a verified creation record selects the linked worktree for its current session", () => {
  const worktrees = [
    { path: "/repo", isMain: true },
    { path: "/repo/.worktrees/task", isMain: false },
  ];
  assert.equal(preferredWorktreePath(worktrees, "/repo", "creator", {
    partial: false,
    records: [{ worktreePath: "/repo/.worktrees/task", sessionId: "creator", createdAt: "2026-01-01" }],
  }), "/repo/.worktrees/task");
});

test("verified worktree creators appear in the associated-session list", () => {
  assert.match(graph, /creationHistory: "1"/);
  assert.match(graph, /mergeAssociatedWorktreeSessions\(selectedPath, associatedSessions, creationHistory\)/);
  assert.match(graph, /data-testid="worktree-associated-sessions"/);
  assert.doesNotMatch(graph, /data-testid="worktree-creation-history"|worktreeGraph\.creationHistory/);
  assert.match(graph, /associatedSessionsIncomplete/);
  assert.match(graph, /associatedSessionsRefreshKey, fetchCreationHistory/);
  assert.match(docs, /whose `cwd` matches the selected worktree path, plus sessions whose successful tool history confirms they created that worktree/);
});

test("cwd sessions and verified creators share one list without duplicate IDs", () => {
  const activity = (id, cwd, name, status) => ({ session: { id, cwd, name, firstMessage: "" }, status });
  const result = mergeAssociatedWorktreeSessions("/repo/.worktrees/task", [
    activity("cwd-session", "/repo/.worktrees/task", "Runs here", "running"),
    activity("creator-session", "/repo", "Created it", "idle"),
  ], { partial: false, records: [
    { worktreePath: "/repo/.worktrees/task", sessionId: "cwd-session", sessionName: "Duplicate title", createdAt: "2026-01-01" },
    { worktreePath: "/repo/.worktrees/task", sessionId: "creator-session", sessionName: "Older title", createdAt: "2026-01-01" },
    { worktreePath: "/repo/.worktrees/task", sessionId: "history-only", sessionName: "History session", createdAt: "2026-01-01" },
  ] });
  assert.deepEqual(result, [
    { id: "cwd-session", title: "Runs here", status: "running" },
    { id: "creator-session", title: "Created it", status: "idle" },
    { id: "history-only", title: "History session" },
  ]);
});
