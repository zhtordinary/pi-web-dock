import type { SessionActivityItem, SessionActivityStatus } from "./session-activity-types.ts";
import { UNCLASSIFIED_SUBPROJECT_ID, filterSubprojectItems, orderedSubprojectIds, projectKeysMatch } from "./subproject-groups.ts";
import type { SubprojectDefinition, SubprojectSortMode } from "./subproject-state.ts";
import type { SessionInfo } from "./types.ts";
import type { TalkMapLayoutSort } from "./talk-map-types.ts";

export const TALK_MAP_SUBPROJECT_CARD_GAP = 12;
export const TALK_MAP_SUBPROJECT_HEADER_HEIGHT = 40;
export const TALK_MAP_SUBPROJECT_FRAME_GAP = 24;
export const TALK_MAP_SUBPROJECT_FRAME_HEIGHT = 640;
export const TALK_MAP_SUBPROJECT_STAGE_PADDING = 64;
export const TALK_MAP_SUBPROJECT_VERTICAL_PADDING = 24;

/** Derive the usable frame height from the measured native scrollbar gutter. */
export function talkMapSubprojectFrameHeight(canvasHeight: number, verticalPadding: number, scrollbarGutter: number): number {
  return Math.max(1, Math.floor(canvasHeight - verticalPadding * 2 - Math.max(0, scrollbarGutter)));
}

export interface TalkMapSubprojectModule {
  id: string;
  label: string;
  sessionIds: string[];
  x: number;
  y: number;
  width: number;
  height: number;
  contentHeight: number;
}

export interface TalkMapSubprojectLayout {
  modules: TalkMapSubprojectModule[];
  positions: Record<string, { x: number; y: number }>;
  bounds: { x: number; y: number; width: number; height: number } | null;
}

export interface TalkMapClientRect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export function talkMapSubprojectPointInRect(rect: TalkMapClientRect, clientX: number, clientY: number): boolean {
  return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
}

export function talkMapSubprojectContentYForClient(clientY: number, viewportTop: number, scrollTop: number): number {
  return clientY - viewportTop + scrollTop;
}

export interface BuildTalkMapSubprojectLayoutInput {
  sessions: readonly Pick<SessionInfo, "id" | "subprojectId" | "archived">[];
  activities: readonly SessionActivityItem[];
  subprojects: readonly SubprojectDefinition[];
  projectKey?: string;
  sort: TalkMapLayoutSort;
  manualOrder: readonly string[];
  subprojectSortMode?: SubprojectSortMode;
  subprojectOrder?: readonly string[];
  /** Resolved session-list order; avoids re-sorting modules by Map card order. */
  subprojectDisplayOrder?: readonly string[];
  unclassifiedLabel: string;
  cardWidth: number;
  cardHeight: number;
  /** Height of each project frame in the current viewport. */
  frameHeight?: number;
  cardHeights?: Readonly<Record<string, number>>;
}

function statusRank(status: SessionActivityStatus | undefined): number {
  switch (status) {
    case "waiting_user": return 0;
    case "just_completed": return 1;
    case "running": return 2;
    case "retrying": return 3;
    case "failed": return 4;
    case "aborted": return 5;
    case "unknown": return 6;
    default: return 7;
  }
}

function activityTime(item: SessionActivityItem | undefined, sort: TalkMapLayoutSort | "recent"): string {
  if (!item) return "";
  return sort === "asked" ? item.lastAskedAt || item.lastActivityAt : item.lastActivityAt;
}

export function filterTalkMapSessions<T extends Pick<SessionInfo, "archived"> & Partial<Pick<SessionInfo, "subprojectId">>>(
  sessions: readonly T[],
  hiddenSubprojectIds?: ReadonlySet<string>,
): T[] {
  const activeSessions = sessions.filter((session) => !session.archived);
  return hiddenSubprojectIds ? filterSubprojectItems(activeSessions, hiddenSubprojectIds) : activeSessions;
}

function completeOrder(ids: readonly string[], preferred: readonly string[]): string[] {
  const known = new Set(ids);
  const seen = new Set<string>();
  return [...preferred, ...ids].filter((id) => known.has(id) && !seen.has(id) && seen.add(id));
}

