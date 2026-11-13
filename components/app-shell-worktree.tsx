"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { TalkMapOverlay } from "./TalkMapOverlay";
import { WorktreeGraphOverlay } from "./WorktreeGraphOverlay";
import { BranchNavigator, BranchNavigatorPanel } from "./BranchNavigator";
import type { WorktreeGraphItem } from "@/lib/worktree-graph-types";
import type { SessionActivityDevice, SessionActivityItem } from "@/lib/session-activity-types";
import type { SessionInfo, SessionTreeNode, UserMessage } from "@/lib/types";
import { sendAgentCommand } from "@/lib/agent-client";
import { apiPathForPeer } from "@/lib/file-api";
import { buildTalkMapInjectPrompt, type TalkMapGhostCardState } from "@/lib/talk-map-types";
import { stripHiddenUserQuestion } from "@/lib/session-hover-preview";
import type { TranslationParams } from "@/lib/i18n/types";
import type { WorktreeBindingDraft } from "@/lib/worktree-bindings";

export function AppShellWorktreeBranchNavigator({
  tree,
  activeLeafId,
  onLeafChange,
  locked,
  inline,
  compact,
  open,
  onToggle,
  hasSession,
  hideInlineButton,
}: {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  locked: boolean;
  inline?: boolean;
  compact?: boolean;
  open: boolean;
  onToggle: () => void;
  hasSession: boolean;
  hideInlineButton?: boolean;
}) {
  return <BranchNavigator tree={tree} activeLeafId={activeLeafId} onLeafChange={onLeafChange} locked={locked} inline={inline} compact={compact} open={open} onToggle={onToggle} hasSession={hasSession} hideInlineButton={hideInlineButton} />;
}

export function AppShellWorktreeBranchPanel({
  tree,
  activeLeafId,
  onLeafChange,
  onToggle,
  locked,
  hasSession,
}: {
  tree: SessionTreeNode[];
  activeLeafId: string | null;
  onLeafChange: (leafId: string | null) => void;
  onToggle: () => void;
  locked: boolean;
  hasSession: boolean;
}) {
  return <BranchNavigatorPanel tree={tree} activeLeafId={activeLeafId} onLeafChange={onLeafChange} onToggle={onToggle} locked={locked} hasSession={hasSession} />;
}

export function useAppShellWorktreeCapability(capabilityPath: string | null) {
  const [worktreeCapability, setWorktreeCapability] = useState<{ path: string; isGit: boolean | null; failed?: boolean } | null>(null);
  const [worktreeCapabilityRevision, setWorktreeCapabilityRevision] = useState(0);
  useEffect(() => {
    if (!capabilityPath) return;
    const controller = new AbortController();
    setWorktreeCapability({ path: capabilityPath, isGit: null });
    void fetch(capabilityPath, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10_000)]) })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json() as { isGit?: boolean };
        if (!controller.signal.aborted) setWorktreeCapability({ path: capabilityPath, isGit: data.isGit === true });
      }).catch(() => {
        if (!controller.signal.aborted) setWorktreeCapability({ path: capabilityPath, isGit: null, failed: true });
      });
    return () => controller.abort();
  }, [capabilityPath, worktreeCapabilityRevision]);
  return {
    activeWorktreeCapability: worktreeCapability?.path === capabilityPath ? worktreeCapability : null,
    setWorktreeCapabilityRevision,
  };
}

export interface AppShellWorktreeCallbacks {
  handleSelectSession: (session: SessionInfo) => void;
  openRemoteSession: (device: SessionActivityDevice, sessionId: string, searchTerm?: string | null, options?: { cwd?: string; path?: string }) => void;
  loadLocalSession: (sessionId: string) => Promise<SessionInfo | null>;
  invalidateWorkspaceRestore: () => void;
  handleNewActivitySession: (cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string, options?: {
    initialMessage?: string;
    contextSourceSessionId?: string;
    worktreeBinding?: WorktreeBindingDraft;
    talkMapGhost?: { ghostId: string; projectRoot: string };
  }) => void;
  handleSessionDeleted: (sessionId: string) => void;
  bumpRefresh?: () => void;
  applyTalkMapRestoreMessage?: (message: UserMessage, session: SessionInfo, device?: SessionActivityDevice) => void;
  mutateRemoteSession: (device: SessionActivityDevice, op: "archive" | "delete", sessionId: string) => Promise<boolean>;
  handleCwdChange: (cwd: string, projectRoot?: string | null) => void;
}

