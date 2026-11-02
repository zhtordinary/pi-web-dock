import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./WorktreeGraphOverlay.tsx", import.meta.url), "utf8");
const worktreeSource = await readFile(new URL("../lib/worktree.ts", import.meta.url), "utf8");
const typesSource = await readFile(new URL("../lib/worktree-graph-types.ts", import.meta.url), "utf8");
const zhCN = await readFile(new URL("../lib/i18n/messages/zh-CN.ts", import.meta.url), "utf8");
const en = await readFile(new URL("../lib/i18n/messages/en.ts", import.meta.url), "utf8");
const zhTW = await readFile(new URL("../lib/i18n/messages/zh-TW.ts", import.meta.url), "utf8");

test("i18n message bundles contain head commit time and file modified time translations", () => {
  for (const bundle of [zhCN, en, zhTW]) {
    assert.match(bundle, /"worktreeGraph\.headCommitTime":/);
    assert.match(bundle, /"worktreeGraph\.fileModifiedTime":/);
  }
});

test("backend inspectWorktreeNode attaches mtimeMs to dirty files", () => {
  assert.match(typesSource, /dirtyFiles:\s*Array<\{\s*status:\s*string;\s*path:\s*string;\s*mtimeMs\?:/);
  assert.match(worktreeSource, /statAsync\(join\(target\.path, targetRelPath\)\)/);
  assert.match(worktreeSource, /mtimeMs = Math\.round\(st\.mtimeMs\)/);
  assert.match(worktreeSource, /\.\.\.\(mtimeMs !== undefined \? \{ mtimeMs \} : \{\}\)/);
});

test("formatDate handles both second and millisecond timestamps, formatFullDate exists", () => {
  assert.match(source, /isoOrTs > 1e11 \? isoOrTs : isoOrTs \* 1000/);
  assert.match(source, /function formatFullDate\(isoOrTs: string \| number\): string/);
});

test("uncommitted files view renders file mtime and detailed tooltip", () => {
  assert.match(source, /const mtimeFormatted = f\.mtimeMs \? formatDate\(f\.mtimeMs, t\) : ""/);
  assert.match(source, /title=\{mtimeFull \? `\$\{f\.path\} · \$\{t\("worktreeGraph\.fileModifiedTime"/);
  assert.match(source, /\{mtimeFormatted \? \(/);
});

test("commits inspector list renders commit timestamp and detailed tooltip", () => {
  assert.match(source, /const commitTimeFormatted = commit\.isoDate \? formatDate\(commit\.isoDate, t\) : ""/);
  assert.match(source, /t\("worktreeGraph\.headCommitTime", \{ time: commitTimeFull \}\)/);
  assert.match(source, /\{commitTimeFormatted \? \(/);
});

test("timeline worktree row shows tooltip clarifying that the relative time is the latest commit time", () => {
  assert.match(source, /t\("worktreeGraph\.headCommitTime", \{ time: formatFullDate\(wt\.headTimestamp \|\| wt\.headIsoDate\) \}\)/);
});
