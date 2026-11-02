import type { FileViewerState } from "@/lib/file-viewer-state";
import type { Tab } from "./TabBar";

export function getFileTabId(filePath: string, remotePeer?: string): string {
  return `file:${remotePeer ?? "local"}:${filePath}`;
}

interface OpenFileTabInput {
  fileName: string;
  filePath: string;
  remotePeer?: string;
  cwd?: string;
  projectRoot?: string;
  modeHint?: "diff";
  page?: number;
  sourceSessionId?: string | null;
  tabId: string;
}

export function openFileTab(tabs: Tab[], input: OpenFileTabInput): Tab[] {
  const existing = tabs.find((tab) => tab.id === input.tabId);
  if (!existing) {
    return [
      ...tabs,
      {
        id: input.tabId,
        label: input.fileName,
        filePath: input.filePath,
        remotePeer: input.remotePeer,
        cwd: input.cwd,
        projectRoot: input.projectRoot,
        sourceSessionId: input.sourceSessionId,
        initialDisplayMode: input.modeHint,
        page: input.page,
        viewerState: input.modeHint ? {
          displayMode: input.modeHint,
          wrapLines: false,
          scrollTop: 0,
          scrollLeft: 0,
        } : undefined,
        viewerRevision: 0,
      },
    ];
  }

  const sourceChanged = Boolean(
    input.sourceSessionId && existing.sourceSessionId !== input.sourceSessionId,
  );
  const contextChanged = existing.remotePeer !== input.remotePeer
    || existing.cwd !== input.cwd
    || existing.projectRoot !== input.projectRoot;
  const sourceUnchanged = !sourceChanged;
  const pageChanged = existing.page !== input.page;
  if (sourceUnchanged && !contextChanged && !input.modeHint && !pageChanged) return tabs;

  return tabs.map((tab) => {
    if (tab.id !== input.tabId) return tab;
    const next: Tab = { ...tab };
    let bumpRevision = false;
    if (contextChanged) {
      next.remotePeer = input.remotePeer;
      next.cwd = input.cwd;
      next.projectRoot = input.projectRoot;
      bumpRevision = true;
    }
    if (sourceChanged) {
      next.sourceSessionId = input.sourceSessionId;
      bumpRevision = true;
    }
    if (pageChanged) {
      next.page = input.page;
      bumpRevision = true;
    }
    if (input.modeHint) {
      next.initialDisplayMode = input.modeHint;
      next.viewerState = {
        displayMode: input.modeHint,
        wrapLines: tab.viewerState?.wrapLines ?? false,
        scrollTop: 0,
        scrollLeft: 0,
      };
      bumpRevision = true;
    }
    if (bumpRevision) next.viewerRevision = (tab.viewerRevision ?? 0) + 1;
    return next;
  });
}

export function replaceFileTab(
  tabs: Tab[],
  activeTabId: string,
  input: OpenFileTabInput,
): { tabs: Tab[]; activeTabId: string } {
  const activeIndex = tabs.findIndex((tab) => tab.id === activeTabId);
  if (activeIndex === -1) return { tabs, activeTabId };

  const existingTarget = tabs.findIndex((tab) => tab.id === input.tabId);
  if (existingTarget !== -1 && existingTarget !== activeIndex) {
    return { tabs, activeTabId: input.tabId };
  }

  const replacement = openFileTab([], input)[0];
  if (!replacement) return { tabs, activeTabId };
  const next = [...tabs];
  next[activeIndex] = replacement;
  return { tabs: next, activeTabId: replacement.id };
}

export function saveFileViewerState(
  tabs: Tab[],
  tabId: string,
  viewerRevision: number,
  viewerState: FileViewerState,
): Tab[] {
  const index = tabs.findIndex((tab) => tab.id === tabId);
  if (index === -1 || (tabs[index].viewerRevision ?? 0) !== viewerRevision) return tabs;

  const next = [...tabs];
  next[index] = { ...next[index], viewerState };
  return next;
}
