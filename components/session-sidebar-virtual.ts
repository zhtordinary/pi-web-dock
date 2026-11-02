export interface SessionSidebarTreeNode<T> {
  session: T;
  children: SessionSidebarTreeNode<T>[];
}

export interface SessionSidebarBucket<T, B> {
  id: string;
  label: string;
  items: T[];
  value: B;
}

export type SessionSidebarRow<T, B> =
  | {
      kind: "project";
      id: string;
      path: string;
      height: number;
    }
  | {
      kind: "bucket";
      id: string;
      bucket: SessionSidebarBucket<T, B>;
      collapsed: boolean;
      height: number;
    }
  | {
      kind: "session";
      id: string;
      session: T;
      depth: number;
      hasChildren: boolean;
      collapsed: boolean;
      height: number;
    };

export const SESSION_ROW_HEIGHT = 54;
export const SUBPROJECT_ROW_HEIGHT = 38;
export const PROJECT_ROW_HEIGHT = 26;
export const VIRTUAL_ROW_PIN_BUDGET = 8;

export function getPinnedInteractionIds(
  activeIds: Iterable<string>,
  requiredHeaderIds: Iterable<string> = [],
  budget = VIRTUAL_ROW_PIN_BUDGET,
): Set<string> {
  const pinned = new Set<string>();
  const limit = Math.max(0, Math.min(VIRTUAL_ROW_PIN_BUDGET, budget));
  for (const id of [...activeIds, ...requiredHeaderIds]) {
    if (pinned.size >= limit) break;
    if (id) pinned.add(id);
  }
  return pinned;
}

export function flattenSessionTreeRows<T>(
  nodes: SessionSidebarTreeNode<T>[],
  collapsedIds: ReadonlySet<string> = new Set(),
  depth = 0,
): Array<SessionSidebarRow<T, never>> {
  const rows: Array<SessionSidebarRow<T, never>> = [];
  for (const node of nodes) {
    const id = String((node.session as { id?: unknown }).id ?? "");
    const collapsed = collapsedIds.has(id);
    rows.push({
      kind: "session",
      id,
      session: node.session,
      depth,
      hasChildren: node.children.length > 0,
      collapsed,
      height: SESSION_ROW_HEIGHT,
    });
    if (node.children.length > 0 && !collapsed) {
      rows.push(...flattenSessionTreeRows(node.children, collapsedIds, depth + 1));
    }
  }
  return rows;
}

export function flattenBucketedSessionRows<T, B>(
  buckets: SessionSidebarBucket<T, B>[],
  buildTree: (items: T[]) => SessionSidebarTreeNode<T>[],
  collapsedBucketKeys: ReadonlySet<string> = new Set(),
  collapsedSessionIds: ReadonlySet<string> = new Set(),
): Array<SessionSidebarRow<T, B>> {
  const rows: Array<SessionSidebarRow<T, B>> = [];
  for (const bucket of buckets) {
    const collapsed = collapsedBucketKeys.has(bucket.id);
    rows.push({ kind: "bucket", id: bucket.id, bucket, collapsed, height: SUBPROJECT_ROW_HEIGHT });
    if (!collapsed) rows.push(...flattenSessionTreeRows(buildTree(bucket.items), collapsedSessionIds) as Array<SessionSidebarRow<T, B>>);
  }
  return rows;
}

export interface VirtualRowWindow {
  offsets: number[];
  totalHeight: number;
  start: number;
  end: number;
  indices: number[];
}

export function computeRowOffsets<T, B>(rows: SessionSidebarRow<T, B>[]): { offsets: number[]; totalHeight: number } {
  const offsets: number[] = [];
  let totalHeight = 0;
  for (const row of rows) {
    offsets.push(totalHeight);
    totalHeight += Math.max(1, row.height);
  }
  return { offsets, totalHeight };
}

function firstVisibleIndex(offsets: number[], rows: { height: number }[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] + rows[middle].height <= position) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function getVirtualRowWindow<T, B>(
  rows: SessionSidebarRow<T, B>[],
  scrollTop: number,
  viewportHeight: number,
  overscanRows = 4,
  pinnedIds: ReadonlySet<string> = new Set(),
): VirtualRowWindow {
  const { offsets, totalHeight } = computeRowOffsets(rows);
  if (rows.length === 0) return { offsets, totalHeight, start: 0, end: 0, indices: [] };
  const top = Math.max(0, scrollTop);
  const bottom = top + Math.max(0, viewportHeight);
  const first = firstVisibleIndex(offsets, rows, top);
  const last = firstVisibleIndex(offsets, rows, Math.max(top, bottom - 1));
  const start = Math.max(0, first - overscanRows);
  const end = Math.min(rows.length, last + overscanRows + 1);
  const indices = new Set<number>();
  for (let index = start; index < end; index += 1) indices.add(index);
  const boundedPins = getPinnedInteractionIds(pinnedIds);
  rows.forEach((row, index) => {
    if (boundedPins.has(row.id)) indices.add(index);
  });
  return { offsets, totalHeight, start, end, indices: [...indices].sort((a, b) => a - b) };
}
