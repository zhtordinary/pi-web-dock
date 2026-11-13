"use client";

import { UnifiedSettingsModal, type SettingsTab } from "./UnifiedSettingsModal";
import { FileViewerModal } from "./FileViewerModal";
import { SystemPromptInspector } from "./SystemPromptInspector";
import { SystemPromptPanel } from "./SystemPromptPanel";

// ---------------------------------------------------------------------------
// 面板术语（四面板规范命名）：交代任务、写注释、开 issue 时统一用这套名字。
// 1 聚合侧栏 Aggregate Sidebar：全部设备视图最外层固定左栏（设备切换条 + 跨设备
//   活动会话列表 + 筛选）。外层页渲染 SessionActivitySidebar 且 activityScope="all"，
//   右侧为目标设备 iframe 工作区。
// 2 原始会话侧栏 Original Session Sidebar：左栏「会话模式」（activitySidebarMode=false）——
//   项目选择 + 会话树 + 文件浏览器（./SessionSidebar，#session-sidebar）。
// 3 活动会话侧栏 Activity Session Sidebar：左栏「活动模式」（activitySidebarMode=true）——
//   活动会话列表 + 筛选 + 文件浏览器（SessionActivitySidebar，.session-activity-sidebar）。
// 4 活动大面板 Activity Panel：顶栏「会话活动」单击弹出的浮层面板
//   （.session-activity-panel），与左栏可同开；双击切换侧栏的旧行为已取消。
// 关系：2 与 3 是同一左栏槽位的两种模式（activitySidebarMode 切换）；1 是 3 的外层实例。
// ---------------------------------------------------------------------------

import { useState, useCallback, useRef, useEffect, useLayoutEffect, type ReactNode, type SetStateAction } from "react";
import { createPortal } from "react-dom";
import { useRouter, useSearchParams } from "next/navigation";
import { useGlobalKeyboardShortcuts } from "@/hooks/useKeyboardShortcuts";
import { SessionSidebar, PiWebTitle } from "./SessionSidebar";
import { useAppShellWorktree, useAppShellWorktreeCapability, AppShellWorktreeOverlays, AppShellWorktreeBranchNavigator, AppShellWorktreeBranchPanel, type AppShellWorktreeCallbacks } from "./app-shell-worktree";
import { AppShellSidekickRightPanel, SIDEKICK_TAB_ID, SidekickMessageIcon, buildSidekickButtonLabel, useAppShellSidekick, useAppShellSidekickLifecycle } from "./app-shell-sidekick";
import { readSharedFilters, applyRemoteSharedFilters, readSharedRevision, readSharedOwnerEpoch, subscribeSharedFiltersBroadcast, updateSharedFilters, SessionActivityPanel, SessionActivitySidebar, SharedActivityFilters } from "./SessionActivityPanel";
import { SessionInfoResourcePanel } from "./SessionInfoResourcePanel";
import { SessionTopBarStats } from "./SessionTopBarStats";
import { SessionWaitHistory, SessionWaitPanel } from "./SessionWaitPanel";
import { openReaderEventSource } from "@/lib/reader-events-client";
import { createRemoteSessionMutationClient, type MutationTarget, type PendingSessionMutation } from "@/lib/remote-session-mutation";
import { isSessionMutationBridgeAuthenticationRequired } from "@/lib/session-mutation-bridge";
import { ChatWindow } from "./ChatWindow";
import { SIDEKICK_RIGHT_PANEL_TARGET_ID, SIDEKICK_TOPBAR_PORTAL_ID } from "./SidekickDrawer";
import { CUSTOM_PROMPTS_CHANGED_EVENT } from "@/lib/custom-prompt-types";

export { SIDEKICK_TAB_ID };
import { ExplorerSection } from "./ExplorerSection";
import { FileViewer } from "./FileViewer";
import { BatchContinueButton } from "./BatchContinueButton";
import { TabBar, type Tab } from "./TabBar";
import { movePanelTab, orderPanelTabs } from "@/lib/panel-tab-order";
import { TerminalPanel } from "./TerminalPanel";
import { newTerminalTab, restoreTerminalTabs, TERMINAL_TABS_KEY, type TerminalTab } from "./terminal-tab-state";
import { clearFileTabAnchor, getFileTabId, openFileTab, replaceFileTab, saveFileViewerState } from "./file-tab-state";
import { ProjectTrustDialog, type ProjectTrustFailure } from "./ProjectTrustDialog";
import { AgentFamilyMenu } from "./AgentFamilyMenu";
import { claimSoundRequest, SOUND_CLAIM_REQUEST_EVENT, SOUND_CLAIM_RESPONSE_EVENT, SOUND_UNLOCK_EVENT, statusSoundRequestId, tryPlaySoundRequest, useAudio, waitSoundRequestId, wasSessionDialogRecentlyInteracted } from "@/hooks/useAudio";
import { getThemeSnapshot, useTheme } from "@/hooks/useTheme";
import { isThemePreference } from "@/lib/theme";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { useSessionDetails } from "@/hooks/useSessionDetails";
import { useSessionRunCompletions } from "@/hooks/useSessionRunCompletions";
import { useViewportHeight } from "@/hooks/useViewportHeight";
import { Check, Copy, FileInput, Folder, FolderOpen, GitFork, ListX, Map as MapIcon, MessageSquare, PanelLeftClose, PanelLeftOpen, X } from "lucide-react";
import { useResizablePanel } from "@/hooks/useResizablePanel";
import { copyText } from "@/lib/clipboard";
import { SESSION_RESOURCES_RELOADED_EVENT } from "@/lib/agent-client";
import {
  COLLAPSED_PROVIDERS_CHANGED_EVENT,
  COLLAPSED_PROVIDERS_REQUEST_EVENT,
  COLLAPSED_PROVIDERS_SYNC_EVENT,
  loadCollapsedProviderNames,
  readCollapsedProviderNames,
  writeCollapsedProviderNames,
} from "@/lib/model-visibility-preference";
import { getFileName, normalizeFilePathSlashes } from "@/lib/file-paths";
import { apiPathForPeer } from "@/lib/file-api";
import { clearSessionActivityCache, fetchSessionActivity } from "@/lib/session-activity-fetch";
import { formatMetricNumber as formatMetricNumberValue } from "@/lib/format-metric-number";
import { buildAtMentionText, buildFileAtMentionsText, buildFileLineMentionText } from "@/lib/file-fuzzy";
import {
  claimExtensionAttentionNotification,
  shouldShowBrowserNotification,
  showBrowserNotification,
} from "@/lib/browser-notifications";
import { sessionCompletionTag, type SessionCompletionIdentity } from "@/lib/session-completion-notification";
import { getInitialNavigation, withTabOpen } from "@/lib/initial-navigation";
import { clearTabOpenSession, getTabOpen, setTabOpenNewSession, setTabOpenSession } from "@/lib/tab-session";
import { canRefreshPreview, hasRefreshRisk } from "@/lib/preview-refresh";
import { hasMemoryDraftContent } from "@/lib/draft-store";
import {
  clearLastOpen,
  getLastOpenSession,
  setLastOpenSession,
  workspaceKeyOf,
} from "@/lib/workspace-memory";
import {
  getDefaultRightPanelWidth,
  getRightPanelMaxWidth,
  getSidebarMaxWidth,
  RIGHT_PANEL_FALLBACK_WIDTH,
  RIGHT_PANEL_MAX_WIDTH,
  RIGHT_PANEL_MIN_WIDTH,
  SIDEBAR_DEFAULT_WIDTH,
  SIDEBAR_MAX_WIDTH,
  SIDEBAR_MIN_WIDTH,
} from "@/lib/panel-layout";
import type { BlockingExtensionUiRequest, SessionInfo, SessionTreeNode, UserMessage } from "@/lib/types";
import type { SessionActivityDevice, SessionActivityItem } from "@/lib/session-activity-types";
import type { WorktreeBindingDraft } from "@/lib/worktree-bindings";
import type { SessionForkResult } from "@/hooks/useAgentSession";
import type { McpRefusalReason, ProjectTrustStatus } from "@/lib/api-types";
import type { ChatInputHandle } from "./ChatInput";
import type { SessionStatsInfo } from "@/lib/pi-types";
import type { RuntimeInspection } from "@/lib/runtime-inspection";
import type { SettingsSection } from "@/lib/settings-navigation";
import type { ToolEntry } from "@/lib/tool-presets";
import type { FileViewerState } from "@/lib/file-viewer-state";
import { resolveAgentExecutionContext, resolveFileReferencePath, resolveMainlineFileContext, type FileContext } from "@/lib/file-context";
import { buildTalkMapSourceInfo } from "@/lib/talk-map-types";
import { EMBEDDED_MODAL_STATE_EVENT, EMBEDDED_SIDEKICK_DISMISS_EVENT, EMBEDDED_SLASH_DETAILS_CLOSE_EVENT, EMBEDDED_SLASH_DETAILS_EVENT, EMBEDDED_IMAGE_PREVIEW_EVENT, EMBEDDED_IMAGE_PREVIEW_ACK_EVENT, EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT, EMBEDDED_QUOTE_ANNOTATION_EVENT, EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT, EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT, EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT, reduceEmbeddedImagePreview, notifyEmbeddedModalState, type EmbeddedModalKind, type EmbeddedSlashDetailsState, type EmbeddedImagePreviewState, type EmbeddedQuoteAnnotationState } from "@/lib/embedded-modal";
import { SlashCommandDetailsSurface, type SlashCommandDetailsView } from "./SlashCommandDetailsSurface";
import { ImageLightbox } from "./ImageLightbox";
import { QuoteAnnotationModal } from "./QuoteAnnotationModal";
import { ResourceToolbar } from "./app-shell-resource-toolbar";

type SessionCopyField = "file" | "id" | "projectDir" | "gitBranch" | "gitWorktree" | "sourceInfo";
type LayoutControlId = "sessions" | "explorer" | "reader" | "document";
type LayoutControlSurface = "top" | "panel" | "panel-action" | "recovery" | "sidebar";
type AutoNameStatus =
  | { kind: "idle" }
  | { kind: "naming" }
  | { kind: "success" }
  | { kind: "error"; message: string };

function isSubagentSession(session: Pick<SessionInfo, "relation"> | null | undefined): boolean {
  return session?.relation?.kind === "subagent";
}

interface SessionTopBarButtonProps {
  children: ReactNode;
  ariaLabel: string;
  title?: string;
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  sidekickInteraction?: boolean;
  tone?: "default" | "accent";
  iconOnly?: boolean;
  compact?: boolean;
  borderless?: boolean;
}

function SessionTopBarButton({
  children,
  ariaLabel,
  title = ariaLabel,
  onClick,
  active = false,
  disabled = false,
  sidekickInteraction = false,
  tone = "default",
  iconOnly = false,
  compact = false,
  borderless = false,
}: SessionTopBarButtonProps) {
  const highlighted = active || tone === "accent";
  return (
    <button
      type="button"
      onClick={onClick}
      data-sidekick-interaction={sidekickInteraction ? "true" : undefined}
      title={title}
      aria-label={ariaLabel}
      aria-expanded={active || undefined}
      disabled={disabled}
      style={{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: compact ? 0 : 5,
        flexShrink: 0,
        marginRight: borderless ? 0 : undefined,
        width: iconOnly ? (borderless ? 36 : 22) : undefined,
        height: borderless ? "100%" : 22,
        padding: iconOnly ? 0 : (compact ? "0 6px" : "0 8px"),
        boxSizing: "border-box",
        border: borderless ? "none" : "1px solid var(--border)",
        borderLeft: borderless ? "1px solid var(--border)" : undefined,
        borderRadius: borderless ? 0 : 4,
        background: borderless ? "transparent" : (highlighted ? "var(--bg-selected)" : "var(--bg)"),
        color: highlighted ? "var(--accent)" : "var(--text-muted)",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        fontSize: 11,
        lineHeight: 1,
        transition: "color 0.12s, background-color 0.12s",
      }}
      onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
      onMouseLeave={(e) => { e.currentTarget.style.color = highlighted ? "var(--accent)" : "var(--text-muted)"; }}
    >
      {children}
    </button>
  );
}

interface TalkMapGhostConversion {
  ghostId: string;
  projectRoot: string;
}

interface NewSessionOptions {
  initialMessage?: string;
  contextSourceSessionId?: string;
  talkMapGhost?: TalkMapGhostConversion;
  worktreeBinding?: WorktreeBindingDraft;
}

interface PendingTalkMapGhostConversion extends TalkMapGhostConversion {
  draftKey: string;
  peer?: string;
}

interface EmbeddedNewSessionRequest extends NewSessionOptions {
  cwd: string;
  subprojectId?: string;
  subprojectLabel?: string;
}

interface EmbeddedResourceSession {
  deviceId: string;
  sessionId: string | null;
  cwd: string | null;
  path: string | null;
}

interface WorkspaceOwner {
  cwd: string | null;
  remotePeer: string | null;
}

function embeddedSessionIdOf(
  sessionKey: string | null,
  resourceSession: EmbeddedResourceSession | null,
  iframeSessionId: string | null,
): string | null {
  if (resourceSession?.sessionId) return resourceSession.sessionId;
  if (iframeSessionId) return iframeSessionId;
  if (!sessionKey) return null;
  const separator = sessionKey.indexOf(":");
  const candidate = separator >= 0 ? sessionKey.slice(separator + 1) : "";
  return candidate && !candidate.startsWith("new:") ? candidate : null;
}

const TOP_BAR_ICON_BUTTON_SIZE = 36;
const RUNNING_SESSIONS_POLL_MS = 5_000;
const RUNNING_SESSIONS_POLL_TIMEOUT_MS = 4_000;
const SESSION_ACTIVITY_VIEWED_KEY = "pi-session-activity-viewed";
const EMBEDDED_READER_PARAM = "piWebEmbedded";
const EMBEDDED_SESSION_PARAM = "piWebSessionOnly";
const EMBEDDED_CHAT_PARAM = "piWebChatOnly";
const EMBEDDED_SIDEBAR_PARAM = "piWebSidebarOnly";
const EMBEDDED_ACTIVITY_SIDEBAR_PARAM = "piWebActivitySidebar";
const EMBEDDED_RESOURCE_TOOLBAR_PARAM = "piWebResourceToolbar";
const EMBEDDED_RESOURCE_TOOLBAR_OWNER = "outer";
const EMBEDDED_LAYOUT_STATE_EVENT = "pi-web:layout-state";
const EMBEDDED_PARENT_SIDEBAR_TOGGLE_EVENT = "pi-web:parent-sidebar-toggle";
const EMBEDDED_PARENT_SIDEBAR_REQUEST_EVENT = "pi-web:parent-sidebar-request";
const EMBEDDED_PARENT_SIDEBAR_STATE_EVENT = "pi-web:parent-sidebar-state";
const EMBEDDED_FILTERS_CHANGED_EVENT = "pi-web:filters-changed";
const EMBEDDED_REQUEST_FILTERS_EVENT = "pi-web:request-filters";
const EMBEDDED_OPEN_SESSION_EVENT = "pi-web:open-session";
const EMBEDDED_OPEN_SESSION_REQUEST_EVENT = "pi-web:open-session-request";
// 嵌入页内部打开会话（同设备点击/URL 恢复）→ 通知外层同步 URL。
// 跨源 iframe 无法被外层读 URL，刷新后外层重建 iframe 会丢当前会话，故需主动上报。
const EMBEDDED_SESSION_OPENED_EVENT = "pi-web:session-opened";
// 嵌入页会话文件点击 → 外层统一渲染模态，遮住聚合侧栏与 iframe 外层控件。
const EMBEDDED_OPEN_FILE_EVENT = "pi-web:open-file";
// Delete/archive from one side of an embedded workspace must invalidate the
// other side's active ChatWindow too. The request travels parent -> iframe;
// the notification travels iframe -> parent.
const EMBEDDED_SESSION_INVALIDATE_REQUEST_EVENT = "pi-web:session-invalidate-request";
const EMBEDDED_SESSION_INVALIDATED_EVENT = "pi-web:session-invalidated";
// 嵌入页内部新建会话（草稿）→ 通知外层同步状态：外层 embeddedSessionKey 切到
// 草稿键（device:new:cwd），侧栏高亮清除、URL 会话参数更新，否则高亮残留旧会话。
const EMBEDDED_NEW_SESSION_EVENT = "pi-web:new-session";
// 外层活动面板请求当前嵌入 Reader 在自身文档内新建草稿，避免重建 iframe。
const EMBEDDED_NEW_SESSION_REQUEST_EVENT = "pi-web:new-session-request";
// 嵌入 Reader 完成监听器挂载后通知外层，可安全接收待处理的新建请求。
const EMBEDDED_READER_READY_EVENT = "pi-web:reader-ready";
// Settings can live in outer shell while active composer lives inside iframe.
const EMBEDDED_INSERT_SKILL_EVENT = "pi-web:insert-skill";

interface EmbeddedParentSidebarToggle {
  open?: boolean;
  openDrawer?: boolean;
}

const parseEmbeddedParentSidebarToggle = (data: unknown): EmbeddedParentSidebarToggle | null => {
  if (!data || typeof data !== "object") return null;
  const message = data as { type?: unknown; open?: unknown; openDrawer?: unknown };
  if (message.type !== EMBEDDED_PARENT_SIDEBAR_TOGGLE_EVENT) return null;
  if ("open" in message && typeof message.open !== "boolean") return null;
  if ("openDrawer" in message && typeof message.openDrawer !== "boolean") return null;
  return {
    ...(typeof message.open === "boolean" ? { open: message.open } : {}),
    ...(typeof message.openDrawer === "boolean" ? { openDrawer: message.openDrawer } : {}),
  };
};

const readEmbeddedLayoutState = (
  event: MessageEvent,
  expectedSource: MessageEventSource | null,
): boolean | null => {
  if (!expectedSource || event.source !== expectedSource) return null;
  const data = event.data as { type?: unknown; takesLeftLayout?: unknown } | null;
  if (data?.type !== EMBEDDED_LAYOUT_STATE_EVENT || typeof data.takesLeftLayout !== "boolean") return null;
  return data.takesLeftLayout;
};

const shouldParentYieldLeftLayout = ({
  embeddedDeviceWorkspaceActive,
  readerMode,
  takesLeftLayout,
}: {
  embeddedDeviceWorkspaceActive: boolean;
  readerMode: boolean;
  takesLeftLayout: boolean;
}): boolean => embeddedDeviceWorkspaceActive && !readerMode && takesLeftLayout;

interface EmbeddedLeftSlotState {
  ownsLeftLayout: boolean;
  sidebarShellOpen: boolean;
  mobileBackdropVisible: boolean;
}

const deriveEmbeddedLeftSlotState = ({
  embeddedDeviceWorkspaceActive,
  readerMode,
  takesLeftLayout,
  isMobile,
  sidebarOpen,
  sidebarShellOpen,
}: {
  embeddedDeviceWorkspaceActive: boolean;
  readerMode: boolean;
  takesLeftLayout: boolean;
  isMobile: boolean;
  sidebarOpen: boolean;
  sidebarShellOpen: boolean;
}): EmbeddedLeftSlotState => {
  const ownsLeftLayout = shouldParentYieldLeftLayout({
    embeddedDeviceWorkspaceActive,
    readerMode,
    takesLeftLayout,
  });
  return {
    ownsLeftLayout,
    sidebarShellOpen: ownsLeftLayout ? false : sidebarShellOpen,
    mobileBackdropVisible: isMobile && sidebarOpen && !ownsLeftLayout,
  };
};

const resolveEmbeddedContextCwd = ({
  resourceSession,
  activePeer,
  activeFilePeer,
  activeFileCwd,
}: {
  resourceSession: EmbeddedResourceSession | null;
  activePeer: string | undefined;
  activeFilePeer: string | null;
  activeFileCwd: string | null | undefined;
}): string | null => {
  if (resourceSession && resourceSession.deviceId === activePeer && resourceSession.cwd) return resourceSession.cwd;
  if (activeFilePeer && activeFilePeer === activePeer) return activeFileCwd ?? null;
  return null;
};

const resolveActiveFileCwd = ({
  tabCwd,
  tabPeer,
  activePeer,
  remoteSessionPeer,
  remoteSessionCwd,
  localCwd,
}: {
  tabCwd: string | null | undefined;
  tabPeer: string | null;
  activePeer: string | undefined;
  remoteSessionPeer: string | null;
  remoteSessionCwd: string | null | undefined;
  localCwd: string | null;
}): string | null => {
  // An explicit tab context owns its own path/device; session navigation must not replace it.
  // The former independent guard was `tabPeer !== activePeer || tabPeer !== remoteSessionPeer`.
  // Keep stale tabs out of the active workspace before resolving the shared pair.
  if (tabPeer && activePeer && tabPeer !== activePeer) return null;
  if (tabPeer && remoteSessionPeer && tabPeer !== remoteSessionPeer) return null;
  return resolveWorkspaceOwner({
    embeddedReaderUrl: false,
    activePeer,
    embeddedResourceSession: null,
    remoteSessionPeer,
    remoteSessionCwd,
    activeFilePeer: tabPeer,
    activeFileCwd: tabCwd,
    selectedSessionCwd: tabPeer ? null : tabCwd ?? localCwd,
    newSessionCwd: null,
    activeCwd: tabPeer ? null : localCwd,
  }).cwd;
};

const resolveWorkspaceOwner = ({
  embeddedReaderUrl,
  activePeer,
  embeddedResourceSession,
  remoteSessionPeer,
  remoteSessionCwd,
  activeFilePeer,
  activeFileCwd,
  activeWorkspacePeer,
  activeWorkspaceCwd,
  selectedSessionCwd,
  newSessionCwd,
  activeCwd,
}: {
  embeddedReaderUrl: boolean;
  activePeer: string | null | undefined;
  embeddedResourceSession: EmbeddedResourceSession | null;
  remoteSessionPeer: string | null;
  remoteSessionCwd: string | null | undefined;
  activeFilePeer: string | null;
  activeFileCwd: string | null | undefined;
  activeWorkspacePeer?: string | null;
  activeWorkspaceCwd?: string | null;
  selectedSessionCwd: string | null | undefined;
  newSessionCwd: string | null | undefined;
  activeCwd: string | null | undefined;
}): WorkspaceOwner => {
  const clean = (cwd: string | null | undefined): string | null => cwd?.trim() || null;
  const empty = (): WorkspaceOwner => ({ cwd: null, remotePeer: null });
  const activeOwnerPeer = activePeer ?? null;
  const hasActiveTerminal = activeWorkspacePeer !== undefined || activeWorkspaceCwd !== undefined;

  // An opened remote session is the authoritative workspace owner. A terminal
  // tab from the previous local/remote workspace may stay mounted while the
  // user switches sessions; allowing that stale tab to win here makes the
  // resource toolbar lose its cwd and leaves Skills/Plugins disabled until a
  // full page reload.
  if (remoteSessionPeer) {
    if (activeOwnerPeer && remoteSessionPeer !== activeOwnerPeer) return empty();
    const cwd = clean(remoteSessionCwd);
    return cwd ? { cwd, remotePeer: remoteSessionPeer } : empty();
  }

  if (hasActiveTerminal) {
    const cwd = clean(activeWorkspaceCwd);
    if (activeWorkspacePeer && (!activeOwnerPeer || activeWorkspacePeer !== activeOwnerPeer)) return empty();
    if (!activeWorkspacePeer && activeOwnerPeer) return empty();
    return cwd ? { cwd, remotePeer: activeWorkspacePeer ?? null } : empty();
  }

  if (embeddedReaderUrl) {
    const embeddedCwd = resolveEmbeddedContextCwd({
      resourceSession: embeddedResourceSession,
      activePeer: activeOwnerPeer ?? undefined,
      activeFilePeer,
      activeFileCwd,
    });
    if (embeddedResourceSession?.deviceId === activeOwnerPeer) {
      const cwd = clean(embeddedResourceSession.cwd);
      if (cwd) return { cwd, remotePeer: embeddedResourceSession.deviceId };
    }
    if (activeFilePeer && activeFilePeer === activeOwnerPeer) {
      const cwd = clean(embeddedCwd);
      if (cwd) return { cwd, remotePeer: activeFilePeer };
    }
    return empty();
  }

  if (activeFilePeer) {
    if (!activeOwnerPeer || activeFilePeer !== activeOwnerPeer) return empty();
    const cwd = clean(activeFileCwd);
    return cwd ? { cwd, remotePeer: activeFilePeer } : empty();
  }

  if (activeOwnerPeer) return empty();
  const cwd = clean(selectedSessionCwd) ?? clean(newSessionCwd) ?? clean(activeCwd);
  return cwd ? { cwd, remotePeer: null } : empty();
};

const shouldShowEmbeddedDeviceSwitch = ({
  embeddedDeviceWorkspaceActive,
  readerMode,
  isMobile,
  takesLeftLayout,
}: {
  embeddedDeviceWorkspaceActive: boolean;
  readerMode: boolean;
  isMobile: boolean;
  takesLeftLayout: boolean;
}): boolean => embeddedDeviceWorkspaceActive && !readerMode && !isMobile && !takesLeftLayout;

const shouldShowActivitySidebarContainer = ({
  conversationSidebarVisible,
  embeddedDeviceWorkspaceActive,
  readerMode,
  isMobile,
  takesLeftLayout,
  isEmbeddedSessionOnly = false,
}: {
  conversationSidebarVisible: boolean;
  embeddedDeviceWorkspaceActive: boolean;
  readerMode: boolean;
  isMobile: boolean;
  takesLeftLayout: boolean;
  isEmbeddedSessionOnly?: boolean;
}): boolean => !isEmbeddedSessionOnly && (conversationSidebarVisible || shouldShowEmbeddedDeviceSwitch({
  embeddedDeviceWorkspaceActive,
  readerMode,
  isMobile,
  takesLeftLayout,
}));

const shouldRenderExplorerSection = ({
  explorerSectionOpen,
  activityExplorerCwd,
}: {
  explorerSectionOpen: boolean;
  activityExplorerCwd: string | null;
}): boolean => explorerSectionOpen && Boolean(activityExplorerCwd);

type SessionControlPlacement = "sidebar-header" | "activity-toolbar" | "explorer-toolbar" | "embedded-overlay" | "top-bar" | "right-panel" | "recovery" | "hidden";

/**
 * A（会话侧栏）只有一个可见归属：左侧壳头部 → 活动筛选工具栏 → 文件 Explorer
 * 工具栏 → 父壳嵌入覆盖层 → 主顶栏 → Reader 文件面板 → 恢复条。B/C/D 永远只是
 * 同一行中的相邻控制，不参与 A 的归属决策；嵌套 session-only iframe 则完全交给父壳。
 */
const deriveSessionControlPlacement = ({
  nestedSessionOnlyFrame,
  sidebarHeaderVisible,
  sidebarShellOpen,
  activityToolbarAvailable,
  explorerToolbarAvailable,
  topBarAvailable,
  rightPanelAvailable,
  recoveryAvailable,
  embeddedOverlayAvailable,
}: {
  nestedSessionOnlyFrame: boolean;
  sidebarHeaderVisible: boolean;
  sidebarShellOpen: boolean;
  activityToolbarAvailable: boolean;
  explorerToolbarAvailable: boolean;
  topBarAvailable: boolean;
  rightPanelAvailable: boolean;
  recoveryAvailable: boolean;
  embeddedOverlayAvailable: boolean;
}): SessionControlPlacement => {
  if (nestedSessionOnlyFrame) return "hidden";
  if (sidebarShellOpen && sidebarHeaderVisible) return "sidebar-header";
  if (sidebarShellOpen && activityToolbarAvailable) return "activity-toolbar";
  if (sidebarShellOpen && explorerToolbarAvailable) return "explorer-toolbar";
  if (!sidebarShellOpen && embeddedOverlayAvailable) return "embedded-overlay";
  if (!sidebarShellOpen && topBarAvailable) return "top-bar";
  if (rightPanelAvailable) return "right-panel";
  if (recoveryAvailable) return "recovery";
  return "hidden";
};

const shouldReserveParentSessionControlSlot = ({
  nestedSessionOnlyFrame,
  parentSidebarReady,
  parentSidebarOpen,
  parentSidebarDrawerOpen,
  isMobile,
  sidebarShellOpen = false,
}: {
  nestedSessionOnlyFrame: boolean;
  parentSidebarReady: boolean;
  parentSidebarOpen: boolean;
  parentSidebarDrawerOpen: boolean;
  isMobile: boolean;
  sidebarShellOpen?: boolean;
}): boolean => nestedSessionOnlyFrame
  && parentSidebarReady
  && !(isMobile ? parentSidebarDrawerOpen : parentSidebarOpen)
  && !sidebarShellOpen;

const shouldReserveExplorerParentSessionSlot = ({
  nestedSessionOnlyFrame,
  parentSidebarReady,
  parentSidebarOpen,
  parentSidebarDrawerOpen,
  isMobile,
  sidebarShellOpen = false,
  readerMode = false,
}: {
  nestedSessionOnlyFrame: boolean;
  parentSidebarReady: boolean;
  parentSidebarOpen: boolean;
  parentSidebarDrawerOpen: boolean;
  isMobile: boolean;
  sidebarShellOpen?: boolean;
  readerMode?: boolean;
}): boolean => nestedSessionOnlyFrame
  && parentSidebarReady
  && !(isMobile ? parentSidebarDrawerOpen : parentSidebarOpen)
  && sidebarShellOpen
  && !readerMode;

const MOBILE_VIEWPORT_QUERY = "(max-width: 640px)";
const BUILT_READER_BUILD_ID = process.env.NEXT_PUBLIC_READER_BUILD_ID;
const FIXED_CONVERSATION_SIDEBAR_STORAGE_KEY = "pi-fixed-conversation-sidebar-v1";
const FIXED_CONVERSATION_SIDEBAR_WIDE_QUERY = "(min-width: 1200px)";
type FixedConversationSidebarPreference = "show" | "hide" | null;

function readFixedConversationSidebarPreference(): FixedConversationSidebarPreference {
  if (typeof window === "undefined") return null;
  try {
    const value = window.localStorage.getItem(FIXED_CONVERSATION_SIDEBAR_STORAGE_KEY);
    return value === "show" || value === "hide" ? value : null;
  } catch {
    return null;
  }
}

function defaultFixedConversationSidebarVisible(): boolean {
  if (typeof window === "undefined" || window.innerWidth <= 640) return false;
  return typeof window.matchMedia === "function"
    && window.matchMedia(FIXED_CONVERSATION_SIDEBAR_WIDE_QUERY).matches;
}

function writeFixedConversationSidebarPreference(value: Exclude<FixedConversationSidebarPreference, null>): void {
  try {
    window.localStorage.setItem(FIXED_CONVERSATION_SIDEBAR_STORAGE_KEY, value);
  } catch {
    // Layout preference is optional; the in-memory state remains usable.
  }
}

function hasLegacyWorkspaceLayout(params: URLSearchParams): boolean {
  return params.get("monitor") === "on" || params.get("fullview") === "1";
}

type EmbeddedWorkspaceUrlShape = "session-only" | "full-device" | "device-only";

const embeddedWorkspaceUrlShape = (params: URLSearchParams): EmbeddedWorkspaceUrlShape => {
  const hasDevice = Boolean(params.get("device"));
  const hasSession = Boolean(params.get("session"));
  if (hasDevice && hasSession && (params.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1" || hasLegacyWorkspaceLayout(params))) {
    return "full-device";
  }
  return hasSession ? "session-only" : "device-only";
};

function stripLegacyWorkspaceLayout(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  if (embeddedWorkspaceUrlShape(params) === "full-device") {
    next.set(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1");
  }
  next.delete("monitor");
  next.delete("fullview");
  return next;
}

function isMobileViewport(): boolean {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(MOBILE_VIEWPORT_QUERY).matches;
}

function buildNewSessionDraftKey(cwd: string, subprojectId?: string | null): string {
  return subprojectId ? `new:${cwd}:subproject:${subprojectId}` : `new:${cwd}`;
}

function buildNewSessionPrefill(label?: string | null): string | null {
  const trimmed = label?.trim();
  return trimmed ? `${trimmed}: ` : null;
}

function buildEmbeddedReaderUrl(device: SessionActivityDevice, {
  localDeviceId, sessionId, sessionOnly = false, activitySidebar = false, parentSidebar,
}: {
  localDeviceId: string; sessionId?: string; sessionOnly?: boolean; activitySidebar?: boolean; parentSidebar?: boolean;
}): string | null {
  try {
    const target = new URL(device.id === localDeviceId && typeof window !== "undefined"
      ? window.location.origin : device.url ?? "");
    if (target.protocol !== "http:" && target.protocol !== "https:") return null;
    if (typeof window !== "undefined") {
      const ports: Record<string, string> = ["30142", "30144"].includes(window.location.port)
        ? { "30141": "30142", "30143": "30144" }
        : ["30141", "30143"].includes(window.location.port)
          ? { "30142": "30141", "30144": "30143" } : {};
      target.port = ports[target.port] ?? target.port;
    }
    target.searchParams.set(EMBEDDED_READER_PARAM, "1");
    if (sessionOnly) {
      target.searchParams.set(EMBEDDED_RESOURCE_TOOLBAR_PARAM, EMBEDDED_RESOURCE_TOOLBAR_OWNER);
      target.searchParams.set(EMBEDDED_SESSION_PARAM, "1");
      const parentOpen = parentSidebar ?? (
        typeof document !== "undefined"
          ? !(document.getElementById("session-sidebar")?.classList.contains("sidebar-closed"))
          : true
      );
      target.searchParams.set("piWebParentSidebar", parentOpen ? "1" : "0");
    } else {
      target.searchParams.delete(EMBEDDED_RESOURCE_TOOLBAR_PARAM);
      target.searchParams.delete(EMBEDDED_SESSION_PARAM);
      target.searchParams.delete("piWebParentSidebar");
    }
    if (activitySidebar) target.searchParams.set(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1");
    else target.searchParams.delete(EMBEDDED_ACTIVITY_SIDEBAR_PARAM);
    if (sessionId) target.searchParams.set("session", sessionId);
    else target.searchParams.delete("session");
    target.searchParams.set("theme", getThemeSnapshot().theme);
    applyActivityArchiveView(target);
    return target.toString();
  } catch {
    return null;
  }
}

async function loadLocalSession(sessionId: string): Promise<SessionInfo | null> {
  for (const query of ["", "?archived=1"]) {
    const response = await fetch("/api/sessions" + query, { cache: "no-store" });
    if (!response.ok) throw new Error("Session list HTTP " + response.status);
    const body = await response.json() as { sessions: SessionInfo[] };
    const session = body.sessions.find((item) => item.id === sessionId);
    if (session) return session;
  }
  return null;
}

function withSearchHighlight(url: string, searchTerm?: string | null): string {
  const target = new URL(url);
  if (searchTerm?.trim()) target.searchParams.set("hl", searchTerm.trim());
  else target.searchParams.delete("hl");
  return target.toString();
}

function applyActivityArchiveView(target: URL): void {
  if (readSharedFilters().archiveView === "archived") target.searchParams.set("view", "archived");
  else target.searchParams.delete("view");
}

export function AppShell({ localDeviceId, localDeviceName }: { localDeviceId: string; localDeviceName: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [initialNavigation, setInitialNavigation] = useState(() => getInitialNavigation(searchParams));
  // 聚合外层 URL 恢复标记：?device= 参数（刷新/复制链接）→ 挂载恢复 effect 重建嵌入视图。
  const [restoreDeviceId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("device")
  );
  const embeddedReaderMode = searchParams.get(EMBEDDED_READER_PARAM) === "1";
  const [readerUpdate, setReaderUpdate] = useState<{ version: string; channel?: string } | null>(null);
  const embeddedActivityWorkspace =
    embeddedReaderMode
    && searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1"
    && typeof window !== "undefined"
    && window.parent !== window;
  const [embeddedReaderUrl, setEmbeddedReaderUrl] = useState<string | null>(null);
  const resourceToolbarOwnedByParent = embeddedReaderMode
    && searchParams.get(EMBEDDED_RESOURCE_TOOLBAR_PARAM) === EMBEDDED_RESOURCE_TOOLBAR_OWNER;
  const sessionOnlyMode = embeddedReaderMode && searchParams.get(EMBEDDED_SESSION_PARAM) === "1";
  const isEmbeddedSessionOnly = embeddedReaderMode && (sessionOnlyMode || resourceToolbarOwnedByParent);
  const chatOnlyMode = searchParams.get(EMBEDDED_CHAT_PARAM) === "1";
  const sidebarOnlyMode = searchParams.get(EMBEDDED_SIDEBAR_PARAM) === "1";
  const { preference, isDark, toggleTheme } = useTheme();
  const themeLabelKey = preference === "light"
    ? "theme.light"
    : preference === "dark"
      ? "theme.dark"
      : preference === "mist"
        ? "theme.mist"
        : preference === "rose"
          ? "theme.rose"
          : preference === "pine"
            ? "theme.pine"
            : "theme.auto";
  const { locale, t: translate } = useI18n();
  const isMobile = useIsMobile();
  const mobile = isMobile;
  // 共享 AudioContext 的手势解锁与生命周期由 hooks/useAudio.ts 的模块级监听统一负责
  // （手势、页面可见/聚焦、statechange），这里只需要在嵌入页转告手势时代为恢复。
  const { playWaitSound, canPlaySound: canPlayWaitSound, unlockAudio } = useAudio();
  useViewportHeight();
  // 折叠状态三机同步：启动时预取一次服务端（models.json）折叠清单，
  // 填充模块缓存；预取完成后 dispatch CHANGED，各组件（模型面板/选择器）刷新。
  useEffect(() => {
    loadCollapsedProviderNames();
  }, []);
  // Embedded frames must ask this shell for a sound claim, and tell it about user
  // gestures (those never reach this document). The shell validates both the
  // registered iframe window and the URL origin before acting on either.
  useLayoutEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const data = event.data as {
        type?: unknown;
        requestId?: unknown;
        nonce?: unknown;
      } | null;
      if (!data || (data.type !== SOUND_CLAIM_REQUEST_EVENT && data.type !== SOUND_UNLOCK_EVENT)) return;
      let expectedOrigin: string | null = null;
      try {
        expectedOrigin = embeddedReaderUrl ? new URL(embeddedReaderUrl, window.location.href).origin : null;
      } catch {
        expectedOrigin = null;
      }
      const source = embeddedIframeRef.current?.contentWindow;
      if (!source || event.source !== source || !expectedOrigin || event.origin !== expectedOrigin) return;
      if (data.type === SOUND_UNLOCK_EVENT) {
        unlockAudio();
        return;
      }
      if (
        typeof data.requestId !== "string"
        || data.requestId.length > 512
        || typeof data.nonce !== "string"
      ) return;
      void claimSoundRequest(data.requestId).then((claimed) => {
        source.postMessage(
          { type: SOUND_CLAIM_RESPONSE_EVENT, nonce: data.nonce, claimed },
          expectedOrigin,
        );
      }, () => {
        source.postMessage(
          { type: SOUND_CLAIM_RESPONSE_EVENT, nonce: data.nonce, claimed: false },
          expectedOrigin,
        );
      });
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [embeddedReaderUrl, unlockAudio]);
  // 全局等待播报：没有挂载 ChatWindow 时由 AppShell 消费 Reader 活动 SSE。
  // 嵌入页不独立订阅，由外层 Activity/父级 broker 负责，避免同一 intent 双播。
  useEffect(() => {
    if (embeddedReaderMode) return;
    const source = openReaderEventSource(["waiting_user"]);
    source.onmessage = (event: MessageEvent<string>) => {
      let data: { type?: string; sessions?: Array<{ sessionId: string; requestIds: string[] }> };
      try {
        data = JSON.parse(event.data) as typeof data;
      } catch {
        return;
      }
      if (data.type !== "waiting_user") return;
      // 首帧只记录不播：打开页面/嵌入 iframe 时已存在的弹窗视为回放
      // （弹窗发生时外层聚合页或上一文档已播报过），避免「点进去又响一次」。
      const next = new Set<string>();
      const isFirst = prevWaitRequestIdsRef.current === null;
      for (const session of data.sessions ?? []) {
        // 刚交互过弹窗（弹窗流程的确认/下一步）不播：用户正在操作，弹窗可见。
        if (wasSessionDialogRecentlyInteracted(session.sessionId)) continue;
        for (const requestId of session.requestIds ?? []) {
          next.add(requestId);
          if (isFirst) continue;
          if (!prevWaitRequestIdsRef.current!.has(requestId)) {
            tryPlaySoundRequest(waitSoundRequestId(requestId), playWaitSound, () => canPlayWaitSound("wait"));
          }
        }
      }
      prevWaitRequestIdsRef.current = next;
    };
    return () => source.close();
  }, [embeddedReaderMode, playWaitSound, canPlayWaitSound]);
  const prevWaitRequestIdsRef = useRef<Set<string> | null>(null);
  const [embeddedSessionKey, setEmbeddedSessionKey] = useState<string | null>(null);
  const aggregatedUrlSyncedRef = useRef(false);
  // URL 恢复进行中标记：URL effect 在恢复完成前保持静默（防删参数→重挂载→恢复读错 URL）。
  const mountRestorePendingRef = useRef(false);
  const urlRestoreTokenRef = useRef(0);
  const [embeddedDeviceId, setEmbeddedDeviceId] = useState<string | null>(null);
  const [embeddedResourceSession, setEmbeddedResourceSession] = useState<EmbeddedResourceSession | null>(null);
  // 全部设备完整视图（聚合 monitor）：主区原地显示远程会话视图/本机 ChatWindow，
  // 点会话不整页切 iframe。
  const [aggregateWorkspaceActive, setAggregateWorkspaceActive] = useState(false);
  // Monitor sidebar toggle swaps the activity list for the full Explorer while
  // keeping the chat column mounted.
  const activityWorkspaceActive = aggregateWorkspaceActive || (
    embeddedReaderMode && searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1"
  );
  // 完整设备视图 iframe 内部打开的会话 id（嵌入页 postMessage 上报）。
  // 用于外层 URL 同步（?device=&session=&fullview=1）与刷新恢复。
  const [embeddedIframeSessionId, setEmbeddedIframeSessionId] = useState<string | null>(null);
  // 会话打开时的设备筛选语境：true = 全部设备（URL 带 scope=all）。monitor 切换
  // 据此保留语境——全部设备筛选下打开的会话，monitor on/off 不得跳到具体设备。
  const [embeddedScopeAll, setEmbeddedScopeAll] = useState(false);
  // 收纳/收藏页（URL 带 scope=hidden/favorites）：聚合侧栏切换数据域，主区保持聚合总览。
  const [hiddenView, setHiddenView] = useState(false);
  const [favoritesView, setFavoritesView] = useState(false);
  const [toDiscussView, setToDiscussView] = useState(false);
  const [toReviseView, setToReviseView] = useState(false);
  const [completedView, setCompletedView] = useState(false);
  const [remoteSession, setRemoteSession] = useState<{ device: SessionActivityDevice; sessionInfo: SessionInfo | null; searchTerm: string | null; newSessionCwd: string | null; sessionRunning: boolean; newSessionSubprojectId?: string | null; newSessionSubprojectLabel?: string | null; newSessionContextSourceId?: string | null; newSessionWorktreeBinding?: WorktreeBindingDraft | null; draftInstanceKey?: string; promotedSessionId?: string } | null>(null);
  const committedRemoteSessionRef = useRef(remoteSession);
  useLayoutEffect(() => { committedRemoteSessionRef.current = remoteSession; }, [remoteSession]);
  const remoteDraftInstanceRef = useRef(0);
  const remoteNewSessionDraftKeyRef = useRef<string | null>(null);
  /** Search term that opened the current session; ChatWindow highlights it. */
  const [highlightTerm, setHighlightTerm] = useState<string | null>(null);
  const [embeddedModalOpen, setEmbeddedModalOpen] = useState(false);
  const [embeddedModalKind, setEmbeddedModalKind] = useState<EmbeddedModalKind | null>(null);
  const [embeddedSlashDetails, setEmbeddedSlashDetails] = useState<(SlashCommandDetailsView & { requestId: number }) | null>(null);
  const embeddedSlashDetailsRef = useRef<(SlashCommandDetailsView & { requestId: number }) | null>(null);
  embeddedSlashDetailsRef.current = embeddedSlashDetails;
  const [embeddedQuoteAnnotation, setEmbeddedQuoteAnnotation] = useState<EmbeddedQuoteAnnotationState | null>(null);
  const embeddedQuoteAnnotationRef = useRef<EmbeddedQuoteAnnotationState | null>(null);
  embeddedQuoteAnnotationRef.current = embeddedQuoteAnnotation;
  const [embeddedImagePreview, setEmbeddedImagePreview] = useState<EmbeddedImagePreviewState | null>(null);
  const embeddedImagePreviewRef = useRef<EmbeddedImagePreviewState | null>(null);
  const [embeddedFileViewerOpen, setEmbeddedFileViewerOpen] = useState(false);
  const [embeddedExplorerTakesLeftLayout, setEmbeddedExplorerTakesLeftLayout] = useState(false);
  const embeddedIframeRef = useRef<HTMLIFrameElement | null>(null);
  const embeddedIframeReadyRef = useRef(false);
  const embeddedSessionRequestSerialRef = useRef(0);
  const embeddedSessionRequestTimerRef = useRef<number | null>(null);
  const invalidateEmbeddedSessionRequest = useCallback(() => {
    embeddedSessionRequestSerialRef.current += 1;
    if (embeddedSessionRequestTimerRef.current !== null) {
      window.clearTimeout(embeddedSessionRequestTimerRef.current);
      embeddedSessionRequestTimerRef.current = null;
    }
  }, []);
  // Session changes inside one iframe do not remount its document. Keep the
  // current owner in refs so the iframe readiness listener can stay mounted
  // for the document lifetime instead of resetting on every session click.
  const embeddedSessionKeyRef = useRef<string | null>(null);
  const embeddedDeviceIdRef = useRef<string | null>(null);
  embeddedSessionKeyRef.current = embeddedSessionKey;
  embeddedDeviceIdRef.current = embeddedDeviceId;
  const [selectedSession, setSelectedSessionState] = useState<SessionInfo | null>(null);
  const [sessionKey, setSessionKey] = useState(0);
  const committedSelectedSessionRef = useRef(selectedSession);
  useLayoutEffect(() => { committedSelectedSessionRef.current = selectedSession; }, [selectedSession]);
  const setSelectedSession = useCallback((next: SetStateAction<SessionInfo | null>) => {
    if (next === null && committedSelectedSessionRef.current) setSessionKey((key) => key + 1);
    setSelectedSessionState(next);
  }, []);
  const worktreeCallbacksRef = useRef<AppShellWorktreeCallbacks | null>(null);
  const {
    talkMapOpen, talkMapProjectRoot, talkMapDevice, talkMapFocusSessionId, talkMapSidebarSessionId,
    worktreeGraphOpen, worktreeGraphProjectRoot, worktreeGraphDevice, worktreeGraphSessionId, worktreeGraphSessionPath,
    closeTalkMap, closeWorktreeGraph, openTalkMap, openWorktreeGraph, handleOpenWorktreeGraph,
    handleWorktreeGraphNewSession, handleWorktreeGraphOpenSession, handleOpenTalkMapForSession,
    handleTalkMapSession, talkMapActionDevice, handleTalkMapSelectCard, handleTalkMapSessionMutation,
    handleTalkMapNewSession, handleTalkMapConvertGhost, handleTalkMapInjectContext, handleTalkMapFork,
    handleActivityTalkMap, handleActivityInjectContext, clearTalkMapSelection, cancelWorktreeGraphOpen,
  } = useAppShellWorktree({ callbacksRef: worktreeCallbacksRef, localDeviceId, localDeviceName, translate });
  const [activitySidebarMode, setActivitySidebarMode] = useState(() => (!embeddedReaderMode && !sessionOnlyMode) || searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1");
  // 完整设备视图（monitor 进入）：设备切换条覆盖 iframe 顶部，iframe 保持全宽。
  const [embeddedDeviceWorkspaceActive, setEmbeddedDeviceWorkspaceActive] = useState(false);
  const activityOwnsBackgroundStatusSounds = embeddedActivityWorkspace
    || (!embeddedReaderMode && !chatOnlyMode && activitySidebarMode);
  const [activityViewedAt, setActivityViewedAt] = useState<Record<string, number>>(() => {
    if (typeof window === "undefined") return {};
    try {
      const parsed = JSON.parse(window.localStorage.getItem(SESSION_ACTIVITY_VIEWED_KEY) ?? "null") as Record<string, unknown> | null;
      const result: Record<string, number> = {};
      for (const [sessionId, value] of Object.entries(parsed ?? {})) {
        if (typeof value === "number" && Number.isFinite(value)) result[sessionId] = value;
      }
      return result;
    } catch {
      return {};
    }
  });
  const mergeActivityViewedAt = useCallback((incoming: Record<string, number>) => {
    setActivityViewedAt((previous) => {
      let changed = false;
      const next = { ...previous };
      for (const [sessionId, value] of Object.entries(incoming)) {
        if (!Number.isFinite(value) || value <= (next[sessionId] ?? 0)) continue;
        next[sessionId] = value;
        changed = true;
      }
      if (!changed) return previous;
      try { window.localStorage.setItem(SESSION_ACTIVITY_VIEWED_KEY, JSON.stringify(next)); } catch { /* storage is optional */ }
      return next;
    });
  }, []);
  const markActivitySessionViewed = useCallback((sessionId: string) => {
    const viewedAt = Date.now();
    mergeActivityViewedAt({ [sessionId]: viewedAt });
    // 标记已读后立即刷新活动面板，避免「刚处理完」不刷新就不消失
    // （viewedAt 乐观更新已进 state，但活动快照/派生显示需要一次 refresh 兜底）。
    setRefreshKey((k) => k + 1);
    void fetch("/api/session-viewed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId }),
    })
      .then((response) => response.ok ? response.json() as Promise<{ viewedAt?: unknown }> : null)
      .then((body) => {
        if (typeof body?.viewedAt === "number" && Number.isFinite(body.viewedAt)) {
          mergeActivityViewedAt({ [sessionId]: body.viewedAt });
        }
      })
      .catch(() => { /* local mark remains usable when server is unavailable */ });
  }, [mergeActivityViewedAt]);

  // 服务端已读状态是同一 Reader 地址下多浏览器的共同真相；本地存储只作
  // 首屏/离线回退。聚合面板的快照也会持续合并 viewedAt。
  useEffect(() => {
    let cancelled = false;
    const loadViewedState = async () => {
      try {
        const response = await fetch("/api/session-viewed", { cache: "no-store" });
        if (!response.ok || cancelled) return;
        const body = await response.json() as { viewedAt?: unknown };
        if (!body.viewedAt || typeof body.viewedAt !== "object" || Array.isArray(body.viewedAt)) return;
        const viewedAt: Record<string, number> = {};
        for (const [sessionId, value] of Object.entries(body.viewedAt)) {
          if (typeof value === "number" && Number.isFinite(value)) viewedAt[sessionId] = value;
        }
        if (!cancelled) mergeActivityViewedAt(viewedAt);
      } catch { /* local storage fallback remains active */ }
    };
    void loadViewedState();
    window.addEventListener("focus", loadViewedState);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", loadViewedState);
    };
  }, [mergeActivityViewedAt]);
  const [pendingRestoreMessage, setPendingRestoreMessage] = useState<UserMessage | null>(null);
  const [pendingContextSourceSessionId, setPendingContextSourceSessionId] = useState<string | null>(null);
  const pendingTalkMapGhostConversionRef = useRef<PendingTalkMapGhostConversion | null>(null);
  const pendingEmbeddedNewSessionRef = useRef<{ deviceId: string; request: EmbeddedNewSessionRequest } | null>(null);
  const pendingEmbeddedSkillRef = useRef<string | null>(null);
  // When user clicks +, we only store the cwd — no fake session id
  // Audio ownership lives here (not in ChatWindow) so the completion tone can
  // also fire for tasks finishing in a non-active workspace whose ChatWindow
  // is not mounted. ChatWindow receives the audio callbacks as props.
  const { soundEnabled, onSoundToggle, playDoneSound, playErrorSound, canPlaySound } = useAudio();
  const notifiedAttentionRequestIdsRef = useRef(new Set<string>());
  const activeTopPanelRef = useRef<string | null>(null);
  const [runningSessionIds, setRunningSessionIds] = useState<Set<string>>(() => new Set());
  const runningEventRevisionRef = useRef(0);
  const applyRunningSnapshot = useCallback((values: string[]) => {
    const ids = new Set(values);
    setRunningSessionIds((previous) => {
      if (previous.size === ids.size && [...ids].every((id) => previous.has(id))) return previous;
      return ids;
    });
  }, []);

  useEffect(() => {
    let active = true;
    const source = openReaderEventSource(["running"]);
    source.onmessage = (event: MessageEvent<string>) => {
      try {
        const parsed = JSON.parse(event.data);
        if (active && parsed?.type === "running" && Array.isArray(parsed.runningSessionIds)
          && parsed.runningSessionIds.every((id: unknown) => typeof id === "string")) {
          runningEventRevisionRef.current += 1;
          applyRunningSnapshot(parsed.runningSessionIds);
        }
      } catch {
        // Keep the last valid snapshot.
      }
    };
    return () => { active = false; source.close(); };
  }, [applyRunningSnapshot]);

  // The shell stays mounted when the raw session sidebar is hidden. Its
  // bounded fallback repairs a missed terminal event for all consumers.
  useEffect(() => {
    let stopped = false;
    let timer: number | null = null;
    let controller: AbortController | null = null;
    const clearTimer = () => {
      if (timer !== null) window.clearTimeout(timer);
      timer = null;
    };
    const schedule = () => {
      clearTimer();
      if (!stopped && document.visibilityState === "visible") {
        timer = window.setTimeout(() => void poll(), RUNNING_SESSIONS_POLL_MS);
      }
    };
    const poll = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      clearTimer();
      const revisionAtRequest = runningEventRevisionRef.current;
      const current = new AbortController();
      controller?.abort();
      controller = current;
      const timeout = window.setTimeout(() => current.abort(), RUNNING_SESSIONS_POLL_TIMEOUT_MS);
      try {
        const res = await fetch("/api/agent/running", { cache: "no-store", signal: current.signal });
        if (!res.ok) return;
        const data = await res.json() as { runningSessionIds?: unknown };
        if (stopped || controller !== current || current.signal.aborted
          || revisionAtRequest !== runningEventRevisionRef.current || !Array.isArray(data.runningSessionIds)
          || !data.runningSessionIds.every((id: unknown) => typeof id === "string")) return;
        applyRunningSnapshot(data.runningSessionIds);
      } catch {
        // Keep the last valid snapshot; the next bounded poll retries.
      } finally {
        window.clearTimeout(timeout);
        if (controller === current) {
          controller = null;
          schedule();
        }
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") void poll();
      else {
        clearTimer();
        controller?.abort();
        controller = null;
      }
    };
    void poll();
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => {
      stopped = true;
      clearTimer();
      controller?.abort();
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [applyRunningSnapshot]);
  const [newSessionCwd, setNewSessionCwd] = useState<string | null>(null);
  const [newSessionWorktreeBinding, setNewSessionWorktreeBinding] = useState<WorktreeBindingDraft | null>(null);
  const [newSessionSubprojectId, setNewSessionSubprojectId] = useState<string | null>(() => initialNavigation.subprojectId);
  const [newSessionSubprojectLabel, setNewSessionSubprojectLabel] = useState<string | null>(() => initialNavigation.subprojectLabel);
  const activeNewSessionDraftKeyRef = useRef<string | null>(null);
  const [initialCwdStatus, setInitialCwdStatus] = useState<"idle" | "validating" | "ready" | "error">(
    () => initialNavigation.requestedCwd ? "validating" : "idle",
  );
  const [initialCwdError, setInitialCwdError] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [explorerRefreshKey, setExplorerRefreshKey] = useState(0);
  const [settingsModalTab, setSettingsModalTab] = useState<SettingsTab | null>(null);
  const [modelsRefreshKey, setModelsRefreshKey] = useState(0);
  const [projectTrust, setProjectTrust] = useState<ProjectTrustStatus | null>(null);
  const [projectTrustDialogOpen, setProjectTrustDialogOpen] = useState(false);
  const [projectTrustBusy, setProjectTrustBusy] = useState(false);
  const [projectTrustError, setProjectTrustError] = useState<ProjectTrustFailure | null>(null);
  // Start closed to avoid a mobile race: open drawer + full-screen backdrop can
  // swallow all taps before the isMobile effect runs (theme toggle included).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Start from what the server rendered (no stored preference, hidden); the viewport and the stored
  // preference apply in a layout effect after hydration, before the first paint.
  const [fixedConversationSidebarPreference, setFixedConversationSidebarPreference] = useState<FixedConversationSidebarPreference>(null);
  const [fixedConversationSidebarVisible, setFixedConversationSidebarVisible] = useState(false);
  useLayoutEffect(() => {
    setFixedConversationSidebarPreference(readFixedConversationSidebarPreference());
  }, []);
  const updateFixedConversationSidebarVisibility = useCallback((
    visible: boolean,
    options: { persist?: boolean; openDrawer?: boolean } = {},
  ) => {
    const mobile = isMobileViewport();
    if (!mobile && options.persist !== false) {
      const nextPreference: Exclude<FixedConversationSidebarPreference, null> = visible ? "show" : "hide";
      setFixedConversationSidebarPreference(nextPreference);
      writeFixedConversationSidebarPreference(nextPreference);
    }
    setSessionListOpen(visible);
    setFixedConversationSidebarVisible(visible);
    setSidebarOpen(!mobile || options.openDrawer !== false ? visible : false);
  }, []);
  useLayoutEffect(() => {
    const syncResponsiveVisibility = () => {
      const mobile = isMobileViewport();
      const visible = mobile
        ? false
        : fixedConversationSidebarPreference === "show"
          || (fixedConversationSidebarPreference === null && defaultFixedConversationSidebarVisible());
      setFixedConversationSidebarVisible(visible);
      if (!mobile) setSidebarOpen(visible);
    };
    syncResponsiveVisibility();
    window.addEventListener("resize", syncResponsiveVisibility);
    return () => window.removeEventListener("resize", syncResponsiveVisibility);
  }, [fixedConversationSidebarPreference]);
  const [sessionListOpen, setSessionListOpen] = useState(() => !sessionOnlyMode);
  // One Explorer visibility intent shared by original, activity, and embedded workspaces.
  const [explorerOpen, setExplorerOpen] = useState(() => !activitySidebarMode && !isEmbeddedSessionOnly);
  const sessionSidebarExplorerOpen = explorerOpen;
  const activityExplorerOpen = explorerOpen;
  const embeddedWorkspaceExplorerOpen = explorerOpen;
  const setSessionSidebarExplorerOpen = setExplorerOpen;
  const setActivityExplorerOpen = setExplorerOpen;
  const setEmbeddedWorkspaceExplorerOpen = setExplorerOpen;
  const embeddedWorkspaceExplorerVisible = activityWorkspaceActive && explorerOpen;
  // Shared sidebar header refresh feedback
  const [headerRefreshDone, setHeaderRefreshDone] = useState(false);
  const headerRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Reader mode = hide chat column + agent chrome; keep C/E intents and open file.
  // Desktop: two panes (tree | preview). Mobile: keep original shell (chatOpen stays true).
  const [readerMode, setReaderMode] = useState(false);
  const chatOpen = !sidebarOnlyMode && (isMobile || !readerMode);
  const explorerSectionOpen = activityWorkspaceActive
    ? embeddedWorkspaceExplorerOpen
    : activitySidebarMode
      ? activityExplorerOpen
      : sessionSidebarExplorerOpen;
  const [rightPanelOpen, setRightPanelOpen] = useState(false);
  const [mobileSidebarReady, setMobileSidebarReady] = useState(false);
  const sidebarWidthRef = useRef(SIDEBAR_DEFAULT_WIDTH);
  const rightPanelWidthRef = useRef(RIGHT_PANEL_FALLBACK_WIDTH);
  const getResponsiveRightPanelWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_FALLBACK_WIDTH
      : getDefaultRightPanelWidth(window.innerWidth),
    [],
  );
  const getResponsiveSidebarMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? SIDEBAR_MAX_WIDTH
      : getSidebarMaxWidth({
        viewportWidth: window.innerWidth,
        rightPanelOpen,
        rightPanelWidth: rightPanelWidthRef.current,
      }),
    [rightPanelOpen],
  );
  const getResponsiveRightPanelMaxWidth = useCallback(
    () => typeof window === "undefined"
      ? RIGHT_PANEL_MAX_WIDTH
      : getRightPanelMaxWidth({
        viewportWidth: window.innerWidth,
        sidebarOpen,
        sidebarWidth: sidebarWidthRef.current,
      }),
    [sidebarOpen],
  );
  const sidebarResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeSidebar"),
    cssVariable: "--sidebar-width",
    defaultWidth: SIDEBAR_DEFAULT_WIDTH,
    getMaxWidth: getResponsiveSidebarMaxWidth,
    growthDirection: "right",
    maxWidth: SIDEBAR_MAX_WIDTH,
    minWidth: SIDEBAR_MIN_WIDTH,
    storageKey: "pi-sidebar-width",
    widthRef: sidebarWidthRef,
  });
  const rightPanelResizer = useResizablePanel({
    ariaLabel: translate("layout.resizeFilePanel"),
    cssVariable: "--right-panel-width",
    defaultWidth: RIGHT_PANEL_FALLBACK_WIDTH,
    getDefaultWidth: getResponsiveRightPanelWidth,
    getMaxWidth: getResponsiveRightPanelMaxWidth,
    growthDirection: "left",
    maxWidth: RIGHT_PANEL_MAX_WIDTH,
    minWidth: RIGHT_PANEL_MIN_WIDTH,
    storageKey: "pi-right-panel-width",
    widthRef: rightPanelWidthRef,
  });
  const reclampSidebarWidth = sidebarResizer.reclampWidth;
  const reclampRightPanelWidth = rightPanelResizer.reclampWidth;
  const mobileAggregateSessionOpen = isMobileViewport() && aggregateWorkspaceActive && (selectedSession !== null || remoteSession !== null);
  useEffect(() => {
    // Full embedded device views open their directory sidebar on desktop;
    // session-only workspaces start collapsed and can reveal it with the top-bar toggle.
    // 嵌入页默认原始侧栏（展开显示文件目录，如 30143 行为）；完整设备视图（monitor）
    // 经 piWebActivitySidebar=1 显式开启活动会话侧栏（会话列表）。
    setActivitySidebarMode((!embeddedReaderMode && !sessionOnlyMode) || searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1");
    // 完整设备视图在桌面端只保留顶部设备切换条；它由外层绝对定位覆盖 iframe。
    // 手机端 monitor 视图必须保持活动侧栏打开，否则设备筛选和 monitor 开关会随 URL
    // 恢复/切换被藏到已收起的抽屉里；普通手机页面仍保留用户当前开合状态。
    setSidebarOpen((open) => {
      if (isMobileViewport()) {
        if (sidebarOnlyMode || embeddedDeviceWorkspaceActive || (aggregateWorkspaceActive && !mobileAggregateSessionOpen)) return true;
        if (sessionOnlyMode) return false;
        return open;
      }
      return sidebarOnlyMode || (!sessionOnlyMode && fixedConversationSidebarVisible);
    });
    setMobileSidebarReady(true);
  }, [aggregateWorkspaceActive, embeddedReaderMode, embeddedDeviceWorkspaceActive, fixedConversationSidebarVisible, mobileAggregateSessionOpen, searchParams, sessionOnlyMode, sidebarOnlyMode]);
  useEffect(() => {
    // A remote activity click can land before useIsMobile receives its first
    // media-query snapshot. Keep the chat full-width on narrow viewports.
    if (embeddedSessionKey && isMobileViewport()) setSidebarOpen(false);
  }, [embeddedSessionKey]);
  // 聚合外层 URL 同步：URL 是视图状态的唯一真源。从当前状态推导
  // device/session/activity-sidebar 参数：强制刷新与复制链接可恢复本视图；
  // 退出聚合视图时同步清除。单机形态（URL 从未带聚合参数）不碰 URL——
  // 单机会话参数由 handleSelectSession 管理。
  // 形态 ↔ URL 映射（与挂载恢复 effect 一一对应）：
  //   全部设备完整视图          → aggregateWorkspaceActive
  //   全部设备完整视图+本机会话 → aggregateWorkspaceActive + session=Y
  //   单设备完整视图+会话       → ?device=X&session=Y&piWebActivitySidebar=1
  //   单设备完整视图            → ?device=X
  //   聚合侧边+会话             → ?device=X&session=Y
  useEffect(() => {
    if (embeddedReaderMode) return;
    if (!aggregatedUrlSyncedRef.current) {
      aggregatedUrlSyncedRef.current = true;
      return; // 首帧：刷新恢复场景的参数由挂载恢复 effect 处理，不覆盖
    }
    // 挂载恢复进行中（URL 带 session/device 的恢复 effect 尚未完成）：不写 URL。
    // 否则这里会先删掉 session 参数 → router.replace 触发组件重挂载 →
    // 恢复 effect 以无 session 的 URL 重跑 → 会话恢复失败（实测根因）。
    if (mountRestorePendingRef.current) return;
    const cur = new URLSearchParams(window.location.search);
    const next = stripLegacyWorkspaceLayout(cur);
    const isCollection = hiddenView || favoritesView || toDiscussView || toReviseView || completedView;
    if (isCollection) {
      let collectionScope = hiddenView ? "hidden" : "favorites";
      if (toDiscussView) collectionScope = "to_discuss";
      else if (toReviseView) collectionScope = "to_revise";
      else if (completedView) collectionScope = "completed";
      else if (favoritesView) collectionScope = "favorites";
      // 收纳页/收藏页：scope 恒在。会话在隐藏页内打开（聚合完整视图原地）时
      // 保留 device/session（与全部设备语境同构，刷新可恢复隐藏页+会话）；
      // 纯隐藏页不承载会话/设备。
      next.set("scope", collectionScope);
      // 隐藏页保留既有互斥语义；收藏页与普通聚合页同构，允许归档 URL。
      if (hiddenView) next.delete("view");
      if (aggregateWorkspaceActive && !embeddedReaderUrl) {
        if (remoteSession?.device.id) {
          next.set("device", remoteSession.device.id);
          if (remoteSession.sessionInfo?.id) next.set("session", remoteSession.sessionInfo.id);
          else { next.delete("session"); next.delete("hl"); }
        } else if (selectedSession) {
          next.delete("device");
          next.set("session", selectedSession.id);
        } else {
          next.delete("device");
          next.delete("session");
          next.delete("hl");
        }
      } else {
        next.delete("device");
        next.delete("session");
        next.delete("hl");
      }
    } else if (aggregateWorkspaceActive && !embeddedReaderUrl) {
      
      // 远程会话 → device=X&session=Y（聚合完整视图，内容一致）；
      // 本机会话 → session=Y（无 device）；新建/无会话 → 无聚合参数。
      if (remoteSession?.device.id) {
        next.set("device", remoteSession.device.id);
        if (remoteSession.sessionInfo?.id) next.set("session", remoteSession.sessionInfo.id);
        else { next.delete("session"); next.delete("hl"); }
      } else if (selectedSession) {
        next.delete("device");
        next.set("session", selectedSession.id);
      } else {
        next.delete("device");
        next.delete("session");
        next.delete("hl");
      }
    } else {
      // 完整设备视图 iframe 内部打开的会话：embeddedSessionKey 为空时由
      // embeddedIframeSessionId 提供（嵌入页 postMessage 上报），并带 activity-sidebar 标记，
      // 刷新后按完整设备视图形态恢复（activitySidebar 嵌入 + 会话），而非 sessionOnly。
      const fromEmbeddedIframe = !embeddedSessionKey && Boolean(embeddedDeviceId && embeddedIframeSessionId);
      // 聚合侧边仍保留当前会话：本机会话不写 device，远程会话必须写回
      // owner device，否则 URL 同步会丢失远程会话并让下一次切换退回空白总览。
      const shellRemoteSession = !embeddedSessionKey && !embeddedDeviceId && !embeddedReaderUrl && remoteSession?.sessionInfo?.id
        ? remoteSession
        : null;
      const shellDeviceId = shellRemoteSession?.device.id ?? null;
      const shellSessionId = !embeddedSessionKey && !embeddedDeviceId && !embeddedReaderUrl
        ? shellRemoteSession?.sessionInfo?.id ?? selectedSession?.id ?? null
        : null;
      const deviceId = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId ?? shellDeviceId;
      const sessionId = embeddedSessionKey?.split(":")[1]
        ?? (fromEmbeddedIframe ? embeddedIframeSessionId : null)
        ?? shellSessionId;
      if (!cur.get("device") && !deviceId && !sessionId) return; // 单机形态
      if (deviceId) next.set("device", deviceId); else next.delete("device");
      if (sessionId) next.set("session", sessionId); else { next.delete("session"); next.delete("hl"); }
      if (fromEmbeddedIframe) next.set(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1");
      else next.delete(EMBEDDED_ACTIVITY_SIDEBAR_PARAM);
    }
    // 全部设备筛选语境（会话打开时筛选=全部设备）：scope=all 标记随 URL 保留，
    // 视图切换与刷新后仍保持全部设备语境；无会话时无参数即全部设备，不写。
    if (!isCollection && embeddedScopeAll && (remoteSession?.sessionInfo?.id || selectedSession || embeddedSessionKey || embeddedIframeSessionId)) {
      next.set("scope", "all");
    } else if (!isCollection) {
      next.delete("scope");
    }
    const nextStr = next.toString();
    if (nextStr !== cur.toString()) {
      if (!nextStr) {
        window.history.replaceState(window.history.state, "", window.location.pathname);
        router.replace(window.location.pathname, { scroll: false });
      } else {
        router.replace(`?${nextStr}`, { scroll: false });
      }
    }
  }, [aggregateWorkspaceActive, embeddedReaderMode, embeddedReaderUrl, remoteSession, selectedSession, embeddedSessionKey, embeddedDeviceId, embeddedIframeSessionId, router, embeddedScopeAll, hiddenView, favoritesView, toDiscussView, toReviseView, completedView, searchParams]);
  // 设备 url 缓存：刷新恢复时先命中缓存立即挂 iframe，后台再校验刷新，
  // 消除“先渲染聚合总览 → 再挂会话 iframe”的多余链路（一次 /api/session-runs 往返）。
  const DEVICE_URL_CACHE_KEY = "pi-web-reader:device-urls-v1";
  const writeDeviceUrlCache = useCallback((deviceId: string, url: string) => {
    try {
      const map = JSON.parse(window.localStorage.getItem(DEVICE_URL_CACHE_KEY) ?? "{}") as Record<string, string>;
      map[deviceId] = url;
      window.localStorage.setItem(DEVICE_URL_CACHE_KEY, JSON.stringify(map));
    } catch { /* storage is optional */ }
  }, []);
  const readDeviceUrlCache = useCallback((deviceId: string): string | null => {
    try {
      return (JSON.parse(window.localStorage.getItem(DEVICE_URL_CACHE_KEY) ?? "{}") as Record<string, string>)[deviceId] ?? null;
    } catch { return null; }
  }, []);

  useEffect(() => {
    if (!rightPanelOpen) return;
    reclampSidebarWidth();
    reclampRightPanelWidth();
  }, [reclampRightPanelWidth, reclampSidebarWidth, rightPanelOpen]);
  const chatInputRef = useRef<ChatInputHandle | null>(null);
  const activeCwdRef = useRef<string | null>(null);
  const activeFileTabCwdRef = useRef<string | null>(null);
  const activeFileTabPeerRef = useRef<string | null>(null);
  const activeTerminalCwdRef = useRef<string | null | undefined>(undefined);
  const activeTerminalPeerRef = useRef<string | null | undefined>(undefined);
  const activePeerIdRef = useRef<string | undefined>(undefined);
  const activityExplorerCwdRef = useRef<string | null>(null);
  const activityExplorerPeerRef = useRef<string | undefined>(undefined);
  const manualFileContextRef = useRef<FileContext | null>(null);
  const pendingAgentSelectionRef = useRef<{ cwd: string; projectRoot: string } | null>(null);
  const [manualFileContext, setManualFileContext] = useState<FileContext | null>(null);
  const updateManualFileContext = useCallback((context: FileContext | null) => {
    manualFileContextRef.current = context;
    setManualFileContext(context);
  }, []);
  const topBarRef = useRef<HTMLDivElement>(null);
  const topPanelRef = useRef<HTMLDivElement>(null);

  // Branch navigator state — populated by ChatWindow via onBranchDataChange
  const [branchTree, setBranchTree] = useState<SessionTreeNode[]>([]);
  const [branchActiveLeafId, setBranchActiveLeafId] = useState<string | null>(null);
  const [branchSwitchLocked, setBranchSwitchLocked] = useState(false);
  const branchLeafChangeFnRef = useRef<((leafId: string | null) => void) | null>(null);

  const handleBranchDataChange = useCallback((tree: SessionTreeNode[], activeLeafId: string | null, onLeafChange: (leafId: string | null) => void, locked = false) => {
    setBranchTree(tree);
    setBranchActiveLeafId(activeLeafId);
    setBranchSwitchLocked(locked);
    branchLeafChangeFnRef.current = onLeafChange;
  }, []);

  const handleBranchLeafChange = useCallback((leafId: string | null) => {
    branchLeafChangeFnRef.current?.(leafId);
  }, []);

  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemTools, setSystemTools] = useState<ToolEntry[] | null>(null);
  const [runtimeInspection, setRuntimeInspection] = useState<RuntimeInspection | null>(null);
  const systemPromptLoaderRef = useRef<(() => Promise<void>) | null>(null);
  const systemPromptLoadIdRef = useRef(0);
  const systemBtnRef = useRef<HTMLButtonElement>(null);

  const handleSystemPromptChange = useCallback((prompt: string | null) => {
    setSystemPrompt(prompt);
  }, []);

  const handleRuntimeInspectionChange = useCallback((inspection: RuntimeInspection | null) => {
    setRuntimeInspection(inspection);
  }, []);

  const handleSystemToolsChange = useCallback((tools: ToolEntry[] | null) => {
    setSystemTools(tools);
  }, []);

  const handleOpenSettings = useCallback((section: SettingsSection) => {
    setSettingsModalTab(section);
  }, []);

  const [systemInfoLoading, setSystemInfoLoading] = useState(false);
  const systemInfoLoadIdRef = useRef(0);

  const handleSystemPromptLoaderChange = useCallback((loader: (() => Promise<void>) | null) => {
    systemPromptLoadIdRef.current += 1;
    systemPromptLoaderRef.current = loader;
  }, []);

  // Session stats (tokens + cost) — populated by the active ChatWindow.
  const [sessionStatsSnapshot, setSessionStatsSnapshot] = useState<{
    sessionId: string;
    peer: string | null;
    generation: number;
    stats: SessionStatsInfo;
  } | null>(null);
  const activeTopBarIdentityRef = useRef<{ sessionId: string | null; peer: string | null; generation: number }>({ sessionId: null, peer: null, generation: 0 });
  const sessionStatsRefreshRef = useRef<(() => Promise<void>) | null>(null);
  const [autoNameStatus, setAutoNameStatus] = useState<AutoNameStatus>({ kind: "idle" });
  const autoNameTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeSessionIdRef = useRef<string | null>(selectedSession?.id ?? null);
  activeSessionIdRef.current = selectedSession?.id ?? null;
  const handleSessionStatsChange = useCallback((stats: SessionStatsInfo | null, sessionId: string | null, peer: string | null, generation: number) => {
    const active = activeTopBarIdentityRef.current;
    if (!sessionId || active.sessionId !== sessionId || active.peer !== peer || active.generation !== generation) return;
    setSessionStatsSnapshot((current) => {
      if (!stats) return current?.sessionId === sessionId && current.peer === peer && current.generation === generation ? null : current;
      if (stats.sessionId !== sessionId) return current;
      return { sessionId, peer, generation, stats };
    });
  }, []);
  const [copiedSessionField, setCopiedSessionField] = useState<SessionCopyField | null>(null);
  const [expandedCostModels, setExpandedCostModels] = useState<Record<string, boolean>>({});
  const toggleCostModels = useCallback((key: string) => {
    setExpandedCostModels((prev) => ({ ...prev, [key]: !prev[key] }));
  }, []);
  const sessionCopyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopySessionField = useCallback((field: SessionCopyField, value: string): Promise<void> => {
    const clipboardValue = field === "sourceInfo" ? `${value.replace(/\n*$/, "")}\n` : value;
    return copyText(clipboardValue).then(() => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      setCopiedSessionField(field);
      sessionCopyTimerRef.current = setTimeout(() => setCopiedSessionField(null), 1400);
    });
  }, []);

  const syncCollapsedProvidersToIframe = useCallback((providers = readCollapsedProviderNames()) => {
    embeddedIframeRef.current?.contentWindow?.postMessage(
      { type: COLLAPSED_PROVIDERS_SYNC_EVENT, providers, fromParent: true },
      "*",
    );
  }, []);

  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const sendParentSidebarState = (target: MessageEventSource | null, targetOrigin: string) => {
      (target as Window | null)?.postMessage(
        {
          type: EMBEDDED_PARENT_SIDEBAR_STATE_EVENT,
          open: fixedConversationSidebarVisible && sessionListOpen,
          openDrawer: sidebarOpen,
        },
        targetOrigin || "*",
      );
    };
    const handleEmbeddedParentSidebarMessage = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const command = parseEmbeddedParentSidebarToggle(event.data);
      if (command) {
        const visible = "open" in command
          ? Boolean(command.open)
          : !(fixedConversationSidebarVisible && sessionListOpen);
        updateFixedConversationSidebarVisibility(visible, {
          persist: false,
          ...(typeof command.openDrawer === "boolean" ? { openDrawer: command.openDrawer } : {}),
        });
        return;
      }
      const data = event.data as { type?: unknown } | null;
      if (data?.type === EMBEDDED_PARENT_SIDEBAR_REQUEST_EVENT) {
        sendParentSidebarState(event.source, event.origin);
      }
    };
    window.addEventListener("message", handleEmbeddedParentSidebarMessage);
    sendParentSidebarState(embeddedIframeRef.current?.contentWindow ?? null, "*");
    return () => window.removeEventListener("message", handleEmbeddedParentSidebarMessage);
  }, [embeddedReaderUrl, fixedConversationSidebarVisible, sessionListOpen, sidebarOpen, updateFixedConversationSidebarVisibility]);

  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const handleCollapsedProvidersMessage = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; providers?: unknown } | null;
      if (data?.type === COLLAPSED_PROVIDERS_REQUEST_EVENT) {
        event.source?.postMessage(
          { type: COLLAPSED_PROVIDERS_SYNC_EVENT, providers: readCollapsedProviderNames(), fromParent: true },
          event.origin || "*",
        );
        return;
      }
      if (data?.type !== COLLAPSED_PROVIDERS_SYNC_EVENT || !Array.isArray(data.providers)) return;
      const names = data.providers.filter((name): name is string => typeof name === "string" && name.trim().length > 0);
      writeCollapsedProviderNames(names);
      window.dispatchEvent(new Event(COLLAPSED_PROVIDERS_CHANGED_EVENT));
    };
    const handleCollapsedProvidersChanged = () => syncCollapsedProvidersToIframe();
    window.addEventListener("message", handleCollapsedProvidersMessage);
    window.addEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, handleCollapsedProvidersChanged);
    syncCollapsedProvidersToIframe();
    return () => {
      window.removeEventListener("message", handleCollapsedProvidersMessage);
      window.removeEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, handleCollapsedProvidersChanged);
    };
  }, [embeddedReaderUrl, syncCollapsedProvidersToIframe]);


  const handleEmbeddedLayoutMessage = useCallback((event: MessageEvent) => {
    const takesLeftLayout = readEmbeddedLayoutState(
      event,
      embeddedIframeRef.current?.contentWindow ?? null,
    );
    if (takesLeftLayout === null) return;
    setEmbeddedExplorerTakesLeftLayout(takesLeftLayout);
  }, []);

  useEffect(() => {
    if (!embeddedReaderUrl) {
      setEmbeddedExplorerTakesLeftLayout(false);
      return;
    }
    window.addEventListener("message", handleEmbeddedLayoutMessage);
    return () => {
      window.removeEventListener("message", handleEmbeddedLayoutMessage);
      setEmbeddedExplorerTakesLeftLayout(false);
    };
  }, [embeddedReaderUrl, handleEmbeddedLayoutMessage]);

  useEffect(() => {
    let expectedOrigin: string | null = null;
    try {
      expectedOrigin = embeddedReaderUrl ? new URL(embeddedReaderUrl, window.location.href).origin : null;
    } catch {
      expectedOrigin = null;
    }
    const isCurrentEmbeddedMessage = (event: MessageEvent) => (
      Boolean(expectedOrigin)
      && event.source === embeddedIframeRef.current?.contentWindow
      && event.origin === expectedOrigin
    );
    const handleEmbeddedModalMessage = (event: MessageEvent) => {
      if (!isCurrentEmbeddedMessage(event)) return;
      const data = event.data as { type?: unknown; open?: unknown; kind?: unknown } | null;
      if (data?.type === EMBEDDED_IMAGE_PREVIEW_EVENT) {
        const next = reduceEmbeddedImagePreview(embeddedImagePreviewRef.current, event.data);
        if (next !== embeddedImagePreviewRef.current) {
          embeddedImagePreviewRef.current = next;
          setEmbeddedImagePreview(next);
        }
        return;
      }
      if (data?.type === EMBEDDED_SLASH_DETAILS_EVENT) {
        const details = event.data as EmbeddedSlashDetailsState;
        if (typeof details.requestId !== "number" || !Number.isSafeInteger(details.requestId)) return;
        if (embeddedSlashDetailsRef.current && details.requestId < embeddedSlashDetailsRef.current.requestId) return;
        if (!details.open) {
          setEmbeddedSlashDetails(null);
          setEmbeddedModalOpen(false);
          setEmbeddedModalKind(null);
          return;
        }
        if (
          typeof details.label !== "string"
          || typeof details.content !== "string"
          || typeof details.loading !== "boolean"
          || (details.error !== undefined && details.error !== null && typeof details.error !== "string")
        ) return;
        const label = details.label.slice(0, 512);
        const content = details.content.slice(0, 4 * 1024 * 1024);
        const sourcePath = typeof details.sourcePath === "string" ? details.sourcePath.slice(0, 4096) : undefined;
        const cwd = typeof details.cwd === "string" ? details.cwd.slice(0, 4096) : undefined;
        const sessionId = typeof details.sessionId === "string" ? details.sessionId.slice(0, 256) : undefined;
        const rawPrompt = details.editablePrompt;
        const editablePrompt = rawPrompt
          && typeof rawPrompt.id === "string" && rawPrompt.id.length > 0 && rawPrompt.id.length <= 256
          && typeof rawPrompt.title === "string" && rawPrompt.title.length <= 512
          && typeof rawPrompt.description === "string" && rawPrompt.description.length <= 4096
          && typeof rawPrompt.content === "string" && rawPrompt.content.length <= 4 * 1024 * 1024
          ? {
            id: rawPrompt.id,
            title: rawPrompt.title,
            description: rawPrompt.description,
            content: rawPrompt.content,
          }
          : undefined;
        setEmbeddedSlashDetails({
          requestId: details.requestId,
          label,
          content,
          loading: details.loading,
          error: typeof details.error === "string" ? details.error.slice(0, 4096) : null,
          ...(sourcePath ? { sourcePath } : {}),
          ...(editablePrompt ? { editablePrompt } : {}),
          ...(cwd ? { cwd } : {}),
          ...(sessionId ? { sessionId } : {}),
        });
        setEmbeddedModalOpen(true);
        setEmbeddedModalKind("slash-detail");
        return;
      }
      if (data?.type === EMBEDDED_QUOTE_ANNOTATION_EVENT) {
        const annotation = event.data as EmbeddedQuoteAnnotationState;
        if (typeof annotation.requestId !== "number" || !Number.isSafeInteger(annotation.requestId)) return;
        if (embeddedQuoteAnnotationRef.current && annotation.requestId < embeddedQuoteAnnotationRef.current.requestId) return;
        if (!annotation.open) {
          setEmbeddedQuoteAnnotation(null);
          return;
        }
        if (typeof annotation.quoteText !== "string") return;
        setEmbeddedQuoteAnnotation({
          requestId: annotation.requestId,
          open: true,
          quoteText: annotation.quoteText.slice(0, 1024 * 1024),
          canDelete: annotation.canDelete === true,
          initialReply: typeof annotation.initialReply === "string" ? annotation.initialReply.slice(0, 1024 * 1024) : undefined,
          targetName: typeof annotation.targetName === "string" ? annotation.targetName.slice(0, 256) : undefined,
        });
        return;
      }
      if (data?.type !== EMBEDDED_MODAL_STATE_EVENT || typeof data.open !== "boolean") return;
      if (data.kind === "image-preview") return;
      if (data.kind === "file-viewer") {
        setEmbeddedFileViewerOpen(data.open);
        return;
      }
      if (!data.open) {
        setEmbeddedModalOpen(false);
        setEmbeddedModalKind(null);
        if (data.kind === "config") setEmbeddedFileViewerOpen(false);
        return;
      }
      setEmbeddedModalOpen(true);
      setEmbeddedModalKind(
        data.kind === "talk-map"
          ? "talk-map"
          : data.kind === "image-preview"
            ? "image-preview"
            : data.kind === "sidekick"
              ? "sidekick"
              : data.kind === "slash-detail"
                ? "slash-detail"
                : "config",
      );
    };
    window.addEventListener("message", handleEmbeddedModalMessage);
    return () => {
      window.removeEventListener("message", handleEmbeddedModalMessage);
      setEmbeddedSlashDetails(null);
      embeddedImagePreviewRef.current = null;
      setEmbeddedImagePreview(null);
    };
  }, [embeddedReaderUrl]);

  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const handleEmbeddedParentPointerDown = (event: PointerEvent) => {
      const iframe = embeddedIframeRef.current;
      const target = event.target;
      if (!iframe || target === iframe || (target instanceof Node && iframe.contains(target))) return;
      if (target instanceof Element && target.closest("[data-sidekick-interaction], [data-sidekick-drawer]")) return;
      iframe.contentWindow?.postMessage({ type: EMBEDDED_SIDEKICK_DISMISS_EVENT }, "*");
    };
    document.addEventListener("pointerdown", handleEmbeddedParentPointerDown);
    return () => document.removeEventListener("pointerdown", handleEmbeddedParentPointerDown);
  }, [embeddedReaderUrl]);

  useEffect(() => {
    const forwardCustomPrompts = () => {
      embeddedIframeRef.current?.contentWindow?.postMessage({ type: CUSTOM_PROMPTS_CHANGED_EVENT }, "*");
    };
    const forwardFavorites = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      embeddedIframeRef.current?.contentWindow?.postMessage({ type: "pi-web:slash-command-favorites-changed", detail }, "*");
    };
    window.addEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, forwardCustomPrompts);
    window.addEventListener("pi-web:slash-command-favorites-changed", forwardFavorites);
    return () => {
      window.removeEventListener(CUSTOM_PROMPTS_CHANGED_EVENT, forwardCustomPrompts);
      window.removeEventListener("pi-web:slash-command-favorites-changed", forwardFavorites);
    };
  }, []);

  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    notifyEmbeddedModalState(rightPanelOpen, "file-viewer");
  }, [embeddedReaderMode, rightPanelOpen]);

  useEffect(() => {
    if (!embeddedReaderUrl) {
      embeddedIframeReadyRef.current = false;
      pendingEmbeddedSkillRef.current = null;
      return;
    }
    embeddedIframeReadyRef.current = false;
    const handleEmbeddedReaderReady = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown } | null;
      if (data?.type !== EMBEDDED_READER_READY_EVENT) return;
      embeddedIframeReadyRef.current = true;
      const pendingSkill = pendingEmbeddedSkillRef.current;
      if (pendingSkill && embeddedIframeRef.current?.contentWindow) {
        embeddedIframeRef.current.contentWindow.postMessage(
          { type: EMBEDDED_INSERT_SKILL_EVENT, command: pendingSkill },
          "*",
        );
        pendingEmbeddedSkillRef.current = null;
      }
      const deviceId = embeddedSessionKeyRef.current?.split(":")[0] ?? embeddedDeviceIdRef.current;
      const pending = pendingEmbeddedNewSessionRef.current;
      if (deviceId && pending?.deviceId === deviceId && embeddedIframeRef.current?.contentWindow) {
        embeddedIframeRef.current.contentWindow.postMessage({ type: EMBEDDED_NEW_SESSION_REQUEST_EVENT, ...pending.request }, "*");
        pendingEmbeddedNewSessionRef.current = null;
      }
      syncCollapsedProvidersToIframe();
    };
    window.addEventListener("message", handleEmbeddedReaderReady);
    return () => window.removeEventListener("message", handleEmbeddedReaderReady);
  }, [embeddedReaderUrl, syncCollapsedProvidersToIframe]);

  useEffect(() => {
    return () => invalidateEmbeddedSessionRequest();
  }, [embeddedReaderUrl, invalidateEmbeddedSessionRequest]);

  // 嵌入页内部新建会话（草稿）上报：外层把 embeddedSessionKey 切到草稿键
  // （device:new:cwd），侧栏高亮不再残留旧会话；完整设备视图（无
  // embeddedSessionKey）则只清 embeddedIframeSessionId，让 URL 去掉 session 参数。
  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const handleNewSessionMessage = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; cwd?: unknown; subprojectId?: unknown; subprojectLabel?: unknown } | null;
      if (data?.type !== EMBEDDED_NEW_SESSION_EVENT) return;
      invalidateEmbeddedSessionRequest();
      const cwd = typeof data.cwd === "string" ? data.cwd : null;
      const subprojectId = typeof data.subprojectId === "string" && data.subprojectId ? data.subprojectId : null;
      const subprojectLabel = typeof data.subprojectLabel === "string" && data.subprojectLabel.trim() ? data.subprojectLabel.trim() : null;
      const deviceId = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId;
      if (deviceId) {
        setEmbeddedResourceSession({ deviceId, sessionId: null, cwd, path: null });
      }
      if (embeddedSessionKey) {
        const deviceId = embeddedSessionKey.split(":")[0];
        setEmbeddedSessionKey(`${deviceId}:new:${cwd ?? ""}${subprojectId ? `:subproject:${subprojectId}` : ""}${subprojectLabel ? `:label:${subprojectLabel}` : ""}`);
      } else if (embeddedDeviceId) {
        setEmbeddedIframeSessionId(null);
      }
    };
    window.addEventListener("message", handleNewSessionMessage);
    return () => window.removeEventListener("message", handleNewSessionMessage);
  }, [embeddedDeviceId, embeddedReaderUrl, embeddedSessionKey, invalidateEmbeddedSessionRequest]);

  // 嵌入页内部打开会话（同设备）上报：完整设备视图下外层只同步 URL
  // （device+session+fullview，URL effect 落地），不重建 iframe；
  // sessionOnly 嵌入时 embeddedSessionKey 已覆盖 URL，跳过。
  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const handleSessionOpenedMessage = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as { type?: unknown; sessionId?: unknown; cwd?: unknown; path?: unknown } | null;
      if (data?.type !== EMBEDDED_SESSION_OPENED_EVENT || typeof data.sessionId !== "string") return;
      invalidateEmbeddedSessionRequest();
      const deviceId = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId;
      if (deviceId) {
        setEmbeddedResourceSession({
          deviceId,
          sessionId: data.sessionId,
          cwd: typeof data.cwd === "string" ? data.cwd : null,
          path: typeof data.path === "string" ? data.path : null,
        });
      }
      if (embeddedSessionKey) {
        // 会话键统一切到上报的会话：草稿键（device:new:...）→ 会话已创建升级；
        // 真实键 → 嵌入页内部 fork 后切到新 fork 会话（高亮/URL 跟随，不残留原会话）。
        const deviceId = embeddedSessionKey.split(":")[0];
        setEmbeddedSessionKey(`${deviceId}:${data.sessionId}`);
        return;
      }
      if (!embeddedDeviceId) return;
      setEmbeddedIframeSessionId(data.sessionId);
    };
    window.addEventListener("message", handleSessionOpenedMessage);
    return () => window.removeEventListener("message", handleSessionOpenedMessage);
  }, [embeddedDeviceId, embeddedReaderUrl, embeddedSessionKey, invalidateEmbeddedSessionRequest]);

  // Embedded pages report only layout telemetry; conversation authority remains in parent.
  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({
      type: EMBEDDED_LAYOUT_STATE_EVENT,
      explorerOpen: explorerSectionOpen,
      takesLeftLayout: activityWorkspaceActive && embeddedWorkspaceExplorerOpen,
    }, "*");
  }, [embeddedReaderMode, explorerSectionOpen, embeddedWorkspaceExplorerOpen, activityWorkspaceActive]);

  const [parentSidebarOpen, setParentSidebarOpen] = useState(
    () => searchParams.get("piWebParentSidebar") === "1",
  );
  const [parentSidebarDrawerOpen, setParentSidebarDrawerOpen] = useState(false);
  const [parentSidebarReady, setParentSidebarReady] = useState(() => !isEmbeddedSessionOnly || searchParams.has("piWebParentSidebar"));

  const toggleParentSidebar = useCallback((open?: boolean, options: { openDrawer?: boolean } = {}) => {
    if (
      !embeddedReaderMode
      || typeof window === "undefined"
      || window.parent === window
      || (isEmbeddedSessionOnly && !parentSidebarReady)
    ) return false;
    window.parent.postMessage({
      type: EMBEDDED_PARENT_SIDEBAR_TOGGLE_EVENT,
      ...(typeof open === "boolean" ? { open } : {}),
      ...(typeof options.openDrawer === "boolean" ? { openDrawer: options.openDrawer } : {}),
    }, "*");
    return true;
  }, [embeddedReaderMode, isEmbeddedSessionOnly, parentSidebarReady]);

  useEffect(() => {
    if (
      !embeddedReaderMode
      || typeof window === "undefined"
      || window.parent === window
      || !isEmbeddedSessionOnly
    ) {
      setParentSidebarReady(!isEmbeddedSessionOnly);
      return;
    }
    setParentSidebarReady(false);
    const handleParentSidebarState = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; open?: unknown; openDrawer?: unknown } | null;
      if (data?.type !== EMBEDDED_PARENT_SIDEBAR_STATE_EVENT || typeof data.open !== "boolean") return;
      if ("openDrawer" in (data ?? {}) && typeof data.openDrawer !== "boolean") return;
      setParentSidebarOpen(data.open);
      setParentSidebarDrawerOpen(typeof data.openDrawer === "boolean" ? data.openDrawer : data.open);
      setParentSidebarReady(true);
    };
    window.addEventListener("message", handleParentSidebarState);
    window.parent.postMessage({ type: EMBEDDED_PARENT_SIDEBAR_REQUEST_EVENT }, "*");
    return () => window.removeEventListener("message", handleParentSidebarState);
  }, [embeddedReaderMode, isEmbeddedSessionOnly]);

  // Only a protocol-2 pair shares filters. Older peers retain usable local
  // filters; never emulate an intent with an unversioned full snapshot.
  const filterLinkModeRef = useRef<"pending" | "linked" | "local">("pending");
  const pendingFilterIntentRef = useRef<Partial<SharedActivityFilters>>({});
  useEffect(() => {
    filterLinkModeRef.current = "pending";
    pendingFilterIntentRef.current = {};
    if (!embeddedReaderMode && !embeddedReaderUrl) return;
    const timer = window.setTimeout(() => {
      if (filterLinkModeRef.current === "pending") { filterLinkModeRef.current = "local"; }
    }, 1500);
    return () => window.clearTimeout(timer);
  }, [embeddedReaderMode, embeddedReaderUrl]);

  useEffect(() => {
    const syncArchiveViewToUrl = (patch?: Partial<SharedActivityFilters>) => {
      if (embeddedReaderMode) {
        if (!patch || window.parent === window) return;
        if (filterLinkModeRef.current !== "linked") {
          pendingFilterIntentRef.current = { ...pendingFilterIntentRef.current, ...patch };
          return;
        }
        window.parent.postMessage({ type: EMBEDDED_FILTERS_CHANGED_EVENT, filterProtocol: 2,
          intent: patch, epoch: readSharedOwnerEpoch() }, "*");
        return;
      }
      if (filterLinkModeRef.current === "linked" && embeddedReaderUrl && embeddedIframeRef.current?.contentWindow) {
        embeddedIframeRef.current.contentWindow.postMessage({ type: EMBEDDED_FILTERS_CHANGED_EVENT, filterProtocol: 2,
          filters: readSharedFilters(), rev: readSharedRevision(), epoch: readSharedOwnerEpoch() }, "*");
      }
      const filters = readSharedFilters();
      const next = new URLSearchParams(window.location.search);
      if (filters.archiveView === "archived" && next.get("scope") !== "hidden") next.set("view", "archived");
      else next.delete("view");
      if (next.toString() !== window.location.search.replace(/^\?/, "")) router.replace(`?${next.toString()}`, { scroll: false });
    };
    if (!embeddedReaderMode) syncArchiveViewToUrl();
    return subscribeSharedFiltersBroadcast(syncArchiveViewToUrl);
  }, [embeddedReaderMode, embeddedReaderUrl, router]);

  useEffect(() => {
    const handleFiltersMessage = (event: MessageEvent) => {
      if (embeddedReaderMode) {
        if (event.source !== window.parent) return;
      } else if (!embeddedReaderUrl || event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as { type?: string; filterProtocol?: number; filters?: SharedActivityFilters; intent?: Partial<SharedActivityFilters>; rev?: number; epoch?: string; initial?: boolean } | null;
      if (![EMBEDDED_FILTERS_CHANGED_EVENT, EMBEDDED_REQUEST_FILTERS_EVENT].includes(data?.type || "")) return;
      if (data?.filterProtocol !== 2) {
        filterLinkModeRef.current = "local";
        return;
      }
      if (data?.type === EMBEDDED_FILTERS_CHANGED_EVENT && data.filters && typeof data.rev === "number" && embeddedReaderMode) {
        // Initial/reload handshake accepts the owner's epoch; local storage is
        // never sent upstream. Actual user edits made before ready are replayed.
        filterLinkModeRef.current = "linked";
        const accepted = applyRemoteSharedFilters(data.rev, data.filters, data.epoch, data.initial === true);
        if (!accepted) return;
        const pending = pendingFilterIntentRef.current; pendingFilterIntentRef.current = {};
        if (Object.keys(pending).length) updateSharedFilters(pending);
      }
      if (data?.type === EMBEDDED_FILTERS_CHANGED_EVENT && !embeddedReaderMode && data.intent && data.epoch === readSharedOwnerEpoch()) {
        updateSharedFilters(data.intent);
      }
      if (data?.type === EMBEDDED_REQUEST_FILTERS_EVENT && !embeddedReaderMode) {
        filterLinkModeRef.current = "linked";
        embeddedIframeRef.current?.contentWindow?.postMessage({ type: EMBEDDED_FILTERS_CHANGED_EVENT, filterProtocol: 2,
          initial: true, filters: readSharedFilters(), rev: readSharedRevision(), epoch: readSharedOwnerEpoch() }, "*");
      }
    };
    window.addEventListener("message", handleFiltersMessage);
    return () => window.removeEventListener("message", handleFiltersMessage);
  }, [embeddedReaderMode, embeddedReaderUrl]);

  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ type: EMBEDDED_REQUEST_FILTERS_EVENT, filterProtocol: 2 }, "*");
  }, [embeddedReaderMode]);

  useEffect(() => {
    return () => {
      if (sessionCopyTimerRef.current) clearTimeout(sessionCopyTimerRef.current);
      if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
      if (headerRefreshTimerRef.current) clearTimeout(headerRefreshTimerRef.current);
    };
  }, []);

  // Context usage — populated by the active ChatWindow.
  const [liveContextUsageSnapshot, setLiveContextUsageSnapshot] = useState<{
    sessionId: string;
    peer: string | null;
    generation: number;
    usage: { percent: number | null; contextWindow: number; tokens: number | null };
  } | null>(null);
  const handleContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null, sessionId: string | null, peer: string | null, generation: number) => {
    const active = activeTopBarIdentityRef.current;
    if (!sessionId || active.sessionId !== sessionId || active.peer !== peer || active.generation !== generation) return;
    setLiveContextUsageSnapshot((current) => {
      if (!usage) return current?.sessionId === sessionId && current.peer === peer && current.generation === generation ? null : current;
      return { sessionId, peer, generation, usage };
    });
  }, []);

  // Single active panel — only one dropdown open at a time
  const [activeTopPanel, setActiveTopPanel] = useState<"branches" | "system" | "session" | "activity" | "agents" | "language" | null>(null);
  activeTopPanelRef.current = activeTopPanel;
  const [topPanelPos, setTopPanelPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const suppressActivityPanelRestoreRef = useRef(false);
  const [fileSearchFocusRequest, setFileSearchFocusRequest] = useState(0);
  const fileSearchFocusConsumedRef = useRef(0);

  const updateTopPanelPosition = useCallback(() => {
    const topBar = topBarRef.current;
    if (!topBar) return;
    const rect = topBar.getBoundingClientRect();
    setTopPanelPos({ top: rect.bottom, left: rect.left, width: rect.width });
  }, []);

  const toggleTopPanel = useCallback((
    panel: "branches" | "system" | "session" | "activity" | "agents",
    _mobile = false,
  ) => {
    if (isMobileViewport()) setSidebarOpen(false);
    if (panel === "system" && activeTopPanelRef.current !== "system") {
      void systemPromptLoaderRef.current?.();
    }
    // Prime position in same event as activation; waiting only for the effect can
    // leave the button selected while the panel render remains gated by topPanelPos.
    updateTopPanelPosition();
    setActiveTopPanel((cur) => cur === panel ? null : panel);
  }, [updateTopPanelPosition]);

  const handleSystemInfoToggle = useCallback((
    panel: "system",
    mobile = false,
  ) => {
    const opening = activeTopPanel !== panel;
    toggleTopPanel(panel, mobile);
    if (!opening || systemInfoLoading) return;

    const load = systemPromptLoaderRef.current;
    if (!load) return;
    const loadId = ++systemInfoLoadIdRef.current;
    setSystemInfoLoading(true);
    void load().catch((error) => {
      console.error("Failed to load system information:", error);
    }).finally(() => {
      if (systemInfoLoadIdRef.current === loadId) {
        setSystemInfoLoading(false);
      }
    });
  }, [activeTopPanel, systemInfoLoading, toggleTopPanel]);


  const handleActivityButtonClick = useCallback(() => {
    toggleTopPanel("activity");
  }, [toggleTopPanel]);
  const openSessionStatsPanel = useCallback(() => {
    if (isMobileViewport()) setSidebarOpen(false);
    setActiveTopPanel("session");
  }, []);

  const handleSidebarToggle = useCallback(() => {
    if (isEmbeddedSessionOnly) {
      const mobile = isMobileViewport();
      const parentDrawerOpen = mobile ? parentSidebarDrawerOpen : undefined;
      toggleParentSidebar(
        mobile ? !parentDrawerOpen : undefined,
        mobile ? { openDrawer: !parentDrawerOpen } : {},
      );
      return;
    }
    if (activityWorkspaceActive && embeddedWorkspaceExplorerOpen) return;
    if (isMobileViewport()) {
      setActiveTopPanel(null);
      const conversationVisible = sidebarOpen
        && sessionListOpen
        && !(activityWorkspaceActive && embeddedWorkspaceExplorerOpen);
      if (!conversationVisible) {
        if (readerMode && !activitySidebarMode) setActivitySidebarMode(true);
        setSessionListOpen(true);
        setSidebarOpen(true);
      } else {
        setSessionListOpen(false);
        if (!explorerSectionOpen) setSidebarOpen(false);
      }
      return;
    }
    const conversationVisible = fixedConversationSidebarVisible
      && sessionListOpen
      && !(activityWorkspaceActive && embeddedWorkspaceExplorerOpen);
    if (!conversationVisible && readerMode && !activitySidebarMode) setActivitySidebarMode(true);
    updateFixedConversationSidebarVisibility(!conversationVisible);
    setActiveTopPanel(null);
  }, [activitySidebarMode, activityWorkspaceActive, embeddedWorkspaceExplorerOpen, explorerSectionOpen, fixedConversationSidebarVisible, isEmbeddedSessionOnly, parentSidebarDrawerOpen, readerMode, sessionListOpen, sidebarOpen, toggleParentSidebar, updateFixedConversationSidebarVisibility]);

  const setExplorerForContext = useCallback((open: boolean, options: { openMobileDrawer?: boolean; workspace?: WorkspaceOwner; cwd?: string | null } = {}) => {
    const manualContext = manualFileContextRef.current;
    const workspace = options.workspace ?? resolveWorkspaceOwner({
      embeddedReaderUrl: Boolean(embeddedReaderUrl),
      activePeer: activePeerIdRef.current,
      embeddedResourceSession,
      remoteSessionPeer: remoteSession?.device.id ?? null,
      remoteSessionCwd: remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd,
      activeFilePeer: activeFileTabPeerRef.current,
      activeFileCwd: activeFileTabCwdRef.current,
      activeWorkspacePeer: activeTerminalPeerRef.current,
      activeWorkspaceCwd: activeTerminalCwdRef.current,
      selectedSessionCwd: selectedSession?.cwd,
      newSessionCwd,
      activeCwd: activeCwdRef.current,
    });
    const manualCwd = manualContext
      && (!manualContext.deviceId || manualContext.deviceId === activePeerIdRef.current)
      ? manualContext.cwd
      : null;
    if (open && !workspace.cwd) return;
    const contextCwd = options.cwd?.trim()
      ?? (options.workspace ? workspace.cwd : manualCwd ?? workspace.cwd);
    if (activityWorkspaceActive) {
      setEmbeddedWorkspaceExplorerOpen(open);
    } else if (activitySidebarMode) {
      setActivityExplorerOpen(open);
    } else {
      setSessionSidebarExplorerOpen(open);
    }
    if (isMobileViewport() && options.openMobileDrawer !== false) {
      setSidebarOpen(open || (sessionListOpen && !readerMode));
    }
  }, [activitySidebarMode, activityWorkspaceActive, embeddedReaderUrl, embeddedResourceSession, newSessionCwd, readerMode, remoteSession?.device.id, remoteSession?.newSessionCwd, remoteSession?.sessionInfo?.cwd, selectedSession?.cwd, sessionListOpen]);

  const setReaderConversationLayout = useCallback((open: boolean) => {
    if (isEmbeddedSessionOnly) {
      return toggleParentSidebar(open, { openDrawer: open || !isMobileViewport() });
    }
    setSessionListOpen(open);
    if (isMobileViewport()) {
      setSidebarOpen(open);
    } else {
      setFixedConversationSidebarVisible(open);
    }
    return true;
  }, [isEmbeddedSessionOnly, toggleParentSidebar]);

  const closeExplorerContexts = useCallback(() => {
    setSessionSidebarExplorerOpen(false);
    setActivityExplorerOpen(false);
    setEmbeddedWorkspaceExplorerOpen(false);
  }, []);

  const toggleExplorer = useCallback(() => {
    const shouldOpen = !explorerSectionOpen || (isMobileViewport() && !sidebarOpen);
    setExplorerForContext(shouldOpen, { openMobileDrawer: true });
  }, [explorerSectionOpen, setExplorerForContext, sidebarOpen]);

  const ensureExplorerOpen = useCallback(() => {
    if (!explorerSectionOpen) setExplorerForContext(true);
  }, [explorerSectionOpen, setExplorerForContext]);

  const handleSessionListToggle = useCallback(() => {
    setSessionListOpen((open) => !open);
  }, []);


  useEffect(() => {
    if (!activeTopPanel) {
      setTopPanelPos(null);
      return;
    }
    if (!topBarRef.current) return;
    updateTopPanelPosition();
    const ro = new ResizeObserver(updateTopPanelPosition);
    ro.observe(topBarRef.current);
    return () => ro.disconnect();
  }, [activeTopPanel, isMobile, mobileSidebarReady, updateTopPanelPosition]);

  // All top panels close when the pointer lands outside the top-bar trigger
  // and the shared panel content.
  useEffect(() => {
    if (!activeTopPanel) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (topBarRef.current?.contains(target) || topPanelRef.current?.contains(target)) return;
      setActiveTopPanel(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [activeTopPanel]);

  // Files unmount when inactive; workspace terminals stay mounted until closed.
  const [fileTabs, setFileTabs] = useState<Tab[]>([]);
  const [activeFileTabId, setActiveFileTabId] = useState<string | null>(null);
  const [terminalTabs, setTerminalTabs] = useState<TerminalTab[]>([]);
  const [terminalsRestored, setTerminalsRestored] = useState(false);
  const [terminalCleanupError, setTerminalCleanupError] = useState<string | null>(null);
  const [panelTabOrder, setPanelTabOrder] = useState<string[]>([]);
  const sidekickSessionIdentity = remoteSession
    ? `remote:${remoteSession.device.id}:${remoteSession.sessionInfo?.id ?? remoteSession.newSessionCwd ?? ""}`
    : `local:${selectedSession?.id ?? ""}`;
  const {
    sidekickOpen,
    sidekickCount,
    sidekickRightPanelOpen,
    isSidekickTabActive,
    selectionToolbar,
    setSidekickCount,
    toggleSidekick,
    toggleSidekickRightPanel,
    closeSidekickRightPanel,
    closeSidekickTab,
    handleSelectionToolbarChange,
  } = useAppShellSidekick({
    sessionIdentity: sidekickSessionIdentity,
    activeFileTabId,
    fileTabs,
    terminalTabs,
    rightPanelOpen,
    setActiveFileTabId,
    setRightPanelOpen,
  });
  const rawPanelTabs: Tab[] = [
    ...fileTabs,
    ...terminalTabs.filter((tab) => tab.closing !== "close").map((tab) => ({
      id: tab.id,
      label: translate("terminal.tabLabel", { name: getFileName(tab.cwd) || tab.cwd }),
      filePath: tab.cwd,
      kind: "terminal" as const,
      closing: Boolean(tab.closing),
    })),
  ];
  const panelTabs = orderPanelTabs(rawPanelTabs, panelTabOrder);
  const panelTabIds = rawPanelTabs.map((tab) => tab.id).join("\n");

  useEffect(() => {
    const openIds = new Set(panelTabIds ? panelTabIds.split("\n") : []);
    setPanelTabOrder((current) => {
      const next = current.filter((id) => openIds.has(id));
      return next.length === current.length ? current : next;
    });
  }, [panelTabIds]);

  useEffect(() => {
    try {
      const saved = restoreTerminalTabs(window.sessionStorage.getItem(TERMINAL_TABS_KEY));
      setTerminalTabs(saved.tabs);
      setActiveFileTabId(saved.activeId);
      if (saved.open && saved.activeId) setRightPanelOpen(true);
    } catch { /* storage is optional */ }
    setTerminalsRestored(true);
  }, []);

  useEffect(() => {
    if (!terminalsRestored) return;
    try {
      window.sessionStorage.setItem(TERMINAL_TABS_KEY, JSON.stringify({
        tabs: terminalTabs.map(({ id, cwd, peer }) => ({ id, cwd, ...(peer ? { peer } : {}) })),
        activeId: terminalTabs.some((tab) => tab.id === activeFileTabId) ? activeFileTabId : null,
        open: rightPanelOpen,
      }));
    } catch { /* storage is optional */ }
  }, [activeFileTabId, rightPanelOpen, terminalTabs, terminalsRestored]);

  const activeFilePath = fileTabs.find((tab) => tab.id === activeFileTabId)?.filePath ?? null;

  const handleExplorerPathRenamed = useCallback((oldPath: string, newPath: string, isDir: boolean, remotePeer?: string) => {
    const oldNormalized = normalizeFilePathSlashes(oldPath).replace(/\/+$/, "");
    const newNormalized = normalizeFilePathSlashes(newPath).replace(/\/+$/, "");
    let nextActiveTabId: string | null = null;
    const nextTabs = fileTabs.map((tab) => {
      if ((tab.remotePeer ?? undefined) !== (remotePeer ?? undefined)) return tab;
      const tabPath = normalizeFilePathSlashes(tab.filePath).replace(/\/+$/, "");
      const isMatch = tabPath === oldNormalized || (isDir && tabPath.startsWith(`${oldNormalized}/`));
      if (!isMatch) return tab;
      const nextPath = isDir && tabPath.startsWith(`${oldNormalized}/`)
        ? `${newNormalized}${tabPath.slice(oldNormalized.length)}`
        : newNormalized;
      const tabCwd = tab.cwd ? normalizeFilePathSlashes(tab.cwd).replace(/\/+$/, "") : "";
      const cwdMatches = tabCwd === oldNormalized || (isDir && tabCwd.startsWith(`${oldNormalized}/`));
      const nextCwd = cwdMatches
        ? (isDir && tabCwd.startsWith(`${oldNormalized}/`) ? `${newNormalized}${tabCwd.slice(oldNormalized.length)}` : newNormalized)
        : tab.cwd;
      const tabRoot = tab.projectRoot ? normalizeFilePathSlashes(tab.projectRoot).replace(/\/+$/, "") : "";
      const rootMatches = tabRoot === oldNormalized || (isDir && tabRoot.startsWith(`${oldNormalized}/`));
      const nextRoot = rootMatches
        ? (isDir && tabRoot.startsWith(`${oldNormalized}/`) ? `${newNormalized}${tabRoot.slice(oldNormalized.length)}` : newNormalized)
        : tab.projectRoot;
      const nextId = getFileTabId(nextPath, tab.remotePeer);
      if (tab.id === activeFileTabId) nextActiveTabId = nextId;
      return { ...tab, id: nextId, label: getFileName(nextPath), filePath: nextPath, ...(nextCwd ? { cwd: nextCwd } : {}), ...(nextRoot ? { projectRoot: nextRoot } : {}), viewerRevision: (tab.viewerRevision ?? 0) + 1 };
    });
    if (nextTabs.some((tab, index) => tab !== fileTabs[index])) setFileTabs(nextTabs);
    if (nextActiveTabId) setActiveFileTabId(nextActiveTabId);
  }, [activeFileTabId, fileTabs]);

  const handleFileViewerStateChange = useCallback((
    tabId: string,
    viewerRevision: number,
    viewerState: FileViewerState,
  ) => {
    setFileTabs((prev) => saveFileViewerState(prev, tabId, viewerRevision, viewerState));
  }, []);

  const handleFileViewerDirtyChange = useCallback((tabId: string, dirty: boolean) => {
    setFileTabs((prev) => {
      const index = prev.findIndex((tab) => tab.id === tabId);
      if (index === -1 || Boolean(prev[index].dirty) === dirty) return prev;
      const next = [...prev];
      next[index] = { ...next[index], dirty };
      return next;
    });
  }, []);

  const confirmDiscardFileChanges = useCallback((tab?: Tab): boolean => {
    if (!tab?.dirty) return true;
    return window.confirm(translate("files.unsavedChangesConfirm", { name: tab.label }));
  }, [translate]);

  const handleChatInputReady = useCallback(() => {
    const command = pendingEmbeddedSkillRef.current;
    if (!command || !chatInputRef.current) return;
    chatInputRef.current.prependText(command);
    pendingEmbeddedSkillRef.current = null;
  }, []);

  const handleUseSkill = useCallback((skillName: string) => {
    // The SDK requires a literal space before any appended multiline draft.
    const command = `/skill:${skillName} `;
    setSettingsModalTab(null);
    let attempts = 0;
    const insertWhenReady = () => {
      const input = chatInputRef.current;
      if (input) {
        input.prependText(command);
        return;
      }
      const iframe = embeddedIframeRef.current?.contentWindow;
      if (embeddedReaderUrl && iframe) {
        pendingEmbeddedSkillRef.current = command;
        if (embeddedIframeReadyRef.current) {
          iframe.postMessage({ type: EMBEDDED_INSERT_SKILL_EVENT, command }, "*");
          pendingEmbeddedSkillRef.current = null;
        }
        return;
      }
      const hasCurrentSession = Boolean(selectedSession || remoteSession?.sessionInfo);
      if (hasCurrentSession || remoteSession) {
        if (attempts++ < 30) requestAnimationFrame(insertWhenReady);
        return;
      }
      const cwd = newSessionCwd ?? activeCwdRef.current;
      if (!cwd) return;
      setNewSessionCwd(cwd);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => chatInputRef.current?.prependText(command));
      });
    };
    requestAnimationFrame(insertWhenReady);
  }, [embeddedReaderUrl, newSessionCwd, remoteSession, selectedSession]);

  useEffect(() => {
    if (typeof window === "undefined" || window.parent === window) return;
    const handleEmbeddedSkillInsert = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; command?: unknown } | null;
      if (data?.type !== EMBEDDED_INSERT_SKILL_EVENT || typeof data.command !== "string") return;
      pendingEmbeddedSkillRef.current = data.command;
      handleChatInputReady();
    };
    window.addEventListener("message", handleEmbeddedSkillInsert);
    return () => window.removeEventListener("message", handleEmbeddedSkillInsert);
  }, []);

  // Same @mention format as the chat input's @ autocomplete, so the agent's
  // read tool resolves it the same way (it strips the @ prefix).
  const handleAtMention = useCallback((filePath: string, isDir: boolean) => {
    const text = buildAtMentionText(resolveFileReferencePath(filePath, manualFileContextRef.current), isDir);
    if (chatInputRef.current) {
      chatInputRef.current.insertText(text);
      return;
    }
    // 无聊天输入框（聚合页未选会话）：以文件浏览目录激活新建会话输入框后再插入，
    // 恢复「点 @ 文件夹 → 输入框出现 @路径」的原有行为。
    const cwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwdRef.current;
    if (!cwd) return;
    setNewSessionCwd(cwd);
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        chatInputRef.current?.insertText(text);
      });
    });
  }, [selectedSession?.cwd, newSessionCwd]);

  const handleAtMentions = useCallback((filePaths: string[]) => {
    const mentions = buildFileAtMentionsText(filePaths.map((path) => resolveFileReferencePath(path, manualFileContextRef.current)));
    if (mentions) chatInputRef.current?.insertText(mentions);
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const handleFileLineMention = useCallback((filePath: string, startLine: number, endLine: number) => {
    chatInputRef.current?.insertText(buildFileLineMentionText(resolveFileReferencePath(filePath, manualFileContextRef.current), startLine, endLine));
    if (isMobile) { setRightPanelOpen(false); setSidebarOpen(false); }
  }, [isMobile]);

  const initialSessionId = initialNavigation.sessionId;
  const [activeCwd, setActiveCwd] = useState<string | null>(null);
  useEffect(() => {
    activeCwdRef.current = activeCwd;
  }, [activeCwd]);
  const activeProjectKeyRef = useRef<string | null>(null);
  // True once the initial ?session= URL param has been resolved (or confirmed absent)
  const [initialSessionRestored, setInitialSessionRestored] = useState<boolean>(() => !initialSessionId);
  useLayoutEffect(() => {
    const next = withTabOpen(initialNavigation, getTabOpen());
    if (next === initialNavigation) return;
    setInitialNavigation(next);
    if (next.sessionId) setInitialSessionRestored(false);
  }, [initialNavigation]);
  const defaultProjectLockedRef = useRef(false);
  // Suppresses sessionKey bump in handleCwdChange during the initial URL restore
  const suppressCwdBumpRef = useRef(false);
  // Guards the async workspace restore so a slow response from an earlier
  // switch cannot resurrect a session into a project the user already left.
  const workspaceRestoreTokenRef = useRef(0);
  const initialSessionRestoredRef = useRef(initialSessionRestored);
  initialSessionRestoredRef.current = initialSessionRestored;

  const invalidateWorkspaceRestore = useCallback(() => {
    workspaceRestoreTokenRef.current += 1;
    // A user selection supersedes any URL restore already in flight. Without
    // this second token a late restore can resurrect the previous device's
    // iframe after the aggregate view has already moved to another device.
    urlRestoreTokenRef.current += 1;
    mountRestorePendingRef.current = false;
    invalidateEmbeddedSessionRequest();
    cancelWorktreeGraphOpen?.();
  }, [cancelWorktreeGraphOpen, invalidateEmbeddedSessionRequest]);

  const clearEmbeddedReaderOwner = useCallback(() => {
    invalidateEmbeddedSessionRequest();
    embeddedIframeReadyRef.current = false;
    setEmbeddedSessionKey(null);
    setEmbeddedDeviceId(null);
    setEmbeddedResourceSession(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    setEmbeddedExplorerTakesLeftLayout(false);
    setEmbeddedModalOpen(false);
    setEmbeddedModalKind(null);
    setEmbeddedSlashDetails(null);
    embeddedImagePreviewRef.current = null;
    setEmbeddedImagePreview(null);
    setEmbeddedFileViewerOpen(false);
  }, [invalidateEmbeddedSessionRequest]);

  // Persist every active-session transition, including new and forked sessions
  // that bypass the sidebar selection handler. Transient sessions do not yet
  // carry projectKey, so use the active project identity until hydration.
  useEffect(() => {
    if (!selectedSession) return;
    const projectKey = selectedSession.projectKey
      ?? activeProjectKeyRef.current
      ?? workspaceKeyOf(selectedSession);
    setLastOpenSession(projectKey, selectedSession.id);
  }, [selectedSession]);

  useEffect(() => {
    if (selectedSession) {
      setTabOpenSession(selectedSession.id);
      return;
    }
    if (newSessionCwd) setTabOpenNewSession(newSessionCwd);
  }, [newSessionCwd, selectedSession]);

  // Reopen the activity panel whenever URL restoration settles a session or cwd.
  const activityPanelRequested = searchParams.get("panel") === "activity";
  useEffect(() => {
    if (!activityPanelRequested) return;
    const frame = window.requestAnimationFrame(() => {
      if (suppressActivityPanelRestoreRef.current) {
        suppressActivityPanelRestoreRef.current = false;
        return;
      }
      if (new URLSearchParams(window.location.search).get("panel") === "activity") setActiveTopPanel("activity");
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activityPanelRequested, activeCwd, selectedSession?.id, initialSessionRestored, mobileSidebarReady]);

  useEffect(() => {
    const requestedCwd = initialNavigation.requestedCwd;
    if (!requestedCwd) return;

    const controller = new AbortController();
    setInitialCwdStatus("validating");
    setInitialCwdError(null);

    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd: requestedCwd }),
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({})) as { cwd?: string; error?: string };
        if (!response.ok || !data.cwd) {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }

        // The sidebar will notify us when it adopts this cwd. Avoid remounting
        // the just-created empty chat during that initial synchronization.
        suppressCwdBumpRef.current = true;
        activeNewSessionDraftKeyRef.current = buildNewSessionDraftKey(data.cwd, initialNavigation.subprojectId);
        setNewSessionSubprojectId(initialNavigation.subprojectId);
        setNewSessionSubprojectLabel(initialNavigation.subprojectLabel);
        setNewSessionCwd(data.cwd);
        setInitialCwdStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setInitialCwdError(error instanceof Error ? error.message : String(error));
        setInitialCwdStatus("error");
      });

    return () => controller.abort();
  }, [initialNavigation]);

  const ensureCwdAllowed = useCallback((cwd: string | null | undefined) => {
    if (!cwd) return;
    void fetch("/api/cwd/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    }).catch(() => { /* non-fatal */ });
  }, []);

  // Current embed shape as URL params (piWebEmbedded / piWebSessionOnly /
  // piWebChatOnly / piWebSidebarOnly). URL rewrites that must not drop the
  // embed shape (new session id, fork id, cwd switch) go through this.
  const workspaceParams = useCallback(() => {
    const params = new URLSearchParams();
    if (embeddedReaderMode) params.set(EMBEDDED_READER_PARAM, "1");
    if (sessionOnlyMode) params.set(EMBEDDED_SESSION_PARAM, "1");
    if (chatOnlyMode) params.set(EMBEDDED_CHAT_PARAM, "1");
    if (sidebarOnlyMode) params.set(EMBEDDED_SIDEBAR_PARAM, "1");
    if (searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1") params.set(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1");
    if (resourceToolbarOwnedByParent) params.set(EMBEDDED_RESOURCE_TOOLBAR_PARAM, EMBEDDED_RESOURCE_TOOLBAR_OWNER);
    // Keep the seeded ?theme= on embedded pages: dropping it would make a
    // later reload fall back to this origin's own pi-theme storage and split
    // the theme away from the aggregate shell again.
    const urlTheme = new URLSearchParams(window.location.search).get("theme");
    if (isThemePreference(urlTheme) && urlTheme !== "auto") params.set("theme", urlTheme);
    return params;
  }, [chatOnlyMode, embeddedReaderMode, resourceToolbarOwnedByParent, searchParams, sessionOnlyMode, sidebarOnlyMode]);

  const replaceWorkspaceRoot = useCallback(() => {
    const params = workspaceParams();
    const query = params.toString();
    const target = query ? `/?${query}` : "/";
    if (typeof window !== "undefined") {
      window.history.replaceState(window.history.state, "", target);
    }
    router.replace(target, { scroll: false });
  }, [router, workspaceParams]);

  // Keep every project we actually use (new session / cwd pick) in the saved
  // project list, so clearing a project's sessions does not lose it — only a
  // right-click removal drops it. Fire-and-forget; failures are harmless.
  const rememberProjectPath = useCallback((cwd: string | null | undefined) => {
    if (!cwd) return;
    void fetch("/api/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd }),
    }).catch(() => { /* non-fatal */ });
  }, []);

  // Restore the workspace's last open session after switching to it. Called
  // from handleCwdChange once the outgoing context has been reset. The session
  // is looked up against the live list so a deleted or drifted session falls
  // back to the default welcome page instead of erroring.
  const restoreWorkspaceContext = useCallback((projectKey: string) => {
    const token = ++workspaceRestoreTokenRef.current;
    const lastOpenSessionId = getLastOpenSession(projectKey);
    if (!lastOpenSessionId) return;
    void fetch("/api/sessions")
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        if (token !== workspaceRestoreTokenRef.current) return; // stale switch
        // A ?session= URL restore still in flight owns the selection (deep
        // links, refresh restore, archived-session iframes). Workspace memory
        // must not hijack it — otherwise the remembered last-open session
        // overwrites the explicitly requested one.
        if (!initialSessionRestoredRef.current) return;
        const s = d?.sessions.find((x) => x.id === lastOpenSessionId);
        if (!s) {
          // The list loaded but the remembered session is gone — forget it.
          // When the list itself failed (d === null) keep the memory so a
          // later switch retries the restore.
          if (d) clearLastOpen(projectKey);
          return;
        }
        if (workspaceKeyOf(s) !== projectKey) {
          // Defensive: the remembered session drifted out of this workspace.
          clearLastOpen(projectKey);
          return;
        }
        // Selecting the session must remount the chat with the session
        // present: useAgentSession loads content in a mount-only effect, so
        // the null-session welcome mount from the switch would never load
        // the restored session's messages.
        setSelectedSession(s);
        setSessionKey((k) => k + 1);
        if (new URLSearchParams(window.location.search).get("session") !== s.id) {
          // Preserve existing params (piWebEmbedded / piWebSessionOnly /
          // piWebChatOnly / piWebSidebarOnly): a bare ?session= replace would
          // drop them and turn an embedded session page back into the full
          // aggregate shell (the "popped side panel").
          const params = workspaceParams();
          params.set("session", s.id);
          router.replace(`?${params.toString()}`, { scroll: false });
        }
      })
      .catch(() => {
        // Network hiccup: keep the remembered session for a later retry.
      });
  }, [router, workspaceParams]);

  const handleCwdChange = useCallback((
    cwd: string | null,
    projectRoot?: string | null,
    projectKey?: string | null,
  ) => {
    invalidateWorkspaceRestore();
    rememberProjectPath(cwd);
    ensureCwdAllowed(cwd);
    const currentFreshCwd = newSessionCwd ?? activeCwd;
    const pendingSelection = pendingAgentSelectionRef.current;
    const agentSelectionSync = Boolean(
      cwd
      && pendingSelection
      && pendingSelection.cwd === cwd
      && pendingSelection.projectRoot === (projectRoot ?? cwd),
    );
    pendingAgentSelectionRef.current = null;
    if (!agentSelectionSync) {
      updateManualFileContext(resolveMainlineFileContext({
        deviceId: activePeerIdRef.current ?? null,
        projectRoot: projectRoot ?? cwd,
        cwd,
      }));
    }
    setActiveCwd(cwd);
    // Skip if cwd is null (initial mount).
    if (!cwd) return;
    const newProject = projectKey ?? projectRoot ?? cwd;
    const currentProject = activeProjectKeyRef.current
      ?? (selectedSession ? workspaceKeyOf(selectedSession) : null);
    activeProjectKeyRef.current = newProject;

    // Keep the project identity in sync during the initial URL restore without
    // remounting the just-created or restored chat.
    if (suppressCwdBumpRef.current) {
      suppressCwdBumpRef.current = false;
      return;
    }
    // The server may hydrate a normalized key after a custom cwd is already
    // active. Updating identity for the exact same cwd is not a user switch.
    if (currentFreshCwd === cwd && currentProject !== newProject) return;
    // Existing sessions stay open when the worktree selector moves within the
    // same project. A fresh composer must remount when its effective cwd moves,
    // otherwise its already-created runtime would keep sending to the old cwd.
    if (
      currentProject === newProject
      && (selectedSession !== null || currentFreshCwd === cwd)
    ) {
      return;
    }
    // Close any session that belongs to a different project — it no longer
    // matches the selected project directory.
    activeNewSessionDraftKeyRef.current = buildNewSessionDraftKey(cwd);
    setSelectedSession(null);
    setNewSessionSubprojectId(null);
    setNewSessionSubprojectLabel(null);
    setNewSessionCwd((prev) => {
      if (prev && prev !== cwd) return null;
      return prev;
    });
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    // Manual file tabs and terminals are independent of Agent execution. Keep
    // them mounted across project/worktree switches; only the Agent session
    // state above changes here.
    if (currentProject !== newProject) {
      // Restore the workspace we switched to: its last open session, or keep
      // the default welcome page when none is remembered.
      restoreWorkspaceContext(newProject);
    }
    replaceWorkspaceRoot();
  }, [activeCwd, ensureCwdAllowed, invalidateWorkspaceRestore, newSessionCwd, rememberProjectPath, replaceWorkspaceRoot, restoreWorkspaceContext, selectedSession, terminalTabs, updateManualFileContext]);

  const handleSelectSession = useCallback((session: SessionInfo, isRestore = false, searchTerm?: string) => {
    closeTalkMap();
    updateManualFileContext(resolveMainlineFileContext({
      deviceId: null,
      projectRoot: session.projectRoot,
      cwd: session.cwd,
    }));
    pendingAgentSelectionRef.current = {
      cwd: session.cwd,
      projectRoot: session.projectRoot ?? session.cwd,
    };
    // Sidebar syncs the selected session cwd after this state update. Keep the
    // project identity current so that sync is not mistaken for a workspace switch.
    activeProjectKeyRef.current = session.projectRoot ?? session.cwd;
    activeNewSessionDraftKeyRef.current = null;
    remoteNewSessionDraftKeyRef.current = null;
    pendingTalkMapGhostConversionRef.current = null;
    pendingEmbeddedNewSessionRef.current = null;
    // 嵌入页：会话打开/恢复上报外层（跨源 iframe 无法被外层读状态）。外层据此
    // 同步 URL（完整设备视图 + 会话可刷新恢复）与侧栏高亮。isRestore 也上报：
    // 嵌入页 URL 恢复（?session= 加载）后外层得知当前会话，URL 保持一致。
    if (embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({
        type: EMBEDDED_SESSION_OPENED_EVENT,
        sessionId: session.id,
        cwd: session.cwd,
        path: session.path,
      }, "*");
    }
    invalidateWorkspaceRestore();
    clearEmbeddedReaderOwner();
    setRemoteSession(null);
    activeNewSessionDraftKeyRef.current = null;
    setPendingRestoreMessage(null);
    // Search state is independent from chat remounting: a search result may
    // point at the session that is already open.
    setHighlightTerm(searchTerm?.trim() || null);
    // Re-clicking the already-open session must not remount the chat and
    // re-run the full load/positioning cycle. Only skip when the effective
    // cwd context already matches — otherwise a pending cwd move still needs
    // the full re-select flow.
    if (selectedSession) {
      const sameProject =
        workspaceKeyOf(selectedSession) === workspaceKeyOf(session);
      if (selectedSession.id === session.id && sameProject) {
        pendingAgentSelectionRef.current = null;
        setInitialSessionRestored(true);
        if (isMobile) setSidebarOpen(false);
        return;
      }
    }
    setPendingContextSourceSessionId(null);
    setNewSessionCwd(null);
    setNewSessionSubprojectId(null);
    setNewSessionSubprojectLabel(null);
    if (!isRestore && new URLSearchParams(window.location.search).get("panel") === "activity") {
      suppressActivityPanelRestoreRef.current = true;
    }
    markActivitySessionViewed(session.id);
    setActiveTopPanel(null);
    setSelectedSession(session);
    setSessionKey((k) => k + 1);
    setSystemPrompt(null);
    setInitialSessionRestored(true);
    // On mobile, collapse the overlay drawer so the chat is revealed after pick.
    if (isMobileViewport() && !isRestore) setSidebarOpen(false);
    if (isRestore) {
      // Suppress the redundant sessionKey bump that would come from the
      // onCwdChange effect firing after setSelectedCwd in the sidebar
      suppressCwdBumpRef.current = true;
    }
    // Skip router.replace when restoring from URL — the param is already correct
    // and calling replace in production Next.js triggers a Suspense remount loop
    if (!isRestore || new URLSearchParams(window.location.search).get("session") !== session.id) {
      const params = workspaceParams();
      params.set("session", session.id);
      if (searchTerm?.trim()) params.set("hl", searchTerm.trim());
      router.replace(`?${params.toString()}`, { scroll: false });
    }
  }, [clearEmbeddedReaderOwner, closeTalkMap, invalidateWorkspaceRestore, router, isMobile, markActivitySessionViewed, workspaceParams, embeddedReaderMode, selectedSession, updateManualFileContext]);

  const openRemoteSession = useCallback((
    device: SessionActivityDevice,
    sessionId: string,
    searchTerm?: string | null,
    context?: { cwd?: string | null; path?: string | null },
  ) => {
    invalidateWorkspaceRestore();
    if (device.id === localDeviceId) {
      const token = urlRestoreTokenRef.current;
      void loadLocalSession(sessionId).then((session) => {
        if (token !== urlRestoreTokenRef.current) return;
        if (!session) throw new Error("Session not found");
        handleSelectSession(session, false, searchTerm ?? undefined);
      }).catch((cause) => {
        if (token === urlRestoreTokenRef.current) window.alert(cause instanceof Error ? cause.message : String(cause));
      });
      return;
    }
    activeNewSessionDraftKeyRef.current = null;
    remoteNewSessionDraftKeyRef.current = null;
    updateManualFileContext(null);
    setSelectedSession(null);
    if (device.url) writeDeviceUrlCache(device.id, device.url);
    const url = buildEmbeddedReaderUrl(device, { localDeviceId, sessionId, sessionOnly: true });
    if (!url) return;
    const highlightedUrl = withSearchHighlight(url, searchTerm);
    setExplorerOpen(false);
    setEmbeddedResourceSession({
      deviceId: device.id,
      sessionId,
      cwd: context?.cwd ?? null,
      path: context?.path ?? null,
    });
    setEmbeddedSessionKey(`${device.id}:${sessionId}`);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedScopeAll(false);
    setEmbeddedReaderUrl(highlightedUrl);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setEmbeddedDeviceWorkspaceActive(false); // 内层转发会话 = 聚合形态，恢复外层聚合侧栏
    setSidebarOpen(!isMobileViewport());
  }, [handleSelectSession, invalidateWorkspaceRestore, localDeviceId, updateManualFileContext, writeDeviceUrlCache]);
  const handleOpenRelatedSession = useCallback((device: { id: string; name: string; url?: string }, sessionId: string) => {
    if (embeddedReaderMode && device.id !== localDeviceId) {
      window.parent.postMessage({ type: EMBEDDED_OPEN_SESSION_EVENT, device, sessionId }, "*");
      return;
    }
    openRemoteSession({ ...device, online: true, lastSeenAt: new Date().toISOString() }, sessionId);
  }, [embeddedReaderMode, localDeviceId, openRemoteSession]);
  // 嵌入页（大面板恒为全部设备）点异设备会话时，外层壳收到 open-session
  // 消息后切换 iframe 到该会话（session-only 嵌入）。
  useEffect(() => {
    if (!embeddedReaderUrl) return;
    const handleOpenSessionMessage = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        device?: SessionActivityDevice;
        sessionId?: unknown;
        searchTerm?: unknown;
        cwd?: unknown;
        path?: unknown;
      } | null;
      if (data?.type !== EMBEDDED_OPEN_SESSION_EVENT || !data.device || typeof data.sessionId !== "string") return;
      openRemoteSession(
        data.device,
        data.sessionId,
        typeof data.searchTerm === "string" ? data.searchTerm : null,
        {
          cwd: typeof data.cwd === "string" ? data.cwd : null,
          path: typeof data.path === "string" ? data.path : null,
        },
      );
    };
    window.addEventListener("message", handleOpenSessionMessage);
    return () => window.removeEventListener("message", handleOpenSessionMessage);
  }, [embeddedReaderUrl, openRemoteSession]);

  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    const handleOpenSessionRequest = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; session?: unknown; searchTerm?: unknown } | null;
      if (data?.type !== EMBEDDED_OPEN_SESSION_REQUEST_EVENT || !data.session || typeof data.session !== "object") return;
      const session = data.session as SessionInfo;
      if (typeof session.id !== "string" || typeof session.cwd !== "string" || typeof session.path !== "string") return;
      handleSelectSession(session, false, typeof data.searchTerm === "string" ? data.searchTerm : undefined);
    };
    window.addEventListener("message", handleOpenSessionRequest);
    return () => window.removeEventListener("message", handleOpenSessionRequest);
  }, [embeddedReaderMode, handleSelectSession]);

  const deleteTalkMapGhost = useCallback(async (conversion: PendingTalkMapGhostConversion): Promise<void> => {
    const peerParam = conversion.peer ? `?peer=${encodeURIComponent(conversion.peer)}` : "";
    const response = await fetch(`/api/${conversion.peer ? "remote/talk-map" : "talk-map"}${peerParam}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectRoot: conversion.projectRoot,
        mutation: { op: "delete-ghost", ghostId: conversion.ghostId },
      }),
    });
    if (!response.ok) throw new Error(`Talk Map ghost deletion HTTP ${response.status}`);
  }, []);

  const appendTalkMapSession = useCallback(async (conversion: PendingTalkMapGhostConversion, sessionId: string): Promise<void> => {
    const peerParam = conversion.peer ? `?peer=${encodeURIComponent(conversion.peer)}` : "";
    const response = await fetch(`/api/${conversion.peer ? "remote/talk-map" : "talk-map"}${peerParam}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectRoot: conversion.projectRoot,
        mutation: { op: "append-session", sessionId },
      }),
    });
    if (!response.ok) throw new Error(`Talk Map session order HTTP ${response.status}`);
  }, []);

  const completeTalkMapGhostConversion = useCallback((sessionId: string, sourceDraftKey: string) => {
    const conversion = pendingTalkMapGhostConversionRef.current;
    if (!conversion || conversion.draftKey !== sourceDraftKey) return;
    pendingTalkMapGhostConversionRef.current = null;
    void deleteTalkMapGhost(conversion).catch((cause) => console.error("Failed to delete converted Talk Map ghost:", cause));
    void appendTalkMapSession(conversion, sessionId).catch((cause) => console.error("Failed to append converted Talk Map session:", cause));
  }, [appendTalkMapSession, deleteTalkMapGhost]);

  const handleNewSession = useCallback((_sessionId: string, cwd: string, subprojectId?: string, subprojectLabel?: string, options?: NewSessionOptions): boolean => {
    updateManualFileContext(resolveMainlineFileContext({
      deviceId: null,
      projectRoot: cwd,
      cwd,
    }));
    closeTalkMap();
    closeWorktreeGraph();
    remoteNewSessionDraftKeyRef.current = null;
    setPendingContextSourceSessionId(options?.contextSourceSessionId ?? null);
    setNewSessionWorktreeBinding(options?.worktreeBinding ?? null);
    const nextSubprojectId = subprojectId || null;
    const nextSubprojectLabel = nextSubprojectId ? subprojectLabel?.trim() || null : null;
    if (embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      // 嵌入页内部新建会话（草稿）：外层 embeddedSessionKey 切到草稿键，
      // 否则侧栏高亮残留旧会话（跨源 iframe 无法被外层读状态）。
      window.parent.postMessage({
        type: EMBEDDED_NEW_SESSION_EVENT,
        cwd,
        ...(nextSubprojectId ? { subprojectId: nextSubprojectId } : {}),
        ...(nextSubprojectLabel ? { subprojectLabel: nextSubprojectLabel } : {}),
        ...(options?.initialMessage ? { initialMessage: options.initialMessage } : {}),
        ...(options?.contextSourceSessionId ? { contextSourceSessionId: options.contextSourceSessionId } : {}),
        ...(options?.worktreeBinding ? { worktreeBinding: options.worktreeBinding } : {}),
        ...(options?.talkMapGhost ? { talkMapGhost: options.talkMapGhost } : {}),
      }, "*");
    }
    invalidateWorkspaceRestore();
    rememberProjectPath(cwd);
    ensureCwdAllowed(cwd);
    const ghostConversion = options?.talkMapGhost;
    setPendingRestoreMessage(options?.initialMessage ? { role: "user", content: options.initialMessage } : null);
    const draftKey = buildNewSessionDraftKey(cwd, nextSubprojectId);
    activeNewSessionDraftKeyRef.current = draftKey;
    pendingTalkMapGhostConversionRef.current = ghostConversion ? { ...ghostConversion, draftKey } : null;
    setSelectedSession(null);
    setNewSessionSubprojectId(nextSubprojectId);
    setNewSessionSubprojectLabel(nextSubprojectLabel);
    setNewSessionCwd(cwd);
    setSessionKey((k) => k + 1);
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setSystemPrompt(null);
    setActiveTopPanel(null);
    clearEmbeddedReaderOwner();
    setRemoteSession(null);
    if (isMobileViewport()) setSidebarOpen(false);
    replaceWorkspaceRoot();
    return true;
  }, [clearEmbeddedReaderOwner, closeTalkMap, closeWorktreeGraph, embeddedReaderMode, ensureCwdAllowed, invalidateWorkspaceRestore, rememberProjectPath, replaceWorkspaceRoot, updateManualFileContext]);

  const handleActivityProjectCwdChange = useCallback((cwd: string | null) => {
    if (!cwd) {
      invalidateWorkspaceRestore();
      setSelectedSession(null);
      setNewSessionSubprojectId(null);
      setNewSessionSubprojectLabel(null);
      setNewSessionCwd(null);
      setRemoteSession(null);
      return;
    }
    // An empty activity project has no session row to open. Reuse the normal
    // new-session transition while explicitly moving the manual mainline view.
    updateManualFileContext(resolveMainlineFileContext({
      deviceId: activePeerIdRef.current ?? null,
      projectRoot: cwd,
      cwd,
    }));
    if (!handleNewSession(`activity-${Date.now()}`, cwd)) return;
    setRemoteSession(null);
  }, [handleNewSession, invalidateWorkspaceRestore, updateManualFileContext]);

  const handleActivityProjectRemoved = useCallback((path: string, deviceId: string) => {
    invalidateWorkspaceRestore();
    if (remoteSession?.device.id === deviceId && remoteSession.sessionInfo === null && remoteSession.newSessionCwd === path) {
      remoteNewSessionDraftKeyRef.current = null;
      setRemoteSession(null);
      return;
    }
    if (deviceId !== localDeviceId || selectedSession !== null) return;
    if (newSessionCwd === path) {
      setNewSessionCwd(null);
      setNewSessionSubprojectId(null);
      setNewSessionSubprojectLabel(null);
    }
    if (activeCwd === path) {
      setActiveCwd(null);
      replaceWorkspaceRoot();
    }
  }, [activeCwd, invalidateWorkspaceRestore, localDeviceId, newSessionCwd, remoteSession, replaceWorkspaceRoot, selectedSession]);

  // Global keyboard shortcuts (handles Esc, Ctrl+Alt+N etc.)
  const inheritedNewSessionSubprojectId = selectedSession?.subprojectId;
  useGlobalKeyboardShortcuts({
    onNewSession: (cwd: string) => handleNewSession(`kb-${Date.now()}`, cwd, inheritedNewSessionSubprojectId),
    activeCwd,
    onFileSearch: () => {
      setFileSearchFocusRequest((request) => request + 1);
      setExplorerForContext(true);
    },
  });

  // Client-built transient SessionInfo (new session / fork) lacks the
  // server-computed projectKey, which the same-project check in
  // handleCwdChange relies on. Hydrate it from the session list so switching
  // worktrees right after creating a session doesn't close the chat.
  const hydrateSelectedSession = useCallback((sessionId: string) => {
    void fetch("/api/sessions", { cache: "no-store" })
      .then((r) => (r.ok ? (r.json() as Promise<{ sessions: SessionInfo[] }>) : null))
      .then((d) => {
        const full = d?.sessions.find((s) => s.id === sessionId);
        if (!full) return;
        setSelectedSession((prev) => (
          prev?.id === sessionId
            ? { ...prev, ...full, transient: full.transient ?? false }
            : prev
        ));
      })
      .catch(() => {});
  }, []);

  const refreshTopBarSessionMetadata = useCallback(() => {
    if (remoteSession) {
      const peerId = remoteSession.device.id;
      const sessionId = remoteSession.sessionInfo?.id;
      if (!sessionId) return;
      void fetch(`/api/remote/sessions?peer=${encodeURIComponent(peerId)}`, { cache: "no-store" })
        .then((response) => (response.ok ? response.json() as Promise<{ sessions?: SessionInfo[] }> : null))
        .then((body) => {
          const updatedSession = body?.sessions?.find((session) => session.id === sessionId);
          if (!updatedSession) return;
          setRemoteSession((current) => (
            current?.device.id === peerId && current.sessionInfo?.id === sessionId
              ? {
                ...current,
                sessionInfo: { ...current.sessionInfo, ...updatedSession, transient: updatedSession.transient ?? false },
              }
              : current
          ));
        })
        .catch(() => {});
      return;
    }
    if (selectedSession) hydrateSelectedSession(selectedSession.id);
  }, [hydrateSelectedSession, remoteSession, selectedSession]);

  const handleSessionStatsButtonClick = useCallback(() => {
    if (activeTopPanelRef.current !== "session") {
      void sessionStatsRefreshRef.current?.();
      refreshTopBarSessionMetadata();
    }
    toggleTopPanel("session");
  }, [refreshTopBarSessionMetadata, toggleTopPanel]);

  // Called by ChatWindow when a new session gets its real id from pi.
  // Keep the current embed shape (piWebEmbedded / piWebSessionOnly) in the
  // URL: dropping them would turn an embedded workspace into a full Reader
  // (activity sidebar reopens, duplicating the outer aggregation list).
  const handleSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string) => {
    // 无论当前前台草稿是否已切走，只要新会话创建成功，都必须立即刷新列表
    setRefreshKey((k) => k + 1);
    // Reject stale completions before applying any conversion or notifying an
    // embedded parent; otherwise a late draft result can consume the current
    // draft's Talk Map context and move its sidebar highlight back to the old
    // draft.
    if (activeNewSessionDraftKeyRef.current !== sourceDraftKey) return;
    completeTalkMapGhostConversion(session.id, sourceDraftKey);
    if (embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      // 嵌入页草稿发送成功、会话已创建：通知外层把草稿键（device:new:cwd）
      // 升级为真实会话键——侧栏高亮跟随新会话、URL 同步（刷新可恢复）。
      window.parent.postMessage({
        type: EMBEDDED_SESSION_OPENED_EVENT,
        sessionId: session.id,
        cwd: session.cwd,
        path: session.path,
      }, "*");
    }
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    setPendingRestoreMessage(null);
    setPendingContextSourceSessionId(null);
    setNewSessionWorktreeBinding(null);
    setNewSessionCwd(null);
    setNewSessionSubprojectId(null);
    setNewSessionSubprojectLabel(null);
    setSelectedSession(session);
    hydrateSelectedSession(session.id);
    const params = workspaceParams();
    params.set("session", session.id);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [completeTalkMapGhostConversion, invalidateWorkspaceRestore, router, hydrateSelectedSession, workspaceParams, embeddedReaderMode]);

  const deliverSessionNotification = useCallback(({
    targetSession,
    targetDevice,
    title,
    body,
    tag,
    identity,
  }: {
    targetSession: SessionInfo | null;
    targetDevice?: SessionActivityDevice;
    title: string;
    body: string;
    tag?: string;
    identity?: SessionCompletionIdentity;
  }) => {
    if (!("Notification" in window)) return;

    const fire = () => {
      const params = new URLSearchParams();
      if (targetSession) params.set("session", targetSession.id);
      if (targetDevice && targetDevice.id !== localDeviceId) params.set("device", targetDevice.id);
      const sessionUrl = `/?${params.toString()}`;
      void showBrowserNotification({
        title,
        body,
        sessionUrl,
        tag,
        identity,
        onClick: () => {
          window.focus();
          if (targetSession && targetDevice && targetDevice.id !== localDeviceId) {
            openRemoteSession(targetDevice, targetSession.id, null, targetSession);
          } else if (targetSession) handleSelectSession(targetSession);
        },
      });
    };

    if (Notification.permission === "granted") {
      fire();
    } else if (Notification.permission === "default") {
      void Notification.requestPermission().then((p) => { if (p === "granted") fire(); });
    }
  }, [handleSelectSession, localDeviceId, openRemoteSession]);

  const handleAgentEnd = useCallback((completedRemoteSessionId?: string, completedRemotePeer?: string) => {
    setRemoteSession((current) => current && completedRemoteSessionId !== undefined && current.device.id === completedRemotePeer && current.sessionInfo?.id === completedRemoteSessionId && current.sessionRunning ? { ...current, sessionRunning: false } : current);
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    refreshTopBarSessionMetadata();
  }, [refreshTopBarSessionMetadata]);

  const handleRemoteAgentError = useCallback((sourceSessionId: string | null, sourcePeer: string) => {
    // Error callbacks can arrive after the remote slot has changed. Only the
    // ChatWindow that raised this terminal error may clear its matching slot.
    setRemoteSession((current) => {
      if (
        !current?.sessionInfo
        || current.device.id !== sourcePeer
        || current.sessionInfo.id !== sourceSessionId
        || !current.sessionRunning
      ) return current;
      return { ...current, sessionRunning: false };
    });
    setRefreshKey((k) => k + 1);
    setExplorerRefreshKey((k) => k + 1);
    refreshTopBarSessionMetadata();
  }, [refreshTopBarSessionMetadata]);

  const handleAttentionNeeded = useCallback((request: BlockingExtensionUiRequest, sourceSession?: SessionInfo | null) => {
    if (isSubagentSession(sourceSession)) return;
    if (!shouldShowBrowserNotification()) return;
    if (!claimExtensionAttentionNotification(request, notifiedAttentionRequestIdsRef.current)) return;

    deliverSessionNotification({
      targetSession: selectedSession,
      title: translate("i18n.attentionNeeded"),
      body: request.method === "custom"
        ? translate("i18n.extensionInputNeeded")
        : request.title,
      tag: `pi-extension-ui:${request.id}`,
    });
  }, [deliverSessionNotification, selectedSession, translate]);

  const handleSessionRunComplete = useCallback((item: SessionActivityItem) => {
    setRefreshKey((key) => key + 1);
    setExplorerRefreshKey((key) => key + 1);
    setRemoteSession((current) => current?.device.id === item.device.id
      && current.sessionInfo?.id === item.session.id && current.sessionRunning
      ? { ...current, sessionRunning: false } : current);
    refreshTopBarSessionMetadata();
    if (isSubagentSession(item.session)) return;
    const kind = item.latestRun?.status === "completed" ? "done" : "error";
    const soundKey = statusSoundRequestId(item.session.id, kind, item.latestRun?.runId);
    if (!soundKey) return;
    if (kind === "done" || !item.unattended) {
      tryPlaySoundRequest(soundKey, kind === "done" ? playDoneSound : playErrorSound, () => canPlaySound(kind));
    }
    if (kind !== "done" || !shouldShowBrowserNotification()) return;
    // Notification and audio share the existing claim store, but cannot consume each other's claim.
    const notificationKey = `notification:${soundKey}`;
    const identity = item.latestRun?.runId
      ? { deviceId: item.device.id, sessionId: item.session.id, runId: item.latestRun.runId }
      : undefined;
    void claimSoundRequest(notificationKey).then((claimed) => {
      if (!claimed) return;
      deliverSessionNotification({
        targetSession: item.session,
        targetDevice: item.device,
        title: item.session.name ?? translate("i18n.sessionComplete"),
        body: translate("i18n.taskFinished"),
        tag: sessionCompletionTag(identity),
        identity,
      });
    });
  }, [canPlaySound, deliverSessionNotification, playDoneSound, playErrorSound, refreshTopBarSessionMetadata, translate]);
  useSessionRunCompletions(embeddedReaderMode ? "local" : "all", handleSessionRunComplete);

  const topBarSession = remoteSession ? remoteSession.sessionInfo : selectedSession;
  const topBarPeer = remoteSession?.device.id;

  const handleAutoName = useCallback(async () => {
    const sessionId = topBarSession?.id;
    const sessionPeer = topBarPeer ?? null;
    const sessionGeneration = activeTopBarIdentityRef.current.generation;
    const active = activeTopBarIdentityRef.current;
    if (!sessionId || active.sessionId !== sessionId || active.peer !== sessionPeer || autoNameStatus.kind === "naming") return;
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setActiveTopPanel(null);
    setAutoNameStatus({ kind: "naming" });

    try {
      const route = `/sessions/${encodeURIComponent(sessionId)}/auto-name`;
      const response = await fetch(topBarPeer
        ? `/api/remote${route}?peer=${encodeURIComponent(topBarPeer)}`
        : `/api${route}`, {
        method: "POST",
      });
      const body = (await response.json().catch(() => ({}))) as { title?: string; error?: string };
      if (!response.ok || !body.title) {
        throw new Error(body.error || `HTTP ${response.status}`);
      }

      const title = body.title.trim();
      const latestIdentity = activeTopBarIdentityRef.current;
      if (latestIdentity.sessionId !== sessionId || latestIdentity.peer !== sessionPeer || latestIdentity.generation !== sessionGeneration) return;
      setRefreshKey((key) => key + 1);
      if (topBarPeer) {
        setRemoteSession((current) => current?.device.id === sessionPeer && current.sessionInfo?.id === sessionId
          ? { ...current, sessionInfo: { ...current.sessionInfo, name: title } }
          : current);
      } else {
        if (activeSessionIdRef.current !== sessionId) return;
        setSelectedSession((current) => current?.id === sessionId ? { ...current, name: title } : current);
      }
      setSessionStatsSnapshot((current) => current?.sessionId === sessionId
        && current.peer === sessionPeer
        && current.generation === sessionGeneration
        ? { ...current, stats: { ...current.stats, sessionName: title } }
        : current);
      setAutoNameStatus({ kind: "success" });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 1800);
    } catch (error) {
      const latestIdentity = activeTopBarIdentityRef.current;
      const stillActive = latestIdentity.sessionId === sessionId
        && latestIdentity.peer === sessionPeer
        && latestIdentity.generation === sessionGeneration;
      if (!stillActive) return;
      const message = error instanceof Error ? error.message : String(error);
      setAutoNameStatus({ kind: "error", message });
      autoNameTimerRef.current = setTimeout(() => setAutoNameStatus({ kind: "idle" }), 5000);
    }
  }, [autoNameStatus.kind, remoteSession, topBarPeer, topBarSession?.id]);

  useEffect(() => {
    if (autoNameTimerRef.current) clearTimeout(autoNameTimerRef.current);
    setAutoNameStatus({ kind: "idle" });
  }, [remoteSession?.sessionInfo?.id, selectedSession?.id]);

  const handleExplorerRefresh = useCallback(() => {
    setExplorerRefreshKey((k) => k + 1);
  }, []);

  const handleSessionForked = useCallback((result: SessionForkResult) => {
    if (remoteSession) {
      const current = committedRemoteSessionRef.current;
      if (!current || current.device.id !== remoteSession.device.id
        || current.sessionInfo?.id !== remoteSession.sessionInfo?.id
        || current.draftInstanceKey !== remoteSession.draftInstanceKey) return;
    } else if (committedRemoteSessionRef.current || committedSelectedSessionRef.current?.id !== selectedSession?.id) return;
    invalidateWorkspaceRestore();
    const forkRestoreToken = urlRestoreTokenRef.current;
    activeNewSessionDraftKeyRef.current = null;
    const sourceSession = remoteSession?.sessionInfo ?? selectedSession;
    const inheritedSubprojectId = sourceSession?.subprojectId ?? null;
    if ("restoreMessage" in result) {
      const cwd = selectedSession?.cwd ?? remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd ?? activeCwd;
      if (!cwd) return;
      if (remoteSession) {
        // 远程会话 fork 首条消息（编辑式新聊天）：转远程新建草稿并保留恢复消息。
        remoteNewSessionDraftKeyRef.current = `remote-new:${remoteSession.device.id}:${cwd}:${inheritedSubprojectId ?? ""}`;
        const draftInstanceKey = `remote-draft:${++remoteDraftInstanceRef.current}`;
        setRemoteSession((prev) => (prev?.device.id === remoteSession.device.id && prev.sessionInfo?.id === remoteSession.sessionInfo?.id && prev.draftInstanceKey === remoteSession.draftInstanceKey
          ? { ...prev, sessionInfo: null, sessionRunning: false, newSessionCwd: cwd, newSessionSubprojectId: inheritedSubprojectId, newSessionSubprojectLabel: null, newSessionContextSourceId: null, draftInstanceKey, promotedSessionId: undefined } : prev));
        setPendingRestoreMessage(result.restoreMessage);
        return;
      }
      if (!handleNewSession("fork-draft", cwd, inheritedSubprojectId ?? undefined)) return;
      setPendingRestoreMessage(result.restoreMessage);
      return;
    }

    const { newSessionId, newSessionPath } = result;
    setPendingRestoreMessage(null);
    setRefreshKey((k) => k + 1);
    setSessionKey((k) => k + 1);
    setNewSessionCwd(null);
    setNewSessionSubprojectId(null);
    setNewSessionSubprojectLabel(null);

    // 嵌入页（iframe 内 fork）：上报外层同步 URL + 侧栏高亮（跨源 iframe
    // 无法被外层读状态）。外层把 embeddedSessionKey/embeddedIframeSessionId
    // 切到新 fork 会话，URL 写 session=forkId——刷新可恢复，侧栏不残留旧会话。
    if (embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({
        type: EMBEDDED_SESSION_OPENED_EVENT,
        sessionId: newSessionId,
        cwd: selectedSession?.cwd ?? remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd ?? activeCwd ?? null,
        path: null,
      }, "*");
    }

    if (remoteSession) {
      // 聚合全部设备视图的远程会话 fork：fork 创建在远程设备，本机 selectedSession
      // 不接管（那是本机会话槽）。先脱离原会话（侧栏不残留原会话高亮），再经
      // peer 代理拉取远程设备的完整会话列表（scope=all 活动列表不含刚 fork 的
      // 会话——新会话没有 activity run，会找不到）定位 fork 真实信息回填远程视图
      // ——主区 ChatWindow 切到 fork（key 变化重挂载）、侧栏高亮跟随、URL 写 forkId。
      const deviceId = remoteSession.device.id;
      const fallbackCwd = remoteSession.sessionInfo?.cwd ?? remoteSession.newSessionCwd ?? null;
      if (fallbackCwd) {
        // 用已知信息（forkId + 原 cwd）立即回填 fork 视图，避免 fetch 往返期间
        // 空草稿中间态闪烁；后台经 peer 代理拉取真实 sessionInfo 校准（ChatWindow
        // 挂载后自行经 /api/remote 拉会话数据，临时对象仅作标识）。
        setRemoteSession((prev) => (prev?.device.id === deviceId && prev.sessionInfo?.id === remoteSession.sessionInfo?.id && prev.draftInstanceKey === remoteSession.draftInstanceKey ? {
          ...prev,
          sessionInfo: {
            id: newSessionId,
            cwd: fallbackCwd,
            path: "", created: "", modified: "", messageCount: 0, firstMessage: "",
            subprojectId: inheritedSubprojectId ?? undefined,
            transient: false,
          } as SessionInfo,
          sessionRunning: false,
        } : prev));
      } else {
        setRemoteSession((prev) => (prev?.device.id === deviceId && prev.sessionInfo?.id === remoteSession.sessionInfo?.id && prev.draftInstanceKey === remoteSession.draftInstanceKey
          ? { ...prev, sessionInfo: null, sessionRunning: false } : prev));
      }
      void fetch(`/api/remote/sessions?peer=${encodeURIComponent(deviceId)}`, { cache: "no-store" })
        .then((res) => (res.ok ? (res.json() as Promise<{ sessions?: SessionInfo[] }>) : null))
        .then((body) => {
          if (forkRestoreToken !== urlRestoreTokenRef.current) return;
          const fork = body?.sessions?.find((s) => s.id === newSessionId);
          if (fork) {
            setRemoteSession((prev) => (prev?.device.id === deviceId && (fallbackCwd ? prev.sessionInfo?.id === newSessionId : prev.sessionInfo === null)
              ? { ...prev, sessionInfo: fork, sessionRunning: false } : prev));
          } else if (!fallbackCwd) {
            // 未能临时回填且 fork 未出现在远程会话列表（极端时序）：退出远程会话视图
            // 回聚合列表，列表刷新后 fork 可见、侧栏不再残留原会话。
            setRemoteSession((prev) => prev?.device.id === deviceId && prev.sessionInfo === null ? null : prev);
          }
        })
        .catch(() => { /* 保留临时 fork 视图（fork 已创建，仅校准失败） */ });
      return;
    }

    setSelectedSession((prev) => ({
      ...(prev ?? { path: "", cwd: "", created: "", modified: "", messageCount: 0, firstMessage: "" }),
      ...(newSessionPath ? { path: newSessionPath } : {}),
      ...(sourceSession?.id ? { parentSessionId: sourceSession.id } : {}),
      id: newSessionId,
      subprojectId: inheritedSubprojectId ?? undefined,
      transient: false,
    }));
    // The fork response now carries the new file path, so the selected row is
    // complete enough for immediate sidebar rendering. Keep the old lookup as
    // a compatibility fallback for older fork producers without that field.
    if (!newSessionPath) hydrateSelectedSession(newSessionId);
    const params = workspaceParams();
    params.set("session", newSessionId);
    router.replace(`?${params.toString()}`, { scroll: false });
  }, [activeCwd, embeddedReaderMode, handleNewSession, hydrateSelectedSession, invalidateWorkspaceRestore, remoteSession, router, selectedSession, workspaceParams]);

  const handleNewActivitySession = useCallback((cwd: string, device?: SessionActivityDevice, subprojectId?: string, subprojectLabel?: string, options?: NewSessionOptions) => {
    invalidateWorkspaceRestore();
    closeTalkMap();
    closeWorktreeGraph();
    pendingTalkMapGhostConversionRef.current = null;
    pendingEmbeddedNewSessionRef.current = null;
    setPendingRestoreMessage(null);
    setPendingContextSourceSessionId(null);
    if (!device || device.id === localDeviceId || embeddedReaderMode) {
      handleNewSession(`activity-${Date.now()}`, cwd, subprojectId, subprojectLabel, options);
      return;
    }
    if (aggregateWorkspaceActive || isMobileViewport() || !embeddedReaderUrl) {
      // 聚合壳（Monitor off/on）里的远程新建都原地走 remote ChatWindow，避免
      // 先挂目标设备 iframe 再创建草稿导致整块工作区闪切。
      const contextSourceDraftPart = options?.contextSourceSessionId ? `:context:${options.contextSourceSessionId}` : "";
      const draftKey = `remote-new:${device.id}:${cwd}:${subprojectId || ""}${contextSourceDraftPart}`;
      remoteNewSessionDraftKeyRef.current = draftKey;
      pendingTalkMapGhostConversionRef.current = options?.talkMapGhost
        ? { ...options.talkMapGhost, draftKey, peer: device.id }
        : null;
      setPendingRestoreMessage(options?.initialMessage ? { role: "user", content: options.initialMessage } : null);
      setActiveTopPanel(null);
      if (isMobileViewport()) setSidebarOpen(false);
      clearEmbeddedReaderOwner();
      // Remote drafts must not inherit local session state; clear the local
      // slots first, then open the remote draft with its own identity.
      activeNewSessionDraftKeyRef.current = null;
      updateManualFileContext(null);
      setNewSessionCwd(null);
      setNewSessionSubprojectId(null);
      setNewSessionSubprojectLabel(null);
      setSelectedSession(null);
      const draftInstanceKey = `remote-draft:${++remoteDraftInstanceRef.current}`;
      setRemoteSession({ device, sessionInfo: null, searchTerm: null, newSessionCwd: cwd, sessionRunning: false, newSessionSubprojectId: subprojectId || null, newSessionSubprojectLabel: subprojectLabel?.trim() || null, newSessionContextSourceId: options?.contextSourceSessionId ?? null, newSessionWorktreeBinding: options?.worktreeBinding ?? null, draftInstanceKey });
      return;
    }
    if (device && embeddedReaderUrl && embeddedIframeReadyRef.current) {
      const embeddedDevice = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId;
      const iframe = embeddedIframeRef.current?.contentWindow;
      if (embeddedDevice === device.id && iframe) {
        // 当前 iframe 已明确支持该协议：把请求交给目标 Reader 内部处理，不能
        // 回退到 URL 重建，否则会卸载整个 Reader，造成运行态闪切。
        iframe.postMessage({ type: EMBEDDED_NEW_SESSION_REQUEST_EVENT, cwd, ...(subprojectId ? { subprojectId } : {}), ...(subprojectLabel?.trim() ? { subprojectLabel: subprojectLabel.trim() } : {}), ...(options?.initialMessage ? { initialMessage: options.initialMessage } : {}), ...(options?.contextSourceSessionId ? { contextSourceSessionId: options.contextSourceSessionId } : {}), ...(options?.worktreeBinding ? { worktreeBinding: options.worktreeBinding } : {}), ...(options?.talkMapGhost ? { talkMapGhost: options.talkMapGhost } : {}) }, "*");
        setEmbeddedResourceSession({ deviceId: device.id, sessionId: null, cwd, path: null });
        setActiveTopPanel(null);
        setActivitySidebarMode(true);
        setReaderMode(false);
        setRightPanelOpen(false);
        setSidebarOpen(!isMobileViewport());
        return;
      }
    }
    const remoteUrl = buildEmbeddedReaderUrl(device, { localDeviceId, sessionOnly: true });
    if (remoteUrl && device) {
      const target = new URL(remoteUrl);
      const pendingRequest: EmbeddedNewSessionRequest = {
        cwd,
        ...(subprojectId ? { subprojectId } : {}),
        ...(subprojectLabel?.trim() ? { subprojectLabel: subprojectLabel.trim() } : {}),
        ...(options ?? {}),
      };
      pendingEmbeddedNewSessionRef.current = options?.initialMessage || options?.contextSourceSessionId || options?.worktreeBinding || options?.talkMapGhost
        ? { deviceId: device.id, request: pendingRequest }
        : null;
      target.searchParams.set("cwd", cwd);
      if (subprojectId) target.searchParams.set("subproject", subprojectId);
      else target.searchParams.delete("subproject");
      if (subprojectLabel?.trim()) target.searchParams.set("subprojectLabel", subprojectLabel.trim());
      else target.searchParams.delete("subprojectLabel");
      setEmbeddedDeviceId(null);
      setEmbeddedResourceSession({ deviceId: device.id, sessionId: null, cwd, path: null });
      setEmbeddedSessionKey(`${device.id}:new:${cwd}${subprojectId ? `:subproject:${subprojectId}` : ""}`);
      setEmbeddedReaderUrl(target.toString());
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen(!isMobileViewport());
      return;
    }
    handleNewSession(`activity-${Date.now()}`, cwd, subprojectId, subprojectLabel, options);
  }, [aggregateWorkspaceActive, clearEmbeddedReaderOwner, closeTalkMap, closeWorktreeGraph, embeddedDeviceId, embeddedReaderMode, embeddedReaderUrl, embeddedSessionKey, handleNewSession, invalidateWorkspaceRestore, localDeviceId, updateManualFileContext]);

  // 嵌入页收到外层活动面板的新建请求后，复用本地新建流程；这保留目标设备
  // 自己的 cwd 白名单、Agent/会话状态和完成音归属，同时不重载当前 iframe。
  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    const handleNewSessionRequest = (event: MessageEvent) => {
      if (event.source !== window.parent) return;
      const data = event.data as { type?: unknown; cwd?: unknown; subprojectId?: unknown; subprojectLabel?: unknown; initialMessage?: unknown; contextSourceSessionId?: unknown; worktreeBinding?: unknown; talkMapGhost?: unknown } | null;
      if (data?.type !== EMBEDDED_NEW_SESSION_REQUEST_EVENT || typeof data.cwd !== "string" || !data.cwd) return;
      const subprojectId = typeof data.subprojectId === "string" && data.subprojectId ? data.subprojectId : undefined;
      const subprojectLabel = typeof data.subprojectLabel === "string" && data.subprojectLabel.trim() ? data.subprojectLabel.trim() : undefined;
      const ghostData = data.talkMapGhost && typeof data.talkMapGhost === "object"
        ? data.talkMapGhost as { ghostId?: unknown; projectRoot?: unknown }
        : null;
      const talkMapGhost = ghostData && typeof ghostData.ghostId === "string" && ghostData.ghostId && typeof ghostData.projectRoot === "string" && ghostData.projectRoot
        ? { ghostId: ghostData.ghostId, projectRoot: ghostData.projectRoot }
        : undefined;
      const initialMessage = typeof data.initialMessage === "string" && data.initialMessage.trim() ? data.initialMessage : undefined;
      const contextSourceSessionId = typeof data.contextSourceSessionId === "string" && data.contextSourceSessionId.trim() ? data.contextSourceSessionId.trim() : undefined;
      const bindingData = data.worktreeBinding && typeof data.worktreeBinding === "object" ? data.worktreeBinding as { projectRoot?: unknown; worktreePath?: unknown; relation?: unknown } : null;
      const worktreeBinding = bindingData && typeof bindingData.projectRoot === "string" && typeof bindingData.worktreePath === "string"
        ? { projectRoot: bindingData.projectRoot, worktreePath: bindingData.worktreePath, relation: (bindingData.relation === "creator" ? "creator" : "task-root") as WorktreeBindingDraft["relation"] }
        : undefined;
      handleNewSession(`activity-${Date.now()}`, data.cwd, subprojectId, subprojectLabel, initialMessage || contextSourceSessionId || worktreeBinding || talkMapGhost
        ? { ...(initialMessage ? { initialMessage } : {}), ...(contextSourceSessionId ? { contextSourceSessionId } : {}), ...(worktreeBinding ? { worktreeBinding } : {}), ...(talkMapGhost ? { talkMapGhost } : {}) }
        : undefined);
    };
    window.addEventListener("message", handleNewSessionRequest);
    return () => window.removeEventListener("message", handleNewSessionRequest);
  }, [embeddedReaderMode, handleNewSession]);

  // 请求监听器挂载后再发就绪消息，避免外层点击发生在 iframe 首次加载窗口内。
  useEffect(() => {
    if (!embeddedReaderMode || typeof window === "undefined" || window.parent === window) return;
    window.parent.postMessage({ type: EMBEDDED_READER_READY_EVENT }, "*");
  }, [embeddedReaderMode]);

  const handleInitialRestoreDone = useCallback(() => {
    setInitialSessionRestored(true);
  }, []);

  // URL → 视图状态（统一恢复入口）：monitor/device/session（fullview=1 视为
  // monitor=on）一次重建形态。挂载恢复 effect 与 monitor 切换（保留会话）共用——
  // monitor on/off 只增删 monitor 参数，device/session 不动，会话自然保留。
  const restoreFromParams = useCallback(async (params: URLSearchParams, deviceUrl?: string, restoreToken = ++urlRestoreTokenRef.current) => {
    invalidateEmbeddedSessionRequest();
    const isCurrentRestore = () => restoreToken === urlRestoreTokenRef.current;
    const deviceParam = params.get("device");
    const sessionParam = params.get("session");
    const hiddenScope = params.get("scope") === "hidden";
    const favoritesScope = params.get("scope") === "favorites";
    const toDiscussScope = params.get("scope") === "to_discuss";
    const toReviseScope = params.get("scope") === "to_revise";
    const completedScope = params.get("scope") === "completed";
    const collectionScope = params.get("scope") === "hidden" || params.get("scope") === "favorites" || toDiscussScope || toReviseScope || completedScope;
    const currentScopeName = hiddenScope
      ? "hidden"
      : favoritesScope
        ? "favorites"
        : toDiscussScope
          ? "to_discuss"
          : toReviseScope
            ? "to_revise"
            : completedScope
              ? "completed"
              : null;
    const collectionArchiveQuery = params.get("view") === "archived" || readSharedFilters().archiveView === "archived"
      ? "&archived=1"
      : "";
    if (collectionScope && !sessionParam) {
      // 收纳页/收藏页（纯页，无会话组合）：聚合总览形态 + 对应列表侧栏。
      // 同时清 selectedSession：URL 无 session 时视图必须无会话，否则 URL 同步
      // effect 会把残留会话写回 URL（?scope=hidden&session=Y）→ 刷新重开隐藏页会话。
      setHiddenView(hiddenScope);
      setFavoritesView(favoritesScope);
      setToDiscussView(toDiscussScope);
      setToReviseView(toReviseScope);
      setCompletedView(completedScope);
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      // 收纳/收藏页与聚合页同构：默认 monitor off 聚合总览形态；
      // 点会话/点 monitor 才进聚合完整视图（aggregateWorkspaceActive=true）。
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setSelectedSession(null);
      setEmbeddedScopeAll(false);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen(!isMobileViewport());
      setInitialSessionRestored(true);
      return;
    }
    if (collectionScope) {
      // 收纳/收藏页 + 会话（?scope=...&monitor=on[&device=X]&session=Y）：恢复对应页，
      // 会话从 scope=hidden 数据源反查——隐藏会话不在 /api/sessions 列表里，
      // 只能走隐藏数据源（本机经 handleSelectSession，远程经 remoteSession）。
      setHiddenView(hiddenScope);
      setFavoritesView(favoritesScope);
      setToDiscussView(toDiscussScope);
      setToReviseView(toReviseScope);
      setCompletedView(completedScope);
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setEmbeddedScopeAll(false);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen(!isMobileViewport());
      try {
        const _runsScopeUrl = `/api/session-runs?scope=${hiddenScope ? "hidden" : "favorites"}${collectionArchiveQuery}`;
        void _runsScopeUrl;
        const body = await fetchSessionActivity<{ sessions?: SessionActivityItem[] }>(
          `/api/session-runs?scope=${currentScopeName ?? "all"}${collectionArchiveQuery}`,
        );
        const item = (body?.sessions ?? []).find((candidate) => deviceParam
          ? candidate.device.id === deviceParam && candidate.session.id === sessionParam
          : candidate.session.id === sessionParam);
        if (!isCurrentRestore()) return;
        if (item) {
          setAggregateWorkspaceActive(true);
          if (item.device.id !== localDeviceId) {
            // 远程隐藏会话：主区切远程会话视图，本机残留会话槽一并清（单槽语义）。
            setSelectedSession(null);
            setRemoteSession({ device: item.device, sessionInfo: item.session, searchTerm: null, newSessionCwd: null, sessionRunning: item.status === "running" || item.status === "retrying" });
          } else handleSelectSession(item.session, true, params.get("hl") ?? undefined);
        }
      } catch { /* 保持隐藏页列表态 */ }
      if (isCurrentRestore()) setInitialSessionRestored(true);
      return;
    }
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(false);
    if (!deviceParam && !sessionParam) {
      // 无聚合参数：聚合总览（monitor off 且无会话的退出场景）。
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setEmbeddedScopeAll(false);
      return;
    }
    const scopeAll = params.get("scope") === "all";
    setEmbeddedScopeAll(scopeAll);
    const workspaceShape = embeddedWorkspaceUrlShape(params);
    if (!deviceParam || (deviceParam === localDeviceId && sessionParam && workspaceShape === "session-only")) {
      // 普通本机会话由本地槽恢复，显式完整设备视图保留独立工作区。
      // 无 device：monitor=on 为全部设备完整视图；monitor off + session 为聚合侧边会话。
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen((scopeAll && Boolean(sessionParam)) || !isMobileViewport());
      if (sessionParam) {
        // 本机会话：monitor on 时为聚合完整视图，monitor off + scope=all 时为聚合侧边会话。
        try {
          const target = await loadLocalSession(sessionParam);
          if (!isCurrentRestore()) return;
          if (target) handleSelectSession(target, true, params.get("hl") ?? undefined);
          else handleInitialRestoreDone();
        } catch {
          if (isCurrentRestore()) handleInitialRestoreDone();
        }
      } else {
        if (isCurrentRestore()) setInitialSessionRestored(true);
      }
      return;
    }
    const sessionId = sessionParam;
    const fullDeviceSession = workspaceShape === "full-device";
    if (((isMobileViewport() && !fullDeviceSession) || (scopeAll && !deviceParam)) && sessionId) {
      // 全部设备筛选语境 + 完整设备视图：聚合完整视图原地显示远程会话（remoteSession，
      // 经 /api/remote 代理），不切单设备 iframe——monitor on/off 保持全部设备语境。
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      setAggregateWorkspaceActive(true);
      setRemoteSession(null);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen(true);
      try {
        const body = await fetchSessionActivity<{ device?: SessionActivityDevice; devices?: SessionActivityDevice[]; sessions?: SessionActivityItem[] }>(
          "/api/session-runs?scope=all",
        );
        let localDeviceIdFromResponse = body?.device?.id;
        let item = body?.sessions?.find((s) => s.device.id === deviceParam && s.session.id === sessionId);
        if (!item) {
          // Monitor links can outlive the active list after a session is archived.
          const archivedBody = await fetchSessionActivity<{ device?: SessionActivityDevice; sessions?: SessionActivityItem[] }>(
            "/api/session-runs?scope=all&archived=1",
          );
          localDeviceIdFromResponse ??= archivedBody?.device?.id;
          item = archivedBody?.sessions?.find((s) => s.device.id === deviceParam && s.session.id === sessionId);
        }
        if (!isCurrentRestore()) return;
        if (item) {
          if (item.device.id === localDeviceIdFromResponse) {
            // 本机会话不能经 /api/remote 自代理；本机归档会话仍由本地 API 解析。
            setRemoteSession(null);
            handleSelectSession(item.session, true);
          } else {
            // 远程会话：主区切远程视图，本机残留会话槽一并清（单槽语义，避免归档/删除远程后主区回旧本机会话）。
            markActivitySessionViewed(item.session.id);
            setSelectedSession(null);
            setRemoteSession({ device: item.device, sessionInfo: item.session, searchTerm: null, newSessionCwd: null, sessionRunning: item.status === "running" || item.status === "retrying" });
          }
        }
      } catch { /* 保持列表态 */ }
      if (isCurrentRestore()) setInitialSessionRestored(true);
      return;
    }
    const url = buildEmbeddedReaderUrl(
      { id: deviceParam, url: deviceUrl } as SessionActivityDevice,
      { localDeviceId, sessionId: sessionId ?? undefined, sessionOnly: Boolean(sessionId) && !fullDeviceSession, activitySidebar: fullDeviceSession || !sessionId },
    );
    if (!url) return;
    if (sessionId && !fullDeviceSession) {
      // 聚合侧边会话（sessionOnly 嵌入）。会话经 URL 恢复即视为打开阅读，
      // 在查看设备标记已读（修复 monitor-off 重进/刷新后「刚处理完」不消失）。
      markActivitySessionViewed(sessionId);
      // 聚合侧边会话（sessionOnly 嵌入）。清残留聚合完整视图状态：
      // session-only 恢复若不清，fullDeviceActive 恒 true，设备视图按钮永远停在
      // 「关闭完整设备视图」态（多点几次就“无法退出”，实测根因）。
      setEmbeddedSessionKey(`${deviceParam}:${sessionId}`);
      setEmbeddedDeviceId(null);
      setEmbeddedIframeSessionId(null);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setEmbeddedDeviceWorkspaceActive(false);
      setSidebarOpen(true);
    } else if (fullDeviceSession) {
      // 单设备完整视图+会话：iframe = activitySidebar 嵌入 + session（嵌入页自行恢复会话）。
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(deviceParam);
      setEmbeddedIframeSessionId(sessionId);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setActiveTopPanel(null);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setEmbeddedDeviceWorkspaceActive(true);
      setSidebarOpen(true);
    } else {
      // 单设备完整视图（device-only）。
      setEmbeddedSessionKey(null);
      setEmbeddedDeviceId(deviceParam);
      setEmbeddedIframeSessionId(null);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setEmbeddedDeviceWorkspaceActive(true);
      if (isMobileViewport()) setSidebarOpen(true);
    }
    setEmbeddedReaderUrl(url);
    setInitialSessionRestored(true);
  }, [handleSelectSession, handleInitialRestoreDone, invalidateEmbeddedSessionRequest, localDeviceId, markActivitySessionViewed]);

  // monitor 切换（保留会话）用：读设备 url（缓存优先，未命中异步反查）后恢复。
  const restoreWithDeviceUrl = useCallback((params: URLSearchParams) => {
    invalidateEmbeddedSessionRequest();
    const restoreToken = ++urlRestoreTokenRef.current;
    mountRestorePendingRef.current = true;
    const finishRestore = () => {
      if (urlRestoreTokenRef.current === restoreToken) mountRestorePendingRef.current = false;
    };
    const deviceId = params.get("device");
    if (!deviceId || deviceId === localDeviceId) {
      void restoreFromParams(params, undefined, restoreToken).catch(() => {}).finally(finishRestore);
      return;
    }
    const cachedUrl = readDeviceUrlCache(deviceId);
    if (cachedUrl) {
      void restoreFromParams(params, cachedUrl, restoreToken).catch(() => {}).finally(finishRestore);
      return;
    }
    void (async () => {
      try {
        const body = await fetchSessionActivity(
          "/api/session-runs?scope=all",
        );
        if (urlRestoreTokenRef.current !== restoreToken) return;
        const device = body?.devices?.find((d) => d.id === deviceId);
        if (device?.url) {
          writeDeviceUrlCache(device.id, device.url);
          await restoreFromParams(params, device.url, restoreToken);
        }
      } catch { /* 保持现状 */ }
      finally { finishRestore(); }
    })();
  }, [invalidateEmbeddedSessionRequest, localDeviceId, readDeviceUrlCache, writeDeviceUrlCache, restoreFromParams]);

  // 聚合外层刷新/链接恢复（单一入口）：URL 是唯一状态真源。读
  // device/session/activity-sidebar 一次重建形态（monitor/fullview 仅作旧链接兼容）：
  //   无 device + aggregate session → 全部设备聚合视图；
  //   device=X（无 session）         → 单设备完整视图（activitySidebar 嵌入）
  //   device=X&session=Y（无标记）   → 聚合侧边会话（sessionOnly 嵌入）
  //   device=X&session=Y&piWebActivitySidebar=1 → 单设备完整视图 + 会话
  // 设备不可达/参数过期 → 清参数回落聚合总览。单机形态（无 device/monitor）不参与。
  useEffect(() => {
    const current = new URLSearchParams(window.location.search);
    if (!hasLegacyWorkspaceLayout(current)) return;
    const canonical = stripLegacyWorkspaceLayout(current);
    const nextUrl = canonical.toString() ? "?" + canonical.toString() : window.location.pathname;
    router.replace(nextUrl, { scroll: false });
  }, [router, searchParams]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // 归档视图 URL 锁定：?view=archived → 恢复归档 tab（与 localStorage 存储互备；
    // 与 scope=hidden 互斥——隐藏页无归档切换）。
    if (params.get("view") === "archived" && params.get("scope") !== "hidden") {
      updateSharedFilters({ archiveView: "archived" });
    }
    let cancelled = false;
    const restoreToken = ++urlRestoreTokenRef.current;
    mountRestorePendingRef.current = true;
    const finishRestore = () => {
      if (urlRestoreTokenRef.current === restoreToken) mountRestorePendingRef.current = false;
    };
    const cancelRestore = () => {
      cancelled = true;
      if (urlRestoreTokenRef.current === restoreToken) {
        urlRestoreTokenRef.current += 1;
        mountRestorePendingRef.current = false;
      }
    };
    // 隐藏页（纯页或带会话组合）：由 restoreFromParams 统一恢复，不依赖设备 url。
    if (params.get("scope") === "hidden" || params.get("scope") === "favorites") {
      const snapshot = new URLSearchParams(window.location.search);
      void restoreFromParams(snapshot, undefined, restoreToken).catch(() => {}).finally(() => {
        if (!cancelled) finishRestore();
      });
      return cancelRestore;
    }
    const deviceParam = params.get("device");
    if (!deviceParam && !params.get("session")) {
      finishRestore();
      return;
    }
    const paramsSnapshot = new URLSearchParams(window.location.search);
    if (!deviceParam || deviceParam === localDeviceId) {
      // 本机身份已由请求提供，恢复不依赖可选的设备 URL 或缓存。
      void restoreFromParams(paramsSnapshot, undefined, restoreToken).catch(() => {}).finally(() => {
        if (!cancelled) finishRestore();
      });
      return cancelRestore;
    }
    const cachedUrl = readDeviceUrlCache(deviceParam);
    let restorePromise: Promise<void> = Promise.resolve();
    if (cachedUrl) {
      // 缓存命中：立即恢复，不等 /api/session-runs 往返（刷新不再闪聚合总览）。
      restorePromise = restoreFromParams(paramsSnapshot, cachedUrl, restoreToken).catch(() => {});
    }
    void (async () => {
      try {
        // /api/peers 只有 POST（添加设备）；设备列表（含 url）从聚合数据源反查。
        const body = await fetchSessionActivity(
          "/api/session-runs?scope=all",
        );
        const device = body?.devices?.find((d) => d.id === deviceParam);
        if (cancelled || urlRestoreTokenRef.current !== restoreToken) return;
        if (device?.url) {
          writeDeviceUrlCache(device.id, device.url);
          // 无缓存或 url 变了才重建 iframe（缓存路径已挂载，避免重复挂载）。
          if (!cachedUrl || device.url !== cachedUrl) restorePromise = restoreFromParams(paramsSnapshot, device.url, restoreToken).catch(() => {});
        } else if (!cachedUrl) {
          throw new Error("restore device unavailable");
        }
        await restorePromise;
        if (!cancelled) finishRestore();
      } catch {
        if (!cancelled && urlRestoreTokenRef.current === restoreToken) {
          if (!cachedUrl) {
            const p = stripLegacyWorkspaceLayout(new URLSearchParams(window.location.search));
            p.delete("device");
            p.delete("session");
            p.delete("hl");
            if (!p.toString()) {
              window.history.replaceState(window.history.state, "", window.location.pathname);
              router.replace(window.location.pathname, { scroll: false });
            } else router.replace(`?${p.toString()}`, { scroll: false });
          }
          finishRestore();
        }
      }
    })();
    return cancelRestore;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoreDeviceId]);

  // Restore a ?session= URL target at the shell level so it also works when
  // the activity sidebar is the default mode (SessionSidebar may not mount).
  useEffect(() => {
    // 聚合外层恢复（?device= / ?scope=hidden|favorites）由挂载恢复 effect 处理，
    // 这里只处理单机 ?session=，避免收纳/收藏页会话被普通列表重复恢复。
    const shellParams = new URLSearchParams(window.location.search);
    if (shellParams.get("device") || shellParams.get("scope") === "hidden" || shellParams.get("scope") === "favorites") return;
    if (!initialSessionId || initialSessionRestored) return;
    let cancelled = false;
    void (async () => {
      try {
        const target = await loadLocalSession(initialSessionId);
        if (cancelled) return;
        if (target) {
          const hl = new URLSearchParams(window.location.search).get("hl") ?? undefined;
          handleSelectSession(target, true, hl);
        } else {
          handleInitialRestoreDone();
        }
      } catch {
        if (!cancelled) handleInitialRestoreDone();
      }
    })();
    return () => { cancelled = true; };
  }, [initialSessionId, initialSessionRestored, handleSelectSession, handleInitialRestoreDone]);

  const handleRestoreMessageApplied = useCallback(() => {
    setPendingRestoreMessage(null);
  }, []);

  const remoteMutationClientRef = useRef<ReturnType<typeof createRemoteSessionMutationClient> | null>(null);
  const remoteMutationTargetsRef = useRef<MutationTarget[]>([]);
  const [remoteMutationNotice, setRemoteMutationNotice] = useState<string | null>(null);
  const [remoteMutationLink, setRemoteMutationLink] = useState<string | null>(null);
  const [pendingRemoteMutations, setPendingRemoteMutations] = useState<PendingSessionMutation[]>([]);
  const [mutationRecoveryOpen, setMutationRecoveryOpen] = useState(false);
  const [mutationRecoveryBusy, setMutationRecoveryBusy] = useState(false);
  const [mutationRecoveryIncomplete, setMutationRecoveryIncomplete] = useState(false);
  const [mutationAuthenticationTargets, setMutationAuthenticationTargets] = useState<MutationTarget[]>([]);
  const getRemoteMutationClient = useCallback(() => {
    if (!remoteMutationClientRef.current) {
      let storage: Storage | undefined, legacyStorage: Storage | undefined;
      try { storage = window.localStorage; legacyStorage = window.sessionStorage; } catch { /* Server discovery remains available. */ }
      remoteMutationClientRef.current = createRemoteSessionMutationClient({ storage, legacyStorage });
    }
    return remoteMutationClientRef.current;
  }, []);
  const showRemoteMutationAuthentication = useCallback((target: MutationTarget, notSent = false) => {
    setRemoteMutationLink(target.url);
    setRemoteMutationNotice((notSent ? `${translate("mutationRecovery.notSent")} ` : "") + translate("mutationRecovery.authenticationRequired"));
    setMutationRecoveryIncomplete(true);
    setMutationRecoveryOpen(true);
  }, [translate]);
  const refreshRemoteMutationRecovery = useCallback(async () => {
    setRemoteMutationNotice(null);
    setMutationRecoveryBusy(true);
    try {
      const response = await fetch("/api/session-mutations?peers=1", { cache: "no-store", signal: AbortSignal.timeout(12_000) });
      if (response.ok) {
        const body = await response.json() as { peers?: MutationTarget[] };
        if (!Array.isArray(body.peers)) throw new Error("Invalid recovery peer list");
        remoteMutationTargetsRef.current = body.peers;
      }
      const recovered = await getRemoteMutationClient().recover(remoteMutationTargetsRef.current);
      setMutationRecoveryIncomplete(!response.ok || recovered.unavailableTargets.length > 0);
      setMutationAuthenticationTargets(recovered.authenticationRequiredTargets);
    } catch { setMutationRecoveryIncomplete(true); setRemoteMutationNotice(translate("mutationRecovery.refreshFailed")); }
    finally { setMutationRecoveryBusy(false); }
  }, [getRemoteMutationClient, translate]);
  useEffect(() => {
    const client = getRemoteMutationClient();
    const update = () => setPendingRemoteMutations(client.snapshot());
    update();
    const unsubscribe = client.subscribe(update);
    void refreshRemoteMutationRecovery();
    return unsubscribe;
  }, [getRemoteMutationClient, refreshRemoteMutationRecovery]);
  const queryRemoteMutation = useCallback(async (item: PendingSessionMutation) => {
    try {
      const receipt = await getRemoteMutationClient().query(item.command.operationId, item.target.id);
      if (receipt.authenticationRequired) { showRemoteMutationAuthentication(item.target); return; }
      if (receipt.refreshUnavailable) {
        setMutationRecoveryIncomplete(true);
        setRemoteMutationNotice(translate("mutationRecovery.refreshFailed"));
        return;
      }
      setRemoteMutationNotice(receipt.status === "completed" ? translate("mutationRecovery.originalComplete")
        : translate("mutationRecovery.originalStatus", { status: translate(`mutationRecovery.status.${receipt.status}`), detail: receipt.error ?? translate("mutationRecovery.inspectHint") }));
      if (receipt.status === "completed") { clearSessionActivityCache(); setRefreshKey(key => key + 1); }
    } catch { setRemoteMutationNotice(translate("mutationRecovery.queryFailed")); }
  }, [getRemoteMutationClient, showRemoteMutationAuthentication, translate]);
  const reviewRemoteMutation = useCallback(async (item: PendingSessionMutation) => {
    if (!window.confirm(translate("mutationRecovery.reviewConfirm"))) return;
    try {
      const reviewed = await getRemoteMutationClient().review(item.command.operationId, item.target.id);
      setRemoteMutationNotice(reviewed ? translate("mutationRecovery.reviewed") : translate("mutationRecovery.reviewBlocked"));
      if (reviewed && !getRemoteMutationClient().snapshot().length) setMutationRecoveryOpen(false);
    } catch (error) {
      if (isSessionMutationBridgeAuthenticationRequired(error)) showRemoteMutationAuthentication(item.target);
      else setRemoteMutationNotice(translate("mutationRecovery.reviewFailed"));
    }
  }, [getRemoteMutationClient, showRemoteMutationAuthentication, translate]);

  const continueRemoteMutation = useCallback(async (item: PendingSessionMutation) => {
    setRemoteMutationNotice(null);
    try {
      const receipt = await getRemoteMutationClient().continueOriginal(item.command.operationId, item.target.id);
      if (receipt.authenticationRequired) { showRemoteMutationAuthentication(item.target, receipt.notSent); return; }
      setRemoteMutationNotice(receipt.notSent ? translate(`mutationRecovery.${receipt.notSentReason ?? "notSent"}`)
        : receipt.status === "completed" ? translate("mutationRecovery.originalComplete")
        : translate("mutationRecovery.originalStatus", { status: translate(`mutationRecovery.status.${receipt.status}`), detail: receipt.error ?? translate("mutationRecovery.inspectHint") }));
      if (receipt.status === "completed") { clearSessionActivityCache(); setRefreshKey(key => key + 1); }
    } catch { setRemoteMutationNotice(translate("mutationRecovery.continueFailed")); }
  }, [getRemoteMutationClient, showRemoteMutationAuthentication, translate]);

  // Recovery owns the original operation even after its session row disappears.
  const mutateRemoteSession = useCallback(async (
    device: SessionActivityDevice,
    op: "rename" | "archive" | "unarchive" | "delete",
    sessionId: string,
    name?: string,
  ): Promise<boolean> => {
    if (!device.url) { setMutationRecoveryOpen(true); setRemoteMutationNotice(translate("mutationRecovery.addressUnavailable")); return false; }
    try {
      const target = new URL(device.url);
      setRemoteMutationLink(["http:", "https:"].includes(target.protocol) ? target.origin : null);
    } catch { setRemoteMutationLink(null); }
    setRemoteMutationNotice(translate("mutationRecovery.checking"));
    try {
      const receipt = await getRemoteMutationClient()({ id: device.id, name: device.name, url: device.url }, op, sessionId, name);
      if (receipt.authenticationRequired) {
        showRemoteMutationAuthentication({ id: device.id, url: new URL(device.url).origin }, receipt.notSent);
        return false;
      }
      if (receipt.previousOperation) {
        setMutationRecoveryOpen(true);
        setRemoteMutationNotice(receipt.status === "completed" ? translate("mutationRecovery.previousComplete")
          : translate("mutationRecovery.previousQueried", { detail: receipt.error ?? translate("mutationRecovery.inspectHint") }));
        clearSessionActivityCache(); setRefreshKey(key => key + 1);
        return false;
      }
      if (receipt.status === "completed") {
        setRemoteMutationNotice(translate("mutationRecovery.completed"));
        if (!getRemoteMutationClient().snapshot().length) setMutationRecoveryOpen(false);
        clearSessionActivityCache(); setRefreshKey(key => key + 1);
        return true;
      }
      setMutationRecoveryOpen(true);
      setRemoteMutationNotice(receipt.notSent ? translate(`mutationRecovery.${receipt.notSentReason ?? "notSent"}`)
        : ["failed", "conflict"].includes(receipt.status) ? translate("mutationRecovery.failed", { detail: receipt.error ?? translate("mutationRecovery.failedHint") })
        : translate("mutationRecovery.unknown", { id: receipt.operationId, detail: receipt.error ?? translate("mutationRecovery.queryHint") }));
      return false;
    } catch { setMutationRecoveryOpen(true); setRemoteMutationNotice(translate("mutationRecovery.channelFailed")); return false; }
  }, [getRemoteMutationClient, showRemoteMutationAuthentication, translate]);

  const handleSessionDeleted = useCallback((sessionId: string, propagate = true) => {
    clearSessionActivityCache();
    invalidateWorkspaceRestore();
    const embeddedSessionId = embeddedSessionIdOf(embeddedSessionKey, embeddedResourceSession, embeddedIframeSessionId);
    const embeddedKeySessionId = embeddedSessionIdOf(embeddedSessionKey, null, null);
    const embeddedOwnsSession = embeddedSessionId === sessionId;
    const localOwnsSession = selectedSession?.id === sessionId || remoteSession?.sessionInfo?.id === sessionId;
    const currentWorkspaceOwnsSession = embeddedOwnsSession || localOwnsSession;
    if (currentWorkspaceOwnsSession) {
      // Invalidate restores and in-place iframe requests captured before the
      // deletion so they cannot write the deleted session back into the shell.
      urlRestoreTokenRef.current += 1;
      mountRestorePendingRef.current = false;
      invalidateEmbeddedSessionRequest();
      pendingEmbeddedNewSessionRef.current = null;
    }
    if (propagate && embeddedOwnsSession && embeddedReaderUrl && embeddedIframeRef.current?.contentWindow) {
      embeddedIframeRef.current.contentWindow.postMessage({
        type: EMBEDDED_SESSION_INVALIDATE_REQUEST_EVENT,
        sessionId,
      }, "*");
    }
    if (propagate && localOwnsSession && embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({
        type: EMBEDDED_SESSION_INVALIDATED_EVENT,
        sessionId,
      }, "*");
    }
    if (embeddedOwnsSession) {
      const keepDeviceWorkspace = !embeddedSessionKey && Boolean(embeddedDeviceId && embeddedReaderUrl);
      if (embeddedKeySessionId === sessionId) setEmbeddedSessionKey(null);
      if (embeddedIframeSessionId === sessionId) setEmbeddedIframeSessionId(null);
      setEmbeddedResourceSession((current) => current?.sessionId === sessionId
        ? { ...current, sessionId: null, path: null }
        : current);
      if (keepDeviceWorkspace && embeddedReaderUrl) {
        try {
          const next = new URL(embeddedReaderUrl);
          next.searchParams.delete("session");
          next.searchParams.delete("hl");
          setEmbeddedReaderUrl(next.toString());
        } catch {
          setEmbeddedReaderUrl(null);
        }
      } else {
        // A session-only iframe has no useful document after its only session
        // is gone. Unmount it instead of leaving a stale ChatWindow visible.
        setEmbeddedReaderUrl(null);
      }
    }
    // The worktree hook compares against its live selection ref so an older
    // deletion callback cannot clear a newer Talk Map selection.
    clearTalkMapSelection(sessionId);
    if (currentWorkspaceOwnsSession) {
      setPendingRestoreMessage(null);
      setHighlightTerm(null);
      setLiveContextUsageSnapshot(null);
      setSessionStatsSnapshot(null);
      setActiveTopPanel(null);
    }
    // 删除/归档当前打开的远程会话：主区同步关闭（与 selectedSession 行为对齐），
    // 避免残留已删除会话视图（继续发送会 404）。
    if (remoteSession?.sessionInfo?.id === sessionId) {
      setRemoteSession(null);
      return;
    }
    if (selectedSession?.id === sessionId) {
      clearTabOpenSession(sessionId);
      const cwd = selectedSession.cwd;
      const subprojectId = selectedSession.subprojectId ?? null;
      clearLastOpen(workspaceKeyOf(selectedSession));
      activeNewSessionDraftKeyRef.current = buildNewSessionDraftKey(cwd, subprojectId);
      setSelectedSession(null);
      setNewSessionSubprojectId(subprojectId);
      setNewSessionSubprojectLabel(null);
      setNewSessionCwd(cwd ?? null);
      setSessionKey((k) => k + 1);
      setBranchTree([]);
      setBranchActiveLeafId(null);
      setSystemPrompt(null);
      replaceWorkspaceRoot();
    }
  }, [clearTalkMapSelection, embeddedDeviceId, embeddedIframeSessionId, embeddedReaderMode, embeddedReaderUrl, embeddedResourceSession, embeddedSessionKey, invalidateEmbeddedSessionRequest, invalidateWorkspaceRestore, remoteSession, replaceWorkspaceRoot, selectedSession]);

  // An outer activity list can delete the session currently rendered inside an
  // iframe. Ask that document to leave the deleted session; the local callback
  // remains the single state transition so it also opens a safe new composer.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleEmbeddedSessionInvalidation = (event: MessageEvent) => {
      const expectedSource = embeddedReaderMode
        ? window.parent
        : embeddedIframeRef.current?.contentWindow;
      if (event.source !== expectedSource) return;
      const data = event.data as { type?: unknown; sessionId?: unknown } | null;
      const expectedType = embeddedReaderMode
        ? EMBEDDED_SESSION_INVALIDATE_REQUEST_EVENT
        : EMBEDDED_SESSION_INVALIDATED_EVENT;
      if (data?.type !== expectedType || typeof data.sessionId !== "string" || !data.sessionId) return;
      handleSessionDeleted(data.sessionId, false);
    };
    window.addEventListener("message", handleEmbeddedSessionInvalidation);
    return () => window.removeEventListener("message", handleEmbeddedSessionInvalidation);
  }, [embeddedReaderMode, embeddedReaderUrl, handleSessionDeleted]);

  const handleOpenFile = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; remotePeer?: string; cwd?: string; projectRoot?: string; page?: number; anchor?: string; reuseActiveTab?: boolean },
  ) => {
    const sourceSessionId = options?.sourceSessionId;
    const modeHint = options?.modeHint;
    const workspace = resolveWorkspaceOwner({
      embeddedReaderUrl: Boolean(embeddedReaderUrl),
      activePeer: activePeerIdRef.current,
      embeddedResourceSession,
      remoteSessionPeer: remoteSession?.device.id ?? null,
      remoteSessionCwd: remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd,
      activeFilePeer: activeFileTabPeerRef.current,
      activeFileCwd: activeFileTabCwdRef.current,
      activeWorkspacePeer: activeTerminalPeerRef.current,
      activeWorkspaceCwd: activeTerminalCwdRef.current,
      selectedSessionCwd: selectedSession?.cwd,
      newSessionCwd,
      activeCwd: activeCwdRef.current,
    });
    const requestedCwd = options?.cwd?.trim() || null;
    const requestedPeer = options?.remotePeer ?? null;
    // An explicit file open from the mainline Explorer or an existing tab owns its
    // own cwd/peer. Validate device reachability without forcing equality to the
    // separate Agent worktree workspace.
    if (requestedPeer && activePeerIdRef.current && requestedPeer !== activePeerIdRef.current) return;
    const fallbackContext = manualFileContextRef.current
      ?? resolveAgentExecutionContext({
        deviceId: remoteSession?.device.id
          ?? (embeddedSessionKey ? embeddedSessionKey.split(":")[0] : null)
          ?? embeddedDeviceId
          ?? embeddedResourceSession?.deviceId
          ?? null,
        projectRoot: remoteSession?.sessionInfo?.projectRoot ?? selectedSession?.projectRoot,
        cwd: remoteSession?.sessionInfo?.cwd
          ?? remoteSession?.newSessionCwd
          ?? selectedSession?.cwd
          ?? newSessionCwd
          ?? (embeddedReaderUrl ? null : activeCwd),
      });
    const remotePeer = options?.remotePeer ?? fallbackContext?.deviceId ?? workspace.remotePeer ?? undefined;
    const cwd = options?.cwd ?? fallbackContext?.cwd ?? workspace.cwd ?? undefined;
    const projectRoot = options?.projectRoot ?? fallbackContext?.projectRoot ?? cwd;
    const tabId = getFileTabId(filePath, remotePeer);
    const tabInput = {
      fileName,
      filePath,
      remotePeer,
      cwd,
      projectRoot,
      modeHint,
      sourceSessionId,
      page: options?.page,
      anchor: options?.anchor,
      tabId,
    };
    const targetTab = fileTabs.find((tab) => tab.id === tabId);
    if (options?.anchor && targetTab?.dirty && !confirmDiscardFileChanges(targetTab)) return;

    if (options?.reuseActiveTab && activeFileTabId) {
      const activeTab = fileTabs.find((tab) => tab.id === activeFileTabId);
      const targetAlreadyOpen = fileTabs.some((tab) => tab.id === tabId && tab.id !== activeFileTabId);
      if (!targetAlreadyOpen && activeTab?.dirty && !confirmDiscardFileChanges(activeTab)) return;
      const replacement = replaceFileTab(fileTabs, activeFileTabId, tabInput);
      setFileTabs(replacement.tabs);
      setActiveFileTabId(replacement.activeTabId);
    } else {
      setFileTabs((prev) => openFileTab(prev, tabInput));
      setActiveFileTabId(tabId);
    }
    setRightPanelOpen(true);
    // On mobile the file panel is full-screen; close the drawer so it shows.
    if (isMobile) setSidebarOpen(false);
  }, [activeCwd, activeFileTabId, confirmDiscardFileChanges, embeddedDeviceId, embeddedReaderUrl, embeddedResourceSession, embeddedSessionKey, fileTabs, isMobile, newSessionCwd, remoteSession, selectedSession?.cwd, selectedSession?.projectRoot]);
  const activateReaderMode = useCallback((cwdOverride?: string | null, peerOverride?: string | null) => {
    if (isEmbeddedSessionOnly && !parentSidebarReady) return;
    const currentWorkspace = resolveWorkspaceOwner({
      embeddedReaderUrl: Boolean(embeddedReaderUrl),
      activePeer: activePeerIdRef.current,
      embeddedResourceSession,
      remoteSessionPeer: remoteSession?.device.id ?? null,
      remoteSessionCwd: remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd,
      activeFilePeer: activeFileTabPeerRef.current,
      activeFileCwd: activeFileTabCwdRef.current,
      activeWorkspacePeer: activeTerminalPeerRef.current,
      activeWorkspaceCwd: activeTerminalCwdRef.current,
      selectedSessionCwd: selectedSession?.cwd,
      newSessionCwd,
      activeCwd: activeCwdRef.current,
    });
    const requestedCwd = cwdOverride?.trim();
    const requestedOwner = requestedCwd
      && (!peerOverride || peerOverride === activePeerIdRef.current || peerOverride === currentWorkspace.remotePeer)
      ? { cwd: requestedCwd, remotePeer: peerOverride ?? activePeerIdRef.current ?? currentWorkspace.remotePeer ?? null }
      : null;
    const rejectedOwner = Boolean(requestedCwd && peerOverride && !requestedOwner);
    const workspace = requestedOwner ?? (rejectedOwner ? { cwd: null, remotePeer: null } : currentWorkspace);
    if (workspace.cwd) {
      setExplorerForContext(true, { openMobileDrawer: false, workspace });
    }
    setReaderConversationLayout(false);
    setReaderMode(true);
    setActiveTopPanel(null);
    setRightPanelOpen(true);
    if (isMobileViewport()) setSidebarOpen(false);
  }, [embeddedReaderUrl, embeddedResourceSession, isEmbeddedSessionOnly, newSessionCwd, parentSidebarReady, remoteSession, selectedSession?.cwd, setExplorerForContext, setReaderConversationLayout]);

  const enterReaderMode = useCallback(() => {
    if (isEmbeddedSessionOnly && !parentSidebarReady) return;
    activateReaderMode();
  }, [activateReaderMode, isEmbeddedSessionOnly, parentSidebarReady]);

  const closeFilePreview = useCallback(() => {
    setRightPanelOpen(false);
  }, []);

  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen((open) => !open);
  }, []);

  const exitReaderMode = useCallback(() => {
    setReaderMode(false);
    setExplorerForContext(false, { openMobileDrawer: false });
    setReaderConversationLayout(true);
    setRightPanelOpen(false);
  }, [setExplorerForContext, setReaderConversationLayout]);

  const toggleReaderMode = useCallback(() => {
    if (readerMode) exitReaderMode();
    else enterReaderMode();
  }, [enterReaderMode, exitReaderMode, readerMode]);

  const clearFileTabsLayout = useCallback(() => {
    closeExplorerContexts();
    setReaderMode(false);
    setReaderConversationLayout(true);
    setRightPanelOpen(false);
    if (isMobileViewport()) setSidebarOpen(false);
  }, [closeExplorerContexts, setReaderConversationLayout]);

  const handleOpenFileFromExplorer = useCallback((
    filePath: string,
    fileName: string,
    options?: { sourceSessionId?: string | null; modeHint?: "diff"; reuseActiveTab?: boolean },
  ) => {
    const context = resolveMainlineFileContext({
      deviceId: activityExplorerPeerRef.current ?? null,
      projectRoot: activityExplorerCwdRef.current,
      cwd: activityExplorerCwdRef.current,
    });
    if (!context) return;
    updateManualFileContext(context);
    handleOpenFile(filePath, fileName, {
      ...options,
      remotePeer: context.deviceId ?? undefined,
      cwd: context.cwd,
      projectRoot: context.projectRoot,
    });
    activateReaderMode(context.cwd, context.deviceId);
  }, [activateReaderMode, handleOpenFile, updateManualFileContext]);

  const [sessionPopupFile, setSessionPopupFile] = useState<{
    filePath: string;
    remotePeer?: string;
    sourceSessionId?: string | null;
    cwd?: string;
    page?: number;
  } | null>(null);

  const handleOpenLinkedFile = useCallback((filePath: string, page?: number) => {
    const cwd = selectedSession?.cwd ?? newSessionCwd ?? undefined;
    if (embeddedReaderMode && typeof window !== "undefined" && window.parent !== window) {
      window.parent.postMessage({
        type: EMBEDDED_OPEN_FILE_EVENT,
        filePath,
        cwd,
        sourceSessionId: selectedSession?.id ?? null,
        page,
      }, "*");
      return;
    }
    setSessionPopupFile({
      filePath,
      sourceSessionId: selectedSession?.id ?? null,
      cwd,
      page,
    });
  }, [embeddedReaderMode, newSessionCwd, selectedSession?.cwd, selectedSession?.id]);

  const closeEmbeddedSlashDetails = useCallback(() => {
    const details = embeddedSlashDetails;
    if (!details) return;
    setEmbeddedSlashDetails(null);
    setEmbeddedModalOpen(false);
    setEmbeddedModalKind(null);
    let targetOrigin = window.location.origin;
    try {
      if (embeddedReaderUrl) targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin;
    } catch {
      targetOrigin = window.location.origin;
    }
    embeddedIframeRef.current?.contentWindow?.postMessage(
      { type: EMBEDDED_SLASH_DETAILS_CLOSE_EVENT, requestId: details.requestId },
      targetOrigin,
    );
  }, [embeddedReaderUrl, embeddedSlashDetails]);

  const acknowledgeEmbeddedImagePreview = useCallback(() => {
    const current = embeddedImagePreviewRef.current;
    if (!current || current.documentId !== embeddedImagePreview?.documentId || current.requestId !== embeddedImagePreview?.requestId || current.phase !== "prepare") return;
    if (!embeddedReaderUrl) return;
    let targetOrigin: string;
    try { targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin; } catch { return; }
    embeddedIframeRef.current?.contentWindow?.postMessage(
      { type: EMBEDDED_IMAGE_PREVIEW_ACK_EVENT, documentId: current.documentId, requestId: current.requestId },
      targetOrigin,
    );
  }, [embeddedReaderUrl, embeddedImagePreview?.documentId, embeddedImagePreview?.requestId]);

  const closeEmbeddedImagePreview = useCallback(() => {
    const current = embeddedImagePreviewRef.current;
    if (!current || current.documentId !== embeddedImagePreview?.documentId || current.requestId !== embeddedImagePreview?.requestId || current.phase === "closed") return;
    const next = reduceEmbeddedImagePreview(current, {
      type: EMBEDDED_IMAGE_PREVIEW_EVENT, documentId: current.documentId, requestId: current.requestId, phase: "closed",
    });
    embeddedImagePreviewRef.current = next;
    setEmbeddedImagePreview(next);
    if (!embeddedReaderUrl) return;
    let targetOrigin: string;
    try { targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin; } catch { return; }
    embeddedIframeRef.current?.contentWindow?.postMessage(
      { type: EMBEDDED_IMAGE_PREVIEW_CLOSE_EVENT, documentId: current.documentId, requestId: current.requestId },
      targetOrigin,
    );
  }, [embeddedReaderUrl, embeddedImagePreview?.documentId, embeddedImagePreview?.requestId]);

  const handleOpenEmbeddedSlashFile = useCallback((filePath: string, page?: number) => {
    if (!embeddedSlashDetails) return;
    const deviceId = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId ?? embeddedResourceSession?.deviceId;
    setSessionPopupFile({
      filePath,
      remotePeer: deviceId ?? undefined,
      sourceSessionId: embeddedSlashDetails.sessionId ?? embeddedResourceSession?.sessionId ?? null,
      cwd: embeddedSlashDetails.cwd ?? embeddedResourceSession?.cwd ?? undefined,
      page,
    });
  }, [embeddedDeviceId, embeddedResourceSession?.cwd, embeddedResourceSession?.deviceId, embeddedResourceSession?.sessionId, embeddedSessionKey, embeddedSlashDetails]);

  const handleEmbeddedQuoteConfirm = useCallback((reply: string) => {
    const current = embeddedQuoteAnnotationRef.current;
    if (!current) return;
    setEmbeddedQuoteAnnotation(null);
    let targetOrigin = window.location.origin;
    try {
      if (embeddedReaderUrl) targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin;
    } catch {
      targetOrigin = window.location.origin;
    }
    embeddedIframeRef.current?.contentWindow?.postMessage({
      type: EMBEDDED_QUOTE_ANNOTATION_RESULT_EVENT,
      requestId: current.requestId,
      reply,
    }, targetOrigin);
  }, [embeddedReaderUrl]);

  const handleEmbeddedQuoteDelete = useCallback(() => {
    const current = embeddedQuoteAnnotationRef.current;
    if (!current?.canDelete) return;
    setEmbeddedQuoteAnnotation(null);
    let targetOrigin = window.location.origin;
    try {
      if (embeddedReaderUrl) targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin;
    } catch {
      targetOrigin = window.location.origin;
    }
    embeddedIframeRef.current?.contentWindow?.postMessage({
      type: EMBEDDED_QUOTE_ANNOTATION_DELETE_EVENT,
      requestId: current.requestId,
    }, targetOrigin);
  }, [embeddedReaderUrl]);

  const handleEmbeddedQuoteClose = useCallback(() => {
    const current = embeddedQuoteAnnotationRef.current;
    if (!current) return;
    setEmbeddedQuoteAnnotation(null);
    let targetOrigin = window.location.origin;
    try {
      if (embeddedReaderUrl) targetOrigin = new URL(embeddedReaderUrl, window.location.href).origin;
    } catch {
      targetOrigin = window.location.origin;
    }
    embeddedIframeRef.current?.contentWindow?.postMessage({
      type: EMBEDDED_QUOTE_ANNOTATION_CLOSE_EVENT,
      requestId: current.requestId,
    }, targetOrigin);
  }, [embeddedReaderUrl]);

  useEffect(() => {
    if (!embeddedReaderUrl || typeof window === "undefined") return;
    const handleEmbeddedFileOpen = (event: MessageEvent) => {
      if (event.source !== embeddedIframeRef.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        filePath?: unknown;
        cwd?: unknown;
        sourceSessionId?: unknown;
        page?: unknown;
      } | null;
      if (data?.type !== EMBEDDED_OPEN_FILE_EVENT || typeof data.filePath !== "string" || !data.filePath.trim()) return;
      const deviceId = embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId ?? embeddedResourceSession?.deviceId;
      setSessionPopupFile({
        filePath: data.filePath,
        remotePeer: deviceId ?? undefined,
        sourceSessionId: typeof data.sourceSessionId === "string"
          ? data.sourceSessionId
          : embeddedResourceSession?.sessionId ?? null,
        cwd: typeof data.cwd === "string" && data.cwd.trim()
          ? data.cwd
          : embeddedResourceSession?.cwd ?? undefined,
        page: typeof data.page === "number" && Number.isFinite(data.page) && data.page > 0 ? data.page : undefined,
      });
    };
    window.addEventListener("message", handleEmbeddedFileOpen);
    return () => window.removeEventListener("message", handleEmbeddedFileOpen);
  }, [embeddedDeviceId, embeddedReaderUrl, embeddedResourceSession?.cwd, embeddedResourceSession?.deviceId, embeddedResourceSession?.sessionId, embeddedSessionKey]);

  const handleOpenRemoteFile = useCallback((filePath: string, page?: number) => {
    const session = remoteSession?.sessionInfo;
    setSessionPopupFile({
      filePath,
      remotePeer: remoteSession?.device.id,
      sourceSessionId: session?.id ?? null,
      cwd: session?.cwd ?? remoteSession?.newSessionCwd ?? undefined,
      page,
    });
  }, [remoteSession]);

  const handleSelectFileTab = useCallback((tabId: string) => {
    closeSidekickRightPanel();
    if (tabId === activeFileTabId) return;
    setActiveFileTabId(tabId);
  }, [activeFileTabId, closeSidekickRightPanel]);

  const handleOpenTerminal = useCallback((cwd: string, peer?: string) => {
    updateManualFileContext(resolveMainlineFileContext({ deviceId: peer ?? null, projectRoot: cwd, cwd }));
    const terminalList = Array.isArray(terminalTabs) ? terminalTabs : [];
    const existing = terminalList.find((tab) => tab.cwd === cwd && tab.peer === peer);
    const tab = existing ?? newTerminalTab(cwd, peer);
    if (!existing) setTerminalTabs((tabs) => [...tabs, tab]);
    setActiveFileTabId(tab.id);
    setRightPanelOpen(true);
    if (isMobile) setSidebarOpen(false);
  }, [isMobile, terminalTabs, updateManualFileContext]);

  const handleTerminalClosed = useCallback((tab: TerminalTab) => {
    const terminalList = Array.isArray(terminalTabs) ? terminalTabs : [];
    const replacement = tab.closing === "restart" ? newTerminalTab(tab.cwd, tab.peer) : null;
    const remaining = terminalList.filter((item) => item.id !== tab.id);
    setTerminalTabs((tabs) => tabs.flatMap((item) => item.id !== tab.id ? [item] : replacement ? [replacement] : []));
    setActiveFileTabId((current) => current !== tab.id
      ? current
      : replacement?.id ?? remaining.at(-1)?.id ?? (sidekickRightPanelOpen ? SIDEKICK_TAB_ID : null) ?? fileTabs.at(-1)?.id ?? null);
    if (!replacement && !remaining.length && !fileTabs.length && !sidekickRightPanelOpen) setRightPanelOpen(false);
  }, [fileTabs, sidekickRightPanelOpen, terminalTabs]);
  const handleCloseFileTab = useCallback((tabId: string) => {
    if (tabId === SIDEKICK_TAB_ID) {
      // Only the panel that hosted Sidekick closes; explorer and reading layout stay as they were.
      closeSidekickTab();
      return;
    }
    const terminalList = Array.isArray(terminalTabs) ? terminalTabs : [];
    const terminal = terminalList.find((tab) => tab.id === tabId);
    if (terminal) {
      if (!terminal.closing) {
        setTerminalTabs((tabs) => tabs.map((tab) => tab.id === tabId ? { ...tab, closing: "close" } : tab));
        setActiveFileTabId((current) => current === tabId ? terminalList.filter((tab) => tab.id !== tabId && !tab.closing).at(-1)?.id ?? (sidekickRightPanelOpen ? SIDEKICK_TAB_ID : null) ?? fileTabs.at(-1)?.id ?? null : current);
      }
      return;
    }
    const tab = fileTabs.find((item) => item.id === tabId);
    if (!confirmDiscardFileChanges(tab)) return;
    const remaining = fileTabs.filter((t) => t.id !== tabId);
    setFileTabs(remaining);
    setActiveFileTabId((cur) => {
      if (cur !== tabId) return cur;
      return remaining.at(-1)?.id ?? (sidekickRightPanelOpen ? SIDEKICK_TAB_ID : null) ?? terminalList.at(-1)?.id ?? null;
    });
    if (remaining.length === 0) {
      if (!sidekickRightPanelOpen && terminalTabs.length === 0) clearFileTabsLayout();
    }
    if (terminalList.length > 0 || sidekickRightPanelOpen) setRightPanelOpen(true);
  }, [clearFileTabsLayout, confirmDiscardFileChanges, fileTabs, sidekickRightPanelOpen, terminalTabs]);

  const handleCloseAllFileTabs = useCallback(() => {
    const terminalList = Array.isArray(terminalTabs) ? terminalTabs : [];
    if (fileTabs.some((tab) => tab.dirty) && !window.confirm(translate("files.closeAllUnsavedConfirm"))) return;
    const fallbackId = sidekickRightPanelOpen ? SIDEKICK_TAB_ID : terminalList.at(-1)?.id ?? null;
    if (!fallbackId) {
      setFileTabs([]);
      setActiveFileTabId(null);
      clearFileTabsLayout();
      return;
    }
    setFileTabs([]);
    setActiveFileTabId(fallbackId);
    setRightPanelOpen(true);
  }, [clearFileTabsLayout, fileTabs, sidekickRightPanelOpen, terminalTabs, translate]);

  // 隐藏页入口（设备下拉「隐藏页」）：清掉会话/设备语境，切换到隐藏收纳聚合页。
  const handleOpenHiddenView = useCallback(() => {
    invalidateWorkspaceRestore();
    setHiddenView(true);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(false);
    setEmbeddedSessionKey(null);
    setEmbeddedResourceSession(null);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    // 与聚合页一致：进隐藏页为聚合总览（monitor off）；点会话/monitor 才进完整视图。
    setAggregateWorkspaceActive(false);
    setRemoteSession(null);
    setSelectedSession(null);
    setEmbeddedScopeAll(false);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setSidebarOpen(!isMobileViewport());
  }, [invalidateWorkspaceRestore]);

  const handleOpenFavoritesView = useCallback(() => {
    invalidateWorkspaceRestore();
    setHiddenView(false);
    setFavoritesView(true);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(false);
    setEmbeddedSessionKey(null);
    setEmbeddedResourceSession(null);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    setAggregateWorkspaceActive(false);
    setRemoteSession(null);
    setSelectedSession(null);
    setEmbeddedScopeAll(false);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setSidebarOpen(!isMobileViewport());
  }, [invalidateWorkspaceRestore]);

  const handleOpenToDiscussView = useCallback(() => {
    invalidateWorkspaceRestore();
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(true);
    setToReviseView(false);
    setCompletedView(false);
    setEmbeddedSessionKey(null);
    setEmbeddedResourceSession(null);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    setAggregateWorkspaceActive(false);
    setRemoteSession(null);
    setSelectedSession(null);
    setEmbeddedScopeAll(false);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setSidebarOpen(!isMobileViewport());
  }, [invalidateWorkspaceRestore]);

  const handleOpenToReviseView = useCallback(() => {
    invalidateWorkspaceRestore();
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(true);
    setCompletedView(false);
    setEmbeddedSessionKey(null);
    setEmbeddedResourceSession(null);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    setAggregateWorkspaceActive(false);
    setRemoteSession(null);
    setSelectedSession(null);
    setEmbeddedScopeAll(false);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setSidebarOpen(!isMobileViewport());
  }, [invalidateWorkspaceRestore]);

  const handleOpenCompletedView = useCallback(() => {
    invalidateWorkspaceRestore();
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(true);
    setEmbeddedSessionKey(null);
    setEmbeddedResourceSession(null);
    setEmbeddedDeviceId(null);
    setEmbeddedIframeSessionId(null);
    setEmbeddedReaderUrl(null);
    setEmbeddedDeviceWorkspaceActive(false);
    setAggregateWorkspaceActive(false);
    setRemoteSession(null);
    setSelectedSession(null);
    setEmbeddedScopeAll(false);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    setSidebarOpen(!isMobileViewport());
  }, [invalidateWorkspaceRestore]);

  // 旧完整设备视图设备切换：仅由 deviceSwitchOnly 入口调用。
  const handleChangeActivityDevice = useCallback((device: SessionActivityDevice | null) => {
    invalidateWorkspaceRestore();
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(false);
    if (!device) {
      if (aggregateWorkspaceActive) {
        // 已在全部设备完整视图：下拉再选「全部设备」保持现状。
        return;
      }
      // 全部设备：聚合总览（外层侧栏 + 主区）。
      setEmbeddedSessionKey(null);
      setEmbeddedResourceSession(null);
      setEmbeddedDeviceId(null);
      setEmbeddedReaderUrl(null);
      setEmbeddedDeviceWorkspaceActive(false);
      setAggregateWorkspaceActive(false);
      setRemoteSession(null);
      setEmbeddedScopeAll(false);
      setSidebarOpen(true);
      return;
    }
    setEmbeddedSessionKey(null);
    setEmbeddedScopeAll(false);
    setEmbeddedResourceSession(null);
    // 下拉选任意设备（含本机）→ 默认打开完整设备视图（monitor 形态）。
    setAggregateWorkspaceActive(false);
    setEmbeddedIframeSessionId(null);
    setEmbeddedDeviceWorkspaceActive(true);
    const url = buildEmbeddedReaderUrl(device, { localDeviceId, activitySidebar: true });
    if (!url) return;
    if (device.url) writeDeviceUrlCache(device.id, device.url);
    setEmbeddedDeviceId(device.id);
    setEmbeddedReaderUrl(url);
    setActiveTopPanel(null);
    setActivitySidebarMode(true);
    setReaderMode(false);
    setRightPanelOpen(false);
    if (isMobileViewport()) {
      setSessionListOpen(true);
      setSidebarOpen(true);
    }
  }, [aggregateWorkspaceActive, invalidateWorkspaceRestore, localDeviceId, writeDeviceUrlCache]);

  // 普通活动设备筛选只切换列表数据域；不得触碰当前工作区布局。
  const handleActivityDeviceFilterChange = useCallback(() => {
    setHiddenView(false);
    setFavoritesView(false);
    setToDiscussView(false);
    setToReviseView(false);
    setCompletedView(false);
  }, []);

  const selectRemoteActivitySession = useCallback((item: SessionActivityItem, searchTerm?: string) => {
    setRemoteSession((previous) => ({
      ...(previous?.device.id === item.device.id && previous.sessionInfo?.id === item.session.id ? previous : {}),
      device: item.device,
      sessionInfo: item.session,
      searchTerm: searchTerm?.trim() || null,
      newSessionCwd: null,
      sessionRunning: item.status === "running" || item.status === "retrying",
    }));
  }, []);

  const handleOpenActivitySession = useCallback((item: SessionActivityItem, searchTerm?: string, deviceFilter?: string) => {
    closeTalkMap();
    // 活动列表选择是新的会话导航：取消旧新建草稿/工作区恢复，避免异步完成回写旧会话。
    invalidateWorkspaceRestore();
    activeNewSessionDraftKeyRef.current = null;
    remoteNewSessionDraftKeyRef.current = null;
    // 隐藏页内点会话：保持 hiddenView（侧栏不跳变），走聚合完整视图原地打开，
    // URL sync 写 scope=hidden&monitor=on[&device]&session，刷新恢复隐藏页+会话。
    // 会话打开时的设备筛选语境：panel 传 state.device（"all" | 设备 id）；undefined
    // （搜索等入口）= 聚合语境，按全部设备处理。
    const aggregateDeviceScope = deviceFilter === undefined || deviceFilter === "all";
    setEmbeddedScopeAll(aggregateDeviceScope);
    const isLocalSession = item.device.id === localDeviceId;
    const target = new URL(isLocalSession ? window.location.origin : item.device.url || window.location.origin);
    const isRemoteSession = !isLocalSession;
    if (item.device.url) writeDeviceUrlCache(item.device.id, item.device.url);
    const collectionScope = hiddenView ? "hidden" : favoritesView ? "favorites" : toDiscussView ? "to_discuss" : toReviseView ? "to_revise" : completedView ? "completed" : null;
    if (collectionScope) target.searchParams.set("scope", collectionScope);
    applyActivityArchiveView(target);
    target.searchParams.set("session", item.session.id);
    if (searchTerm?.trim()) target.searchParams.set("hl", searchTerm.trim());
    else target.searchParams.delete("hl");

    if (isLocalSession && !embeddedReaderMode && !embeddedDeviceWorkspaceActive) {
      if (collectionScope || aggregateDeviceScope || isMobileViewport()) {
        setAggregateWorkspaceActive(true);
      }
      setActiveTopPanel(null);
      handleSelectSession(item.session, true, searchTerm);
      router.replace(`${target.pathname}${target.search}`, { scroll: false });
      return;
    }

    const fallbackToEmbeddedSession = () => {
      updateManualFileContext(null);
      // A fallback supersedes any earlier request. Otherwise a late timeout
      // can navigate back to the session captured by its old closure.
      invalidateEmbeddedSessionRequest();
      const embeddedUrl = !embeddedReaderMode
        ? buildEmbeddedReaderUrl(item.device, { localDeviceId, sessionId: item.session.id, sessionOnly: true })
        : null;
      if (!embeddedUrl) return false;
      setExplorerOpen(false);
      const highlightedUrl = withSearchHighlight(embeddedUrl, searchTerm);
      markActivitySessionViewed(item.session.id);
      setEmbeddedResourceSession({ deviceId: item.device.id, sessionId: item.session.id, cwd: item.session.cwd, path: item.session.path });
      setEmbeddedDeviceWorkspaceActive(false);
      setEmbeddedSessionKey(`${item.device.id}:${item.session.id}`);
      setEmbeddedReaderUrl(highlightedUrl);
      setActivitySidebarMode(true);
      setReaderMode(false);
      setRightPanelOpen(false);
      setSidebarOpen(!isMobileViewport());
      return true;
    };

    const currentEmbeddedDeviceId = embeddedDeviceId
      ?? embeddedSessionKey?.split(":")[0]
      ?? embeddedResourceSession?.deviceId;
    if (
      !embeddedReaderMode
      && !searchTerm?.trim()
      && embeddedReaderUrl
      && embeddedIframeReadyRef.current
      && currentEmbeddedDeviceId === item.device.id
      && embeddedIframeRef.current?.contentWindow
    ) {
      // 点开会话一律标记已读：d7c7b6b9 把该调用改成了「仅当前会话相同时才标」，
      // 导致 monitor-off 点开一个不同于当前显示会话的会话时不写 viewed——需点两次才转空闲。
      markActivitySessionViewed(item.session.id);
      const requestSerial = ++embeddedSessionRequestSerialRef.current;
      // session-only iframe 的外层列表立即跟随点击；完整 Monitor iframe
      // 使用 embeddedIframeSessionId，不能把它误切成 session-only 键。
      if (embeddedSessionKey) {
        setEmbeddedSessionKey(`${item.device.id}:${item.session.id}`);
        setEmbeddedResourceSession({ deviceId: item.device.id, sessionId: item.session.id, cwd: item.session.cwd, path: item.session.path });
      }
      if (embeddedSessionRequestTimerRef.current !== null) {
        window.clearTimeout(embeddedSessionRequestTimerRef.current);
        embeddedSessionRequestTimerRef.current = null;
      }
      setExplorerOpen(false);
      embeddedIframeRef.current.contentWindow.postMessage({
        type: EMBEDDED_OPEN_SESSION_REQUEST_EVENT,
        session: item.session,
      }, "*");
      embeddedSessionRequestTimerRef.current = window.setTimeout(() => {
        if (embeddedSessionRequestSerialRef.current !== requestSerial) return;
        embeddedSessionRequestTimerRef.current = null;
        fallbackToEmbeddedSession();
      }, 1200);
      setActiveTopPanel(null);
      return;
    }

    if (embeddedReaderMode) {
      target.searchParams.set(EMBEDDED_READER_PARAM, "1");
      if (resourceToolbarOwnedByParent) target.searchParams.set(EMBEDDED_RESOURCE_TOOLBAR_PARAM, EMBEDDED_RESOURCE_TOOLBAR_OWNER);
      // 保持当前页面形态：session-only 工作区内切会话仍是 session-only；
      // 完整设备视图（?piWebEmbedded=1，无 sessionOnly）内点会话只加 session，
      // 不误切 sessionOnly 形态，否则聚合列表会被收掉（收缩错面板）。
      if (sessionOnlyMode) target.searchParams.set(EMBEDDED_SESSION_PARAM, "1");
      else target.searchParams.delete(EMBEDDED_SESSION_PARAM);
      // 保留完整设备视图的活动会话侧栏形态参数（否则 router.replace 后丢参数，
      // 重挂载会退回原始 SessionSidebar 文件目录）。
      if (searchParams.get(EMBEDDED_ACTIVITY_SIDEBAR_PARAM) === "1") target.searchParams.set(EMBEDDED_ACTIVITY_SIDEBAR_PARAM, "1");
      else target.searchParams.delete(EMBEDDED_ACTIVITY_SIDEBAR_PARAM);
      // 设备身份决定会话归属；浏览器地址只决定对应 Reader 的访问频道。
      if (isRemoteSession) {
        markActivitySessionViewed(item.session.id);
        window.parent.postMessage({
          type: EMBEDDED_OPEN_SESSION_EVENT,
          device: item.device,
          sessionId: item.session.id,
          cwd: item.session.cwd,
          path: item.session.path,
          searchTerm: searchTerm?.trim() || null,
        }, "*");
        setActiveTopPanel(null);
        return;
      }
    }
    setActiveTopPanel(null);
    const isCategoryView = toDiscussView || toReviseView || completedView;
    if (isCategoryView && !embeddedReaderMode) {
      clearEmbeddedReaderOwner();
      setAggregateWorkspaceActive(true);
      if (isLocalSession) {
        suppressActivityPanelRestoreRef.current = true;
        setRemoteSession(null);
        handleSelectSession(item.session, true, searchTerm);
        router.replace(`${target.pathname}${target.search}`, { scroll: false });
      } else {
        updateManualFileContext(null);
        markActivitySessionViewed(item.session.id);
        setSelectedSession(null);
        selectRemoteActivitySession(item, searchTerm);
      }
      return;
    }
    if ((aggregateWorkspaceActive || hiddenView || favoritesView || isMobileViewport() || aggregateDeviceScope) && !embeddedReaderMode) {
      // 全部设备完整视图（或隐藏页）点会话：原地打开（不整页切 iframe）。
      // 隐藏页 monitor off 总览点会话 → 进入聚合完整视图（主区会话窗，侧栏保持隐藏列表）。
      // Aggregate navigation owns the main chat surface. Drop any previous
      // embedded Reader before rendering the selected device so its old
      // iframe cannot mask the new local/remote session.
      clearEmbeddedReaderOwner();
      setAggregateWorkspaceActive(true);
      // 用 device.id 判定本机；URL 和 hostname 不一定相同。
      if (isLocalSession) {
        // 本机会话：本机 ChatWindow 直接打开。
        suppressActivityPanelRestoreRef.current = true;
        setRemoteSession(null);
        handleSelectSession(item.session, true, searchTerm);
        router.replace(`${target.pathname}${target.search}`, { scroll: false });
      } else {
        updateManualFileContext(null);
        // 远程会话：主区切远程会话视图（经 /api/remote 代理读取+操作）；
        // 本机残留会话槽一并清（单槽语义：归档/删除远程会话后主区回列表，不跳回旧本机会话）。
        markActivitySessionViewed(item.session.id);
        setSelectedSession(null);
        selectRemoteActivitySession(item, searchTerm);
      }
      return;
    }
    if (fallbackToEmbeddedSession()) return;
    setEmbeddedSessionKey(null);
    setEmbeddedDeviceId(null);
    setEmbeddedReaderUrl(null);
    if (isLocalSession) {
      suppressActivityPanelRestoreRef.current = true;
      handleSelectSession(item.session, true, searchTerm);
      router.replace(`${target.pathname}${target.search}`, { scroll: false });
    } else {
      window.open(target.toString(), "_blank", "noopener,noreferrer");
    }
  }, [aggregateWorkspaceActive, clearEmbeddedReaderOwner, closeTalkMap, completedView, embeddedDeviceId, embeddedDeviceWorkspaceActive, embeddedReaderMode, embeddedReaderUrl, embeddedResourceSession, embeddedSessionKey, favoritesView, handleSelectSession, hiddenView, invalidateEmbeddedSessionRequest, invalidateWorkspaceRestore, localDeviceId, markActivitySessionViewed, resourceToolbarOwnedByParent, router, searchParams, selectRemoteActivitySession, sessionOnlyMode, toDiscussView, toReviseView, updateManualFileContext, writeDeviceUrlCache]);

  // 远程草稿创建成功后原地切换为会话视图（不离开聚合完整视图）。
  const handleRemoteSessionCreated = useCallback((session: SessionInfo, sourceDraftKey: string, instanceKey?: string) => {
    setRefreshKey((k) => k + 1);
    const current = committedRemoteSessionRef.current;
    if (remoteNewSessionDraftKeyRef.current !== sourceDraftKey || !instanceKey
      || !current || current.draftInstanceKey !== instanceKey || current.sessionInfo !== null) return;
    remoteNewSessionDraftKeyRef.current = null;
    completeTalkMapGhostConversion(session.id, sourceDraftKey);
    setRemoteSession((prev) => (prev?.draftInstanceKey === instanceKey && prev.sessionInfo === null ? { ...prev, sessionInfo: session, sessionRunning: false, newSessionCwd: null, newSessionSubprojectId: null, newSessionSubprojectLabel: null, newSessionContextSourceId: null, newSessionWorktreeBinding: null, promotedSessionId: session.id } : prev));
  }, [completeTalkMapGhostConversion]);

  // Show chat area if a session is selected, or if we have a cwd to start a new session in
  const effectiveNewSessionCwd = newSessionCwd ?? (selectedSession === null && activeCwd ? activeCwd : null);
  const effectiveNewSessionSubprojectId = newSessionCwd ? newSessionSubprojectId : null;
  const effectiveNewSessionSubprojectLabel = newSessionCwd ? newSessionSubprojectLabel : null;
  const newSessionPrefill = buildNewSessionPrefill(effectiveNewSessionSubprojectLabel);
  const newSessionDraftKey = selectedSession === null && effectiveNewSessionCwd
    ? buildNewSessionDraftKey(effectiveNewSessionCwd, effectiveNewSessionSubprojectId)
    : null;
  useLayoutEffect(() => {
    activeNewSessionDraftKeyRef.current = newSessionDraftKey;
  }, [newSessionDraftKey]);
  const showChat = selectedSession !== null || effectiveNewSessionCwd !== null;
  const embeddedTalkMapOpen = Boolean(
    embeddedReaderUrl && embeddedModalOpen && embeddedModalKind === "talk-map",
  );
  // Aggregate remote sessions use a separate remoteSession slot instead of
  // selectedSession, but still own the outer top-bar usage/status display.
  const topBarSessionActive = showChat || Boolean(remoteSession);
  useAppShellSidekickLifecycle({
    sessionId: topBarSession?.id ?? null,
    sessionActive: topBarSessionActive,
    onToggle: toggleSidekick,
  });

  // 新建项目/面板操作跟随的当前设备：打开中的远程会话（聚合完整视图）→
  // 嵌入的远程会话（聚合视图 iframe，embeddedSessionKey 格式 device:session）→
  // monitor 单台设备。全部设备且无会话时回落本机。
  const activePeerId = embeddedDeviceWorkspaceActive
    ? embeddedDeviceId
      ?? embeddedResourceSession?.deviceId
      ?? (embeddedSessionKey ? embeddedSessionKey.split(":")[0] : null)
      ?? remoteSession?.device.id
      ?? undefined
    : remoteSession?.device.id
      ?? (embeddedSessionKey ? embeddedSessionKey.split(":")[0] : null)
      ?? embeddedDeviceId
      ?? embeddedResourceSession?.deviceId
      ?? undefined;
  // One activity identity for every workspace shape: direct remote session,
  // session-only iframe, and full-device iframe session.
  const activeActivitySessionKey = embeddedSessionKey
    ?? (embeddedDeviceId && embeddedIframeSessionId ? `${embeddedDeviceId}:${embeddedIframeSessionId}` : null);
  const activeActivitySessionId = activeActivitySessionKey
    ? activeActivitySessionKey.split(":")[1] ?? null
    : remoteSession?.sessionInfo?.id ?? selectedSession?.id ?? null;
  const activeFileTab = fileTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeTerminalTab = terminalTabs.find((tab) => tab.id === activeFileTabId) ?? null;
  const activeFileCwd = resolveActiveFileCwd({
    tabCwd: activeFileTab?.cwd,
    tabPeer: activeFileTab?.remotePeer ?? null,
    activePeer: activePeerId,
    remoteSessionPeer: remoteSession?.device.id ?? null,
    remoteSessionCwd: remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd,
    localCwd: activeCwd,
  });
  activeFileTabCwdRef.current = activeFileCwd ?? null;
  activeFileTabPeerRef.current = activeFileTab?.remotePeer ?? null;
  activeTerminalCwdRef.current = activeTerminalTab ? activeTerminalTab.cwd : undefined;
  activeTerminalPeerRef.current = activeTerminalTab ? activeTerminalTab.peer ?? null : undefined;
  const workspaceOwner = resolveWorkspaceOwner({
    embeddedReaderUrl: Boolean(embeddedReaderUrl),
    activePeer: activePeerId,
    embeddedResourceSession,
    remoteSessionPeer: remoteSession?.device.id ?? null,
    remoteSessionCwd: remoteSession?.sessionInfo?.cwd ?? remoteSession?.newSessionCwd,
    activeFilePeer: activeFileTab?.remotePeer ?? null,
    activeFileCwd,
    activeWorkspacePeer: activeTerminalPeerRef.current,
    activeWorkspaceCwd: activeTerminalCwdRef.current,
    selectedSessionCwd: selectedSession?.cwd,
    newSessionCwd,
    activeCwd,
  });
  const resourceCwd = workspaceOwner.cwd;
  const resourceSessionFile = embeddedReaderUrl
    ? embeddedResourceSession?.path ?? undefined
    : remoteSession?.sessionInfo?.path ?? selectedSession?.path ?? undefined;
  const resourceSessionId = embeddedReaderUrl
    ? embeddedResourceSession?.sessionId ?? null
    : remoteSession?.sessionInfo?.id ?? selectedSession?.id ?? null;
  const resourcePeer = workspaceOwner.remotePeer ?? undefined;
  const projectTrustCwd = workspaceOwner.remotePeer ? null : workspaceOwner.cwd;
  const activeSystemOwnerKey = `${resourcePeer ?? "local"}:${resourceSessionId ?? "new"}:${resourceCwd ?? ""}`;
  const previousSystemOwnerKeyRef = useRef(activeSystemOwnerKey);
  useEffect(() => {
    if (previousSystemOwnerKeyRef.current === activeSystemOwnerKey) return;
    previousSystemOwnerKeyRef.current = activeSystemOwnerKey;
    setSystemPrompt(null);
    setSystemTools(null);
    setRuntimeInspection(null);
    systemPromptLoaderRef.current = null;
    setBranchTree([]);
    setBranchActiveLeafId(null);
    setBranchSwitchLocked(false);
    branchLeafChangeFnRef.current = null;
  }, [activeSystemOwnerKey]);

  // While restoring initial session from URL, don't show the placeholder
  const showPlaceholder = initialSessionRestored && !showChat;
  // Fresh load with no restored session and no cwd: lock the top-ranked
  // project (most recent session first, else newest saved project) so the
  // chat input is immediately usable instead of the get-started placeholder.
  useEffect(() => {
    if (!initialSessionRestored || selectedSession !== null || newSessionCwd !== null || activeCwd !== null) return;
    if (defaultProjectLockedRef.current) return;
    defaultProjectLockedRef.current = true;
    let cancelled = false;
    (async () => {
      try {
        // Only a local directory can become the default project: a session
        // from another device carries a foreign absolute cwd that would fail
        // every local project-trust / model request.
        const runs = await fetchSessionActivity<{ sessions?: Array<{ projectKey?: string; session?: { cwd?: string; projectRoot?: string } }>; knownProjects?: Array<{ key: string; path: string }> }>(
          "/api/session-runs?scope=local",
        );
        if (cancelled) return;
        // A persisted single-project activity filter owns the lock even when
        // that project has zero sessions; otherwise a saved filter reloads to
        // the top-ranked session project instead. Resolution stays inside the
        // scope=local response so a foreign device path can never become the
        // local default project.
        const filterProjects = readSharedFilters().project;
        if (filterProjects.length === 1) {
          const byKey = new Map<string, string>();
          for (const item of runs?.sessions ?? []) {
            if (!item.session) continue;
            const key = item.projectKey ?? item.session.cwd ?? "";
            if (key) byKey.set(key, item.session.projectRoot ?? item.session.cwd ?? "");
          }
          for (const known of runs?.knownProjects ?? []) {
            if (known.key && !byKey.has(known.key)) byKey.set(known.key, known.path);
          }
          const lockedCwd = byKey.get(filterProjects[0]);
          if (lockedCwd) { setNewSessionCwd(lockedCwd); return; }
        }
        const firstCwd = runs?.sessions?.[0]?.session?.cwd;
        if (firstCwd) { setNewSessionCwd(firstCwd); return; }
        const projects = await fetch("/api/projects", { cache: "no-store" }).then((r) => r.json()) as { projects?: { path?: string }[] };
        if (cancelled) return;
        const firstPath = projects?.projects?.[0]?.path;
        if (firstPath) setNewSessionCwd(firstPath);
      } catch {
        // Keep the get-started placeholder when nothing can be resolved.
      }
    })();
    return () => { cancelled = true; };
  }, [initialSessionRestored, selectedSession, newSessionCwd, activeCwd, embeddedReaderMode]);

  useEffect(() => {
    setProjectTrust(null);
    setProjectTrustDialogOpen(false);
    setProjectTrustError(null);
    if (!projectTrustCwd) return;

    const controller = new AbortController();
    fetch(`/api/project-trust?cwd=${encodeURIComponent(projectTrustCwd)}`, {
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json() as ProjectTrustStatus & { error?: string };
        if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
        setProjectTrust(data);
      })
      .catch((error) => {
        if (error instanceof DOMException && error.name === "AbortError") return;
        console.error("Failed to load project trust:", error);
      });
    return () => controller.abort();
  }, [projectTrustCwd]);

  const handleTrustProject = useCallback(async () => {
    if (!projectTrustCwd || projectTrustBusy) return;
    setProjectTrustBusy(true);
    setProjectTrustError(null);
    try {
      const response = await fetch("/api/project-trust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: projectTrustCwd }),
      });
      const data = await response.json() as ProjectTrustStatus & { error?: string; reason?: McpRefusalReason };
      if (!response.ok || data.error) {
        setProjectTrustError({ error: data.error ?? `HTTP ${response.status}`, ...(data.reason ? { reason: data.reason } : {}) });
        return;
      }
      setProjectTrust(data);
      setProjectTrustDialogOpen(false);
      setModelsRefreshKey((key) => key + 1);
      setSessionKey((key) => key + 1);
    } catch (error) {
      setProjectTrustError({ error: error instanceof Error ? error.message : String(error) });
    } finally {
      setProjectTrustBusy(false);
    }
  }, [projectTrustBusy, projectTrustCwd]);

  const activeCwdName = activeCwd ? getFileName(activeCwd) || activeCwd : null;  const windowTitle = activeCwdName ? `${activeCwdName} - Pi Web` : "Pi Web";

  useEffect(() => {
    const syncWindowTitle = () => {
      if (document.title !== windowTitle) document.title = windowTitle;
    };

    syncWindowTitle();
    const observer = new MutationObserver(syncWindowTitle);
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
    return () => observer.disconnect();
  }, [windowTitle]);

  const embeddedManualContext = manualFileContext
    && (!manualFileContext.deviceId || manualFileContext.deviceId === activePeerId)
    ? manualFileContext
    : null;
  const embeddedFallbackContext = resolveMainlineFileContext({
    deviceId: activePeerId ?? null,
    cwd: resolveEmbeddedContextCwd({
      resourceSession: embeddedResourceSession,
      activePeer: activePeerId,
      activeFilePeer: activeFileTab?.remotePeer ?? null,
      activeFileCwd,
    }),
  });
  const activityExplorerContext = embeddedReaderUrl
    ? embeddedManualContext ?? embeddedFallbackContext
    : manualFileContext
      ?? (remoteSession
        ? resolveMainlineFileContext({
          deviceId: remoteSession.device.id,
          projectRoot: remoteSession.sessionInfo?.projectRoot,
          cwd: remoteSession.sessionInfo?.cwd ?? remoteSession.newSessionCwd,
        })
        : resolveMainlineFileContext({
          deviceId: null,
          projectRoot: selectedSession?.projectRoot,
          cwd: selectedSession?.cwd ?? newSessionCwd ?? embeddedResourceSession?.cwd ?? activeFileCwd ?? activeCwd,
        }));
  const activityExplorerCwd = activityExplorerContext?.cwd ?? null;
  const explorerContentVisible = !embeddedDeviceWorkspaceActive
    && explorerSectionOpen
    && Boolean(activityExplorerCwd)
    && (!isMobile || sidebarOpen);
  const sessionListBlockedByExplorer = activityWorkspaceActive && embeddedWorkspaceExplorerOpen;
  const localConversationSidebarVisible = isMobile
    ? sidebarOpen
      && sessionListOpen
      && !sessionListBlockedByExplorer
    : fixedConversationSidebarVisible
      && sessionListOpen
      && !embeddedWorkspaceExplorerVisible;
  activePeerIdRef.current = activePeerId;
  activityExplorerCwdRef.current = activityExplorerCwd;
  activityExplorerPeerRef.current = activityExplorerContext?.deviceId ?? undefined;
  const baseSidebarShellOpen = isEmbeddedSessionOnly ? explorerContentVisible : (isMobile ? sidebarOpen : localConversationSidebarVisible || explorerContentVisible);
  const mobileFullDeviceSelectorVisible = isMobile
    && embeddedDeviceWorkspaceActive
    && !readerMode
    && !embeddedExplorerTakesLeftLayout
    && !rightPanelOpen
    && !embeddedModalOpen
    && !embeddedFileViewerOpen;
  const embeddedLeftSlotState = deriveEmbeddedLeftSlotState({
    embeddedDeviceWorkspaceActive,
    readerMode,
    takesLeftLayout: embeddedExplorerTakesLeftLayout,
    isMobile,
    sidebarOpen,
    sidebarShellOpen: baseSidebarShellOpen,
  });
  const embeddedExplorerOwnsLeftLayout = embeddedLeftSlotState.ownsLeftLayout;
  const conversationSidebarVisible = isEmbeddedSessionOnly
    ? parentSidebarReady && parentSidebarOpen
    : localConversationSidebarVisible;
  const sidebarShellOpen = embeddedLeftSlotState.sidebarShellOpen || mobileFullDeviceSelectorVisible;
  const sidebarHeaderVisible = !readerMode
    && !isEmbeddedSessionOnly
    && !embeddedDeviceWorkspaceActive
    && !activitySidebarMode;
  const nestedSessionOnlyFrame = embeddedReaderMode
    && isEmbeddedSessionOnly
    && resourceToolbarOwnedByParent
    && typeof window !== "undefined"
    && window.parent !== window;
  // Reader/session-only sidebars are already opened only when their Explorer
  // content is available. Reuse that shell state instead of recomputing cwd
  // from a second fallback chain; this keeps A mounted in the actual File row.
  const explorerToolbarAvailable = !embeddedDeviceWorkspaceActive
    && (readerMode || isEmbeddedSessionOnly || !conversationSidebarVisible)
    && sidebarShellOpen;
  const readerRecoveryVisible = readerMode && !chatOpen && !rightPanelOpen;
  const filePanelRecoveryVisible = !rightPanelOpen && (readerRecoveryVisible || (fileTabs.length > 0 && (!chatOpen || Boolean(embeddedReaderUrl))));
  // When the parent owns a session-only iframe, its top bar is intentionally
  // absent. Keep A as a parent overlay when that outer sidebar is collapsed;
  // the child reserves the same slot before B/C so the two surfaces cannot
  // overlap when the child's own file Explorer is later collapsed.
  const embeddedSessionControlOverlayAvailable = Boolean(embeddedReaderUrl)
    && !embeddedDeviceWorkspaceActive
    && !embeddedTalkMapOpen
    && !embeddedModalOpen
    && !embeddedFileViewerOpen
    && !sidebarShellOpen;
  const activitySidebarControlAvailable = !isEmbeddedSessionOnly
    && !embeddedDeviceWorkspaceActive
    && activitySidebarMode
    && conversationSidebarVisible;
  const sessionControlPlacement = deriveSessionControlPlacement({
    nestedSessionOnlyFrame,
    sidebarHeaderVisible,
    sidebarShellOpen,
    activityToolbarAvailable: activitySidebarControlAvailable,
    explorerToolbarAvailable,
    topBarAvailable: chatOpen && !embeddedReaderUrl,
    rightPanelAvailable: readerMode && !isMobile && rightPanelOpen,
    recoveryAvailable: readerRecoveryVisible,
    embeddedOverlayAvailable: embeddedSessionControlOverlayAvailable,
  });
  const reserveParentSessionControlSlot = shouldReserveParentSessionControlSlot({
    nestedSessionOnlyFrame,
    parentSidebarReady,
    parentSidebarOpen,
    parentSidebarDrawerOpen,
    isMobile,
    sidebarShellOpen,
  });
  const reserveExplorerParentSessionSlot = shouldReserveExplorerParentSessionSlot({
    nestedSessionOnlyFrame,
    parentSidebarReady,
    parentSidebarOpen,
    parentSidebarDrawerOpen,
    isMobile,
    sidebarShellOpen,
    readerMode,
  });
  const layoutControls: Record<LayoutControlId, {
    open: boolean;
    disabled: boolean;
    title: string;
    ariaLabel: string;
    ariaExpanded: boolean;
    ariaPressed: boolean;
    onClick: () => void;
  }> = {
    sessions: {
      open: conversationSidebarVisible,
      disabled: (isEmbeddedSessionOnly && !parentSidebarReady) || sessionListBlockedByExplorer,
      title: isEmbeddedSessionOnly && !parentSidebarReady
        ? translate("layout.waitingParentSessionList")
        : sessionListBlockedByExplorer
          ? translate("layout.closeExplorerFirst")
          : conversationSidebarVisible ? translate("sidebar.hideSessions") : translate("sidebar.showSessions"),
      ariaLabel: isEmbeddedSessionOnly && !parentSidebarReady
        ? translate("layout.waitingParentSessionList")
        : sessionListBlockedByExplorer
          ? translate("layout.closeExplorerFirst")
          : conversationSidebarVisible ? translate("sidebar.hideSessions") : translate("sidebar.showSessions"),
      ariaExpanded: true,
      ariaPressed: false,
      onClick: handleSidebarToggle,
    },
    explorer: {
      open: embeddedDeviceWorkspaceActive ? false : explorerContentVisible,
      disabled: embeddedDeviceWorkspaceActive || !activityExplorerCwd,
      title: embeddedDeviceWorkspaceActive
        ? translate("layout.explorerControlledByDevice")
        : activityExplorerCwd
          ? explorerContentVisible ? translate("files.hideExplorer") : translate("files.showExplorer")
          : translate("layout.noWorkspace"),
      ariaLabel: embeddedDeviceWorkspaceActive
        ? translate("layout.explorerControlledByDevice")
        : activityExplorerCwd
          ? explorerContentVisible ? translate("files.hideExplorer") : translate("files.showExplorer")
          : translate("layout.noWorkspace"),
      ariaExpanded: true,
      ariaPressed: false,
      onClick: embeddedDeviceWorkspaceActive ? () => {} : toggleExplorer,
    },
    reader: {
      open: readerMode,
      disabled: !readerMode && isEmbeddedSessionOnly && !parentSidebarReady,
      title: readerMode
        ? translate("files.exitReadingMode")
        : isEmbeddedSessionOnly && !parentSidebarReady
          ? translate("files.waitingForParentSessionList")
          : translate("files.enterReadingMode"),
      ariaLabel: readerMode
        ? translate("files.exitReadingMode")
        : isEmbeddedSessionOnly && !parentSidebarReady
          ? translate("files.waitingForParentSessionList")
          : translate("files.enterReadingMode"),
      ariaExpanded: false,
      ariaPressed: true,
      onClick: toggleReaderMode,
    },
    document: {
      open: rightPanelOpen,
      disabled: false,
      title: rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel"),
      ariaLabel: rightPanelOpen ? translate("files.hidePanel") : translate("files.showPanel"),
      ariaExpanded: true,
      ariaPressed: false,
      onClick: toggleRightPanel,
    },
  };
  const renderLayoutControl = (id: LayoutControlId, surface: LayoutControlSurface) => {
    const control = layoutControls[id];
    const size = (surface === "top" || surface === "sidebar") && isMobile ? 44 : 36;
    const readerMarker = surface === "top"
      ? "top-bar"
      : surface === "recovery" ? "fixed-file-panel" : "right-panel";
    const isRightBorder = id !== "document" && surface !== "panel-action";
    const isLeftBorder = id === "document" || surface === "panel-action";
    return (
      <button
        key={`${surface}-${id}`}
        type="button"
        className={(surface === "top" && id === "sessions") || (surface === "sidebar" && id === "sessions")
          ? "top-bar-sidebar-toggle"
          : id === "explorer" && surface === "top" ? "top-bar-folder-toggle" : undefined}
        data-layout-control={id}
        data-activity-sidebar-toggle={id === "sessions" ? "true" : undefined}
        data-reader-mode-toggle={id === "reader" ? readerMarker : undefined}
        data-file-panel-toggle={id === "document" ? (surface === "recovery" ? "fixed" : "right-panel") : undefined}
        onClick={control.onClick}
        aria-controls={id === "sessions" || id === "explorer" ? "session-sidebar" : id === "document" ? "file-panel" : undefined}
        aria-expanded={control.ariaExpanded ? control.open : undefined}
        aria-pressed={control.ariaPressed ? control.open : undefined}
        title={control.title}
        aria-label={control.ariaLabel}
        disabled={control.disabled}
        style={{
          display: "flex", alignItems: "center", justifyContent: "center",
          width: size, height: size, minWidth: size, padding: 0,
          background: surface === "recovery" ? "var(--bg-panel)" : "none",
          boxShadow: "none", border: "none",
          borderRight: isRightBorder ? "1px solid var(--border)" : undefined,
          borderLeft: isLeftBorder ? "1px solid var(--border)" : undefined,
          color: "var(--text-muted)", cursor: control.disabled ? "not-allowed" : "pointer",
          opacity: control.disabled ? 0.5 : 1, flexShrink: 0,
          touchAction: "manipulation", transition: "color 0.12s",
        }}
        onMouseEnter={(event) => {
          if (!control.disabled) event.currentTarget.style.color = "var(--text)";
        }}
        onMouseLeave={(event) => {
          event.currentTarget.style.color = "var(--text-muted)";
        }}
      >
        {id === "sessions" ? (
          control.open
            ? <PanelLeftClose size={16} strokeWidth={1.8} aria-hidden="true" />
            : <PanelLeftOpen size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : id === "explorer" ? (
          control.open
            ? <FolderOpen size={16} strokeWidth={1.8} aria-hidden="true" />
            : <Folder size={16} strokeWidth={1.8} aria-hidden="true" />
        ) : id === "reader" ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
            <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="15" y1="3" x2="15" y2="21" />
          </svg>
        )}
      </button>
    );
  };
  useEffect(() => {
    if (!fileSearchFocusRequest || fileSearchFocusConsumedRef.current === fileSearchFocusRequest) return;
    if (!explorerSectionOpen || !activityExplorerCwd) return;
    fileSearchFocusConsumedRef.current = fileSearchFocusRequest;
    const frame = window.requestAnimationFrame(() => {
      window.dispatchEvent(new Event("reader:focus-file-search"));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [activityExplorerCwd, explorerSectionOpen, fileSearchFocusRequest]);
  const headerNewCwd = selectedSession?.cwd ?? newSessionCwd ?? activeCwd;
  // 设备切换条只覆盖 iframe 顶部第一格，不遮挡 iframe 的会话范围控件。
  const activityDeviceOverlayWidth = `${Math.round(SIDEBAR_DEFAULT_WIDTH / 2 + 3)}px`;
  const activityDeviceShieldWidth = embeddedExplorerTakesLeftLayout
    ? `${sidebarResizer.width}px`
    : activityDeviceOverlayWidth;
  const remoteWorkspaceUrl = embeddedReaderUrl;
  const sidebarHeader = (
    <>
      {/* Original session sidebar header; activity mode starts with its filter row. */}
      {sidebarHeaderVisible && (
        <div style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          height: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
          borderBottom: "1px solid var(--border)",
          background: "var(--bg-panel)",
          flexShrink: 0,
        }}>
          <div style={{ display: "flex", alignItems: "center", minWidth: 0, overflow: "hidden", height: "100%" }}>
            {sessionControlPlacement === "sidebar-header" && renderLayoutControl("sessions", "sidebar")}
            <div style={{ paddingLeft: 8, paddingRight: 6, display: "flex", alignItems: "center", minWidth: 0 }}>
              <PiWebTitle />
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4, paddingRight: 6, flexShrink: 0 }}>
            <button
              type="button"
              onClick={() => setActivitySidebarMode((v) => !v)}
              title={activitySidebarMode ? translate("sidebar.switchToOriginal") : translate("sidebar.openActivitySidebar")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: activitySidebarMode ? "var(--bg-selected)" : "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: activitySidebarMode ? "var(--accent)" : "var(--text-muted)",
                cursor: "pointer", width: 28, height: 28, borderRadius: 6, padding: 0, flexShrink: 0,
                transition: "background 0.12s, color 0.12s",
              }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M3 12h4l3-8 4 16 3-8h4" />
              </svg>
            </button>
            <button
              type="button"
              onClick={() => { if (headerNewCwd) handleNewSession(`header-${Date.now()}`, headerNewCwd, inheritedNewSessionSubprojectId); }}
              disabled={!headerNewCwd}
              title={headerNewCwd ? translate("sidebar.newSessionTitle", { path: headerNewCwd }) : translate("sidebar.selectProject")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 4,
                background: "var(--bg-hover)",
                border: "1px solid var(--border)",
                color: headerNewCwd ? "var(--text-muted)" : "var(--text-dim)",
                cursor: headerNewCwd ? "pointer" : "not-allowed",
                height: 28, paddingLeft: 8, paddingRight: 10, borderRadius: 6,
                fontSize: 11, fontWeight: 500, letterSpacing: "-0.01em", flexShrink: 0,
                transition: "background 0.12s, color 0.12s, border-color 0.12s",
              }}
              onMouseEnter={(e) => {
                if (!headerNewCwd) return;
                e.currentTarget.style.background = "var(--bg-selected)";
                e.currentTarget.style.color = "var(--accent)";
                e.currentTarget.style.borderColor = "rgba(37,99,235,0.35)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.background = "var(--bg-hover)";
                e.currentTarget.style.color = headerNewCwd ? "var(--text-muted)" : "var(--text-dim)";
                e.currentTarget.style.borderColor = "var(--border)";
              }}
            >
              <svg width="11" height="11" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                <line x1="6" y1="1" x2="6" y2="11" />
                <line x1="1" y1="6" x2="11" y2="6" />
              </svg>
              {translate("sidebar.new")}
            </button>
            <button
              type="button"
              onClick={() => {
                setRefreshKey((k) => k + 1);
                setHeaderRefreshDone(true);
                if (headerRefreshTimerRef.current) clearTimeout(headerRefreshTimerRef.current);
                headerRefreshTimerRef.current = setTimeout(() => setHeaderRefreshDone(false), 2000);
              }}
              title={translate("sidebar.refresh")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                background: headerRefreshDone ? "rgba(74,222,128,0.18)" : "var(--bg-hover)",
                border: `1px solid ${headerRefreshDone ? "rgba(74,222,128,0.4)" : "var(--border)"}`,
                color: headerRefreshDone ? "#4ade80" : "var(--text-muted)",
                cursor: "pointer", width: 28, height: 28, borderRadius: 6, padding: 0, flexShrink: 0,
                transition: "background 0.3s, color 0.3s, border-color 0.3s",
              }}
            >
              {headerRefreshDone ? (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#4ade80" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              ) : (
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                  <path d="M3 3v5h5" />
                </svg>
              )}
            </button>
          </div>
        </div>
      )}
    </>
  );
  const resourceToolbar = !readerMode && !embeddedWorkspaceExplorerVisible && !resourceToolbarOwnedByParent && !embeddedDeviceWorkspaceActive ? (
    <ResourceToolbar
      cwd={resourceCwd}
      onOpenModels={() => setSettingsModalTab("models")}
      onOpenSkills={() => setSettingsModalTab("skills")}
      onOpenPlugins={() => setSettingsModalTab("plugins")}
      onOpenAgents={() => setSettingsModalTab("agents")}
    />
  ) : null;


  const activitySidebarContainerVisible = mobileFullDeviceSelectorVisible || shouldShowActivitySidebarContainer({
    conversationSidebarVisible,
    embeddedDeviceWorkspaceActive,
    readerMode,
    isMobile,
    takesLeftLayout: embeddedExplorerTakesLeftLayout,
    isEmbeddedSessionOnly,
  });
  const explorerSessionLeadingControl = reserveExplorerParentSessionSlot ? (
    <div
      data-layout-control-reserved="sessions"
      aria-hidden="true"
      style={{
        width: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
        minWidth: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
        height: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
        borderRight: "1px solid var(--border)",
        flexShrink: 0,
      }}
    />
  ) : renderLayoutControl("sessions", "sidebar");
  const explorerSectionRendered = !embeddedDeviceWorkspaceActive && shouldRenderExplorerSection({
    explorerSectionOpen,
    activityExplorerCwd,
  });
  const sideBySideSidebarPanels = !isMobile
    && !embeddedDeviceWorkspaceActive
    && activitySidebarMode
    && activitySidebarContainerVisible
    && explorerSectionOpen
    && Boolean(activityExplorerCwd);
  const handleActivityCopySessionInfo = useCallback((item: SessionActivityItem) => {
    if (!item.session.path) return;
    const title = item.session.name?.trim() || item.session.firstMessage?.trim().split("\n")[0]?.slice(0, 100) || item.session.id;
    const sourceInfo = buildTalkMapSourceInfo({
      sourceDevice: item.device.name,
      sourceSessionId: item.session.id,
      sourceTitle: title,
      sourcePath: item.session.path,
      sourceProject: item.session.projectRoot ?? item.session.cwd ?? "",
    });
    return handleCopySessionField("sourceInfo", sourceInfo);
  }, [handleCopySessionField]);
  const sidebarContent = (
    <>
      {sidebarHeader}
      {activitySidebarMode ? (
        <div style={{ display: "flex", flexDirection: sideBySideSidebarPanels ? "row" : "column", flex: 1, minHeight: 0 }}>
          <div style={{
            display: activitySidebarContainerVisible ? "flex" : "none",
            flexDirection: "column",
            flex: 1,
            minHeight: 0,
            width: sideBySideSidebarPanels ? `${sidebarResizer.width}px` : undefined,
            minWidth: sideBySideSidebarPanels ? `${sidebarResizer.width}px` : undefined,
            borderRight: sideBySideSidebarPanels ? "1px solid var(--border)" : undefined,
          }}>
            {!isEmbeddedSessionOnly && (
              <SessionActivitySidebar
                remotePeer={activePeerId}
                selectedSessionId={activeActivitySessionKey ? null : activeActivitySessionId}
                selectedSessionKey={activeActivitySessionKey}
                highlightedSessionId={talkMapSidebarSessionId}
                onOpenSession={handleOpenActivitySession}
                activityScope={hiddenView ? "hidden" : favoritesView ? "favorites" : embeddedReaderMode ? "local" : "all"}
                onProjectCwdChange={handleActivityProjectCwdChange}
                onProjectRemoved={handleActivityProjectRemoved}
                onNewSession={handleNewActivitySession}
                onOpenWorktreeGraph={handleOpenWorktreeGraph}
                onOpenTalkMapForSession={handleActivityTalkMap}
                onInjectContext={handleActivityInjectContext}
                onCopySessionInfo={handleActivityCopySessionInfo}
                onSessionDeleted={handleSessionDeleted}
                onRemoteMutate={mutateRemoteSession}

                onDeviceChange={!embeddedReaderMode ? handleChangeActivityDevice : undefined}
                onActivityDeviceFilterChange={!embeddedReaderMode ? handleActivityDeviceFilterChange : undefined}
                showDeviceSelector={!embeddedReaderMode}
                deviceSwitchOnly={Boolean(embeddedDeviceWorkspaceActive)}
                deviceSwitchValue={embeddedDeviceId ?? undefined}
                hiddenView={hiddenView}
                favoriteView={favoritesView}
                toDiscussView={toDiscussView}
                toReviseView={toReviseView}
                completedView={completedView}
                onOpenHidden={handleOpenHiddenView}
                onOpenFavorites={handleOpenFavoritesView}
                onOpenToDiscuss={handleOpenToDiscussView}
                onOpenToRevise={handleOpenToReviseView}
                onOpenCompleted={handleOpenCompletedView}
                soundAlerts={!embeddedReaderMode}
                statusSoundOwner={activityOwnsBackgroundStatusSounds ? "activity" : "chat"}

                refreshKey={refreshKey}
                viewedAtBySession={activityViewedAt}
                onViewedAtChange={mergeActivityViewedAt}
                leadingControl={sessionControlPlacement === "activity-toolbar" ? renderLayoutControl("sessions", "sidebar") : undefined}
              />
            )}
            {sideBySideSidebarPanels && resourceToolbar}
          </div>
          {explorerSectionRendered && (
            <div style={{
              display: "flex",
              flexDirection: "column",
              flex: explorerSectionOpen ? "1 1 0" : "0 0 auto",
              minHeight: explorerSectionOpen ? 0 : undefined,
              overflow: "hidden",
              borderTop: readerMode || embeddedWorkspaceExplorerVisible || sideBySideSidebarPanels ? undefined : "1px solid var(--border)",
              width: sideBySideSidebarPanels ? `${sidebarResizer.width}px` : undefined,
              minWidth: sideBySideSidebarPanels ? `${sidebarResizer.width}px` : undefined,
            }}>
            <ExplorerSection
              t={translate}
              readerMode={readerMode}
              open={explorerSectionOpen}
              filePanelOpen={rightPanelOpen}
              cwd={activityExplorerCwd}
              remotePeer={activityExplorerContext?.deviceId ?? undefined}
              onEnsureOpen={ensureExplorerOpen}
              leadingControl={explorerSessionLeadingControl}
              folderControl={renderLayoutControl("explorer", "sidebar")}
              showSessionToggle={!readerMode && !activityWorkspaceActive && !isEmbeddedSessionOnly}
              sessionsOpen={sessionListOpen}
              onToggleSessions={handleSessionListToggle}
              onOpenFile={handleOpenFileFromExplorer}
              onPathRenamed={handleExplorerPathRenamed}
              activeFilePath={activeFilePath}
              externalRefreshKey={explorerRefreshKey}
              onRefresh={() => setExplorerRefreshKey((k) => k + 1)}
              onAtMention={handleAtMention}
              onAtMentions={handleAtMentions}
              contentStyle={explorerSectionOpen ? undefined : { maxHeight: "38vh" }}
            />
            </div>
          )}
        </div>
      ) : (
        <SessionSidebar
        selectedSessionId={selectedSession?.id ?? null}
        highlightedSessionId={talkMapSidebarSessionId}
        selectedSession={selectedSession}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
        initialSessionId={initialSessionId}
        skipInitialProjectSelection={initialNavigation.requestedCwd !== null}
        onInitialRestoreDone={handleInitialRestoreDone}
        refreshKey={refreshKey}
        onSessionDeleted={handleSessionDeleted}
        selectedCwd={manualFileContext?.cwd ?? selectedSession?.cwd ?? newSessionCwd ?? null}
        onCwdChange={handleCwdChange}
        onOpenFile={handleOpenFileFromExplorer}
        onPathRenamed={handleExplorerPathRenamed}
        activeFilePath={activeFilePath}
        filePanelOpen={rightPanelOpen}
        explorerRefreshKey={explorerRefreshKey}
        onExplorerRefresh={handleExplorerRefresh}
        onAtMention={handleAtMention}
        onAtMentions={handleAtMentions}
        readerMode={readerMode || isEmbeddedSessionOnly}
        preserveExplorerContextOnSessionSelect={Boolean(manualFileContext)}
        readerModeTransition={readerMode}
        controlledSessionsOpen={sessionListOpen}
        onSessionsOpenChange={setSessionListOpen}
        controlledExplorerOpen={sessionSidebarExplorerOpen}
        onExplorerOpenChange={setSessionSidebarExplorerOpen}
        explorerLeadingControl={sessionControlPlacement === "explorer-toolbar" ? renderLayoutControl("sessions", "sidebar") : undefined}
        reservedLeadingControl={reserveExplorerParentSessionSlot ? explorerSessionLeadingControl : renderLayoutControl("sessions", "sidebar")}
        folderControl={renderLayoutControl("explorer", "sidebar")}
        compactReaderMode={sidebarOnlyMode}
        runningSessionIds={runningSessionIds}
        />
      )}
      {!sideBySideSidebarPanels && resourceToolbar}
    </>
  );
  // 主区聊天窗口（聚合完整视图与本机视图共用一份 props，避免重复）。
  const topBarDeviceName = remoteSession ? remoteSession.device.name : localDeviceName ?? translate("remote.localDevice");
  const topBarProjectPath = remoteSession
    ? remoteSession.sessionInfo?.projectRoot ?? remoteSession.sessionInfo?.cwd ?? remoteSession.newSessionCwd
    : selectedSession?.projectRoot ?? selectedSession?.cwd ?? effectiveNewSessionCwd;
  const topBarProjectName = topBarProjectPath ? getFileName(topBarProjectPath) || topBarProjectPath : null;
  // 顶部状态栏会话名与左侧活动侧栏标题同源（sessionTitle 链）：
  // name（recap/自动命名标题）→ firstMessage 首行（第一个问题）→ 新建会话占位。
  // 只认 name 会在未命名会话上显示「新建会话」，与侧边栏标题不一致。
  const sessionTitleLike = (s: { name?: string | null; firstMessage?: string | null } | null | undefined, fallback: string) => {
    const name = s?.name?.trim();
    if (name) return name;
    const first = s?.firstMessage?.trim().split("\n")[0]?.slice(0, 100);
    if (first) return first;
    return fallback;
  };
  const topBarSessionName = remoteSession
    ? sessionTitleLike(remoteSession.sessionInfo, remoteSession.newSessionCwd ? translate("sessionActivity.newSessionIn", { path: remoteSession.newSessionCwd }) : translate("sessionActivity.newSession"))
    : sessionTitleLike(selectedSession, effectiveNewSessionCwd ? translate("sessionActivity.newSessionIn", { path: effectiveNewSessionCwd }) : translate("sessionActivity.newSession"));
  // 顶部会话状态栏复用会话详情预览；Map 注入入口使用同一份 recap 内容。
  const topBarSessionId = remoteSession ? remoteSession.sessionInfo?.id ?? null : selectedSession?.id ?? null;
  const topBarSessionPeer = remoteSession?.device.id ?? undefined;
  const activeSessionPeer = topBarSessionPeer ?? null;
  if (activeTopBarIdentityRef.current.sessionId !== topBarSessionId || activeTopBarIdentityRef.current.peer !== activeSessionPeer) {
    activeTopBarIdentityRef.current = {
      sessionId: topBarSessionId,
      peer: activeSessionPeer,
      generation: activeTopBarIdentityRef.current.generation + 1,
    };
  }
  const activeSessionGeneration = activeTopBarIdentityRef.current.generation;
  const sessionStats = sessionStatsSnapshot?.sessionId === topBarSessionId
    && sessionStatsSnapshot.peer === activeSessionPeer
    && sessionStatsSnapshot.generation === activeSessionGeneration
    ? sessionStatsSnapshot.stats
    : null;
  const liveContextUsage = liveContextUsageSnapshot?.sessionId === topBarSessionId
    && liveContextUsageSnapshot.peer === activeSessionPeer
    && liveContextUsageSnapshot.generation === activeSessionGeneration
    ? liveContextUsageSnapshot.usage
    : null;
  const reportSessionStatsChange = useCallback((stats: SessionStatsInfo | null) => {
    handleSessionStatsChange(stats, topBarSessionId, activeSessionPeer, activeSessionGeneration);
  }, [activeSessionGeneration, activeSessionPeer, handleSessionStatsChange, topBarSessionId]);
  const reportContextUsageChange = useCallback((usage: { percent: number | null; contextWindow: number; tokens: number | null } | null) => {
    handleContextUsageChange(usage, topBarSessionId, activeSessionPeer, activeSessionGeneration);
  }, [activeSessionGeneration, activeSessionPeer, handleContextUsageChange, topBarSessionId]);
  const topBarSessionSourceDevice = remoteSession
    ? remoteSession.device.name
    : localDeviceId
      ? topBarDeviceName
      : localDeviceName ?? "本机";
  const topBarSessionInfoText = topBarSession ? buildTalkMapSourceInfo({
    sourceDevice: topBarSessionSourceDevice,
    sourceSessionId: topBarSession.id,
    sourceTitle: topBarSessionName,
    sourcePath: topBarSession.path,
    sourceProject: topBarProjectPath ?? "",
  }) : "";
  const topBarTalkMapLabel = topBarSessionId
    ? translate("talkMap.locateSession")
    : translate("talkMap.open");
  const handleTopBarTalkMap = useCallback(() => {
    if (!topBarProjectPath) return;
    const device = remoteSession?.device ?? (localDeviceId ? { id: localDeviceId, name: topBarDeviceName } : undefined);
    handleOpenTalkMapForSession(topBarProjectPath, device, topBarSessionId);
  }, [handleOpenTalkMapForSession, localDeviceId, remoteSession?.device, topBarDeviceName, topBarProjectPath, topBarSessionId]);
  const capabilityPath = topBarProjectPath ? apiPathForPeer(topBarSessionPeer ?? undefined, `worktrees?cwd=${encodeURIComponent(topBarProjectPath)}`) : null;
  const { activeWorktreeCapability, setWorktreeCapabilityRevision } = useAppShellWorktreeCapability(capabilityPath);
  const topBarIsGit = activeWorktreeCapability?.isGit === true;
  const handleTopBarWorktreeGraph = useCallback(() => {
    if (!topBarProjectPath) return;
    if (!topBarIsGit) { setWorktreeCapabilityRevision((value) => value + 1); return; }
    const device = remoteSession?.device ?? (localDeviceId ? { id: localDeviceId, name: topBarDeviceName } : undefined);
    openWorktreeGraph(topBarProjectPath, device, { id: topBarSession?.id ?? null, cwd: topBarSession?.cwd ?? null });
  }, [localDeviceId, openWorktreeGraph, remoteSession?.device, topBarDeviceName, topBarIsGit, topBarProjectPath, topBarSession?.cwd, topBarSession?.id]);
  const topBarSessionVersion = remoteSession ? remoteSession.sessionInfo?.modified ?? "" : selectedSession?.modified ?? "";
  const topBarDetails = useSessionDetails({
    sessionId: topBarSessionId,
    version: topBarSessionVersion,
    modelConfigRevision: modelsRefreshKey,
    peer: topBarSessionPeer,
    loadCost: Boolean(topBarSessionId),
    loadPreview: false,
  });
  const contextUsage = liveContextUsage ?? topBarDetails.cost?.contextUsage ?? sessionStats?.contextUsage ?? null;
  const handleTopBarInjectContext = useCallback(() => {
    if (!topBarSession) return;
    const device = remoteSession?.device ?? (localDeviceId ? { id: localDeviceId, name: topBarDeviceName } : undefined);
    handleTalkMapInjectContext(topBarSession, device);
  }, [handleTalkMapInjectContext, localDeviceId, remoteSession?.device, topBarDeviceName, topBarSession]);
  const handleTopBarCopySessionInfo = useCallback(() => {
    if (!topBarSession?.path || !topBarSessionInfoText) return;
    return handleCopySessionField("sourceInfo", topBarSessionInfoText).catch(() => {});
  }, [handleCopySessionField, topBarSession?.path, topBarSessionInfoText]);
  const sidekickButtonLabel = buildSidekickButtonLabel(sidekickCount, translate);
  // Historical top bar padding reference for regression tests: padding: "8px 14px 8px 8px"
  const sessionTopBar = (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 8,
      height: isMobile ? 44 : 36,
      minHeight: isMobile ? 44 : 36,
      boxSizing: "border-box",
      padding: isMobile ? "0 0 0 10px" : "0 0 0 8px",
      background: "var(--bg-panel)",
      borderBottom: "1px solid var(--border)",
      position: "relative",
      flexShrink: 0,
    }}>
      {topBarProjectPath && (
        <button type="button" onClick={handleTopBarTalkMap}
          title={topBarTalkMapLabel}
          aria-label={topBarTalkMapLabel}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 28, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <MapIcon size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {topBarSessionId && topBarProjectPath && (
        <button
          type="button"
          data-top-bar-inject-context
          onClick={handleTopBarInjectContext}
          title={translate("talkMap.injectContext")}
          aria-label={translate("talkMap.injectContext")}
          style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0, width: 28, height: 22, padding: 0, border: "1px solid var(--border)", borderRadius: 4, background: "var(--bg)", color: "var(--text-muted)", cursor: "pointer" }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
        >
          <FileInput size={14} strokeWidth={1.8} aria-hidden="true" />
        </button>
      )}
      {topBarSessionId && topBarSession?.path && (
        <SessionTopBarButton
          ariaLabel={copiedSessionField === "sourceInfo" ? translate("session.copied") : translate("session.copySourceInfo")}
          title={copiedSessionField === "sourceInfo" ? translate("session.copied") : translate("session.copySourceInfo")}
          onClick={handleTopBarCopySessionInfo}
          iconOnly
        >
          {copiedSessionField === "sourceInfo"
            ? <Check size={13} strokeWidth={2} aria-hidden="true" />
            : <Copy size={13} strokeWidth={1.8} aria-hidden="true" />}
        </SessionTopBarButton>
      )}
      <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{topBarDeviceName}</span>
      {topBarProjectName && (
        <>
          <span style={{ color: "var(--text-muted)" }}>·</span>
          <span style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{topBarProjectName}</span>
        </>
      )}
      <span style={{ color: "var(--text-muted)" }}>·</span>
      <span style={{ fontSize: 12, color: "var(--text-muted)", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={topBarSessionName}>
        {topBarSessionName}
      </span>
      {topBarSessionId && (
        <SessionWaitPanel
          key={`${topBarSessionPeer ?? "local"}:${topBarSessionId}`}
          sessionId={topBarSessionId}
          peerId={topBarSessionPeer}
          onOpenSession={handleOpenRelatedSession}
        />
      )}
      {topBarSession?.id && (selectionToolbar ? (
        <div style={{ display: "flex", alignItems: "center", gap: 6, height: "100%", paddingRight: 8, flexShrink: 0 }}>
          <SessionTopBarButton
            ariaLabel={translate("chat.askInCurrent")}
            title={translate("chat.askInCurrent")}
            onClick={selectionToolbar.askCurrent}
            tone="accent"
            compact={isMobile}
          >
            <span style={{ fontSize: 15 }} aria-hidden="true">@</span>
            {!isMobile && <span>{translate("chat.askInCurrent")}</span>}
          </SessionTopBarButton>
          <SessionTopBarButton
            ariaLabel={translate("chat.askInSidekick")}
            title={translate("chat.askInSidekick")}
            onClick={selectionToolbar.askSidekick}
            sidekickInteraction
            compact={isMobile}
          >
            <GitFork size={14} strokeWidth={1.8} aria-hidden="true" />
            {!isMobile && <span>{translate("chat.askInSidekick")}</span>}
          </SessionTopBarButton>
          <SessionTopBarButton
            ariaLabel={translate("i18n.close")}
            title={translate("i18n.close")}
            onClick={selectionToolbar.dismiss}
            iconOnly
          >
            <X size={14} strokeWidth={1.8} aria-hidden="true" />
          </SessionTopBarButton>
        </div>
      ) : (
        <div
          id={SIDEKICK_TOPBAR_PORTAL_ID}
          data-sidekick-interaction="true"
          style={{
            display: "flex",
            alignItems: "center",
            height: "100%",
            flexShrink: 0,
            ...(sidekickOpen ? {
              width: isMobile ? "100%" : 410,
              maxWidth: isMobile ? "100vw" : "94vw",
              boxSizing: "border-box",
              borderLeft: "1px solid var(--border)",
              background: "var(--bg-panel)",
            } : {}),
          }}
        >
          {!sidekickOpen && (
            <SessionTopBarButton
              ariaLabel={sidekickButtonLabel}
              title={`${sidekickButtonLabel} (Cmd+J)`}
              onClick={toggleSidekick}
              active={sidekickOpen}
              sidekickInteraction
              iconOnly
              borderless
            >
              <SidekickMessageIcon count={sidekickCount} />
            </SessionTopBarButton>
          )}
        </div>
      ))}
    </div>
  );

  const chatWindowContent = showChat ? (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      {sessionTopBar}
      <div style={{ flex: 1, minHeight: 0 }}>
    <ChatWindow
      key={sessionKey}
      session={selectedSession}
      deviceName={localDeviceName ?? undefined}
      onOpenRelatedSession={handleOpenRelatedSession}
      sessionRunning={Boolean(selectedSession && runningSessionIds.has(selectedSession.id))}
      newSessionCwd={effectiveNewSessionCwd}
      newSessionSubprojectId={effectiveNewSessionSubprojectId}
      newSessionContextSourceId={effectiveNewSessionCwd ? pendingContextSourceSessionId : null}
      newSessionWorktreeBinding={effectiveNewSessionCwd ? newSessionWorktreeBinding : null}
      newSessionPrefill={newSessionPrefill}
      newSessionDraftKey={newSessionDraftKey}
      onAgentEnd={() => handleAgentEnd()}
      onAttentionNeeded={(request) => handleAttentionNeeded(request, selectedSession)}
      onSessionCreated={handleSessionCreated}
      onSessionForked={handleSessionForked}
      restoreMessage={pendingRestoreMessage}
      onRestoreMessageApplied={handleRestoreMessageApplied}
      modelsRefreshKey={modelsRefreshKey}
      chatInputRef={chatInputRef}
      onChatInputReady={handleChatInputReady}
      onBranchDataChange={handleBranchDataChange}
      onOpenSettings={handleOpenSettings}
      sidekickOpen={sidekickOpen}
      onToggleSidekick={toggleSidekick}
      sidekickRightPanelOpen={sidekickRightPanelOpen}
      onCloseSidekickRightPanel={closeSidekickRightPanel}
      onSidekickCountChange={setSidekickCount}
      onSelectionToolbarChange={topBarSessionId ? handleSelectionToolbarChange : undefined}
      onSystemPromptChange={handleSystemPromptChange}
      onSystemToolsChange={handleSystemToolsChange}
      onRuntimeInspectionChange={handleRuntimeInspectionChange}
      onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
      onSessionStatsChange={reportSessionStatsChange}
      sessionStatsRefreshRef={sessionStatsRefreshRef}
      onSessionStatsPanelOpen={openSessionStatsPanel}
      highlightTerm={highlightTerm}
      onContextUsageChange={reportContextUsageChange}
      onOpenFile={handleOpenLinkedFile}
      soundEnabled={soundEnabled}
      onSoundToggle={onSoundToggle}
      playDoneSound={playDoneSound}
      canPlaySound={canPlaySound}
      unlockAudio={unlockAudio}
      statusSoundOwner={activityOwnsBackgroundStatusSounds ? "activity" : "chat"}
      suppressStatusSounds={isSubagentSession(selectedSession)}
    />
      </div>
    </div>
  ) : null;

  useEffect(() => {
    if (embeddedReaderMode || !BUILT_READER_BUILD_ID) return;
    const source = openReaderEventSource(["runtime_identity"]);
    source.onmessage = ({ data }) => {
      try {
        const identity = JSON.parse(data) as { buildId?: string; readerCommit?: string; channel?: string };
        if (identity.buildId && identity.buildId !== BUILT_READER_BUILD_ID) {
          setReaderUpdate({ version: identity.readerCommit || identity.buildId, channel: identity.channel });
        }
      } catch { /* Invalid identity cannot authorize a refresh. */ }
    };
    return () => source.close();
  }, [embeddedReaderMode]);

  useEffect(() => {
    if (typeof window === "undefined" || embeddedReaderMode || !BUILT_READER_BUILD_ID) return;
    let cancelled = false;
    const check = async () => {
      try {
        const response = await fetch("/api/reader/build", { cache: "no-store" });
        // 204: an ordinary install has no managed build identity to compare.
        if (!response.ok || response.status === 204) return;
        const current = await response.json() as { buildId?: string; readerCommit?: string; channel?: string };
        if (!cancelled && current.buildId && current.buildId !== BUILT_READER_BUILD_ID) {
          setReaderUpdate({ version: current.readerCommit || current.buildId, channel: current.channel });
        }
      } catch { /* A disconnected Reader keeps the current page and its draft. */ }
    };
    void check();
    const interval = window.setInterval(() => void check(), 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", check);
    };
  }, [embeddedReaderMode]);

  useEffect(() => {
    if (!readerUpdate) return;
    const maybeRefresh = () => {
      if (canRefreshPreview(document, {
        hidden: document.visibilityState === "hidden",
        sessionOpen: Boolean(selectedSession || remoteSession || embeddedReaderUrl),
        pending: Boolean(newSessionCwd || pendingRestoreMessage || activeNewSessionDraftKeyRef.current
          || remoteNewSessionDraftKeyRef.current || pendingTalkMapGhostConversionRef.current
          || pendingEmbeddedNewSessionRef.current || pendingAgentSelectionRef.current
          || hasMemoryDraftContent() || chatInputRef.current?.hasRefreshRisk()
          || terminalTabs.length || pendingRemoteMutations.length || mutationRecoveryBusy),
        dirtyFileTabs: fileTabs.some((tab) => tab.dirty),
      })) window.location.reload();
    };
    maybeRefresh();
    const interval = window.setInterval(maybeRefresh, 5_000);
    return () => window.clearInterval(interval);
  }, [readerUpdate, selectedSession, remoteSession, embeddedReaderUrl, newSessionCwd, pendingRestoreMessage, fileTabs, terminalTabs, pendingRemoteMutations, mutationRecoveryBusy]);

  const worktreeGraphCurrentPath = remoteSession?.sessionInfo?.cwd
    ?? remoteSession?.newSessionCwd
    ?? remoteSession?.sessionInfo?.projectRoot
    ?? selectedSession?.cwd
    ?? selectedSession?.projectRoot
    ?? newSessionCwd
    ?? null;
  worktreeCallbacksRef.current = {
    handleSelectSession,
    openRemoteSession,
    loadLocalSession,
    invalidateWorkspaceRestore,
    handleNewActivitySession,
    handleSessionDeleted,
    mutateRemoteSession,
    handleCwdChange,
    bumpRefresh: () => setRefreshKey((key) => key + 1),
    applyTalkMapRestoreMessage: (message) => setPendingRestoreMessage(message),
  };
  const mutationRecoveryVisible = pendingRemoteMutations.length > 0
    || Boolean(mutationRecoveryOpen && (remoteMutationNotice || mutationRecoveryBusy));

  return (
    <>
    <style>{`
      @keyframes session-info-pop {
        0% {
          opacity: 0;
          transform: translateY(-24px);
          filter: blur(6px);
          box-shadow: 0 2px 8px rgba(0,0,0,0);
        }
        55% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: color-mix(in srgb, var(--accent) 8%, var(--bg-panel));
          box-shadow: 0 18px 44px rgba(37,99,235,0.16);
        }
        100% {
          opacity: 1;
          transform: translateY(0);
          filter: blur(0);
          background: var(--bg-panel);
          box-shadow: 0 10px 28px rgba(0,0,0,0.10);
        }
      }
      @keyframes session-info-light-wash {
        0% {
          opacity: 0;
          transform: translateX(-110%) skewX(-16deg);
        }
        24% {
          opacity: 0.42;
        }
        100% {
          opacity: 0;
          transform: translateX(115%) skewX(-16deg);
        }
      }
      .session-info-popover {
        position: relative;
        overflow: hidden;
        transform-origin: top right;
        animation: session-info-pop 360ms ease-out both;
        will-change: transform, opacity, filter, background, box-shadow;
      }
      .session-info-popover::after {
        content: "";
        position: absolute;
        top: 0;
        bottom: 0;
        left: 0;
        width: 44%;
        pointer-events: none;
        background: linear-gradient(90deg, transparent, color-mix(in srgb, var(--accent) 24%, transparent), transparent);
        animation: session-info-light-wash 620ms ease-out both;
      }
      @media (prefers-reduced-motion: reduce) {
        .session-info-popover,
        .session-info-popover::after {
          animation: none;
        }
      }
      .mobile-session-stats {
        container-type: inline-size;
      }
      @container (max-width: 158px) {
        .mobile-session-stat-io {
          display: none !important;
        }
      }
      @container (max-width: 88px) {
        .mobile-session-stat-cost {
          display: none !important;
        }
      }
      @media (max-width: 640px) {
        .sidebar-overlay-backdrop.sidebar-mobile-pending {
          opacity: 0 !important;
          pointer-events: none !important;
        }
        .sidebar-container.sidebar-mobile-pending.sidebar-open {
          transform: translateX(calc(-100% - env(safe-area-inset-left)));
          box-shadow: none;
        }
      }
    `}</style>
    {/* Recovery stays in flow when it needs user attention. */}
    <div className="app-viewport" style={{
      display: "flex", flexDirection: "column", width: "100%",
      height: "var(--app-viewport-height, 100dvh)", minHeight: 0, overflow: "hidden",
    }}>
    <div
      className={`app-shell${readerMode ? " layout-reader" : ""}`}
      style={{
        display: "flex",
        width: "100%",
        flex: 1,
        minHeight: 0,
        paddingLeft: "env(safe-area-inset-left)",
        paddingRight: "env(safe-area-inset-right)",
        overflow: "hidden",
        background: "var(--bg)",
      }}
    >
      {readerUpdate && !embeddedReaderMode && (
        <div role="status" aria-live="polite" style={{ position: "fixed", top: 12, right: 12, zIndex: 500,
          padding: "8px 12px", borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)",
          border: "1px solid var(--border)", boxShadow: "0 6px 24px rgba(0,0,0,.14)" }}>
          {translate(readerUpdate.channel === "production" ? "reader.productionUpdateAvailable"
            : readerUpdate.channel === "preview" ? "reader.previewUpdateAvailable" : "reader.updateAvailable")}
          <button type="button" onClick={() => {
            const risk = hasRefreshRisk(document, {
              pending: Boolean(pendingRestoreMessage || pendingAgentSelectionRef.current
                || pendingTalkMapGhostConversionRef.current || pendingEmbeddedNewSessionRef.current
                || hasMemoryDraftContent() || chatInputRef.current?.hasRefreshRisk()
                || terminalTabs.length || pendingRemoteMutations.length || mutationRecoveryBusy),
              dirtyFileTabs: fileTabs.some((tab) => tab.dirty),
            });
            if (!risk || window.confirm(translate("reader.refreshConfirm"))) window.location.reload();
          }} style={{ marginLeft: 8, color: "var(--accent)" }}>
            {translate("reader.refreshNow")}
          </button>
        </div>
      )}
      {/* Mobile overlay backdrop */}
      <div
        className={`sidebar-overlay-backdrop${mobileSidebarReady ? "" : " sidebar-mobile-pending"}`}
        onClick={() => setSidebarOpen(false)}
        style={{
          position: "fixed",
          inset: 0,
          zIndex: 199,
          background: "rgba(0,0,0,0.4)",
          opacity: embeddedLeftSlotState.mobileBackdropVisible ? 1 : 0,
          pointerEvents: embeddedLeftSlotState.mobileBackdropVisible ? "auto" : "none",
          transition: "opacity 0.25s ease",
        }}
      />

      {/* Left sidebar */}
      <div
        ref={sidebarResizer.panelRef}
        id="session-sidebar"
        className={`sidebar-container${sidebarShellOpen ? " sidebar-open" : " sidebar-closed"}${mobileSidebarReady ? "" : " sidebar-mobile-pending"}${sidebarResizer.isResizing ? " sidebar-resizing" : ""}`}
        style={{
          "--sidebar-width": `${sideBySideSidebarPanels ? sidebarResizer.width * 2 : sidebarResizer.width}px`,
          background: "var(--bg-panel)",
          borderRight: "1px solid var(--border)",
          display: "flex",
          flexDirection: "column",
          flexShrink: 0,
          paddingTop: "env(safe-area-inset-top)",
          paddingBottom: "env(safe-area-inset-bottom)",
          // Stay above the compact right-panel backdrop (240), while the panel itself (250) remains on top.
          zIndex: 245,
          ...(chatOnlyMode ? { display: "none" } : {}),
          ...(sidebarOnlyMode ? { "--sidebar-width": "100%" } : {}),
          ...(embeddedTalkMapOpen ? { display: "none" } : {}),
          ...(embeddedExplorerOwnsLeftLayout ? {
            display: "none",
            width: 0,
            minWidth: 0,
            borderRight: "none",
          } : {}),
          ...(shouldShowEmbeddedDeviceSwitch({
            embeddedDeviceWorkspaceActive,
            readerMode,
            isMobile,
            takesLeftLayout: embeddedExplorerTakesLeftLayout,
          }) ? {
            display: embeddedModalKind === "talk-map" || embeddedFileViewerOpen ? "none" : "flex",
            position: "absolute",
            top: 0,
            left: 0,
            "--sidebar-width": activityDeviceOverlayWidth,
            width: activityDeviceOverlayWidth,
            minWidth: activityDeviceOverlayWidth,
            height: "38px",
            paddingTop: 0,
            paddingBottom: 0,
            background: "transparent",
            borderRight: "none",
            pointerEvents: "auto",
            zIndex: 300,
          } : {}),
          ...(mobileFullDeviceSelectorVisible ? {
            display: "flex",
            position: "fixed",
            top: 0,
            left: "env(safe-area-inset-left)",
            "--sidebar-width": activityDeviceOverlayWidth,
            width: activityDeviceOverlayWidth,
            minWidth: activityDeviceOverlayWidth,
            height: "38px",
            paddingTop: 0,
            paddingBottom: 0,
            background: "transparent",
            borderRight: "none",
            pointerEvents: "auto",
            transform: "none",
            boxShadow: "none",
            zIndex: 300,
          } : {}),
        } as React.CSSProperties}
      >
        {sidebarContent}
      </div>
      {sessionControlPlacement === "embedded-overlay" && (
        <div
          data-layout-control-group="embedded-overlay"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            zIndex: 320,
            display: "flex",
            alignItems: "center",
            height: isMobile ? "calc(44px + env(safe-area-inset-top))" : "calc(36px + env(safe-area-inset-top))",
            paddingTop: "env(safe-area-inset-top)",
            boxSizing: "border-box",
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
          }}
        >
          {renderLayoutControl("sessions", "top")}
        </div>
      )}
      {embeddedDeviceWorkspaceActive && !isMobile && (
        (embeddedModalOpen && embeddedModalKind !== "talk-map" && embeddedModalKind !== "image-preview") || embeddedFileViewerOpen
      ) && (
        <div
          data-embedded-modal-shield
          aria-hidden="true"
          style={{
            position: "fixed",
            top: 0,
            left: 0,
            width: activityDeviceShieldWidth,
            height: "38px",
            zIndex: 310,
            background: "rgba(0,0,0,0.35)",
            pointerEvents: "auto",
          }}
        />
      )}
      {sidebarShellOpen && !mobileFullDeviceSelectorVisible && !chatOnlyMode && (!embeddedDeviceWorkspaceActive || readerMode) && !embeddedTalkMapOpen && (
        <div
          {...sidebarResizer.separatorProps}
          aria-controls="session-sidebar"
          className={`panel-resize-handle sidebar-resize-handle${sidebarResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="sidebar"
          title={`${translate("layout.resizeSidebar")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Center: chat — mobile always keeps shell; desktop reader can hide it */}
      <div
        className={`chat-panel-container${chatOpen ? " chat-panel-open" : " chat-panel-closed"}`}
        style={{
          flex: chatOpen ? 1 : "0 0 0",
          display: chatOpen ? "flex" : "none",
          flexDirection: "column",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {/* Top bar layout controls: A sessions, B explorer, C Reader. */}
        <div ref={topBarRef} className="app-top-bar" style={{ display: embeddedReaderUrl ? "none" : "flex", alignItems: "center", flexShrink: 0, borderBottom: "1px solid var(--border)", height: isMobile ? "calc(44px + env(safe-area-inset-top))" : "calc(36px + env(safe-area-inset-top))", paddingTop: "env(safe-area-inset-top)", background: "var(--bg-panel)" }}>
          <div
            data-layout-control-group="leading"
            style={{ display: "flex", alignItems: "center", flexShrink: 0 }}
          >
            {reserveParentSessionControlSlot && (
              <div
                data-layout-control-reserved="sessions"
                aria-hidden="true"
                style={{
                  width: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
                  minWidth: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
                  height: isMobile ? 44 : TOP_BAR_ICON_BUTTON_SIZE,
                  borderRight: "1px solid var(--border)",
                  flexShrink: 0,
                }}
              />
            )}
            {sessionControlPlacement === "top-bar" && renderLayoutControl("sessions", "top")}
            {renderLayoutControl("explorer", "top")}
            {renderLayoutControl("reader", "top")}
          </div>
          <button
            onClick={(e) => {
              const rect = e.currentTarget.getBoundingClientRect();
              toggleTheme({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 });
            }}
            title={translate(themeLabelKey)}
            aria-label={translate(themeLabelKey)}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderRight: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
          >
            {preference === "auto" ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="20" height="14" rx="2" />
                <line x1="8" y1="21" x2="16" y2="21" />
                <line x1="12" y1="17" x2="12" y2="21" />
              </svg>
            ) : isDark ? (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
              </svg>
            ) : (
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <circle cx="12" cy="12" r="5" />
                <line x1="12" y1="1" x2="12" y2="3" /><line x1="12" y1="21" x2="12" y2="23" />
                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" /><line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
                <line x1="1" y1="12" x2="3" y2="12" /><line x1="21" y1="12" x2="23" y2="12" />
                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" /><line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
              </svg>
            )}
           </button>
           <button
             type="button"
             onClick={handleActivityButtonClick}
             title={translate("sessionActivity.buttonHint")}
             aria-label={translate("sessionActivity.buttonHint")}
             aria-haspopup="dialog"
             aria-expanded={activeTopPanel === "activity"}
             style={{
               display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
               height: TOP_BAR_ICON_BUTTON_SIZE, padding: isMobile ? 0 : "0 10px",
               minWidth: isMobile ? TOP_BAR_ICON_BUTTON_SIZE : undefined,
               background: activeTopPanel === "activity" ? "var(--bg-selected)" : "none",
               border: "none", borderRight: "1px solid var(--border)",
               color: activeTopPanel === "activity" ? "var(--accent)" : "var(--text-muted)",
               cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
             }}
             onMouseEnter={(e) => { e.currentTarget.style.color = activeTopPanel === "activity" ? "var(--accent)" : "var(--text)"; }}
             onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "activity" ? "var(--accent)" : "var(--text-muted)"; }}
           >
             <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
               <path d="M3 12h4l3-8 4 16 3-8h4" />
             </svg>
             {!isMobile && <span style={{ fontSize: 11 }}>{translate("sessionActivity.title")}</span>}
           </button>
           {showChat && projectTrust?.requiresTrust && !projectTrust.trusted && (
            <button
              type="button"
              onClick={() => {
                setProjectTrustError(null);
                setProjectTrustDialogOpen(true);
              }}
              title={translate("trust.resourcesNotLoaded")}
              aria-label={translate("trust.resourcesNotLoaded")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                height: "100%",
                padding: isMobile ? "0 10px" : "0 12px",
                background: "none",
                border: "none",
                borderRight: "1px solid var(--border)",
                color: "#d97706",
                cursor: "pointer",
                flexShrink: 0,
                fontSize: 11,
                whiteSpace: "nowrap",
              }}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" />
                <path d="M12 8v4" />
                <path d="M12 16h.01" />
              </svg>
              {!isMobile && <span>{translate("trust.resourcesNotLoaded")}</span>}
            </button>
          )}
          {topBarSessionActive && (
            <div style={{ display: "flex", alignItems: "stretch", height: "100%" }}>
              {(() => {
                const hasMessages = Boolean(
                  topBarSession
                  && (sessionStats?.userMessages ?? topBarSession.messageCount) > 0,
                );
                const disabled = !topBarSession || topBarSession.transient || !hasMessages || autoNameStatus.kind === "naming";
                const isSuccess = autoNameStatus.kind === "success";
                const isError = autoNameStatus.kind === "error";
                const label = autoNameStatus.kind === "naming"
                   ? translate("title.generating")
                    : isSuccess
                    ? translate("title.updated")
                    : isError
                      ? translate("title.failed")
                      : translate("title.generate");
                const title = !topBarSession
                   ? translate("title.unsaved")
                   : !hasMessages
                     ? translate("title.noMessages")
                     : isError
                       ? autoNameStatus.message
                       : translate("title.generateSession");

                return (
                  <button
                    type="button"
                    onClick={() => void handleAutoName()}
                    disabled={disabled}
                    title={title}
                    aria-label={label}
                    style={{
                      display: "none", alignItems: "center", gap: 6,
                      height: "100%", padding: "0 12px",
                      background: "none", border: "none",
                      borderTop: "2px solid transparent",
                      borderRight: "1px solid var(--border)",
                      color: isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)",
                      cursor: disabled ? "not-allowed" : "pointer",
                      opacity: disabled && autoNameStatus.kind !== "naming" ? 0.45 : 1,
                      flexShrink: 0, fontSize: 11, whiteSpace: "nowrap",
                      transition: "color 0.1s, background 0.1s, opacity 0.1s",
                    }}
                    onMouseEnter={(e) => {
                      if (disabled) return;
                      e.currentTarget.style.color = isError ? "#dc2626" : "var(--text)";
                      e.currentTarget.style.background = "var(--bg-hover)";
                    }}
                    onMouseLeave={(e) => {
                      e.currentTarget.style.color = isError ? "#dc2626" : isSuccess ? "var(--accent)" : disabled ? "var(--text-dim)" : "var(--text-muted)";
                      e.currentTarget.style.background = "none";
                    }}
                  >
                    {autoNameStatus.kind === "naming" ? (
                      <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                        <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
                        <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                      </svg>
                    ) : isSuccess ? (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    ) : (
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                        <path d="m15 4 5 5L7 22l-5-5Z" />
                        <path d="m14 5 5 5" />
                        <path d="M6 4V2M5 3H3M19 19v3M17.5 20.5h3" />
                      </svg>
                    )}
                    {!isMobile && <span>{label}</span>}
                  </button>
                );
              })()}
              {topBarProjectPath && topBarIsGit && (
                <button
                  type="button"
                  data-top-bar-worktree-graph="true"
                  onClick={handleTopBarWorktreeGraph}
                  title={translate("worktreeGraph.open")}
                  aria-label={translate("worktreeGraph.open")}
                  aria-haspopup="dialog"
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    height: "100%",
                    padding: "0 12px",
                    background: "none",
                    border: "none",
                    borderTop: "2px solid transparent",
                    borderRight: "1px solid var(--border)",
                    color: "var(--text-muted)",
                    cursor: "pointer",
                    flexShrink: 0,
                    fontSize: 11,
                    whiteSpace: "nowrap",
                    transition: "color 0.1s, background 0.1s",
                  }}
                  onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                  onMouseLeave={(e) => { e.currentTarget.style.color = "var(--text-muted)"; }}
                >
                  <GitFork size={12} strokeWidth={1.8} aria-hidden="true" style={{ color: "var(--accent)", flexShrink: 0 }} />
                  {!isMobile && <span>{translate("worktreeGraph.open")}</span>}
                </button>
              )}
              <AppShellWorktreeBranchNavigator
                tree={branchTree}
                activeLeafId={branchActiveLeafId}
                onLeafChange={handleBranchLeafChange}
                locked={branchSwitchLocked}
                inline
                compact={isMobile}
                open={activeTopPanel === "branches"}
                onToggle={() => toggleTopPanel("branches")}
                hasSession={Boolean(topBarSession)}
                hideInlineButton={!topBarSession}
              />
              <button
                ref={systemBtnRef}
                type="button"
                onClick={() => handleSystemInfoToggle("system", mobile)}
                disabled={mobile && !showChat}
                title={translate("system.prompt")}
                aria-label={translate("system.prompt")}
                aria-pressed={activeTopPanel === "system"}
                style={{
                  display: "flex", alignItems: "center", gap: 6,
                  height: "100%", padding: "0 12px",
                  background: activeTopPanel === "system" ? "var(--bg-selected)" : "none",
                  border: "none",
                  borderTop: activeTopPanel === "system" ? "2px solid var(--accent)" : "2px solid transparent",
                  borderRight: "1px solid var(--border)",
                  cursor: "pointer",
                  color: activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)",
                  fontSize: 11, whiteSpace: "nowrap", transition: "color 0.1s, background 0.1s",
                }}
                onMouseEnter={(e) => { e.currentTarget.style.color = "var(--text)"; }}
                onMouseLeave={(e) => { e.currentTarget.style.color = activeTopPanel === "system" ? "var(--text)" : "var(--text-muted)"; }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ color: systemPrompt ? "var(--accent)" : "var(--text-dim)", flexShrink: 0 }}>
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                  <line x1="8" y1="13" x2="16" y2="13" />
                  <line x1="8" y1="17" x2="13" y2="17" />
                </svg>
                 {!isMobile && <span>{translate("system.label")}</span>}
              </button>
            </div>
          )}
          {/* Keep cost, cache-hit rate, and context usage in the top bar; input/output/cache-read counts stay in the expanded panel. */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", height: "100%", flexShrink: 0 }}>
            <SessionTopBarStats
              sessionActive={topBarSessionActive}
              sessionStats={sessionStats}
              contextUsage={contextUsage}
              active={activeTopPanel === "session"}
              onOpen={handleSessionStatsButtonClick}
            />
            <BatchContinueButton />
            {/* Scheme A: fixed right panel toggle always anchored in top-right */}
            {renderLayoutControl("document", "top")}
          </div>
          {/* Top panel dropdown — shared, only one active at a time */}
          {activeTopPanel && topPanelPos && typeof document !== "undefined" && createPortal((
            <div ref={topPanelRef} style={{
              position: "fixed",
              top: topPanelPos.top,
              left: topPanelPos.left,
              width: topPanelPos.width,
              height: activeTopPanel === "activity" ? `calc(100dvh - ${topPanelPos.top}px)` : undefined,
              maxHeight: activeTopPanel === "activity" ? undefined : `calc(100dvh - ${topPanelPos.top}px)`,
              overflow: activeTopPanel === "activity" ? "hidden" : "auto",
              zIndex: 500,
            }}>
              {activeTopPanel === "activity" && (
                <div
                  style={{
                    height: "100%",
                    minHeight: 0,
                    display: "flex",
                    flexDirection: "column",
                    background: "var(--bg-panel)",
                    color: "var(--text)",
                    borderLeft: "1px solid var(--border)",
                    borderRight: "1px solid var(--border)",
                    borderBottom: "1px solid var(--border)",
                    boxShadow: "0 10px 28px color-mix(in srgb, var(--text) 10%, transparent)",
                  }}
                >
                  <div style={{ flex: 1, minHeight: 0 }}>
                  <SessionActivityPanel onOpenSession={handleOpenActivitySession} onProjectCwdChange={handleActivityProjectCwdChange}
                onProjectRemoved={handleActivityProjectRemoved} onNewSession={handleNewActivitySession} onOpenWorktreeGraph={handleOpenWorktreeGraph} onOpenTalkMapForSession={handleActivityTalkMap} onInjectContext={handleActivityInjectContext} onCopySessionInfo={handleActivityCopySessionInfo} onSessionDeleted={handleSessionDeleted} onActivityDeviceFilterChange={!embeddedReaderMode ? handleActivityDeviceFilterChange : undefined} activityScope={embeddedReaderMode ? "local" : hiddenView ? "hidden" : favoritesView ? "favorites" : "all"} hiddenView={hiddenView} favoriteView={favoritesView} toDiscussView={toDiscussView} toReviseView={toReviseView} completedView={completedView} onOpenHidden={handleOpenHiddenView} onOpenFavorites={handleOpenFavoritesView} onOpenToDiscuss={handleOpenToDiscussView} onOpenToRevise={handleOpenToReviseView} onOpenCompleted={handleOpenCompletedView} refreshKey={refreshKey} viewedAtBySession={activityViewedAt} onViewedAtChange={mergeActivityViewedAt} focusSessionId={activeActivitySessionId} focusSessionKey={activeActivitySessionKey} highlightedSessionId={talkMapSidebarSessionId} remotePeer={activePeerId} soundAlerts={!embeddedReaderMode} statusSoundOwner={activityOwnsBackgroundStatusSounds ? "activity" : "chat"} />
                  </div>
                  <SessionWaitHistory onOpenSession={handleOpenRelatedSession} />
                </div>
              )}
              {activeTopPanel === "agents" && topBarSessionId && localDeviceId && (
                <AgentFamilyMenu
                  key={`${topBarPeer ?? localDeviceId}:${topBarSessionId}:${Boolean(topBarSession?.archived)}:${hiddenView}`}
                  sessionId={topBarSessionId}
                  deviceId={topBarPeer ?? localDeviceId}
                  peer={topBarPeer}
                  includeHidden={hiddenView}
                  archived={Boolean(topBarSession?.archived)}
                  onSelectSession={(item) => handleOpenActivitySession({
                    ...item,
                    device: remoteSession?.device.id === item.device.id ? { ...item.device, ...remoteSession.device } : item.device,
                  }, undefined, item.device.id)}
                />
              )}
              {activeTopPanel === "branches" && (
                <AppShellWorktreeBranchPanel
                  tree={branchTree}
                  activeLeafId={branchActiveLeafId}
                  onLeafChange={handleBranchLeafChange}
                  onToggle={() => toggleTopPanel("branches")}
                  locked={branchSwitchLocked}
                  hasSession={Boolean(topBarSession)}
                />
              )}
              {activeTopPanel === "system" && (
                runtimeInspection ? (
                  <SystemPromptInspector
                    prompt={systemPrompt}
                    inspection={runtimeInspection}
                    tools={systemTools}
                  />
                ) : (
                  <SystemPromptPanel
                    loading={systemInfoLoading}
                    prompt={systemPrompt}
                    translate={translate}
                  />
                )
              )}
              {activeTopPanel === "session" && (
                <div className="session-info-popover" style={{
                  background: "var(--bg-panel)",
                  borderBottom: "1px solid var(--border)",
                  boxShadow: "0 10px 28px rgba(0,0,0,0.10)",
                  padding: "12px 16px",
                }}>
                  {sessionStats ? (() => {
                    const workspaceSession = topBarSession;
                    const projectRows = workspaceSession ? [
                      { label: translate("session.projectDir"), value: workspaceSession.projectRoot ?? workspaceSession.cwd, copyField: "projectDir" as const },
                      ...(workspaceSession.branch ? [{ label: translate("session.gitBranch"), value: workspaceSession.branch, copyField: "gitBranch" as const }] : []),
                      ...(workspaceSession.isWorktree ? [{ label: translate("session.gitWorktree"), value: workspaceSession.cwd, copyField: "gitWorktree" as const }] : []),
                    ] : [];
                    const formatMetricNumber = (n: number) => formatMetricNumberValue(n, locale);
                    const sessionRows = [
                       ...(sessionStats.sessionName ? [{ label: translate("session.name"), value: sessionStats.sessionName, copyField: null }] : []),
                       { label: translate("session.file"), value: sessionStats.sessionFile ?? translate("session.inMemory"), copyField: sessionStats.sessionFile ? ("file" as const) : null },
                       { label: translate("session.id"), value: sessionStats.sessionId, copyField: "id" as const },
                    ];
                    const messageDetailRows = [
                       { label: translate("session.user"), value: formatMetricNumber(sessionStats.userMessages), raw: sessionStats.userMessages },
                       { label: translate("session.assistant"), value: formatMetricNumber(sessionStats.assistantMessages), raw: sessionStats.assistantMessages },
                       { label: translate("session.toolCalls"), value: formatMetricNumber(sessionStats.toolCalls), raw: sessionStats.toolCalls },
                       { label: translate("session.toolResults"), value: formatMetricNumber(sessionStats.toolResults), raw: sessionStats.toolResults },
                    ];
                    const resourceSection = (
                      <SessionInfoResourcePanel
                        sessionStats={sessionStats}
                        contextUsage={contextUsage}
                        expandedCostModels={expandedCostModels}
                        toggleCostModels={toggleCostModels}
                      />
                    );
                    const copyTitleKey: Record<SessionCopyField, string> = {
                      file: "session.copyFile",
                      id: "session.copyId",
                      sourceInfo: "session.copySourceInfo",
                      projectDir: "session.copyProjectDir",
                      gitBranch: "session.copyGitBranch",
                      gitWorktree: "session.copyGitWorktree",
                    };
                    const copyButton = (field: SessionCopyField, value: string) => {
                      const copied = copiedSessionField === field;
                      return (
                        <button
                          type="button"
                          title={copied ? translate("session.copied") : translate(copyTitleKey[field])}
                          onClick={() => void handleCopySessionField(field, value).catch(() => {})}
                          style={{
                            display: "inline-flex",
                            alignItems: "center",
                            justifyContent: "center",
                            width: 20,
                            height: 20,
                            color: copied ? "var(--accent)" : "var(--text-dim)",
                            background: "transparent",
                            border: "1px solid var(--border)",
                            borderRadius: 4,
                            cursor: "pointer",
                            flex: "0 0 auto",
                            padding: 0,
                            transition: "color 0.12s, border-color 0.12s, background 0.12s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.color = "var(--accent)";
                            e.currentTarget.style.borderColor = "var(--accent)";
                            e.currentTarget.style.background = "var(--bg-hover)";
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.color = copied ? "var(--accent)" : "var(--text-dim)";
                            e.currentTarget.style.borderColor = "var(--border)";
                            e.currentTarget.style.background = "transparent";
                          }}
                        >
                          {copied ? (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <polyline points="20 6 9 17 4 12" />
                            </svg>
                          ) : (
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
                              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                            </svg>
                          )}
                        </button>
                      );
                    };
                    const sessionInfoSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{translate("session.infoSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 10, rowGap: 5, alignItems: "center" }}>
                          {sessionRows.map((row) => {
                            const isFile = row.copyField === "file";
                            return (
                              <div key={`session-info:${row.label}`} style={{ display: "contents" }}>
                                <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                                <div
                                  title={row.value}
                                  style={{
                                    color: "var(--text-muted)",
                                    minWidth: 0,
                                    overflow: isFile ? "visible" : "hidden",
                                    textOverflow: isFile ? "clip" : "ellipsis",
                                    whiteSpace: isFile ? "normal" : "nowrap",
                                    overflowWrap: isFile ? "anywhere" : "normal",
                                  }}
                                >{row.value}</div>
                                <div>{row.copyField ? copyButton(row.copyField, row.value) : null}</div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    );
                    const projectInfoSection = projectRows.length > 0 ? (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{translate("session.projectSection")}</div>
                        <div style={{ display: "grid", gridTemplateColumns: "auto minmax(0, 1fr) auto", columnGap: 10, rowGap: 5, alignItems: "center" }}>
                          {projectRows.map((row) => (
                            <div key={`project-info:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div
                                title={row.value}
                                style={{
                                  color: "var(--text-muted)",
                                  minWidth: 0,
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  whiteSpace: "nowrap",
                                }}
                              >{row.value}</div>
                              <div>{copyButton(row.copyField, row.value)}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null;
                    const messageSection = (
                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--text)", marginBottom: 6 }}>{translate("session.messages")}</div>
                        <div style={{
                          display: "grid",
                          gridTemplateColumns: "auto minmax(0, 1fr)",
                          columnGap: 14,
                          rowGap: 4,
                          alignItems: "center",
                        }}>
                          {messageDetailRows.map((row) => (
                            <div key={`msg:${row.label}`} style={{ display: "contents" }}>
                              <div style={{ color: "var(--text-dim)", whiteSpace: "nowrap" }}>{row.label}</div>
                              <div
                                title={row.raw.toLocaleString(locale)}
                                style={{
                                  color: "var(--text-muted)",
                                  textAlign: "right",
                                  fontVariantNumeric: "tabular-nums",
                                  whiteSpace: "nowrap",
                                }}
                              >{row.value}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    );


                    return (
                      <div style={{
                        display: "grid",
                        gridTemplateColumns: isMobile
                          ? "1fr"
                          : "minmax(320px, 1fr) minmax(260px, 0.9fr)",
                        gap: isMobile ? 16 : 28,
                        maxWidth: 960,
                        fontSize: 11,
                        lineHeight: 1.5,
                        fontFamily: "var(--font-mono)",
                      }}>
                        <div style={{ display: "flex", flexDirection: "column", gap: isMobile ? 16 : 20, width: "100%", minWidth: 0 }}>
                          {sessionInfoSection}
                          {projectInfoSection}
                          {messageSection}
                        </div>
                        {resourceSection}
                      </div>
                    );
                  })() : (
                    <div style={{ fontSize: 12, color: "var(--text-muted)", fontStyle: "italic" }}>
                       {translate("session.load")}
                    </div>
                  )}
                </div>
              )}
            </div>
          ), document.body)}

        </div>


        {/* Chat content */}
        <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
          {embeddedReaderUrl ? (
            <iframe ref={embeddedIframeRef} key={remoteWorkspaceUrl} src={remoteWorkspaceUrl ?? undefined} title="Embedded Pi Web Reader" allow="clipboard-read; clipboard-write; fullscreen" onLoad={() => { setEmbeddedModalOpen(false); setEmbeddedModalKind(null); setEmbeddedSlashDetails(null); setEmbeddedQuoteAnnotation(null); embeddedImagePreviewRef.current = null; setEmbeddedImagePreview(null); setEmbeddedFileViewerOpen(false); }} style={{ width: "100%", height: "100%", border: 0, display: "block", background: "var(--bg)", ...(embeddedModalOpen && embeddedModalKind === "sidekick" ? { position: "fixed", inset: 0, zIndex: 1400 } : {}), }} />
          ) : (aggregateWorkspaceActive || remoteSession) && !embeddedReaderUrl ? (
            remoteSession ? (
              <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
                {sessionTopBar}
                <div style={{ flex: 1, minHeight: 0 }}>
                  {remoteSession.sessionInfo ? (
                    <ChatWindow
                      key={remoteSession.promotedSessionId === remoteSession.sessionInfo.id && remoteSession.draftInstanceKey
                        ? remoteSession.draftInstanceKey : `session:${remoteSession.device.id}:${remoteSession.sessionInfo.id}`}
                      session={remoteSession.sessionInfo}
                      sessionRunning={Boolean(remoteSession.sessionInfo && remoteSession.sessionRunning)}
                      deviceName={remoteSession.device.name}
                      onOpenRelatedSession={handleOpenRelatedSession}
                      remotePeer={remoteSession.device.id}
                      newSessionCwd={null}
                      newSessionDraftKey={null}
                      onAgentEnd={() => handleAgentEnd(remoteSession.sessionInfo?.id ?? undefined, remoteSession.device.id)}
                      onAgentError={() => handleRemoteAgentError(remoteSession.sessionInfo?.id ?? null, remoteSession.device.id)}
                      onAttentionNeeded={(request) => handleAttentionNeeded(request, remoteSession.sessionInfo)}
                      modelsRefreshKey={modelsRefreshKey}
                      onBranchDataChange={handleBranchDataChange}
                      onOpenSettings={handleOpenSettings}
                      sidekickOpen={sidekickOpen}
                      onToggleSidekick={toggleSidekick}
                      sidekickRightPanelOpen={sidekickRightPanelOpen}
                      onCloseSidekickRightPanel={closeSidekickRightPanel}
                      onSidekickCountChange={setSidekickCount}
                      onSelectionToolbarChange={topBarSessionId ? handleSelectionToolbarChange : undefined}
                      onSystemPromptChange={handleSystemPromptChange}
                      onSystemToolsChange={handleSystemToolsChange}
                      onRuntimeInspectionChange={handleRuntimeInspectionChange}
                      onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
                      onSessionStatsChange={reportSessionStatsChange}
                      sessionStatsRefreshRef={sessionStatsRefreshRef}
                      onContextUsageChange={reportContextUsageChange}
                      onSessionForked={handleSessionForked}
                      restoreMessage={pendingRestoreMessage}
                      onRestoreMessageApplied={handleRestoreMessageApplied}
                      chatInputRef={chatInputRef}
                      onChatInputReady={handleChatInputReady}
                      highlightTerm={remoteSession.searchTerm}
                      onOpenFile={handleOpenRemoteFile}
                      soundEnabled={soundEnabled}
                      onSoundToggle={onSoundToggle}
                      playDoneSound={playDoneSound}
                      canPlaySound={canPlaySound}
                      statusSoundOwner={activityOwnsBackgroundStatusSounds ? "activity" : "chat"}
                      suppressStatusSounds={isSubagentSession(remoteSession.sessionInfo)}
                    />
                  ) : (
                    <ChatWindow
                      key={remoteSession.draftInstanceKey ?? `new:${remoteSession.device.id}:${remoteSession.newSessionCwd ?? ""}:${remoteSession.newSessionSubprojectId ?? ""}:${remoteSession.newSessionSubprojectLabel ?? ""}:${remoteSession.newSessionContextSourceId ?? ""}`}
                      session={null}
                      deviceName={remoteSession.device.name}
                      remotePeer={remoteSession.device.id}
                      newSessionCwd={remoteSession.newSessionCwd}
                      newSessionSubprojectId={remoteSession.newSessionSubprojectId ?? null}
                      newSessionContextSourceId={remoteSession.newSessionContextSourceId ?? null}
                      newSessionWorktreeBinding={remoteSession.newSessionWorktreeBinding ?? null}
                      newSessionPrefill={buildNewSessionPrefill(remoteSession.newSessionSubprojectLabel)}
                      newSessionDraftKey={remoteSession.newSessionCwd ? `remote-new:${remoteSession.device.id}:${remoteSession.newSessionCwd}:${remoteSession.newSessionSubprojectId ?? ""}${remoteSession.newSessionContextSourceId ? `:context:${remoteSession.newSessionContextSourceId}` : ""}` : null}
                      onAgentEnd={() => handleAgentEnd(remoteSession.sessionInfo?.id ?? undefined, remoteSession.device.id)}
                      onAttentionNeeded={(request) => handleAttentionNeeded(request, remoteSession.sessionInfo)}
                      onSessionCreated={(created, draftKey) => handleRemoteSessionCreated(created, draftKey, remoteSession.draftInstanceKey)}
                      onSessionForked={handleSessionForked}
                      restoreMessage={pendingRestoreMessage}
                      onRestoreMessageApplied={handleRestoreMessageApplied}
                      chatInputRef={chatInputRef}
                      onChatInputReady={handleChatInputReady}
                      modelsRefreshKey={modelsRefreshKey}
                      onBranchDataChange={handleBranchDataChange}
                      onOpenSettings={handleOpenSettings}
                      sidekickOpen={sidekickOpen}
                      onToggleSidekick={toggleSidekick}
                      sidekickRightPanelOpen={sidekickRightPanelOpen}
                      onCloseSidekickRightPanel={closeSidekickRightPanel}
                      onSidekickCountChange={setSidekickCount}
                      onSelectionToolbarChange={topBarSessionId ? handleSelectionToolbarChange : undefined}
                      onSystemPromptChange={handleSystemPromptChange}
                      onSystemToolsChange={handleSystemToolsChange}
                      onRuntimeInspectionChange={handleRuntimeInspectionChange}
                      onSystemPromptLoaderChange={handleSystemPromptLoaderChange}
                      onSessionStatsChange={reportSessionStatsChange}
                      sessionStatsRefreshRef={sessionStatsRefreshRef}
                      onContextUsageChange={reportContextUsageChange}
                      highlightTerm={null}
                      onOpenFile={handleOpenRemoteFile}
                      soundEnabled={soundEnabled}
                      onSoundToggle={onSoundToggle}
                      playDoneSound={playDoneSound}
                      canPlaySound={canPlaySound}
                      statusSoundOwner={activityOwnsBackgroundStatusSounds ? "activity" : "chat"}
                      suppressStatusSounds={isSubagentSession(remoteSession.sessionInfo)}
                    />
                  )}
                </div>
              </div>
            ) : chatWindowContent
          ) : showChat ? (
            chatWindowContent
          ) : initialCwdStatus === "validating" ? (
            <div
              role="status"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "var(--text)" }}>{translate("workspace.opening")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
            </div>
          ) : initialCwdStatus === "error" ? (
            <div
              role="alert"
              style={{ height: "100%", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 8, padding: 24, color: "var(--text-muted)", textAlign: "center" }}
            >
               <div style={{ fontSize: 14, color: "#dc2626" }}>{translate("workspace.unable")}</div>
              <div style={{ maxWidth: "min(720px, 100%)", overflowWrap: "anywhere", fontFamily: "var(--font-mono)", fontSize: 12 }}>
                {initialNavigation.requestedCwd}
              </div>
              <div style={{ maxWidth: 720, fontSize: 12 }}>{initialCwdError}</div>
            </div>
          ) : showPlaceholder ? (
            activeCwd ? (
              <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 15 }}>
                 {translate("workspace.selectSession")}
              </div>
            ) : (
              <div style={{ position: "absolute", top: 12, left: 12, display: "flex", alignItems: "flex-start", gap: 8, userSelect: "none", pointerEvents: "none" }}>
                <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" style={{ opacity: 0.7, flexShrink: 0 }}>
                  <line x1="20" y1="12" x2="4" y2="12" /><polyline points="10 6 4 12 10 18" />
                </svg>
                <div>
                   <div style={{ fontSize: 18, fontWeight: 600, color: "var(--text)", marginBottom: 8 }}>{translate("workspace.getStarted")}</div>
                  <div style={{ fontSize: 12, color: "var(--text-muted)", lineHeight: 1.8 }}>
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>1.</span>{translate("workspace.selectProject")}<br />
                     <span style={{ color: "var(--text-dim)", marginRight: 6 }}>2.</span>{translate("workspace.addModels")}
                  </div>
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      <div
        aria-hidden="true"
        className={`right-panel-overlay-backdrop${rightPanelOpen ? " is-open" : ""}`}
        onClick={closeFilePreview}
      />
      {rightPanelOpen && (
        <div
          {...rightPanelResizer.separatorProps}
          aria-controls="file-panel"
          className={`panel-resize-handle right-panel-resize-handle${rightPanelResizer.isResizing ? " is-resizing" : ""}`}
          data-resize-handle="right-panel"
          title={`${translate("layout.resizeFilePanel")}: ${translate("layout.resizeHint")}`}
        />
      )}

      {/* Right panel: file viewer — always mounted, width animated via CSS */}
      <div
        ref={rightPanelResizer.panelRef}
        id="file-panel"
        className={`right-panel-container${rightPanelOpen ? " right-panel-open" : " right-panel-closed"}${rightPanelResizer.isResizing ? " right-panel-resizing" : ""}${readerMode && !isMobile ? " chat-collapsed" : ""}`}
        style={{
          "--right-panel-width": `${rightPanelResizer.width}px`,
          display: "flex",
          flexDirection: "column",
          borderLeft: "1px solid var(--border)",
          background: "var(--bg)",
          flex: readerMode && !isMobile && rightPanelOpen ? 1 : undefined,
        } as React.CSSProperties}
      >
        {/* Right panel tab bar */}
        <div style={{
          display: "flex",
          alignItems: "center",
          flexShrink: 0,
          height: "calc(36px + env(safe-area-inset-top))",
          paddingTop: "env(safe-area-inset-top)",
          background: "var(--bg-panel)",
          borderBottom: "1px solid var(--border)",
        }}>
          {readerMode && isMobile && (
            <button
              onClick={() => { setSidebarOpen(true); setRightPanelOpen(false); }}
              title={translate("layout.mobileBackTitle")}
              aria-label={translate("layout.mobileBackTitle")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center", gap: 6,
                height: 36, padding: "0 12px",
                background: "none", border: "none", borderRight: "1px solid var(--border)",
                color: "var(--accent)", cursor: "pointer", flexShrink: 0, fontSize: 13, fontWeight: 600,
              }}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M15 18l-6-6 6-6" />
              </svg>
              {translate("layout.mobileBack")}
            </button>
          )}

          {/* Reader mode on desktop keeps left sidebar and exit controls */}
          {readerMode && !isMobile && (
            <>
              {sessionControlPlacement === "right-panel" && renderLayoutControl("sessions", "panel")}
              {renderLayoutControl("reader", "panel")}
            </>
          )}
          <div style={{ flex: 1, overflow: "hidden" }}>
            <TabBar
              tabs={panelTabs}
              activeTabId={activeFileTabId ?? ""}
              onSelectTab={handleSelectFileTab}
              onCloseTab={handleCloseFileTab}
              onReorderTab={(source, target, after) => setPanelTabOrder((current) => movePanelTab(panelTabs.map((tab) => tab.id), source, target, after))}
            />
          </div>
          <button
            type="button"
            data-right-panel-sidekick-toggle="true"
            onClick={toggleSidekickRightPanel}
            aria-label={sidekickButtonLabel}
            aria-pressed={sidekickRightPanelOpen && rightPanelOpen}
            title={sidekickButtonLabel}
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE,
              height: TOP_BAR_ICON_BUTTON_SIZE,
              padding: 0,
              background: "none",
              border: "none",
              borderLeft: "1px solid var(--border)",
              color: sidekickRightPanelOpen && rightPanelOpen ? "var(--accent)" : "var(--text-muted)",
              cursor: "pointer",
              flexShrink: 0,
              fontSize: 11,
              transition: "color 0.12s, background-color 0.12s",
            }}
            onMouseEnter={(event) => {
              if (!(sidekickRightPanelOpen && rightPanelOpen)) event.currentTarget.style.color = "var(--text)";
            }}
            onMouseLeave={(event) => {
              event.currentTarget.style.color = sidekickRightPanelOpen && rightPanelOpen ? "var(--accent)" : "var(--text-muted)";
            }}
          >
            <SidekickMessageIcon count={sidekickCount} />
          </button>
          <button
            type="button"
            data-terminal-open="true"
            data-layout-control="terminal"
            onClick={() => {
              const context = manualFileContext ?? activityExplorerContext;
              if (context) handleOpenTerminal(context.cwd, context.deviceId ?? undefined);
            }}
            title={translate("terminal.open")}
            aria-label={translate("terminal.open")}
            style={{
              display: "flex", alignItems: "center", justifyContent: "center",
              width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
              background: "none", border: "none", borderLeft: "1px solid var(--border)",
              color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
            }}
            onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
            onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          </button>
          {fileTabs.length > 0 && (
            <button
              type="button"
              data-file-tabs-close-all="true"
              onClick={handleCloseAllFileTabs}
              title={translate("files.closeAll")}
              aria-label={translate("files.closeAll")}
              style={{
                display: "flex", alignItems: "center", justifyContent: "center",
                width: TOP_BAR_ICON_BUTTON_SIZE, height: TOP_BAR_ICON_BUTTON_SIZE, padding: 0,
                background: "none", border: "none", borderLeft: "1px solid var(--border)",
                color: "var(--text-muted)", cursor: "pointer", flexShrink: 0, transition: "color 0.12s",
              }}
              onMouseEnter={(event) => { event.currentTarget.style.color = "var(--text)"; }}
              onMouseLeave={(event) => { event.currentTarget.style.color = "var(--text-muted)"; }}
            >
              <ListX size={16} strokeWidth={1.8} aria-hidden="true" />
            </button>
          )}
          {/* Document header top-right: mirrored reader mode toggle for both side panel and fullscreen */}
          {renderLayoutControl("reader", "panel-action")}
          {/* Side panel also offers local close toggle */}
          {!readerMode && renderLayoutControl("document", "panel")}
        </div>

        {/* The same side-question state can occupy this full-height, resizable panel. */}
        <AppShellSidekickRightPanel active={isSidekickTabActive}>
          <div
            id={SIDEKICK_RIGHT_PANEL_TARGET_ID}
            data-right-panel-sidekick="true"
            style={{
              display: isSidekickTabActive ? "flex" : "none",
              flex: 1,
              minHeight: 0,
              overflow: "hidden",
              paddingBottom: "env(safe-area-inset-bottom)",
            }}
          />
        </AppShellSidekickRightPanel>

        {/* Only the active viewer is mounted. Lightweight per-tab state is restored on activation. */}
        <div
          style={{
            flex: 1,
            overflow: "hidden",
            paddingBottom: "env(safe-area-inset-bottom)",
            display: isSidekickTabActive ? "none" : "block",
          }}
        >
          {activeFileTab?.filePath ? (
            <FileViewer
              key={`${activeFileTab.id}:${activeFileTab.viewerRevision ?? 0}`}
              filePath={activeFileTab.filePath}
              cwd={activeFileCwd ?? undefined}
              remotePeer={activeFileTab.remotePeer}
              sourceSessionId={activeFileTab.sourceSessionId}
              gitRefreshKey={explorerRefreshKey}
              panelOpen={rightPanelOpen}
              initialDisplayMode={activeFileTab.initialDisplayMode}
              initialPage={activeFileTab.page}
              initialAnchor={activeFileTab.anchor}
              onAnchorApplied={() => setFileTabs((tabs) => clearFileTabAnchor(tabs, activeFileTab.id, activeFileTab.viewerRevision ?? 0))}
              initialState={activeFileTab.viewerState}
              watchEnabled={rightPanelOpen}
              onStateChange={(viewerState) => handleFileViewerStateChange(
                activeFileTab.id,
                activeFileTab.viewerRevision ?? 0,
                viewerState,
              )}
              onDirtyChange={(dirty) => handleFileViewerDirtyChange(activeFileTab.id, dirty)}
              onMentionLines={rightPanelOpen ? handleFileLineMention : undefined}
              onAtMention={handleAtMention}
              onOpenFile={(filePath, page, anchor) => handleOpenFile(
                filePath,
                getFileName(filePath),
                { sourceSessionId: activeFileTab.sourceSessionId, remotePeer: activeFileTab.remotePeer, cwd: activeFileCwd ?? undefined, projectRoot: activeFileTab.projectRoot ?? activeFileCwd ?? undefined, page, anchor },
              )}
            />
          ) : !activeTerminalTab ? (
            <div style={{ height: "100%", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-dim)", fontSize: 12 }}>
               {translate("files.noneOpen")}
            </div>
          ) : null}
          {terminalTabs.map((tab) => (
            <div key={tab.id} hidden={tab.id !== activeFileTabId} style={{ width: "100%", height: "100%" }}>
              <TerminalPanel
                tab={tab}
                active={rightPanelOpen && tab.id === activeFileTabId}
                onRestart={() => setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: "restart" } : item))}
                onClosed={() => handleTerminalClosed(tab)}
                onCloseError={(message) => {
                  setTerminalCleanupError(`${translate("terminal.cleanupUnconfirmed")}: ${message}`);
                  if (tab.closing === "close") handleTerminalClosed(tab);
                  else setTerminalTabs((tabs) => tabs.map((item) => item.id === tab.id ? { ...item, closing: undefined } : item));
                }}
              />
            </div>
          ))}
        </div>
      </div>
    </div>
    {mutationRecoveryVisible && (
    <details className="remote-mutation-recovery" open={mutationRecoveryOpen} onToggle={event => setMutationRecoveryOpen(event.currentTarget.open)}
      aria-label={translate("mutationRecovery.title")} style={{
        flexShrink: 0, minHeight: 0, width: "100%", maxHeight: "min(35%, 260px)",
        overflowY: "auto", overflowX: "hidden", overflowWrap: "anywhere", overscrollBehavior: "contain",
        padding: "6px 12px", paddingLeft: "max(12px, env(safe-area-inset-left))", paddingRight: "max(12px, env(safe-area-inset-right))",
        paddingBottom: "max(6px, env(safe-area-inset-bottom))", background: "var(--bg-panel)", borderTop: "1px solid var(--border)", fontSize: 12,
      }}>
      <summary aria-busy={mutationRecoveryBusy || pendingRemoteMutations.some(item => item.busy)} style={{ cursor: "pointer", position: "sticky", top: 0, background: "var(--bg-panel)", lineHeight: "20px" }}>{translate("mutationRecovery.title")}{pendingRemoteMutations.length ? ` (${pendingRemoteMutations.length})` : ""}</summary>
      {remoteMutationNotice && <p role="status">{remoteMutationNotice}</p>}
      {remoteMutationLink && <p><a href={remoteMutationLink} target="_blank" rel="noopener noreferrer">{translate("mutationRecovery.openReader")}</a></p>}
      <button type="button" disabled={mutationRecoveryBusy} onClick={() => void refreshRemoteMutationRecovery()}>{translate(mutationRecoveryBusy ? "mutationRecovery.querying" : "mutationRecovery.find")}</button>
      {mutationRecoveryIncomplete && <p role="status">{translate("mutationRecovery.incomplete")}</p>}
      {mutationAuthenticationTargets.map(target => <p key={target.id} role="status">
        {target.name ?? target.id}: {translate("mutationRecovery.authenticationRequired")} {" "}
        <a href={target.url} target="_blank" rel="noopener noreferrer">{translate("mutationRecovery.openReader")}</a>
      </p>)}
      {pendingRemoteMutations.map(item => <div key={`${item.target.id}:${item.command.operationId}`} style={{ marginTop: 10, paddingTop: 8, borderTop: "1px solid var(--border)" }}>
        <div>{item.target.name ?? item.target.id} · {translate(item.actionKnown === false ? "mutationRecovery.historical" : `mutationRecovery.action.${item.command.op}`)}</div>
        <div>{translate("mutationRecovery.session", { id: item.command.sessionId })}{item.command.name !== undefined ? ` → ${item.command.name}` : ""}</div>
        {item.actionKnown !== false && item.command.force && <div>{translate("mutationRecovery.force")}</div>}
        <div style={{ overflowWrap: "anywhere", opacity: 0.7 }}>{translate("mutationRecovery.operation", { id: item.command.operationId })}</div>
        <div role="status">{translate(item.busy ? "mutationRecovery.queryingOriginal" : `mutationRecovery.status.${item.receipt.status}`)}{item.receipt.error ? ` · ${item.receipt.error}` : ""}</div>
        {item.receipt.status === "not_found" && item.actionKnown !== false && <p>{translate("mutationRecovery.continueHint")}</p>}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 4 }}>
          <button type="button" disabled={item.busy} onClick={() => void queryRemoteMutation(item)}>{translate("mutationRecovery.queryOriginal")}</button>
          {item.receipt.status === "not_found" && item.actionKnown !== false && <button type="button" disabled={item.busy} onClick={() => void continueRemoteMutation(item)}>{translate("mutationRecovery.continueOriginal")}</button>}
          <a href={item.target.url} target="_blank" rel="noopener noreferrer">{translate("mutationRecovery.openDevice")}</a>
          {!["accepted", "running", "not_found"].includes(item.receipt.status) && <button type="button" disabled={item.busy} onClick={() => void reviewRemoteMutation(item)}>{translate("mutationRecovery.review")}</button>}
        </div>
      </div>)}
    </details>
    )}
    </div>
    {terminalCleanupError && <div role="alert" style={{ position: "fixed", bottom: 12, right: 12, zIndex: 1200, maxWidth: 420, padding: 10, background: "var(--bg-panel)", border: "1px solid var(--border)", fontSize: 12 }}>
      {terminalCleanupError} <button type="button" onClick={() => setTerminalCleanupError(null)} aria-label={translate("i18n.close")}>×</button>
    </div>}
    {/* Recovery strip keeps D reachable after closing a panel; Reader keeps A/B/C too. */}
    {filePanelRecoveryVisible && (
    <div style={{ position: "fixed", top: "env(safe-area-inset-top)", right: "env(safe-area-inset-right)", zIndex: 300, display: "flex", borderBottom: "1px solid var(--border)" }}>
      {readerRecoveryVisible && sessionControlPlacement === "recovery" && renderLayoutControl("sessions", "recovery")}
      {readerRecoveryVisible && renderLayoutControl("explorer", "recovery")}
      {readerRecoveryVisible && renderLayoutControl("reader", "recovery")}
      {renderLayoutControl("document", "recovery")}
    </div>
    )}
    {/* skillsConfigOpen && resourceCwd handled by UnifiedSettingsModal */}
    {settingsModalTab !== null && (
      <UnifiedSettingsModal
        initialTab={settingsModalTab}
        onClose={() => {
          setSettingsModalTab(null);
          setModelsRefreshKey((k) => k + 1);
        }}
        cwd={resourceCwd ?? undefined}
        sessionFile={resourceSessionFile}
        sessionId={resourceSessionId}
        remotePeer={resourcePeer}
        trust={projectTrust}
        onSessionReloaded={() => {
          if (resourceSessionId) window.dispatchEvent(new CustomEvent(SESSION_RESOURCES_RELOADED_EVENT, {
            detail: { sessionId: resourceSessionId, remotePeer: resourcePeer ?? null },
          }));
          setModelsRefreshKey((k) => k + 1);
        }}
        onTrustProject={() => {
          setProjectTrustError(null);
          setProjectTrustDialogOpen(true);
        }}
        onProjectTrustChanged={(cwd, status) => {
          if (cwd === projectTrustCwd) setProjectTrust(status);
        }}
        onUseSkill={handleUseSkill}
        onOpenFile={(filePath, page, anchor) => {
          const fileName = getFileName(filePath);
          handleOpenFile(filePath, fileName, { remotePeer: resourcePeer, sourceSessionId: resourceSessionId, cwd: resourceCwd ?? undefined, page, anchor });
          setSettingsModalTab(null);
        }}
      />
    )}
    {projectTrustDialogOpen && projectTrustCwd && (
      <ProjectTrustDialog
        cwd={projectTrustCwd}
        busy={projectTrustBusy}
        error={projectTrustError}
        onCancel={() => {
          if (!projectTrustBusy) setProjectTrustDialogOpen(false);
        }}
        onConfirm={() => void handleTrustProject()}
        onStatus={setProjectTrust}
      />
    )}
    {sessionPopupFile && (
      <FileViewerModal
        filePath={sessionPopupFile.filePath}
        cwd={sessionPopupFile.cwd}
        remotePeer={sessionPopupFile.remotePeer}
        sourceSessionId={sessionPopupFile.sourceSessionId}
        initialPage={sessionPopupFile.page}
        onMentionLines={handleFileLineMention}
        onAtMention={handleAtMention}
        onOpenInReaderView={(filePath, page, anchor) => {
          const target = sessionPopupFile;
          setSessionPopupFile(null);
          handleOpenFile(filePath, getFileName(filePath), {
            remotePeer: target.remotePeer,
            sourceSessionId: target.sourceSessionId,
            cwd: target.cwd,
            page,
            anchor,
          });
          activateReaderMode(target.cwd, target.remotePeer);
        }}
        onClose={() => setSessionPopupFile(null)}
      />
    )}
    {embeddedSlashDetails && embeddedReaderUrl && (
      <SlashCommandDetailsSurface
        {...embeddedSlashDetails}
        remotePeer={embeddedSessionKey?.split(":")[0] ?? embeddedDeviceId ?? embeddedResourceSession?.deviceId}
        onClose={closeEmbeddedSlashDetails}
        onOpenFile={handleOpenEmbeddedSlashFile}
      />
    )}
    {embeddedQuoteAnnotation && embeddedReaderUrl && (
      <QuoteAnnotationModal
        isOpen={embeddedQuoteAnnotation.open}
        quoteText={embeddedQuoteAnnotation.quoteText}
        initialReply={embeddedQuoteAnnotation.initialReply}
        onConfirm={handleEmbeddedQuoteConfirm}
        onDelete={embeddedQuoteAnnotation.canDelete ? handleEmbeddedQuoteDelete : undefined}
        onClose={handleEmbeddedQuoteClose}
      />
    )}
    {embeddedImagePreview && embeddedImagePreview.phase !== "closed" && embeddedReaderUrl && (
      <ImageLightbox
        key={`${embeddedImagePreview.documentId}:${embeddedImagePreview.requestId}`}
        src={embeddedImagePreview.src}
        images={embeddedImagePreview.images}
        initialIndex={embeddedImagePreview.initialIndex}
        alt={embeddedImagePreview.alt}
        onReady={acknowledgeEmbeddedImagePreview}
        onClose={closeEmbeddedImagePreview}
      />
    )}
    <AppShellWorktreeOverlays
      talkMapOpen={talkMapOpen}
      talkMapProjectRoot={talkMapProjectRoot}
      talkMapDevice={talkMapDevice}
      talkMapFocusSessionId={talkMapFocusSessionId}
      talkMapSidebarSessionId={talkMapSidebarSessionId}
      worktreeGraphOpen={worktreeGraphOpen}
      worktreeGraphProjectRoot={worktreeGraphProjectRoot}
      worktreeGraphDevice={worktreeGraphDevice}
      worktreeGraphSessionId={worktreeGraphSessionId}
      worktreeGraphSessionPath={worktreeGraphSessionPath}
      worktreeGraphCurrentPath={worktreeGraphCurrentPath}
      topBarSessionId={topBarSessionId} currentSessionId={worktreeGraphSessionId ?? topBarSessionId}
      localDeviceId={localDeviceId}
      localDeviceName={localDeviceName}
      refreshKey={refreshKey}
      onCloseTalkMap={closeTalkMap}
      onTalkMapNewSession={handleTalkMapNewSession}
      onTalkMapConvertGhost={handleTalkMapConvertGhost}
      onTalkMapSession={handleTalkMapSession}
      onTalkMapSelectCard={handleTalkMapSelectCard}
      onTalkMapFork={handleTalkMapFork}
      onTalkMapInjectContext={handleTalkMapInjectContext}
      onCopySessionInfo={handleActivityCopySessionInfo}
      onTalkMapSessionMutation={handleTalkMapSessionMutation}
      onCloseWorktreeGraph={closeWorktreeGraph}
      onSwitchWorktree={worktreeGraphDevice && localDeviceId && worktreeGraphDevice.id !== localDeviceId ? undefined : (wtPath) => {
        handleCwdChange(wtPath, worktreeGraphProjectRoot);
      }}
      onOpenSession={handleWorktreeGraphOpenSession}
      onNewSessionFromNode={handleWorktreeGraphNewSession}
    />
    </>
  );
}
