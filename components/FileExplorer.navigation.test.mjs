import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");

test("keyboard file navigation reuses the active tab and expands folders", () => {
  assert.match(source, /navigateFile: \(direction: FileNavigationDirection\) => Promise<boolean>/);
  assert.match(source, /const loadedChildrenRef = useRef\(new Map<string, FileNode\[\]>\(\)\)/);
  assert.match(source, /const visibleNodes = useMemo/);
  assert.match(source, /setExpandedPaths\(\(current\) => new Set\(current\)\.add\(directory\.fullPath\)\)/);
  assert.match(source, /const findFirstFile = useCallback\(async function findFirstFileIn/);
  assert.match(source, /reuseActiveTab: true/);
});

test("tree loading feeds keyboard navigation without stale child listings", () => {
  assert.match(source, /onChildrenLoaded: \(directory: string, entries: FileNode\[\]\) => void/);
  assert.match(source, /onChildrenLoadSettled: \(directory: string\) => void/);
  assert.match(source, /onChildrenLoaded\(node\.fullPath, entries\)/);
  assert.match(source, /clearNavigationState\(\)/);
});
