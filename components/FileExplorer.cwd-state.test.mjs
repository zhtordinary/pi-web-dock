import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("file tree clears stale roots and reloads when cwd or peer changes", () => {
  assert.match(source, /const prevWorkspaceRef = useRef<\{ cwd: string; peer\?: string \} \| null>\(null\);/);
  assert.match(source, /const workspaceChanged = prevWorkspaceRef\.current === null \|\| prevWorkspaceRef\.current\.cwd !== cwd \|\| prevWorkspaceRef\.current\.peer !== remotePeer;/);
  assert.match(source, /prevWorkspaceRef\.current = \{ cwd, peer: remotePeer \};/);
  assert.match(source, /if \(workspaceChanged\) \{[\s\S]*?setRoots\(\[\]\);[\s\S]*?setLoading\(true\);/);
  assert.match(source, /const requestPeer = remotePeer;[\s\S]*?fetchEntries\(cwd, filter, requestPeer\)/);
  assert.match(source, /clearNavigationState\(\);[\s\S]*?\}, \[clearNavigationState, cwd, remotePeer, filter, filterProjectKey, filterReady, filterScope, refreshKey, treeRefreshKey\]\);/);
});


test("uses a visible blue treatment for the located current file", () => {
  assert.match(source, /data-file-tree-located=\{located \? "true" : undefined\}/);
  const row = source.slice(source.indexOf("ref={rowRef}"), source.indexOf("{node.isDir && !confirmingDelete"));
  const background = row.match(/background: ([^\n]+),/)?.[1];
  const boxShadow = row.match(/boxShadow: ([^\n]+),/)?.[1];
  assert.ok(background && boxShadow);
  const current = { confirmingDelete: null, located: true, hovered: false };
  assert.equal(vm.runInNewContext(background, current), "rgba(37,99,235,0.16)");
  assert.match(vm.runInNewContext(boxShadow, current), /#3b82f6/);
  assert.equal(vm.runInNewContext(background, { ...current, confirmingDelete: {} }), "rgba(239,68,68,0.08)");
});
