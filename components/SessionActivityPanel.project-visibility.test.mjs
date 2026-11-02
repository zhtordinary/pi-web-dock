import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = await readFile(new URL("./SessionActivityPanel.tsx", import.meta.url), "utf8");
function callback(name, end, context) {
  const start = source.indexOf(`  const ${name} =`);
  assert.ok(start >= 0, name);
  const finish = source.indexOf(end, start);
  assert.ok(finish > start, end);
  const code = ts.transpileModule(source.slice(start, finish) + `\nglobalThis.extracted = ${name};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const sandbox = { Error, useCallback: fn => fn, ...context };
  vm.runInNewContext(code, sandbox);
  return sandbox.extracted;
}
const project = { projectKey: "path:/project", key: "path:/project\u0000peer", deviceId: "peer", label: "Project", deviceName: "Peer" };
const t = key => key;

test("project mutation awaits the real owner-device write without publishing a success notice", async () => {
  let finish;
  let args;
  const change = callback("changeProjectVisibility", "\n  const setFavorite", {
    setHidden: (...values) => { args = values; return new Promise(resolve => { finish = resolve; }); }, t,
  });
  const pending = change(project, true);
  assert.deepEqual(args, ["project", "path:/project", true, "peer"]);
  finish(true);
  await pending;
  const undo = change(project, false);
  assert.deepEqual(args, ["project", "path:/project", false, "peer"]);
  finish(true);
  await undo;
});

test("failed project writes propagate to the menu", async () => {
  const change = callback("changeProjectVisibility", "\n  const setFavorite", {
    setHidden: async () => false, t,
  });
  await assert.rejects(change(project, true), /projectVisibilityFailed/);
});

test("project menu stays busy until completion and stays open on failure", async () => {
  for (const fails of [false, true]) {
    let finish;
    let closed = false;
    let error = null;
    let busy;
    const action = () => new Promise((resolve, reject) => { finish = () => fails ? reject(new Error("write failed")) : resolve(); });
    const toggle = callback("toggleHidden", "\n  const toggleAutoHideEmptySubprojects", {
      onHide: action, onUnhide: undefined, setBusy: value => { busy = value; },
      setError: value => { error = value; }, closeMenu: () => { closed = true; }, t,
    });
    const pending = toggle();
    assert.equal(busy, "hide");
    assert.equal(closed, false);
    finish();
    await pending;
    assert.equal(closed, !fails);
    assert.equal(error, fails ? "write failed" : null);
    assert.equal(busy, null);
  }
});

test("both activity surfaces keep project visibility actions without a success notice", () => {
  assert.doesNotMatch(source, /ProjectVisibilityNotice|projectVisibilityNotice/);
  assert.doesNotMatch(source, /sessionActivity.projectHidden|sessionActivity.projectRestored/);
  assert.equal((source.match(/onChangeVisibility=\{activity\.changeProjectVisibility\}/g) ?? []).length, 2);
  assert.match(source, /sessionActivity\.projectVisibilityFailed/);
  const groups = [...source.matchAll(/onUnhide=\{(?:state|filters)\.group === "project"[^\n]+/g)].map(([value]) => value);
  assert.equal(groups.length, 2);
  for (const group of groups) {
    assert.match(group, /groupProject\?\.hidden/);
    assert.doesNotMatch(group, /void activity/);
  }
  assert.match(source, /hidden: item\.projectHidden/);
  assert.match(source, /hidden: entry\.hidden \?\? existing\?\.hidden/);
  assert.equal((source.match(/activity\.groups\.length === 0/g) ?? []).length, 2, "empty registered hidden projects do not get a false empty-state message");
});

test("project filters keep their width and use the existing top dropdown for hidden-page navigation", () => {
  const filter = source.slice(source.indexOf("function ActivityProjectFilter("), source.indexOf("interface SessionActivityDataOptions"));
  assert.doesNotMatch(filter, /onOpenHidden|viewHiddenProjects|hiddenProjects|<EyeOff/);
  assert.match(filter, /onHide=\{allowProjectHiding && !contextMenu\.info\.hidden/);
  assert.match(filter, /onUnhide=\{contextMenu\.info\.hidden/);
  assert.match(source, /allowProjectHiding=\{activityScope !== "hidden" && Boolean\(onOpenHidden\)\}/);
  assert.match(source, /allowProjectHiding=\{!hidden && Boolean\(onOpenHidden\)\}/);
  const dropdown = source.slice(source.indexOf("function ActivityDeviceFilter("), source.indexOf("function FilterSelect("));
  assert.match(dropdown, /if \(next === HIDDEN_PAGE_VALUE\)/);
  assert.match(dropdown, /if \(!hiddenView\) onOpenHidden\?\.\(\)/);
  assert.match(dropdown, /onOpenHidden \? \[hiddenPageOption\] : \[\]/);
});

test("local and remote new-session flows do not opt out of project hiding", async () => {
  const shell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  for (const [start, end] of [["  const handleNewSession =", "  const handleActivityProjectCwdChange"], ["  const handleNewActivitySession =", "  // 嵌入页收到外层活动面板"]]) {
    const flow = shell.slice(shell.indexOf(start), shell.indexOf(end, shell.indexOf(start)));
    assert.ok(flow.length > 0);
    assert.doesNotMatch(flow, /setHiddenView\(false\)|restoreSessionForStorage|setHidden\(/);
  }
});
