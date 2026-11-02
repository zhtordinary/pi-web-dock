import type { SubprojectDefinition, SubprojectSortMode } from "./subproject-state.ts";

export const UNCLASSIFIED_SUBPROJECT_ID = "__unclassified__" as const;

function pathKeyBody(input: string): string | null {
  const value = input.trim();
  if (value.startsWith("path:")) return value.slice("path:".length);
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value) ? value : null;
}

function normalizePath(value: string): { absolute: boolean; value: string } {
  const slash = value.replaceAll("\\", "/");
  const absolute = slash.startsWith("/") || /^[A-Za-z]:\//.test(slash);
  const parts: string[] = [];
  for (const part of slash.split("/")) {
    if (!part || part === ".") continue;
    if (part === ".." && parts.length > 0 && parts.at(-1) !== "..") {
      parts.pop();
    } else if (part !== ".." || !absolute) {
      parts.push(part);
    }
  }
  return { absolute, value: `${absolute ? "/" : ""}${parts.join("/")}` };
}

/**
 * UI-only compatibility comparison for historical path key shapes. The API
 * remains the authorization boundary; it still validates canonical keys.
 */
export function projectKeysMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  const a = left.trim();
  const b = right.trim();
  if (a === b) return true;
  const leftBody = pathKeyBody(a);
  const rightBody = pathKeyBody(b);
  if (leftBody === null || rightBody === null) return false;
  const leftPath = normalizePath(leftBody);
  const rightPath = normalizePath(rightBody);
  if (leftPath.absolute === rightPath.absolute) return leftPath.value === rightPath.value;

  const absolute = leftPath.absolute ? leftPath.value : rightPath.value;
  const relative = leftPath.absolute ? rightPath.value : leftPath.value;
  // ponytail: suffix bridge covers old workspace-relative keys; server still
  // enforces exact canonical identity before mutating state.
  const suffix = relative.replace(/^(?:\.\.\/)+/, "").replace(/^\.\//, "");
  const absoluteBody = absolute.replace(/^\/+/, "");
  return suffix === absoluteBody || absoluteBody.endsWith(`/${suffix}`);
}

export interface SubprojectBucket<T> {
  id: string;
  label: string;
  subproject?: SubprojectDefinition;
  items: T[];
}

export interface SubprojectBucketSortOptions<T> {
  mode?: SubprojectSortMode;
  customOrder?: readonly string[];
  /** Must return negative when left should appear before right. */
  compareItems?: (left: T, right: T) => number;
}

export function orderedSubprojectIds(
  definitions: readonly Pick<SubprojectDefinition, "id">[],
  customOrder: readonly string[] = [],
): string[] {
  const ids = new Set(definitions.map((definition) => definition.id));
  const seen = new Set<string>();
  return [...customOrder, ...definitions.map((definition) => definition.id)]
    .filter((id) => ids.has(id) && !seen.has(id) && seen.add(id));
}

export function reorderSubprojectIds(
  order: readonly string[],
  sourceId: string,
  targetId: string,
  before: boolean,
): string[] {
  if (sourceId === targetId || !order.includes(sourceId) || !order.includes(targetId)) return [...order];
  const next = order.filter((id) => id !== sourceId);
  const targetIndex = next.indexOf(targetId);
  next.splice(targetIndex + (before ? 0 : 1), 0, sourceId);
  return next;
}

export function filterSubprojectItems<T extends { subprojectId?: string; session?: { subprojectId?: string } }>(
  items: readonly T[],
  hiddenSubprojectIds: ReadonlySet<string>,
): T[] {
  return items.filter((item) => {
    const subprojectId = item.subprojectId ?? item.session?.subprojectId;
    return !subprojectId || !hiddenSubprojectIds.has(subprojectId);
  });
}

function preferredItem<T>(items: readonly T[], compareItems?: (left: T, right: T) => number): T | undefined {
  if (items.length === 0) return undefined;
  let preferred = items[0];
  if (!compareItems) return preferred;
  for (const item of items.slice(1)) {
    if (compareItems(item, preferred) < 0) preferred = item;
  }
  return preferred;
}

export function sortSubprojectBuckets<T>(
  buckets: readonly SubprojectBucket<T>[],
  options: SubprojectBucketSortOptions<T> = {},
): SubprojectBucket<T>[] {
  const mode = options.mode ?? "custom";
  const originalOrder = new Map(buckets.map((bucket, index) => [bucket.id, index]));
  const customOrder = new Map(orderedSubprojectIds(
    buckets.filter((bucket) => bucket.subproject).map((bucket) => bucket.subproject!),
    options.customOrder,
  ).map((id, index) => [id, index]));
  const preferred = new Map(buckets.map((bucket) => [bucket.id, preferredItem(bucket.items, options.compareItems)]));
  return [...buckets].sort((left, right) => {
    if (mode === "alpha") {
      return left.label.localeCompare(right.label) || originalOrder.get(left.id)! - originalOrder.get(right.id)!;
    }
    if (mode === "inherit") {
      const leftItem = preferred.get(left.id);
      const rightItem = preferred.get(right.id);
      if (leftItem && !rightItem) return -1;
      if (!leftItem && rightItem) return 1;
      if (leftItem && rightItem && options.compareItems) {
        const itemOrder = options.compareItems(leftItem, rightItem);
        if (itemOrder !== 0) return itemOrder;
      }
      return originalOrder.get(left.id)! - originalOrder.get(right.id)!;
    }
    return (customOrder.get(left.id) ?? Number.MAX_SAFE_INTEGER)
      - (customOrder.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || originalOrder.get(left.id)! - originalOrder.get(right.id)!;
  });
}

/** Keep every defined bucket, then place unassigned rows in implicit bucket. */
export function groupBySubproject<T extends { subprojectId?: string; session?: { subprojectId?: string } }>(
  items: readonly T[],
  definitions: readonly SubprojectDefinition[],
  projectKey: string,
  unclassifiedLabel: string,
  options: SubprojectBucketSortOptions<T> = {},
): SubprojectBucket<T>[] {
  const owned = definitions.filter((definition) => projectKeysMatch(definition.projectKey, projectKey));
  const byId = new Map(owned.map((definition) => [definition.id, [] as T[]]));
  const unclassified: T[] = [];
  for (const item of items) {
    const subprojectId = item.subprojectId ?? item.session?.subprojectId;
    if (subprojectId && byId.has(subprojectId)) byId.get(subprojectId)!.push(item);
    else unclassified.push(item);
  }
  const buckets = sortSubprojectBuckets(
    owned.map((subproject) => ({ id: subproject.id, label: subproject.label, subproject, items: byId.get(subproject.id)! })),
    options,
  );
  return unclassified.length > 0
    ? [...buckets, { id: UNCLASSIFIED_SUBPROJECT_ID, label: unclassifiedLabel, items: unclassified }]
    : buckets;
}
