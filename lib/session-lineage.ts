export interface SessionLineageRecord {
  id: string;
  parentSessionId?: string;
  contextSourceSessionId?: string;
}

/** Shared parent precedence contract used by UI and state consumers. */
export function lineageParentId(session: Pick<SessionLineageRecord, "parentSessionId" | "contextSourceSessionId">): string | undefined {
  const parentId = session.parentSessionId ?? session.contextSourceSessionId;
  const normalized = parentId?.trim();
  return normalized || undefined;
}

/**
 * Resolves the nearest ancestor present in isAvailable by walking parent references.
 * Terminates safely on cycles, missing entries, or reaching a depth limit.
 */
export function resolveNearestLineageAncestor(
  startParentId: string | undefined,
  lookupParent: (id: string) => string | undefined,
  isAvailable: (id: string) => boolean,
  maxDepth = 32,
): string | undefined {
  let current = startParentId?.trim();
  const visited = new Set<string>();
  let depth = 0;
  while (current && depth < maxDepth) {
    if (visited.has(current)) return undefined; // cycle guard
    visited.add(current);
    if (isAvailable(current)) return current;
    current = lookupParent(current)?.trim();
    depth += 1;
  }
  return undefined;
}

/**
 * Asynchronously resolves the nearest ancestor present in isAvailable by walking parent references.
 * Terminates safely on cycles, missing entries, or reaching a depth limit.
 */
export async function resolveNearestLineageAncestorAsync(
  startParentId: string | undefined,
  lookupParent: (id: string) => Promise<string | undefined> | string | undefined,
  isAvailable: (id: string) => boolean,
  maxDepth = 32,
): Promise<string | undefined> {
  let current = startParentId?.trim();
  const visited = new Set<string>();
  let depth = 0;
  while (current && depth < maxDepth) {
    if (visited.has(current)) return undefined; // cycle guard
    visited.add(current);
    if (isAvailable(current)) return current;
    current = (await lookupParent(current))?.trim();
    depth += 1;
  }
  return undefined;
}

/** Return the connected visible-session lineage containing sessionId, in input order. */
export function relatedSessionIds<T extends SessionLineageRecord>(sessions: readonly T[], sessionId: string): string[] {
  const byId = new Map(sessions.map((session) => [session.id, session]));
  if (!byId.has(sessionId)) return [];

  const parentOf = new Map<string, string>();
  for (const session of sessions) {
    const parentId = lineageParentId(session);
    if (parentId && byId.has(parentId)) parentOf.set(session.id, parentId);
  }

  const related = new Set<string>([sessionId]);
  const visited = new Set<string>();
  let current = sessionId;
  while (!visited.has(current)) {
    visited.add(current);
    const parentId = parentOf.get(current);
    if (!parentId) break;
    related.add(parentId);
    current = parentId;
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [childId, parentId] of parentOf) {
      if (!related.has(parentId) || related.has(childId)) continue;
      related.add(childId);
      changed = true;
    }
  }

  return sessions.filter((session) => related.has(session.id)).map((session) => session.id);
}