function compareSessionIds(
  leftId: string,
  rightId: string,
  sort: TalkMapLayoutSort,
  activities: ReadonlyMap<string, SessionActivityItem>,
  manualRank: ReadonlyMap<string, number>,
): number {
  if (sort === "manual") {
    return (manualRank.get(leftId) ?? Number.MAX_SAFE_INTEGER) - (manualRank.get(rightId) ?? Number.MAX_SAFE_INTEGER)
      || leftId.localeCompare(rightId);
  }
  const left = activities.get(leftId);
  const right = activities.get(rightId);
  if (sort === "status") {
    return statusRank(left?.status) - statusRank(right?.status)
      || activityTime(right, "recent").localeCompare(activityTime(left, "recent"))
      || leftId.localeCompare(rightId);
  }
  return activityTime(right, sort).localeCompare(activityTime(left, sort)) || leftId.localeCompare(rightId);
}

export function talkMapSubprojectDropIndex(
  targetModuleSessionIds: readonly string[],
  contentY: number,
  cardHeight: number,
  cardHeights?: Readonly<Record<string, number>>,
): number {
  if (!Number.isFinite(contentY)) return targetModuleSessionIds.length;
  const cardHeightFor = (sessionId: string): number => {
    const measured = cardHeights?.[sessionId];
    return typeof measured === "number" && Number.isFinite(measured) && measured > 0 ? Math.ceil(measured) : cardHeight;
  };
  let cardTop = TALK_MAP_SUBPROJECT_CARD_GAP;
  for (const [index, sessionId] of targetModuleSessionIds.entries()) {
    const height = cardHeightFor(sessionId);
    if (contentY < cardTop + height / 2) return index;
    cardTop += height + TALK_MAP_SUBPROJECT_CARD_GAP;
  }
  return targetModuleSessionIds.length;
}

export function reorderTalkMapSessionOrder(
  order: readonly string[],
  targetModuleSessionIds: readonly string[],
  sourceId: string,
  targetIndex: number,
): string[] {
  const next = order.filter((id) => id !== sourceId);
  const targetIds = targetModuleSessionIds.filter((id) => id !== sourceId && next.includes(id));
  const index = Math.max(0, Math.min(targetIds.length, Math.floor(targetIndex)));
  const anchor = targetIds[index];
  const insertAt = anchor
    ? next.indexOf(anchor)
    : targetIds.length > 0 ? next.indexOf(targetIds[targetIds.length - 1]) + 1 : next.length;
  next.splice(Math.max(0, insertAt), 0, sourceId);
  return next;
}

