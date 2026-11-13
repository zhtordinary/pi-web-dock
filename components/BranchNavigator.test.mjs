import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";
import { installEnglishTestLocale } from "./test-locale.mjs";

const branchNavigatorSource = await readFile(new URL("./BranchNavigator.tsx", import.meta.url), "utf8");

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const { compressChain, countBranches, findLatestLeafId, selectTopLevelBranches } = await jiti.import("./BranchNavigator.tsx");

const msg = (id, role, text) => ({ type: "message", id, parentId: null, timestamp: "t", message: { role, content: text } });
const info = (id) => ({ type: "session_info", id, parentId: null, timestamp: "t", name: "x" });
const model = (id) => ({ type: "model_change", id, parentId: null, timestamp: "t", provider: "test", modelId: "test" });
const node = (entry, children = []) => ({ entry, children });

test("compressChain labels a chain by its first message entry", () => {
  const chain = node(msg("u1", "user", "原问题"), [node(msg("a1", "assistant", "回答"))]);
  const { labelEntry, node: rep } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
});

test("compressChain skips non-message entries such as session_info", () => {
  const chain = node(info("s1"), [node(msg("u1", "user", "原始问题"), [node(msg("a1", "assistant", "答"))])]);
  const { labelEntry, node: rep, skipped } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});

test("compressChain labels a projected chain by its preview but selects its representative", () => {
  const representative = {
    entry: msg("a1", "assistant", "回答"),
    children: [],
    compressedEntryIds: ["u1"],
    branchPreview: { role: "user", text: "原始问题" },
  };
  const chain = node(info("s1"), [representative]);
  const { branchPreview, node: rep, skipped } = compressChain(chain);
  assert.deepEqual(branchPreview, { role: "user", text: "原始问题" });
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});

test("compressChain falls back to the chain end when no message entry exists", () => {
  const chain = node(info("s1"), [node(info("s2"))]);
  const { labelEntry } = compressChain(chain);
  assert.equal(labelEntry.id, "s2");
});

test("selectTopLevelBranches returns all roots for multi-root trees", () => {
  const r1 = node(msg("u1", "user", "第一问"));
  const r2 = node(msg("u1b", "user", "第一问改"));
  assert.deepEqual(selectTopLevelBranches([r1, r2]).map((n) => n.entry.id), ["u1", "u1b"]);
});

test("countBranches matches selectable top-level branch roots", () => {
  const root = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"), [
    node(msg("u2", "user", "分支一")),
    node(msg("u2b", "user", "分支二")),
  ])]);
  assert.equal(countBranches([root]), 2);
});

test("selectTopLevelBranches returns children of the first branching node", () => {
  const b1 = node(msg("u2", "user", "分支一"));
  const b2 = node(msg("u2b", "user", "分支二"));
  const root = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"), [b1, b2])]);
  assert.deepEqual(selectTopLevelBranches([root]).map((n) => n.entry.id), ["u2", "u2b"]);
});

test("selectTopLevelBranches returns empty for a linear session", () => {
  const root = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"))]);
  assert.deepEqual(selectTopLevelBranches([root]), []);
});

test("selectTopLevelBranches works on preview-only server projections", () => {
  const arm1 = {
    entry: msg("a2", "assistant", "答一"),
    children: [],
    compressedEntryIds: ["s1", "u2"],
    branchPreview: { role: "user", text: "分支一" },
  };
  const arm2 = {
    entry: msg("a2b", "assistant", "答二"),
    children: [],
    compressedEntryIds: ["u2b"],
    branchPreview: { role: "user", text: "分支二" },
  };
  const branchPoint = { entry: msg("a1", "assistant", "答"), children: [arm1, arm2] };
  const root = { entry: msg("u1", "user", "第一问"), children: [branchPoint] };
  const topLevel = selectTopLevelBranches([root]);
  assert.deepEqual(topLevel.map((n) => n.entry.id), ["a2", "a2b"]);
  assert.deepEqual(compressChain(topLevel[0]).branchPreview, { role: "user", text: "分支一" });
  assert.equal(compressChain(topLevel[0]).node.entry.id, "a2");
});

