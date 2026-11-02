import type { TabOpen } from "./tab-session";

export interface InitialNavigation {
  requestedCwd: string | null;
  sessionId: string | null;
  subprojectId: string | null;
  subprojectLabel: string | null;
  sidebarCollapsed: boolean;
}

export function getInitialNavigation(
  searchParams: Pick<URLSearchParams, "get">,
): InitialNavigation {
  const requestedCwd = searchParams.get("cwd")?.trim() || null;
  const subprojectId = searchParams.get("subproject")?.trim() || null;
  const subprojectLabel = subprojectId ? searchParams.get("subprojectLabel")?.trim() || null : null;

  return {
    requestedCwd,
    sessionId: requestedCwd ? null : (searchParams.get("session") || null),
    subprojectId: requestedCwd ? subprojectId : null,
    subprojectLabel: requestedCwd ? subprojectLabel : null,
    sidebarCollapsed: searchParams.get("sidebar") === "collapsed",
  };
}

export function withTabOpen(
  navigation: InitialNavigation,
  tabOpen: TabOpen | null,
): InitialNavigation {
  if (navigation.requestedCwd || navigation.sessionId || !tabOpen) {
    return navigation;
  }

  if (tabOpen.kind === "session") {
    return { ...navigation, sessionId: tabOpen.sessionId };
  }

  return { ...navigation, requestedCwd: tabOpen.cwd };
}
