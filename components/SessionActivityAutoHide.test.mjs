import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
const panel = source.slice(source.indexOf("export function SessionActivityPanel"), source.indexOf("export function SessionActivitySidebar"));
const sidebar = source.slice(source.indexOf("export function SessionActivitySidebar"));

test("project headers expose the existing auto-hide policy control", () => {
  assert.match(source, /function AutoHideEmptySubprojectsButton/);
  assert.match(source, /data-project-auto-hide-empty-subprojects/);
  assert.match(source, /toggleAutoHideEmptySubprojects\(projectKey, sortSetting, deviceId, mutate, refresh\)/);
  assert.match(source, /aria-pressed=\{enabled\}/);
  assert.match(source, /aria-busy=\{busy\}/);
  assert.match(source, /color: enabled \? "var\(--text-dim\)" : "var\(--accent\)"/);
  assert.match(source, /\{enabled \? <EyeOff size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/> : <Eye size=\{14\} strokeWidth=\{1\.8\} aria-hidden="true" \/>\}/);
  assert.equal((panel.match(/<AutoHideEmptySubprojectsButton/g) ?? []).length, 1);
  assert.equal((sidebar.match(/<AutoHideEmptySubprojectsButton/g) ?? []).length, 1);
});

test("header policy control is limited to active activity views with subprojects", () => {
  assert.match(panel, /groupSubprojects\.length > 0[\s\S]*?activityScope === "all"[\s\S]*?state\.archiveView === "active"[\s\S]*?<AutoHideEmptySubprojectsButton/);
  assert.match(sidebar, /groupSubprojects\.length > 0[\s\S]*?activityScope === "all"[\s\S]*?filters\.archiveView === "active"[\s\S]*?<AutoHideEmptySubprojectsButton/);
});

test("header policy control catches failed writes and prevents duplicate clicks", () => {
  assert.match(source, /setFailed\(true\)/);
  assert.match(source, /if \(busy\) return;/);
  assert.match(source, /event\.stopPropagation\(\); void toggle\(\)/);
  assert.match(source, /failed \? `\$\{label\}: \$\{t\("sessionActivity\.projectPathActionFailed"\)\}` : label/);
});

test("auto-hide policy updates local projection without waiting for snapshot", () => {
  const helperStart = source.indexOf("async function toggleAutoHideEmptySubprojects");
  const helperEnd = source.indexOf("\n\nfunction AutoHideEmptySubprojectsButton", helperStart);
  const helper = source.slice(helperStart, helperEnd);
  assert.doesNotMatch(helper, /await refresh\(deviceId, true\)/);
  assert.match(helper, /void refresh\(deviceId, true\)/);
  assert.match(helper, /optimistic: true/);

  const mutationStart = source.indexOf("const mutateSubprojects = useCallback");
  const mutationEnd = source.indexOf("\n\n  const moveSessionToSubproject", mutationStart);
  const mutation = source.slice(mutationStart, mutationEnd);
  assert.match(mutation, /options\.optimistic/);
  assert.match(mutation, /subprojectSortSettings/);
  assert.match(mutation, /void pendingRefresh/);
});

test("activity sidebar moves A into its top filter row", () => {
  assert.match(source, /leadingControl\?: ReactNode/);
  assert.match(sidebar, /data-layout-control-group="activity-sidebar"/);
  assert.match(sidebar, /\{leadingControl\}/);
  assert.match(sidebar, /gridTemplateColumns: "minmax\(0, 1fr\) minmax\(0, 1fr\)"[\s\S]{0,180}flex: 1, minWidth: 0/);
});