export interface AppShellWorktreeState {
  talkMapOpen: boolean;
  talkMapProjectRoot: string | null;
  talkMapDevice: SessionActivityDevice | null;
  talkMapFocusSessionId: string | null;
  talkMapSidebarSessionId: string | null;
  worktreeGraphOpen: boolean;
  worktreeGraphProjectRoot: string | null;
  worktreeGraphDevice: SessionActivityDevice | null;
  worktreeGraphSessionId: string | null;
  worktreeGraphSessionPath: string | null;
  closeTalkMap: () => void;
  closeWorktreeGraph: () => void;
  openTalkMap: (projectRoot: string | null, device?: SessionActivityDevice, focusSessionId?: string | null) => void;
  openWorktreeGraph: (projectRoot: string | null, device?: SessionActivityDevice, sessionContext?: { id?: string | null; cwd?: string | null }) => void;
  handleOpenWorktreeGraph: (projectRoot: string | null, device?: SessionActivityDevice) => void;
  handleWorktreeGraphNewSession: (worktree: WorktreeGraphItem, prompt: string) => void;
  handleWorktreeGraphOpenSession: (sessionId: string, worktreePath: string) => void;
  handleOpenTalkMapForSession: (projectRoot: string | null, device?: SessionActivityDevice, sessionId?: string | null) => void;
  handleTalkMapSession: (session: SessionInfo) => void;
  talkMapActionDevice: () => SessionActivityDevice | undefined;
  handleTalkMapSelectCard: (session: SessionInfo | null) => void;
  handleTalkMapSessionMutation: (session: SessionInfo, op: "archive" | "delete") => Promise<void>;
  handleTalkMapNewSession: (subprojectId?: string, subprojectLabel?: string) => void;
  handleTalkMapConvertGhost: (ghostId: string, ghost: TalkMapGhostCardState, subprojectId?: string) => void;
  handleTalkMapInjectContext: (session: SessionInfo, targetDevice?: SessionActivityDevice) => void;
  handleTalkMapFork: (session: SessionInfo) => Promise<void>;
  handleActivityTalkMap: (item: SessionActivityItem) => void;
  handleActivityInjectContext: (item: SessionActivityItem) => void;
  clearTalkMapSelection: (sessionId?: string) => void;
  cancelWorktreeGraphOpen: () => void;
}

