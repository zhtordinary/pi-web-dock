import assert from "node:assert/strict";
import test from "node:test";

const { buildFileSearchTree, collectFileSearchDirectories, flattenFileSearchTree, searchMatchIndices } = await import("./file-search-tree.ts");

test("groups flat file matches into an expanded search tree", () => {
  const tree = buildFileSearchTree([
    { path: "src/components/App.tsx", isDir: false },
    { path: "src/components/Chat.tsx", isDir: false },
    { path: "src/index.ts", isDir: false },
    { path: "README.md", isDir: false },
  ]);

  assert.deepEqual(tree.map((node) => node.path), ["src", "README.md"]);
  assert.deepEqual(tree[0].children.map((node) => node.path), ["src/components", "src/index.ts"]);
  assert.equal(tree[0].children[0].matched, false);
  assert.deepEqual(collectFileSearchDirectories(tree), ["src", "src/components"]);

  const expanded = new Set(collectFileSearchDirectories(tree));
  assert.deepEqual(
    flattenFileSearchTree(tree, expanded).map(({ node, depth }) => [node.path, depth]),
    [
      ["src", 0],
      ["src/components", 1],
      ["src/components/App.tsx", 2],
      ["src/components/Chat.tsx", 2],
      ["src/index.ts", 1],
      ["README.md", 0],
    ],
  );

  assert.deepEqual(
    flattenFileSearchTree(tree, new Set()).map(({ node }) => node.path),
    ["src", "README.md"],
  );
});

test("returns fuzzy filename character positions for search highlighting", () => {
  assert.deepEqual(searchMatchIndices("ChatInput.tsx", "chinp"), [0, 1, 4, 5, 6]);
  assert.deepEqual(searchMatchIndices("src", "src/"), [0, 1, 2]);
  assert.deepEqual(searchMatchIndices("ChatInput.tsx", "zzz"), []);
});
