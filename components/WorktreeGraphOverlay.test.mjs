import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { testTranslator } from "./test-locale.mjs";

const source = await readFile(new URL("./WorktreeGraphOverlay.tsx", import.meta.url), "utf8");
const messageSources = await Promise.all([
  readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8"),
  readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8"),
]);
const jiti = createJiti(import.meta.url, { tsconfigPaths: true, jsx: true });
const { WORKTREE_GRAPH_GEOMETRY, getWorktreeGraphMarkerLeft } = await jiti.import("./WorktreeGraphOverlay.tsx");
const { worktreeNeedsAttention } = await jiti.import("../lib/worktree-graph-types.ts");

test("status tabs filter timeline rows without requiring a search term", () => {
  assert.match(source, /filterTab === "active"/);
  assert.match(source, /const hasWorktreeFilter = filterTab !== "all" \|\| search\.trim\(\)\.length > 0/);
  assert.match(source, /hasWorktreeFilter\s*&&\s*!node\.isMainHead/);
  assert.doesNotMatch(source, /search \? matchedPaths\.has\(w\.path\) : true/);
  assert.doesNotMatch(source, /filterTab === "(?:merged|wip)"|worktreeGraph\.filter(?:Merged|Wip)/);
  for (const messages of messageSources) assert.doesNotMatch(messages, /"worktreeGraph\.filter(?:Merged|Wip)(?:Hint)?"/);
});

test("attention still includes merged worktrees with dirty or unknown state", () => {
  const worktree = { path: "/merged", isMain: false, status: "merged" };
  assert.equal(worktreeNeedsAttention({ ...worktree, dirtySummary: { state: "dirty", hasUncommitted: true } }), true);
  assert.equal(worktreeNeedsAttention({ ...worktree, dirtySummary: { state: "unavailable", hasUncommitted: false } }), true);
  assert.equal(worktreeNeedsAttention({ ...worktree, dirtySummary: { state: "clean", hasUncommitted: false } }), false);
});

test("worktree rows use the graph batch dirty projection and refresh inspection by path", () => {
  assert.match(source, /dirtySummary\?\.hasUncommitted/);
  assert.match(source, /data-testid="worktree-wip-inline"/);
  assert.match(source, /data-testid="worktree-wip-unavailable"/);
  assert.match(source, /dirtySummary\?\.state === "unavailable"/);
  assert.match(source, /worktreeGraph\.subtitle/);
  assert.doesNotMatch(source, /wip: graph\.counts\.wip/);
  assert.match(source, /inspection\?\.path === selectedWorktree\.path/);
  assert.match(source, /\[selectedPath, projectRoot, remotePeer, open, graph\]/);
});

test("delta counts use explicit topology copy", () => {
  assert.match(source, /worktreeGraph\.aheadBehind/);
  assert.match(source, /worktreeGraph\.deltaBasisHint/);
});

test("selection follows the visible worktree set", () => {
  assert.match(source, /filteredWorktrees\.some\(\(w\) => w\.path === currentPath\)/);
  assert.match(source, /if \(filteredWorktrees\.length > 0\) return filteredWorktrees\[0\]\?\.path \?\? null/);
});

test("at-base rows keep a visible diamond marker", () => {
  assert.match(source, /selectedWorktree\.status === "at_base"[\s\S]*?1\.5px solid var\(--text-dim\)/);
  assert.match(source, /wt\.status === "at_base"[\s\S]*?1\.5px solid var\(--text-dim\)/);
  assert.match(source, /worktreeGraph\.filterAtBase/);
});