export function useAppShellWorktree({
  callbacksRef,
  localDeviceId,
  localDeviceName,
  translate,
}: {
  callbacksRef: MutableRefObject<AppShellWorktreeCallbacks | null>;
  localDeviceId: string;
  localDeviceName: string;
  translate: (key: string, params?: TranslationParams) => string;
}): AppShellWorktreeState {
  const [talkMapOpen, setTalkMapOpen] = useState(false);
  const [talkMapProjectRoot, setTalkMapProjectRoot] = useState<string | null>(null);
  const [talkMapDevice, setTalkMapDevice] = useState<SessionActivityDevice | null>(null);
  const [talkMapFocusSessionId, setTalkMapFocusSessionId] = useState<string | null>(null);
  const [talkMapSidebarSessionId, setTalkMapSidebarSessionId] = useState<string | null>(null);
  const [worktreeGraphOpen, setWorktreeGraphOpen] = useState(false);
  const [worktreeGraphProjectRoot, setWorktreeGraphProjectRoot] = useState<string | null>(null);
  const [worktreeGraphDevice, setWorktreeGraphDevice] = useState<SessionActivityDevice | null>(null);
  const [worktreeGraphSessionId, setWorktreeGraphSessionId] = useState<string | null>(null);
  const [worktreeGraphSessionPath, setWorktreeGraphSessionPath] = useState<string | null>(null);
  const worktreeOpenRequestSerialRef = useRef(0);
  const talkMapSidebarSessionIdRef = useRef<string | null>(null);
  talkMapSidebarSessionIdRef.current = talkMapSidebarSessionId;

  const cancelWorktreeGraphOpen = useCallback(() => {
    worktreeOpenRequestSerialRef.current += 1;
  }, []);
  useEffect(() => () => cancelWorktreeGraphOpen(), [cancelWorktreeGraphOpen]);

  const closeTalkMap = useCallback(() => {
    setTalkMapOpen(false);
    setTalkMapDevice(null);
    setTalkMapFocusSessionId(null);
    talkMapSidebarSessionIdRef.current = null;
    setTalkMapSidebarSessionId(null);
  }, []);
  const closeWorktreeGraph = useCallback(() => {
    cancelWorktreeGraphOpen();
    setWorktreeGraphOpen(false);
    setWorktreeGraphProjectRoot(null);
    setWorktreeGraphDevice(null);
    setWorktreeGraphSessionId(null);
    setWorktreeGraphSessionPath(null);
  }, [cancelWorktreeGraphOpen]);
  const openTalkMap = useCallback((projectRoot: string | null, device?: SessionActivityDevice, focusSessionId: string | null = null) => {
    const root = projectRoot?.trim();
    if (!root) return;
    setTalkMapProjectRoot(root);
    setTalkMapDevice(device ?? null);
    setTalkMapFocusSessionId(focusSessionId);
    talkMapSidebarSessionIdRef.current = focusSessionId;
    setTalkMapSidebarSessionId(focusSessionId);
    setTalkMapOpen(true);
  }, []);
  const openWorktreeGraph = useCallback((projectRoot: string | null, device?: SessionActivityDevice, sessionContext?: { id?: string | null; cwd?: string | null }) => {
    const root = projectRoot?.trim();
    if (!root) return;
    cancelWorktreeGraphOpen();
    setWorktreeGraphProjectRoot(root);
    setWorktreeGraphDevice(device ?? null);
    setWorktreeGraphSessionId(sessionContext?.id ?? null);
    setWorktreeGraphSessionPath(sessionContext?.cwd?.trim() || null);
    setWorktreeGraphOpen(true);
  }, [cancelWorktreeGraphOpen]);
  const handleOpenWorktreeGraph = useCallback((projectRoot: string | null, device?: SessionActivityDevice) => {
    openWorktreeGraph(projectRoot, device);
  }, [openWorktreeGraph]);

  const handleWorktreeGraphNewSession = useCallback((worktree: WorktreeGraphItem, prompt: string) => {
    closeWorktreeGraph();
    callbacksRef.current?.handleNewActivitySession(worktree.path, worktreeGraphDevice ?? undefined, undefined, undefined, {
      initialMessage: prompt,
      ...(worktreeGraphProjectRoot ? { worktreeBinding: { projectRoot: worktreeGraphProjectRoot, worktreePath: worktree.path, relation: "task-root" } } : {}),
    });
  }, [callbacksRef, closeWorktreeGraph, worktreeGraphDevice, worktreeGraphProjectRoot]);
  const handleWorktreeGraphOpenSession = useCallback((sessionId: string, worktreePath: string) => {
    const device = worktreeGraphDevice;
    closeWorktreeGraph();
    const callbacks = callbacksRef.current;
    if (!callbacks) return;
    if (device && localDeviceId && device.id !== localDeviceId) {
      callbacks.openRemoteSession(device, sessionId, null, { cwd: worktreePath });
      return;
    }
    callbacks.invalidateWorkspaceRestore();
    const requestSerial = ++worktreeOpenRequestSerialRef.current;
    void callbacks.loadLocalSession(sessionId).then((session) => {
      if (requestSerial !== worktreeOpenRequestSerialRef.current) return;
      if (!session) throw new Error(`Session ${sessionId} not found`);
      callbacksRef.current?.handleSelectSession(session);
    }).catch((cause) => {
      if (requestSerial === worktreeOpenRequestSerialRef.current) {
        window.alert(cause instanceof Error ? cause.message : String(cause));
      }
    });
  }, [callbacksRef, closeWorktreeGraph, localDeviceId, worktreeGraphDevice]);

  const handleOpenTalkMapForSession = useCallback((projectRoot: string | null, device: SessionActivityDevice | undefined, sessionId?: string | null) => {
    openTalkMap(projectRoot, device, sessionId);
  }, [openTalkMap]);
  const handleTalkMapSession = useCallback((session: SessionInfo) => {
    const device = talkMapDevice;
    const callbacks = callbacksRef.current;
    closeTalkMap();
    if (!callbacks) return;
    if (device && localDeviceId && device.id !== localDeviceId) {
      callbacks.openRemoteSession(device, session.id, null, { cwd: session.cwd, path: session.path });
      return;
    }
    callbacks.handleSelectSession(session);
  }, [callbacksRef, closeTalkMap, localDeviceId, talkMapDevice]);
  const talkMapActionDevice = useCallback((): SessionActivityDevice | undefined => (
    talkMapDevice ?? (localDeviceId ? { id: localDeviceId, name: localDeviceName ?? translate("remote.localDevice") } : undefined)
  ), [localDeviceId, localDeviceName, talkMapDevice, translate]);
  const handleTalkMapSelectCard = useCallback((session: SessionInfo | null) => {
    const sessionId = session?.id ?? null;
    talkMapSidebarSessionIdRef.current = sessionId;
    setTalkMapSidebarSessionId(sessionId);
  }, []);
  const clearTalkMapSelection = useCallback((sessionId?: string) => {
    if (sessionId !== undefined && talkMapSidebarSessionIdRef.current !== sessionId) return;
    talkMapSidebarSessionIdRef.current = null;
    setTalkMapSidebarSessionId(null);
  }, []);
  const handleTalkMapSessionMutation = useCallback(async (session: SessionInfo, op: "archive" | "delete"): Promise<void> => {
    const callbacks = callbacksRef.current;
    const device = talkMapActionDevice();
    if (!callbacks) return;
    if (device && localDeviceId && device.id !== localDeviceId) {
      const ok = await callbacks.mutateRemoteSession(device, op, session.id);
      if (!ok) throw new Error(`Talk Map session ${op} failed`);
    } else {
      const archived = op === "archive";
      const response = await fetch(`/api/sessions/${encodeURIComponent(session.id)}${archived ? "/archive" : ""}`, {
        method: archived ? "POST" : "DELETE",
        headers: archived ? { "Content-Type": "application/json" } : undefined,
        body: archived ? JSON.stringify({ archived: true }) : undefined,
      });
      if (!response.ok) throw new Error(`Talk Map session HTTP ${response.status}`);
    }
    callbacksRef.current?.handleSessionDeleted(session.id);
    clearTalkMapSelection(session.id);
    callbacksRef.current?.bumpRefresh?.();
  }, [callbacksRef, clearTalkMapSelection, localDeviceId, talkMapActionDevice]);
  const handleTalkMapNewSession = useCallback((subprojectId?: string, subprojectLabel?: string) => {
    const callbacks = callbacksRef.current;
    if (!talkMapProjectRoot || !callbacks) return;
    callbacks.handleNewActivitySession(talkMapProjectRoot, talkMapActionDevice(), subprojectId, subprojectLabel);
  }, [callbacksRef, talkMapActionDevice, talkMapProjectRoot]);
  const handleTalkMapConvertGhost = useCallback((ghostId: string, ghost: TalkMapGhostCardState, subprojectId?: string) => {
    const callbacks = callbacksRef.current;
    if (!talkMapProjectRoot || !callbacks) return;
    const label = ghost.label.trim();
    const body = ghost.body?.trim();
    const initialMessage = body ? `${label}\n\n${body}` : label;
    callbacks.handleNewActivitySession(talkMapProjectRoot, talkMapActionDevice(), subprojectId, undefined, {
      initialMessage,
      talkMapGhost: { ghostId, projectRoot: talkMapProjectRoot },
    });
  }, [callbacksRef, talkMapActionDevice, talkMapProjectRoot]);
  const handleTalkMapInjectContext = useCallback((session: SessionInfo, targetDevice?: SessionActivityDevice) => {
    const callbacks = callbacksRef.current;
    const device = targetDevice ?? talkMapActionDevice();
    if (!callbacks) return;
    const rawTitle = session.name?.trim() || session.id;
    const title = stripHiddenUserQuestion(rawTitle) || session.id;
    const deviceLabel = device?.name ?? localDeviceName ?? "本机";
    const initialMessage = buildTalkMapInjectPrompt({
      sourceDevice: deviceLabel,
      sourceSessionId: session.id,
      sourceTitle: title,
      sourcePath: session.path,
      sourceProject: session.projectRoot ?? session.cwd,
    });
    closeTalkMap();
    callbacks.handleNewActivitySession(session.cwd, device, session.subprojectId, undefined, { initialMessage, contextSourceSessionId: session.id });
  }, [callbacksRef, closeTalkMap, localDeviceName, talkMapActionDevice]);
  const handleTalkMapFork = useCallback(async (session: SessionInfo): Promise<void> => {
    const callbacks = callbacksRef.current;
    const device = talkMapActionDevice();
    if (!callbacks) return;
    const peer = device && localDeviceId && device.id !== localDeviceId ? device.id : undefined;
    const contextPath = apiPathForPeer(peer, `sessions/${encodeURIComponent(session.id)}/context?deferThinking=1&deferMedia=1`);
    const contextResponse = await fetch(contextPath, { cache: "no-store" });
    if (!contextResponse.ok) throw new Error(`Context HTTP ${contextResponse.status}`);
    const contextBody = await contextResponse.json() as { context?: { messages?: Array<{ role?: string }>; entryIds?: Array<string | null | undefined> } };
    const messages = contextBody.context?.messages ?? [];
    const entryIds = contextBody.context?.entryIds ?? [];
    let userIndex = -1;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index]?.role === "user" && typeof entryIds[index] === "string" && entryIds[index]) { userIndex = index; break; }
    }
    if (userIndex < 0) throw new Error(translate("talkMap.forkUnavailable"));
    const result = await sendAgentCommand<{ cancelled?: boolean; newSessionId?: string; restoreMessage?: UserMessage; subprojectAssignmentFailed?: boolean }>(
      session.id,
      { type: "fork", entryId: entryIds[userIndex] },
      peer,
    );
    if (result.cancelled) return;
    closeTalkMap();
    if (result.restoreMessage?.role === "user") {
      callbacks.handleNewActivitySession(session.cwd, device, session.subprojectId);
      callbacks.applyTalkMapRestoreMessage?.(result.restoreMessage, session, device);
      return;
    }
    if (!result.newSessionId) throw new Error(translate("talkMap.forkUnavailable"));
    const fork = { ...session, id: result.newSessionId, parentSessionId: session.id, messageCount: 0, firstMessage: "", subprojectId: result.subprojectAssignmentFailed ? undefined : session.subprojectId, created: new Date().toISOString(), modified: new Date().toISOString() };
    if (peer && device) callbacks.openRemoteSession(device, result.newSessionId, null, { cwd: session.cwd, path: session.path });
    else callbacks.handleSelectSession(fork);
  }, [callbacksRef, closeTalkMap, localDeviceId, talkMapActionDevice, translate]);
  const handleActivityTalkMap = useCallback((item: SessionActivityItem) => {
    handleOpenTalkMapForSession(item.session.projectRoot ?? item.session.cwd, item.device, item.session.id);
  }, [handleOpenTalkMapForSession]);
  const handleActivityInjectContext = useCallback((item: SessionActivityItem) => {
    handleTalkMapInjectContext(item.session, item.device);
  }, [handleTalkMapInjectContext]);

  return {
    talkMapOpen, talkMapProjectRoot, talkMapDevice, talkMapFocusSessionId, talkMapSidebarSessionId,
    worktreeGraphOpen, worktreeGraphProjectRoot, worktreeGraphDevice, worktreeGraphSessionId, worktreeGraphSessionPath,
    closeTalkMap, closeWorktreeGraph, openTalkMap, openWorktreeGraph, handleOpenWorktreeGraph,
    handleWorktreeGraphNewSession, handleWorktreeGraphOpenSession, handleOpenTalkMapForSession,
    handleTalkMapSession, talkMapActionDevice, handleTalkMapSelectCard, handleTalkMapSessionMutation,
    handleTalkMapNewSession, handleTalkMapConvertGhost, handleTalkMapInjectContext, handleTalkMapFork,
    handleActivityTalkMap, handleActivityInjectContext, clearTalkMapSelection, cancelWorktreeGraphOpen,
  };
}