test("multi-root metadata chains use their user previews and assistant representatives", () => {
  const r1 = node(model("m1"), [{
    entry: msg("a1", "assistant", "回答一"),
    children: [],
    compressedEntryIds: ["u1"],
    branchPreview: { role: "user", text: "第一问" },
  }]);
  const r2 = node(info("s2"), [{
    entry: msg("a2", "assistant", "回答二"),
    children: [],
    compressedEntryIds: ["u2"],
    branchPreview: { role: "user", text: "第二问" },
  }]);
  const topLevel = selectTopLevelBranches([r1, r2]);
  assert.deepEqual(topLevel.map((n) => compressChain(n).branchPreview.text), ["第一问", "第二问"]);
  assert.deepEqual(topLevel.map((n) => compressChain(n).node.entry.id), ["a1", "a2"]);
});

test("findLatestLeafId selects newest timeline leaf without a stored main branch", () => {
  const root = node({ ...msg("root", "user", "根"), timestamp: "2026-09-06T09:00:00.000Z" }, [
    node({ ...msg("old", "assistant", "旧线路"), timestamp: "2026-09-06T09:01:00.000Z" }),
    node({ ...msg("latest", "assistant", "最新线路"), timestamp: "2026-09-06T09:03:00.000Z" }),
  ]);
  assert.equal(findLatestLeafId([root]), "latest");
});

test("findLatestLeafId falls back to timeline order for equal or invalid timestamps", () => {
  const first = node(msg("first", "assistant", "第一条"));
  const last = node(msg("last", "assistant", "最后一条"));
  assert.equal(findLatestLeafId([first, last]), "last");

  const valid = node({ ...msg("valid", "assistant", "有效时间"), timestamp: "2026-09-06T09:00:00.000Z" });
  assert.equal(findLatestLeafId([valid, last]), "last");
});

// Regression cases introduced by upstream v0.10.0, retained with Reader cases.

const { BranchNavigator, BranchNavigatorPanel, buildActivePath, hasSessionBranches } = await jiti.import("./BranchNavigator.tsx");

const React = await jiti.import("react");

const { renderToStaticMarkup } = await jiti.import("react-dom/server");

const { I18nProvider } = await jiti.import("@/hooks/useI18n.tsx");

const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");


