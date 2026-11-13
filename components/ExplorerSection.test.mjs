import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./ExplorerSection.tsx", import.meta.url), "utf8");

test("aborts stale file-index requests during search cleanup", () => {
  assert.match(source, /const controller = new AbortController\(\);/);
  assert.match(source, /fetch\(api\(`file-index\?cwd=.*\), \{ signal: controller\.signal \}\)/);
  assert.match(source, /hideGitIgnored=1/);
  assert.match(source, /onFilterChange=\{handleExplorerFilterChange\}/);
  assert.match(source, /if \(controller\.signal\.aborted \|\| searchSeqRef\.current !== seq\) return;/);
  assert.match(source, /clearTimeout\(timer\);\s*controller\.abort\(\);/);
});

test("locating an active file outside selected cwd re-roots the explorer", () => {
  assert.match(source, /const \[explorerCwd, setExplorerCwd\] = useState<string \| null>\(cwd\);/);
  assert.match(source, /const canLocateActiveFile = Boolean\(activeFilePath && \(cwd \|\| explorerCwd\)\);/);
  assert.match(source, /const targetRoot = activeFileIsInsideCwd \? cwd : getFileDirectory\(activeFilePath\);/);
  assert.match(source, /setExplorerCwd\(targetRoot\);/);
  assert.match(source, /cwd=\{explorerCwd\}/);
});

test("reuses the active file tab for file-panel arrow navigation", () => {
  assert.match(source, /filePanelOpen\?: boolean/);
  assert.match(source, /if \(!filePanelOpen \|\| !open \|\| !activeFilePath\) return;/);
  assert.match(source, /event\.key === "ArrowDown" \? "next" : "previous"/);
  assert.match(source, /target\.closest\("input, textarea, select, button, a, \[contenteditable='true'\]"\)/);
  assert.match(source, /navigateFile/);
  assert.match(source, /activeFilePath=\{activeFilePath\}/);
});

test("provides continuous keyboard navigation across file search results", () => {
  assert.match(source, /handleSearchKeyDown/);
  assert.match(source, /event\.key === "ArrowDown"/);
  assert.match(source, /event\.key === "ArrowUp"/);
  assert.match(source, /event\.key === "Enter"/);
  assert.match(source, /event\.key === "Escape"/);
  assert.match(source, /onKeyDown=\{handleSearchKeyDown\}/);
});

test("file visibility eye reflects current filtered state", () => {
  const start = source.indexOf("onClick={() => explorerRef.current?.toggleHiddenVisibility()}");
  const end = source.indexOf("</ToolbarIconButton>", start);
  assert.ok(start >= 0 && end > start);
  const eyeButton = source.slice(start, end);
  assert.match(eyeButton, /title=\{hiddenActive \? t\("files\.showHiddenItems"\) : t\("files\.restoreHiddenSettings"\)\}/);
  assert.match(eyeButton, /ariaPressed=\{!hiddenActive\}/);
  assert.match(eyeButton, /color=\{hiddenActive \? "var\(--text-dim\)" : "var\(--accent\)"\}/);
  assert.ok(eyeButton.indexOf("M9.88") < eyeButton.indexOf("M2 12"), "filtered files must use EyeOff before all-visible files use Eye");
});

test("filter settings gear button toggles filter panel and reflects open state", () => {
  const start = source.indexOf("onClick={() => explorerRef.current?.toggleFilterSettings()}");
  const end = source.indexOf("</ToolbarIconButton>", start);
  assert.ok(start >= 0 && end > start, "gear button must use ToolbarIconButton with toggleFilterSettings");
  const gearButton = source.slice(start, end);
  assert.match(gearButton, /title=\{t\("files\.filterSettings"\)\}/);
  assert.match(gearButton, /ariaPressed=\{filterSettingsOpen\}/);
  assert.match(gearButton, /color=\{filterSettingsOpen \? "var\(--accent\)" : "var\(--text-dim\)"\}/);
  assert.match(gearButton, /background=\{filterSettingsOpen \? "var\(--bg-selected\)" : "none"\}/);
  assert.match(source, /onFilterSettingsOpenChange=\{setFilterSettingsOpen\}/);
});

test("highlights active file and keyboard-selected search results", () => {
  assert.match(source, /const isActive = !node\.isDir && activeFilePath === fullPath;/);
  assert.match(source, /aria-current=\{isActive \? "true" : undefined\}/);
  assert.match(source, /aria-selected=\{isSelected \|\| isActive\}/);
});

test("toggles folder without wiping search query and provides locateInTree action", () => {
  assert.match(source, /toggleSearchFolder\(node\.path\)/);
  assert.match(source, /files\.locateInTree/);
  assert.match(source, /explorerRef\.current\?\.expandToPath\(fullPath\)/);
});


test("Explorer toolbar accepts a leading layout control before its title", () => {
  assert.match(source, /leadingControl\?: ReactNode/);
  assert.match(source, /\{leadingControl\}\s*\{showSessionToggle && onToggleSessions && !leadingControl \?/);
});

test("Explorer header controls sibling sessions instead of collapsing Explorer", () => {
  assert.ok(source.includes("const showActions = open && Boolean(explorerCwd);"));
  assert.ok(source.includes("onEnsureOpen"));
  assert.ok(source.includes("onToggleSessions"));
  assert.ok(source.includes("aria-expanded={sessionsOpen}"));
  assert.doesNotMatch(source, /onClick=\{onEnsureOpen\}[\s\S]{0,80}aria-expanded=\{open\}/);
});

test("Explorer toolbar is icon-only and names its session toggle accessibly", () => {
  assert.doesNotMatch(source, /<span>.*files\.readerTitle/);
  assert.match(source, /aria-label=\{sessionsOpen \? t\("sidebar\.hideSessions"\) : t\("sidebar\.showSessions"\)\}/);
});
