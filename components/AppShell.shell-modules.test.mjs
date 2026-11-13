import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const sidekick = await readFile(new URL("./app-shell-sidekick.tsx", import.meta.url), "utf8");
const drawer = await readFile(new URL("./SidekickDrawer.tsx", import.meta.url), "utf8");
const worktree = await readFile(new URL("./app-shell-worktree.tsx", import.meta.url), "utf8");

const lines = (source) => source.split("\n").length;

test("AppShell delegates Sidekick state, lifecycle, embedded dismissal, and right-panel layout", () => {
  assert.match(appShell, /useAppShellSidekick\(/);
  assert.match(appShell, /useAppShellSidekickLifecycle/);
  assert.match(appShell, /<AppShellSidekickRightPanel active=\{isSidekickTabActive\}>/);
  assert.match(sidekick, /const \[sidekickOpen, setSidekickOpen\] = useState\(false\)/);
  assert.match(sidekick, /const \[sidekickCount, setSidekickCount\] = useState\(0\)/);
  assert.match(sidekick, /const \[sidekickRightPanelOpen, setSidekickRightPanelOpen\] = useState\(false\)/);
  assert.doesNotMatch(appShell, /const \[sidekick(?:Open|Count|RightPanelOpen)/);
  assert.doesNotMatch(appShell, /setSidekick(?:Open|Count|RightPanelOpen)\(/);
  assert.doesNotMatch(sidekick, /window\.addEventListener\("message", handleEmbeddedParentDismiss\)/);
  assert.match(drawer, /window\.addEventListener\("message", handleEmbeddedParentDismiss\)/);
  assert.match(drawer, /event\.source !== window\.parent/);
  assert.match(drawer, /EMBEDDED_SIDEKICK_DISMISS_EVENT/);
  assert.match(sidekick, /data-sidekick-right-panel-surface/);
  assert.match(sidekick, /SIDEKICK_TAB_ID = "sidekick"/);
});

test("AppShell delegates Worktree graph, Git qualification, Talk Map, and branches", () => {
  assert.match(appShell, /useAppShellWorktree\(/);
  assert.match(appShell, /useAppShellWorktreeCapability\(capabilityPath\)/);
  assert.match(appShell, /<AppShellWorktreeOverlays/);
  assert.match(worktree, /useState\(false\)/);
  assert.match(worktree, /useAppShellWorktreeCapability/);
  assert.match(worktree, /fetch\(capabilityPath/);
  assert.match(worktree, /handleWorktreeGraphOpenSession/);
  assert.match(worktree, /worktreeOpenRequestSerialRef/);
  assert.match(worktree, /<WorktreeGraphOverlay/);
  assert.match(worktree, /<TalkMapOverlay/);
  assert.match(worktree, /<BranchNavigator /);
  assert.match(worktree, /sendAgentCommand<[\s\S]*type: "fork"/);
  assert.ok(lines(appShell) <= 7511, `AppShell should stay slim after extraction; got ${lines(appShell)} lines`);
});
