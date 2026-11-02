import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { TreeNode } = await jiti.import("./FileExplorer.tsx");
const { enLocale } = await jiti.import("@/lib/i18n/messages/en.ts");
const { translateMessage } = await jiti.import("@/lib/i18n/format.ts");

const source = await readFile(new URL("./FileExplorer.tsx", import.meta.url), "utf8");
const t = (key, params) => translateMessage("en", key, { en: enLocale.messages }, params);

function renderNode(node, { open = true, deleteConfirmation, depth = 0 } = {}) {
  return renderToStaticMarkup(React.createElement(TreeNode, {
    node,
    depth,
    cwd: "/hub",
    onOpenFile() {},
    expandedPaths: new Set(open ? [node.fullPath] : []),
    onToggleExpanded() {},
    highlightedPaths: new Set(),
    gitStatusByPath: new Map(),
    changedDirectoryPaths: new Set(),
    locatedPath: null,
    filter: {},
    onRequestDelete() {},
    deleteConfirmation,
    onRequestRename() {},
    onRequestCreate() {},
    onRequestUpload() {},
    t,
  }));
}

const linkedNode = {
  name: "linked",
  fullPath: "/hub/linked",
  isDir: true,
  size: 0,
  children: [],
  loaded: false,
  outsideLinkTarget: "/elsewhere/project",
};

test("an expanded link that leaves the project names its target and offers to allow it", () => {
  const html = renderNode(linkedNode);
  assert.match(html, /Links to \/elsewhere\/project, outside this project/);
  assert.match(html, /<button type="button" title="Browse \/elsewhere\/project until Pi Web restarts[^"]*"[^>]*>Allow browsing<\/button>/);
  assert.doesNotMatch(html, />empty</);
});

test("a collapsed link that leaves the project is marked on its row", () => {
  const html = renderNode(linkedNode, { open: false });
  assert.match(html, /aria-label="Links to \/elsewhere\/project, outside this project"/);
  assert.doesNotMatch(html, /Allow browsing/);
});

test("ordinary directories render no link notice", () => {
  const html = renderNode({ ...linkedNode, outsideLinkTarget: undefined, loaded: true });
  assert.doesNotMatch(html, /outside this project|Allow browsing/);
  assert.match(html, />empty</);
});

test("a folder that fails to load reports why instead of staying blank", () => {
  // Before #748 the failure was swallowed and the folder opened onto nothing.
  assert.doesNotMatch(source, /catch \{\s*\/\/ ignore\s*\}/);
  assert.match(source, /setLoadError\(error instanceof Error \? error\.message : String\(error\)\)/);
  assert.match(source, /\{loadError && \(\s*<div role="alert"/);
});

test("allowing a link sends the target the operator was shown", () => {
  assert.match(source, /\?type=allow-link`\), \{\s*method: "POST",\s*headers: \{ "Content-Type": "application\/json" \},\s*body: JSON\.stringify\(\{ target \}\)/);
  assert.match(source, /await allowOutsideLink\(node\.fullPath, pendingLinkTarget, peer\);/);
  // A pending link is never listed: the server would only refuse it.
  assert.match(source, /if \(next && !loaded && !pendingLinkTarget\) loadChildren\(\);/);
});

test("a link that encloses the project or home folder warns and confirms before allowing", () => {
  const html = renderNode({ ...linkedNode, outsideLinkTarget: "/", outsideLinkEncloses: true });
  assert.match(html, /That folder contains this project or your home folder\./);
  assert.doesNotMatch(renderNode(linkedNode), /contains this project/);
  assert.match(source, /if \(node\.outsideLinkEncloses && !window\.confirm\(t\("files\.allowEnclosingLinkConfirm"/);
});


test("files and folders confirm trash in their own row without the former modal", () => {
  for (const isDir of [false, true]) {
    const node = { name: "notes", fullPath: "/hub/notes", isDir, size: 0, children: [], loaded: true };
    const html = renderNode(node, { deleteConfirmation: { path: node.fullPath, busy: false, error: null, onConfirm() {}, onCancel() {} } });
    assert.match(html, /data-file-delete-confirm="true"/);
    assert.match(html, />Confirm<\/button>/);
    assert.match(html, />Cancel<\/button>/);
    assert.match(html, /title="\/hub\/notes"/);
    assert.doesNotMatch(html, /role="dialog"|aria-modal/);
  }
  assert.doesNotMatch(source, /file-delete-title|file-delete-message/);
});

test("nested trash confirmation targets only one row, keeps failures visible and disables duplicate actions", () => {
  const parent = { name: "docs", fullPath: "/hub/docs", isDir: true, size: 0, loaded: true,
    children: [{ name: "note.md", fullPath: "/hub/docs/note.md", isDir: false, size: 0 }] };
  const html = renderNode(parent, { deleteConfirmation: { path: "/hub/docs/note.md", busy: true, error: "Access denied", onConfirm() {}, onCancel() {} } });
  assert.equal((html.match(/data-file-delete-confirm="true"/g) ?? []).length, 1);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2);
  assert.match(html, /role="alert"[^>]*>[^<]*Access denied/);
  const unrelated = renderNode(parent, { deleteConfirmation: { path: "/hub/other", busy: false, error: null, onConfirm() {}, onCancel() {} } });
  assert.doesNotMatch(unrelated, /data-file-delete-confirm/);
});


test("deep inline confirmation keeps its actions on the visible right edge", () => {
  const node = { name: "deep.md", fullPath: "/hub/a/b/c/deep.md", isDir: false, size: 0 };
  const html = renderNode(node, { depth: 20, deleteConfirmation: { path: node.fullPath, busy: false, error: "Access denied", onConfirm() {}, onCancel() {} } });
  assert.match(html, /display:grid;grid-template-columns:minmax\(0, 1fr\) max-content/);
  assert.match(html, /padding-left:8px/);
  assert.doesNotMatch(html, /padding-left:288px/);
  assert.match(html, /min-width:0/);
  assert.match(html, /role="alert" style="padding-left:8px/);
  assert.match(html, /data-file-delete-confirm="true"/);
});
