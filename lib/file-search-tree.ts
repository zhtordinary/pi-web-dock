export interface FileSearchMatch {
  path: string;
  isDir: boolean;
}

export interface FileSearchTreeNode {
  name: string;
  path: string;
  isDir: boolean;
  matched: boolean;
  children: FileSearchTreeNode[];
}

export interface VisibleFileSearchTreeNode {
  node: FileSearchTreeNode;
  depth: number;
}

function cleanPath(path: string): string {
  return path.split("/").filter(Boolean).join("/");
}

function sortTree(nodes: FileSearchTreeNode[]): void {
  nodes.sort((left, right) => Number(right.isDir) - Number(left.isDir) || left.name.localeCompare(right.name));
  for (const node of nodes) sortTree(node.children);
}

export function buildFileSearchTree(matches: readonly FileSearchMatch[]): FileSearchTreeNode[] {
  const roots: FileSearchTreeNode[] = [];
  const nodesByPath = new Map<string, FileSearchTreeNode>();

  for (const match of matches) {
    const path = cleanPath(match.path);
    if (!path) continue;
    const parts = path.split("/");
    let parent = roots;
    let currentPath = "";
    for (let index = 0; index < parts.length; index += 1) {
      const name = parts[index];
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      let node = nodesByPath.get(currentPath);
      if (!node) {
        node = {
          name,
          path: currentPath,
          isDir: index < parts.length - 1 || match.isDir,
          matched: false,
          children: [],
        };
        nodesByPath.set(currentPath, node);
        parent.push(node);
      }
      if (index === parts.length - 1) {
        node.isDir = match.isDir;
        node.matched = true;
      }
      parent = node.children;
    }
  }

  sortTree(roots);
  return roots;
}

export function searchMatchIndices(text: string, query: string): number[] {
  const needle = query.trim().split("/").filter(Boolean).at(-1) ?? "";
  if (!needle) return [];
  const textChars = Array.from(text.toLowerCase());
  const queryChars = Array.from(needle.toLowerCase());
  const indices: number[] = [];
  let cursor = 0;
  for (const character of queryChars) {
    const index = textChars.indexOf(character, cursor);
    if (index < 0) return [];
    indices.push(index);
    cursor = index + 1;
  }
  return indices;
}

export function collectFileSearchDirectories(nodes: readonly FileSearchTreeNode[]): string[] {
  const paths: string[] = [];
  for (const node of nodes) {
    if (!node.isDir) continue;
    paths.push(node.path);
    paths.push(...collectFileSearchDirectories(node.children));
  }
  return paths;
}

export function flattenFileSearchTree(
  nodes: readonly FileSearchTreeNode[],
  expandedPaths: ReadonlySet<string>,
): VisibleFileSearchTreeNode[] {
  const visible: VisibleFileSearchTreeNode[] = [];
  const visit = (items: readonly FileSearchTreeNode[], depth: number) => {
    for (const node of items) {
      visible.push({ node, depth });
      if (node.isDir && expandedPaths.has(node.path)) visit(node.children, depth + 1);
    }
  };
  visit(nodes, 0);
  return visible;
}