test("inline branch trigger leaves the panel to the shared top-panel host", () => {
  assert.doesNotMatch(branchNavigatorSource, /createPortal/);
  assert.match(branchNavigatorSource, /export function BranchNavigatorPanel/);
  assert.match(branchNavigatorSource, /maxHeight: "min\(600px, 75dvh\)"/);
  assert.match(branchNavigatorSource, /overflow: "auto"/);
  assert.doesNotMatch(branchNavigatorSource, /height: "min\(600px, 75dvh\)"/);
  assert.doesNotMatch(branchNavigatorSource, /minHeight: 220/);
  assert.match(branchNavigatorSource, /aria-haspopup=\"dialog\"/);
  assert.equal(typeof BranchNavigatorPanel, "function");
});

test("hasSessionBranches distinguishes linear sessions from branched sessions", () => {
  const linear = node(msg("u1", "user", "第一问"), [node(msg("a1", "assistant", "答"))]);
  const branched = node(msg("u1", "user", "第一问"), [
    node(msg("a1", "assistant", "答"), [
      node(msg("u2", "user", "分支一")),
      node(msg("u2b", "user", "分支二")),
    ]),
  ]);

  assert.equal(hasSessionBranches([]), false);
  assert.equal(hasSessionBranches([linear]), false);
  assert.equal(hasSessionBranches([branched]), true);
  assert.equal(hasSessionBranches([linear, branched]), true);
});


// --- #509 regression: recursive tree consumption overflowed the stack on a
// linear session (depth == entry count). The iterative rewrite must survive a
// chain far deeper than V8's call-stack limit.

// Build a linear chain of `n` nodes (each child is the previous one).
function linearTree(n) {
  const nodes = [];
  let prev = null;
  for (let i = 0; i < n; i++) {
    const entry = { type: "message", id: `e${i}`, parentId: prev, timestamp: "t", message: { role: "user", content: `m${i}` } };
    nodes.push({ entry, children: [] });
    if (prev) nodes[nodes.length - 2].children = [nodes[nodes.length - 1]];
    prev = `e${i}`;
  }
  return nodes[0];
}


test("buildActivePath finds the leaf on a 6000-deep linear chain without a stack overflow", () => {
  const root = linearTree(6000);
  const path = buildActivePath([root], "e5999");
  assert.equal(path.size, 6000);
  assert.ok(path.has("e0"));
  assert.ok(path.has("e5999"));
});


test("hasSessionBranches reports false for a linear chain (no branching) and true otherwise", () => {
  assert.equal(hasSessionBranches([linearTree(5000)]), false);
  const root = linearTree(3);
  root.children[0].children[0].children = [
    { entry: { type: "message", id: "b1", parentId: "e2", timestamp: "t", message: { role: "user", content: "x" } }, children: [] },
    { entry: { type: "message", id: "b2", parentId: "e2", timestamp: "t", message: { role: "user", content: "y" } }, children: [] },
  ];
  assert.equal(hasSessionBranches([root]), true);
  assert.equal(hasSessionBranches([root]), true);
});


test("hasSessionBranches reports true for multiple root nodes (a branch from the first message)", () => {
  // Each root has a single child, so no node.children.length > 1 — only the
  // multiple-root shape makes this a branch.
  const r1 = { entry: { type: "message", id: "r1", parentId: null, timestamp: "t", message: { role: "user", content: "a" } }, children: [] };
  const r2 = { entry: { type: "message", id: "r2", parentId: null, timestamp: "t", message: { role: "user", content: "b" } }, children: [] };
  assert.equal(hasSessionBranches([r1, r2]), true);
});


test("compressChain never labels a branch with a transcript system message", () => {
  // Pi >= 0.86 roots new sessions at a system message holding the prompt.
  const system = { type: "message", id: "sys", parentId: null, timestamp: "t", message: { role: "system", content: "", sections: { preamble: "You are an expert coding assistant." } } };
  const chain = node(system, [node(msg("u1", "user", "原始问题"), [node(msg("a1", "assistant", "答"))])]);
  const { labelEntry, node: rep, skipped } = compressChain(chain);
  assert.equal(labelEntry.id, "u1");
  assert.equal(rep.entry.id, "a1");
  assert.equal(skipped, 2);
});


test("a locked navigator keeps the tree readable but offers no branch to switch to", () => {
  const tree = [node(msg("u1", "user", "question"), [
    node(msg("a1", "assistant", "first answer")),
    node(msg("a2", "assistant", "second answer")),
  ])];
  const render = (locked) => renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(BranchNavigator, {
      tree,
      activeLeafId: "a1",
      onLeafChange() {},
      open: true,
      hasSession: true,
      locked,
    }),
  ));
  const lockedNotice = enLocale.messages["i18n.branchesLockedWhileRunning"].replace("'", "&#x27;");

  const unlocked = render(false);
  assert.match(unlocked, /second answer/);
  assert.equal((unlocked.match(/cursor:pointer/g) ?? []).length, 4);
  assert.doesNotMatch(unlocked, new RegExp(lockedNotice));

  const locked = render(true);
  assert.match(locked, /second answer/);
  assert.match(locked, new RegExp(lockedNotice));
  // Only the panel header stays clickable; branch rows are not.
  assert.equal((locked.match(/cursor:pointer/g) ?? []).length, 1);
  assert.equal((locked.match(/cursor:default/g) ?? []).length, 3);
});

test("active leaf is rendered with a current branch badge while ancestors and other branches are not", () => {
  const tree = [node(msg("u1", "user", "root question"), [
    node(msg("a1", "assistant", "first answer"), [
      node(msg("u2a", "user", "branch A")),
      node(msg("u2b", "user", "branch B")),
    ]),
  ])];
  const html = renderToStaticMarkup(React.createElement(
    I18nProvider,
    null,
    React.createElement(BranchNavigator, {
      tree,
      activeLeafId: "u2a",
      onLeafChange() {},
      open: true,
      hasSession: true,
    }),
  ));

  const currentBadge = enLocale.messages["branches.current"] ?? "Current";
  const occurrences = (html.match(new RegExp(currentBadge, "g")) ?? []).length;
  assert.ok(occurrences >= 2, "Expected legend and active branch badge to contain Current label");
  assert.match(html, /\[Current\] \(user\) branch A/);
  assert.match(html, /\[History path\]/);
  assert.match(html, /\[Other branch\]/);
});