export function AppShellWorktreeOverlays({
  talkMapOpen,
  talkMapProjectRoot,
  talkMapDevice,
  talkMapFocusSessionId,
  talkMapSidebarSessionId,
  worktreeGraphOpen,
  worktreeGraphProjectRoot,
  worktreeGraphDevice,
  worktreeGraphSessionId,
  worktreeGraphSessionPath,
  worktreeGraphCurrentPath,
  topBarSessionId,
  currentSessionId,
  localDeviceId,
  localDeviceName,
  refreshKey,
  onCloseTalkMap,
  onTalkMapNewSession,
  onTalkMapConvertGhost,
  onTalkMapSession,
  onTalkMapSelectCard,
  onTalkMapFork,
  onTalkMapInjectContext,
  onCopySessionInfo,
  onTalkMapSessionMutation,
  onCloseWorktreeGraph,
  onSwitchWorktree,
  onOpenSession,
  onNewSessionFromNode,
}: {
  talkMapOpen: boolean;
  talkMapProjectRoot: string | null;
  talkMapDevice: SessionActivityDevice | null;
  talkMapFocusSessionId: string | null;
  talkMapSidebarSessionId: string | null;
  worktreeGraphOpen: boolean;
  worktreeGraphProjectRoot: string | null;
  worktreeGraphDevice: SessionActivityDevice | null;
  worktreeGraphSessionId: string | null;
  worktreeGraphSessionPath: string | null;
  worktreeGraphCurrentPath: string | null;
  topBarSessionId: string | null;
  currentSessionId?: string | null;
  localDeviceId: string;
  localDeviceName: string;
  refreshKey: number;
  onCloseTalkMap: () => void;
  onTalkMapNewSession: (subprojectId?: string, subprojectLabel?: string) => void;
  onTalkMapConvertGhost: (ghostId: string, ghost: TalkMapGhostCardState, subprojectId?: string) => void;
  onTalkMapSession: (session: SessionInfo) => void;
  onTalkMapSelectCard: (session: SessionInfo | null) => void;
  onTalkMapFork: (session: SessionInfo) => Promise<void>;
  onTalkMapInjectContext: (session: SessionInfo, device?: SessionActivityDevice) => void;
  onCopySessionInfo: (item: SessionActivityItem) => Promise<void> | void;
  onTalkMapSessionMutation: (session: SessionInfo, op: "archive" | "delete") => Promise<void>;
  onCloseWorktreeGraph: () => void;
  onSwitchWorktree?: (path: string) => void;
  onOpenSession: (sessionId: string, worktreePath: string) => void;
  onNewSessionFromNode: (worktree: WorktreeGraphItem, prompt: string) => void;
}) {
  return <>
    {talkMapOpen && (
      <TalkMapOverlay
        open={talkMapOpen}
        projectRoot={talkMapProjectRoot}
        deviceName={talkMapDevice?.name ?? localDeviceName ?? undefined}
        focusSessionId={talkMapFocusSessionId}
        remotePeer={talkMapDevice && localDeviceId && talkMapDevice.id !== localDeviceId ? talkMapDevice.id : undefined}
        refreshKey={refreshKey}
        onClose={onCloseTalkMap}
        onNewSession={onTalkMapNewSession}
        onConvertGhost={onTalkMapConvertGhost}
        onOpenSession={onTalkMapSession}
        onSelectCard={onTalkMapSelectCard}
        onForkSession={onTalkMapFork}
        onInjectContext={onTalkMapInjectContext}
        onCopySessionInfo={onCopySessionInfo}
        onArchiveSession={(session) => onTalkMapSessionMutation(session, "archive")}
        onDeleteSession={(session) => onTalkMapSessionMutation(session, "delete")}
      />
    )}
    {worktreeGraphOpen && (
      <WorktreeGraphOverlay
        open={worktreeGraphOpen}
        projectRoot={worktreeGraphProjectRoot}
        deviceName={worktreeGraphDevice?.name ?? localDeviceName ?? undefined}
        currentWorktreePath={worktreeGraphSessionPath ?? worktreeGraphCurrentPath}
        currentSessionId={currentSessionId ?? worktreeGraphSessionId ?? topBarSessionId}
        remotePeer={worktreeGraphDevice && localDeviceId && worktreeGraphDevice.id !== localDeviceId ? worktreeGraphDevice.id : undefined}
        onClose={onCloseWorktreeGraph}
        onSwitchWorktree={onSwitchWorktree}
        onOpenSession={onOpenSession}
        onNewSessionFromNode={onNewSessionFromNode}
      />
    )}
  </>;
}
