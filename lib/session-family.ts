import type { SessionInfo } from "./types";

/** The hidden boundary message at the end of a side session's inherited history. */
export const SIDE_BOUNDARY_MESSAGE_TYPE = "pi-web:side-boundary";
export const SIDE_SESSION_NAME = "Side chat";
const SIDE_NAME_MAX_LENGTH = 40;

export function sideChatNameFromText(text: string): string | null {
  const line = text.trim().split("\n")[0].trim();
  if (!line) return null;
  return line.length > SIDE_NAME_MAX_LENGTH ? `${line.slice(0, SIDE_NAME_MAX_LENGTH).trimEnd()}…` : line;
}

export type HiddenRelationKind = "subagent" | "side";
export type HiddenRelation = Extract<SessionInfo["relation"], { kind: HiddenRelationKind }>;

export function isHiddenRelation(relation: SessionInfo["relation"]): relation is HiddenRelation {
  return relation?.kind === "subagent" || relation?.kind === "side";
}

export interface SessionFamily {
  root: SessionInfo;
  subagents: SessionInfo[];
  latestModified: string;
}

function resolveFamilyRoots(sessions: readonly SessionInfo[]): Map<string, string | null> {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  const roots = new Map<string, string | null>();

  for (const session of sessions) {
    if (roots.has(session.id)) continue;

    const path: string[] = [];
    const visited = new Set<string>();
    let currentId = session.id;
    let rootId: string | null = null;

    while (true) {
      if (roots.has(currentId)) {
        rootId = roots.get(currentId) ?? null;
        break;
      }
      if (visited.has(currentId)) break;

      visited.add(currentId);
      path.push(currentId);
      const current = byId.get(currentId);
      if (!current) break;
      if (!isHiddenRelation(current.relation)) {
        rootId = current.id;
        break;
      }
      currentId = current.relation.parentSessionId;
    }

    for (const id of path) roots.set(id, rootId);
  }

  return roots;
}

/** Groups visible main/fork sessions with every persisted subagent descendant. */
export function listSessionFamilies(sessions: readonly SessionInfo[]): SessionFamily[] {
  const rootsBySessionId = resolveFamilyRoots(sessions);
  const families = new Map<string, SessionFamily>();

  for (const session of sessions) {
    if (isHiddenRelation(session.relation)) continue;
    families.set(session.id, {
      root: session,
      subagents: [],
      latestModified: session.modified,
    });
  }

  for (const session of sessions) {
    if (!isHiddenRelation(session.relation)) continue;
    const rootId = rootsBySessionId.get(session.id);
    const family = rootId ? families.get(rootId) : undefined;
    if (!family) continue;
    family.subagents.push(session);
    if (session.modified > family.latestModified) family.latestModified = session.modified;
  }

  return [...families.values()].sort((a, b) => b.latestModified.localeCompare(a.latestModified));
}

export function getSessionFamily(
  sessions: readonly SessionInfo[],
  sessionId: string | null | undefined,
): SessionFamily | null {
  if (!sessionId) return null;
  return listSessionFamilies(sessions).find((family) => (
    family.root.id === sessionId
    || family.subagents.some((session) => session.id === sessionId)
  )) ?? null;
}