test("legend translations leave status icons to the CSS markers", () => {
  for (const messages of messageSources) {
    assert.doesNotMatch(messages, /"worktreeGraph\.legendActive":\s*"[○●◇■]/);
    assert.doesNotMatch(messages, /"worktreeGraph\.legendMerged":\s*"[○●◇■]/);
    assert.doesNotMatch(messages, /"worktreeGraph\.legendAtBase":\s*"[○●◇■]/);
    assert.doesNotMatch(messages, /"worktreeGraph\.legendMain":\s*"[○●◇■]/);
  }
  assert.match(source, /worktreeGraph\.legendActive/);
  assert.match(source, /worktreeGraph\.legendMerged/);
  assert.match(source, /worktreeGraph\.legendAtBase/);
  assert.match(source, /worktreeGraph\.legendMain/);
});

test("at-base diamond markers use the compact size while other markers keep their size", () => {
  assert.match(source, /width: selectedWorktree\.status === "at_base" \? 9 : 10,/);
  assert.match(source, /height: selectedWorktree\.status === "at_base" \? 9 : 10,/);
  assert.match(source, /width: wt\.status === "at_base" \? 9 : 10,/);
  assert.match(source, /height: wt\.status === "at_base" \? 9 : 10,/);
});

test("mainline nodes center on the spine while worktree status markers stay inside cards", () => {
  const spineCenter = WORKTREE_GRAPH_GEOMETRY.spineLeft + WORKTREE_GRAPH_GEOMETRY.spineWidth / 2;
  for (const size of [WORKTREE_GRAPH_GEOMETRY.headSize, WORKTREE_GRAPH_GEOMETRY.commitSize]) {
    const markerLeft = getWorktreeGraphMarkerLeft(size);
    assert.equal(
      WORKTREE_GRAPH_GEOMETRY.timelinePaddingLeft + markerLeft + size / 2,
      spineCenter,
    );
  }
  assert.match(source, /left: node\.isMainHead[\s\S]*?getWorktreeGraphMarkerLeft\(WORKTREE_GRAPH_GEOMETRY\.headSize\)/);
  assert.match(source, /width: node\.isMainHead \? WORKTREE_GRAPH_GEOMETRY\.headSize : WORKTREE_GRAPH_GEOMETRY\.commitSize,/);
  assert.match(source, /boxSizing: "border-box"/);
  assert.match(source, /position: "absolute",\s*left: WORKTREE_GRAPH_GEOMETRY\.statusMarkerLeft,\s*top: "50%"/);
  assert.match(source, /padding: "6px 10px 6px 24px"/);
  assert.match(source, /translateY\(-50%\) rotate\(45deg\)/);
  assert.doesNotMatch(source, /position: "absolute",\s*left: -26,\s*top: "50%"/);
});

test("graph cleanup removes the checkout through the plain worktree API and keeps its branch", () => {
  assert.match(source, /apiPathForPeer\(remotePeer, "worktrees"\)/);
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /JSON\.stringify\(\{ cwd: projectRoot, path: targetPath, force: true \}\)/);
  assert.match(source, /window\.confirm\(t\("worktreeGraph\.removeConfirm"\)\)/);
  assert.match(testTranslator("en")("worktreeGraph.removeConfirm"), /the branch is kept/);
});

test("mainline checkout renders directly under the main head node with one dirty status badge", () => {
  assert.match(source, /const nodeMain = \(node\.mainPaths \?\? \[\]\)/);
  assert.match(source, /nodeMain\.map\(\(wt\) => renderWorktreeRow\(wt\)\)/);
  assert.match(source, /data-testid="worktree-wip-inline"/);
  const nodeHeader = source.slice(source.indexOf("{/* Node Header Row */}"), source.indexOf("{/* Mainline Checkout Worktree */}"));
  assert.doesNotMatch(nodeHeader, /dirtySummary|wipFiles|worktree-wip-inline/);
});

test("shortPath uses shortenPath and does not hardcode dot or main branch", () => {
  assert.doesNotMatch(source, /return "\. \(main\)"/);
  assert.match(source, /shortPath\(fullPath: string, root: string \| null\)/);
  assert.match(source, /shortenPath\(fullPath\)/);
});

test("github buttons render when project has a GitHub remote", () => {
  assert.match(source, /const githubUrl = graph\?\.githubUrl/);
  assert.match(source, /worktreeGraph\.openInGithub/);
  assert.match(source, /worktreeGraph\.openBranchInGithub/);
  assert.match(source, /GitHubIcon/);
});

test("dirty files and scoped commits render as separate sections", () => {
  const dirtySection = source.slice(source.indexOf("{t(\"worktreeGraph.uncommittedChanges\")}"));
  const dirtyFilesIdx = dirtySection.indexOf("selectedInspection.dirtyFiles");
  const commitsIdx = dirtySection.indexOf("selectedInspection.commits");
  assert.ok(dirtyFilesIdx > 0, "dirty files list is rendered");
  assert.ok(commitsIdx > 0, "scoped commit section is rendered");
  assert.ok(dirtyFilesIdx < commitsIdx, "dirty files list appears before scoped commits");
  assert.match(source, /selectedInspection\.commitMode === "head-history"/);
  assert.match(source, /worktreeGraph\.headHistory/);
  assert.match(source, /worktreeGraph\.newCommits/);
  assert.match(source, /worktreeGraph\.noHeadHistory/);
  assert.match(source, /worktreeGraph\.noNewCommits/);
  assert.doesNotMatch(source, /recentCommits|commitHistory/);
});


