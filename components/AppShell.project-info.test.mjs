import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const worktreeShell = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");
const english = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const chinese = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const traditionalChinese = await readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8");

test("project info follows the effective local or remote top-bar session", () => {
  assert.match(appShell, /const topBarSession = remoteSession \? remoteSession.sessionInfo : selectedSession;/);
  assert.match(appShell, /const workspaceSession = topBarSession;/);
  assert.match(appShell, /workspaceSession\.projectRoot \?\? workspaceSession\.cwd/);
  assert.match(appShell, /workspaceSession\.branch/);
  assert.match(appShell, /workspaceSession\.isWorktree/);
  assert.match(appShell, /const topBarIsGit = activeWorktreeCapability\?\.isGit === true/);
  assert.match(appShell, /session\.projectSection/);
  assert.match(appShell, /session\.copyGitWorktree/);
});

test("project and session info remain separate responsive sections", () => {
  assert.match(appShell, /const projectInfoSection = projectRows\.length > 0/);
  assert.match(appShell, /display: "flex", flexDirection: "column", gap: isMobile \? 16 : 20/);
  assert.match(appShell, /\{sessionInfoSection\}[\s\S]*?\{projectInfoSection\}/);
});

test("project info labels exist in every bundled Reader locale", () => {
  for (const messages of [english, chinese]) {
    for (const key of [
      "session.projectSection",
      "session.projectDir",
      "session.gitBranch",
      "session.gitWorktree",
      "session.copyProjectDir",
      "session.copyGitBranch",
      "session.copyGitWorktree",
    ]) {
      assert.match(messages, new RegExp(`\\"${key}\\"\\s*:`));
    }
  }
});


test("worktree graph highlights the session cwd before its shared project root", () => {
  assert.match(appShell, /const worktreeGraphCurrentPath = remoteSession\?\.sessionInfo\?\.cwd[\s\S]*?selectedSession\?\.cwd[\s\S]*?selectedSession\?\.projectRoot/);
  assert.match(worktreeShell, /currentWorktreePath=\{worktreeGraphSessionPath \?\? worktreeGraphCurrentPath\}/);
  assert.match(appShell, /currentSessionId=\{worktreeGraphSessionId \?\? topBarSessionId\}/);
});

test("graph capability is queried for the actual project rather than guessed from a session", () => {
  assert.match(appShell, /worktrees\?cwd=\$\{encodeURIComponent\(topBarProjectPath\)\}/);
  assert.match(appShell, /activeWorktreeCapability\?\.isGit === true/);
  assert.match(appShell, /topBarProjectPath && topBarIsGit && \([\s\S]*data-top-bar-worktree-graph="true"/);
  const sessionTopBarStart = appShell.indexOf("const sessionTopBar");
  const sessionTopBarEnd = appShell.indexOf("  const chatWindowContent", sessionTopBarStart);
  const sessionTopBar = appShell.slice(sessionTopBarStart, sessionTopBarEnd);
  assert.doesNotMatch(sessionTopBar, /worktreeGraph\.open/);
  assert.match(appShell, /if \(!topBarIsGit\) \{ setWorktreeCapabilityRevision\(\(value\) => value \+ 1\); return; \}/);
});

test("Git action is available only in confirmed Git projects", () => {
  const condition = appShell.match(/\{([^\n{}]+) && \(\n\s*<button\n\s*type="button"\n\s*data-top-bar-worktree-graph="true"/);
  assert.ok(condition, "Git action visibility condition missing");
  const visible = new Function("topBarProjectPath", "topBarIsGit", `return Boolean(${condition[1]});`);
  assert.equal(visible("/repo", true), true);
  assert.equal(visible("/repo", false), false);
  assert.equal(visible(null, true), false);
  assert.match(appShell, /const topBarSessionActive = showChat \|\| Boolean\(remoteSession\)/);
  assert.match(appShell, /remoteSession\.newSessionCwd\n\s*: selectedSession\?\.projectRoot \?\? selectedSession\?\.cwd \?\? effectiveNewSessionCwd/);
});

test("Git entry and dialog title use the same short name in every bundled locale", () => {
  for (const messages of [english, chinese, traditionalChinese]) {
    assert.match(messages, /"worktreeGraph\.open": "Git"/);
    assert.match(messages, /"worktreeGraph\.title": "Git"/);
  }
});

test("worktree graph action stays in the global top toolbar", () => {
  const sessionTopBarStart = appShell.indexOf("const sessionTopBar");
  const sessionTopBarEnd = appShell.indexOf("  const chatWindowContent", sessionTopBarStart);
  const appTopBarStart = appShell.indexOf('className="app-top-bar"');
  const sessionTopBar = appShell.slice(sessionTopBarStart, sessionTopBarEnd);
  const appTopBar = appShell.slice(appTopBarStart);
  const graphAction = appTopBar.indexOf('data-top-bar-worktree-graph="true"');

  assert.ok(sessionTopBarStart >= 0 && sessionTopBarEnd > sessionTopBarStart, "session top bar boundary missing");
  assert.ok(appTopBarStart >= 0, "global top bar missing");
  assert.ok(graphAction >= 0, "Git action must be in the global top toolbar");
  assert.ok(appTopBar.indexOf("handleTopBarWorktreeGraph", graphAction) > graphAction);
  assert.doesNotMatch(sessionTopBar, /worktreeGraph\.open/);
});

test("confirmed Git projects use an accent icon in the global top toolbar", () => {
  const appTopBarStart = appShell.indexOf('className="app-top-bar"');
  const appTopBar = appShell.slice(appTopBarStart);
  const graphAction = appTopBar.indexOf('data-top-bar-worktree-graph="true"');
  const button = appTopBar.slice(graphAction, appTopBar.indexOf("</button>", graphAction));
  assert.match(button, /<GitFork[^>]+style=\{\{ color: "var\(--accent\)", flexShrink: 0 \}\}/);
  assert.match(button, /onClick=\{handleTopBarWorktreeGraph\}/);
  assert.match(button, /\{!isMobile && <span>\{translate\("worktreeGraph\.open"\)\}<\/span>\}/);
});
