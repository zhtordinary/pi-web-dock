import type { SessionInfo } from "./types";

export function shouldApplySessionListResponse(
  requestId: number,
  latestRequestId: number,
): boolean {
  return requestId === latestRequestId;
}

export function mergeSelectedSession(
  sessions: SessionInfo[],
  selectedSession: SessionInfo | null | undefined,
  showArchived: boolean,
  selectedProject?: string | null,
  authoritativeSnapshot = false,
): SessionInfo[] {
  // Selection owns the open view, not membership of an authoritative catalog.
  if (authoritativeSnapshot) return sessions;
  if (showArchived || !selectedSession || selectedSession.archived) return sessions;
  if (sessions.some((session) => session.id === selectedSession.id)) return sessions;
  const sessionForDisplay = selectedSession.projectRoot || !selectedProject
    ? selectedSession
    : { ...selectedSession, projectRoot: selectedProject };
  return [sessionForDisplay, ...sessions];
}

/**
 * Project list = session-derived roots ∪ saved (known) project paths.
 * Saved paths keep a project visible even when it has zero sessions; their
 * recency key is the timestamp they were last added/refreshed, so they sink
 * below projects with active sessions.
 */
export function mergeProjectList(
  sessions: SessionInfo[],
  knownProjects: ReadonlyArray<{ path: string; addedAt: string }>,
): string[] {
  const activity = new Map<string, string>(); // root -> latest session modified
  for (const session of sessions) {
    const root = session.projectRoot ?? session.cwd;
    if (!root) continue;
    const previous = activity.get(root);
    if (!previous || session.modified > previous) activity.set(root, session.modified);
  }
  const entries: Array<{ root: string; sortKey: string }> = [];
  for (const [root, modified] of activity) entries.push({ root, sortKey: modified });
  for (const project of knownProjects) {
    if (!activity.has(project.path)) entries.push({ root: project.path, sortKey: project.addedAt });
  }
  return entries
    .sort((a, b) => b.sortKey.localeCompare(a.sortKey))
    .map((entry) => entry.root);
}
