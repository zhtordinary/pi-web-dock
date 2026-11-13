"use client";

import { useCallback, useEffect, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { MessageSquare } from "lucide-react";
import { SIDEKICK_RIGHT_PANEL_TARGET_ID } from "./SidekickDrawer";
import type { SelectionToolbarActions } from "./ChatWindow";

export const SIDEKICK_TAB_ID = "sidekick";

type WorkspaceTab = { id: string };
type WorkspaceTerminalTab = { id: string; closing?: string };

export interface AppShellSidekickState {
  sidekickOpen: boolean;
  sidekickCount: number;
  sidekickRightPanelOpen: boolean;
  isSidekickTabActive: boolean;
  selectionToolbar: SelectionToolbarActions | null;
  setSidekickCount: Dispatch<SetStateAction<number>>;
  toggleSidekick: () => void;
  toggleSidekickRightPanel: () => void;
  closeSidekickRightPanel: () => void;
  closeSidekickTab: () => void;
  handleSelectionToolbarChange: (actions: SelectionToolbarActions | null) => void;
}

/** Owns the Sidekick state machine while coordinating shared workspace tabs. */
export function useAppShellSidekick({
  sessionIdentity,
  activeFileTabId,
  fileTabs,
  terminalTabs,
  rightPanelOpen,
  setActiveFileTabId,
  setRightPanelOpen,
}: {
  sessionIdentity: string;
  activeFileTabId: string | null;
  fileTabs: readonly WorkspaceTab[];
  terminalTabs: readonly WorkspaceTerminalTab[];
  rightPanelOpen: boolean;
  setActiveFileTabId: Dispatch<SetStateAction<string | null>>;
  setRightPanelOpen: Dispatch<SetStateAction<boolean>>;
}): AppShellSidekickState {
  const [sidekickOpen, setSidekickOpen] = useState(false);
  const [sidekickCount, setSidekickCount] = useState(0);
  const [sidekickRightPanelOpen, setSidekickRightPanelOpen] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<SelectionToolbarActions | null>(null);
  const fileTabsRef = useRef(fileTabs);
  const terminalTabsRef = useRef(terminalTabs);
  fileTabsRef.current = fileTabs;
  terminalTabsRef.current = terminalTabs;

  const fallbackWorkspaceTab = useCallback(() => (
    fileTabsRef.current.at(-1)?.id
      ?? terminalTabsRef.current.filter((tab) => !tab.closing).at(-1)?.id
      ?? null
  ), []);
  const toggleSidekick = useCallback(() => {
    setSidekickRightPanelOpen(false);
    setActiveFileTabId((current) => current === SIDEKICK_TAB_ID ? fallbackWorkspaceTab() : current);
    setSidekickOpen((open) => !open);
  }, [fallbackWorkspaceTab, setActiveFileTabId]);
  const toggleSidekickRightPanel = useCallback(() => {
    setSidekickOpen(false);
    if (sidekickRightPanelOpen && activeFileTabId === SIDEKICK_TAB_ID && rightPanelOpen) {
      setSidekickRightPanelOpen(false);
      setActiveFileTabId(fallbackWorkspaceTab());
      if (fileTabsRef.current.length === 0 && terminalTabsRef.current.length === 0) setRightPanelOpen(false);
    } else {
      setSidekickRightPanelOpen(true);
      setActiveFileTabId(SIDEKICK_TAB_ID);
      setRightPanelOpen(true);
    }
  }, [activeFileTabId, fallbackWorkspaceTab, rightPanelOpen, setActiveFileTabId, setRightPanelOpen, sidekickRightPanelOpen]);
  const closeSidekickRightPanel = useCallback(() => {
    setSidekickRightPanelOpen(false);
    setActiveFileTabId((current) => current === SIDEKICK_TAB_ID ? fallbackWorkspaceTab() : current);
    if (fileTabsRef.current.length === 0 && terminalTabsRef.current.length === 0) setRightPanelOpen(false);
  }, [fallbackWorkspaceTab, setActiveFileTabId, setRightPanelOpen]);
  const closeSidekickTab = useCallback(() => {
    setSidekickRightPanelOpen(false);
    setActiveFileTabId((current) => current === SIDEKICK_TAB_ID ? fallbackWorkspaceTab() : current);
    if (fileTabsRef.current.length === 0 && terminalTabsRef.current.filter((tab) => !tab.closing).length === 0) setRightPanelOpen(false);
  }, [fallbackWorkspaceTab, setActiveFileTabId, setRightPanelOpen]);
  const handleSelectionToolbarChange = useCallback((actions: SelectionToolbarActions | null) => {
    setSelectionToolbar(actions);
  }, []);

  useEffect(() => {
    setSidekickOpen(false);
    setSidekickRightPanelOpen(false);
    // File and terminal tabs belong to the shared workspace and survive session changes.
    setActiveFileTabId((current) => current === SIDEKICK_TAB_ID ? fallbackWorkspaceTab() : current);
    setSidekickCount(0);
    setSelectionToolbar(null);
  }, [fallbackWorkspaceTab, sessionIdentity, setActiveFileTabId]);

  return {
    sidekickOpen,
    sidekickCount,
    sidekickRightPanelOpen,
    isSidekickTabActive: sidekickRightPanelOpen && activeFileTabId === SIDEKICK_TAB_ID,
    selectionToolbar,
    setSidekickCount,
    toggleSidekick,
    toggleSidekickRightPanel,
    closeSidekickRightPanel,
    closeSidekickTab,
    handleSelectionToolbarChange,
  };
}

/** Shell-owned keyboard and session lifetime wiring for the shared Sidekick drawer. */
export function useAppShellSidekickLifecycle({
  sessionId,
  sessionActive,
  onToggle,
}: {
  sessionId: string | null;
  sessionActive: boolean;
  onToggle: () => void;
}): void {
  useEffect(() => {
    if (!sessionActive || !sessionId) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        onToggle();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onToggle, sessionActive, sessionId]);
}

/** Top-bar label for the Sidekick control; the count is part of the accessible name. */
export function buildSidekickButtonLabel(count: number, translate: (key: string) => string): string {
  return `${translate("sidekick.title")}${count > 0 ? ` (${count})` : ""}`;
}

/** Top-bar icon whose fill reports whether the drawer holds anything. */
export function SidekickMessageIcon({ count, size = 14 }: { count: number; size?: number }) {
  return (
    <MessageSquare
      size={size}
      strokeWidth={1.8}
      fill={count > 0 ? "color-mix(in srgb, var(--accent) 55%, transparent)" : "none"}
      color="currentColor"
      aria-hidden="true"
    />
  );
}

/** Keeps the right-panel target and its shell layout in one Sidekick boundary. */
export function AppShellSidekickRightPanel({ active, children }: { active: boolean; children: ReactNode }) {
  return (
    <div
      data-sidekick-right-panel-surface="true"
      style={{
        display: active ? "flex" : "none",
        flex: 1,
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {children}
    </div>
  );
}

export { SIDEKICK_RIGHT_PANEL_TARGET_ID };