export function buildTalkMapSubprojectLayout(input: BuildTalkMapSubprojectLayoutInput): TalkMapSubprojectLayout {
  const owned = input.subprojects.filter((subproject) => !input.projectKey || projectKeysMatch(subproject.projectKey, input.projectKey));
  const activeSessions = filterTalkMapSessions(input.sessions);
  const cardHeightFor = (sessionId: string): number => {
    const measured = input.cardHeights?.[sessionId];
    return typeof measured === "number" && Number.isFinite(measured) && measured > 0 ? Math.ceil(measured) : input.cardHeight;
  };
  const frameHeight = typeof input.frameHeight === "number" && Number.isFinite(input.frameHeight)
    ? Math.max(1, Math.ceil(input.frameHeight))
    : TALK_MAP_SUBPROJECT_FRAME_HEIGHT;
  const sessionIds = activeSessions.map((session) => session.id);
  const activities = new Map(input.activities.map((item) => [item.session.id, item]));
  const manualOrder = completeOrder(sessionIds, input.manualOrder);
  const manualRank = new Map(manualOrder.map((id, index) => [id, index]));
  const groups = new Map<string, string[]>(owned.map((subproject) => [subproject.id, []]));
  const unclassified: string[] = [];
  const ownedIds = new Set(owned.map((subproject) => subproject.id));
  for (const session of activeSessions) {
    const id = session.subprojectId && ownedIds.has(session.subprojectId) ? session.subprojectId : UNCLASSIFIED_SUBPROJECT_ID;
    if (id === UNCLASSIFIED_SUBPROJECT_ID) unclassified.push(session.id);
    else groups.get(id)!.push(session.id);
  }
  const compare = (leftId: string, rightId: string) => compareSessionIds(leftId, rightId, input.sort, activities, manualRank);
  const sortGroup = (ids: string[]) => [...ids].sort(compare);
  for (const ids of groups.values()) ids.splice(0, ids.length, ...sortGroup(ids));
  unclassified.splice(0, unclassified.length, ...sortGroup(unclassified));

  const sortMode = input.subprojectSortMode ?? "custom";
  const customOrder = orderedSubprojectIds(owned, input.subprojectOrder);
  const customRank = new Map(customOrder.map((id, index) => [id, index]));
  const displayRank = input.subprojectDisplayOrder
    ? new Map(input.subprojectDisplayOrder.map((id, index) => [id, index]))
    : null;
  const originalRank = new Map(owned.map((subproject, index) => [subproject.id, index]));
  const orderedDefinitions = displayRank
    ? [...owned].sort((left, right) => (displayRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (displayRank.get(right.id) ?? Number.MAX_SAFE_INTEGER) || originalRank.get(left.id)! - originalRank.get(right.id)!)
    : [...owned].sort((left, right) => {
    if (sortMode === "alpha") return left.label.localeCompare(right.label) || originalRank.get(left.id)! - originalRank.get(right.id)!;
    if (sortMode === "inherit") {
      const leftTop = groups.get(left.id)?.[0];
      const rightTop = groups.get(right.id)?.[0];
      if (leftTop && !rightTop) return -1;
      if (!leftTop && rightTop) return 1;
      if (leftTop && rightTop) return compare(leftTop, rightTop);
      return originalRank.get(left.id)! - originalRank.get(right.id)!;
    }
    return (customRank.get(left.id) ?? Number.MAX_SAFE_INTEGER) - (customRank.get(right.id) ?? Number.MAX_SAFE_INTEGER)
      || originalRank.get(left.id)! - originalRank.get(right.id)!;
    });

  const moduleEntries = orderedDefinitions.map((subproject) => ({ id: subproject.id, label: subproject.label, sessionIds: groups.get(subproject.id)! }));
  if (unclassified.length > 0) moduleEntries.push({ id: UNCLASSIFIED_SUBPROJECT_ID, label: input.unclassifiedLabel, sessionIds: unclassified });

  const positions: Record<string, { x: number; y: number }> = {};
  const modules: TalkMapSubprojectModule[] = [];
  const startX = TALK_MAP_SUBPROJECT_STAGE_PADDING;
  let x = startX;
  const y = TALK_MAP_SUBPROJECT_VERTICAL_PADDING;
  let maxHeight = 0;
  for (const entry of moduleEntries) {
    const cardsHeight = entry.sessionIds.reduce((total, sessionId, index) => (
      total + cardHeightFor(sessionId) + (index > 0 ? TALK_MAP_SUBPROJECT_CARD_GAP : 0)
    ), 0);
    const contentHeight = cardsHeight + TALK_MAP_SUBPROJECT_CARD_GAP + 16;
    const height = frameHeight;
    const layoutModule = { id: entry.id, label: entry.label, sessionIds: [...entry.sessionIds], x, y, width: input.cardWidth + 48, height, contentHeight };
    modules.push(layoutModule);
    let cardY = layoutModule.y + TALK_MAP_SUBPROJECT_HEADER_HEIGHT + TALK_MAP_SUBPROJECT_CARD_GAP;
    entry.sessionIds.forEach((sessionId) => {
      positions[sessionId] = {
        x: layoutModule.x + 24,
        y: cardY,
      };
      cardY += cardHeightFor(sessionId) + TALK_MAP_SUBPROJECT_CARD_GAP;
    });
    x += layoutModule.width + TALK_MAP_SUBPROJECT_FRAME_GAP;
    maxHeight = Math.max(maxHeight, frameHeight);
  }
  return {
    modules,
    positions,
    bounds: modules.length > 0 ? { x: startX, y, width: x - startX - TALK_MAP_SUBPROJECT_FRAME_GAP, height: maxHeight } : null,
  };
}
