"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Sliders, Bot, Sparkles, Plug, Users, MessageSquareQuote, Star, X, ChevronLeft, ChevronRight } from "lucide-react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { usePhoneSettingsNavigation } from "@/hooks/usePhoneSettingsNavigation";
import { notifyEmbeddedModalState } from "@/lib/embedded-modal";
import { CUSTOM_PROMPTS_CHANGED_EVENT } from "@/lib/custom-prompt-types";

import { ConfigButton, SettingsDetailNavigationContext } from "./SettingsUi";
import { GeneralConfig } from "./GeneralConfig";
import { ModelsConfig } from "./ModelsConfig";
import { SkillsConfig } from "./SkillsConfig";
import { PluginsConfig } from "./PluginsConfig";
import { AgentsConfig } from "./AgentsConfig";
import { PromptsConfig } from "./PromptsConfig";
import { McpConfig } from "./McpConfig";
import { FavoritesConfig } from "./FavoritesConfig";
import { FileViewerModal } from "./FileViewerModal";
import type { ProjectTrustStatus } from "@/lib/api-types";

function PiWebServerIcon({ size = 24, strokeWidth = 2 }: { size?: number; strokeWidth?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="7" rx="2" />
      <rect x="3" y="14" width="18" height="7" rx="2" />
      <path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" />
    </svg>
  );
}

export type SettingsTab = "general" | "models" | "skills" | "plugins" | "agents" | "prompts" | "favorites" | "mcp";

export interface SettingsPanelController {
  isDirty: () => boolean;
  save: () => Promise<boolean>;
  discard: () => void;
}

export interface UnifiedSettingsModalProps {
  initialTab?: SettingsTab;
  onClose: () => void;
  cwd?: string;
  sessionId?: string | null;
  sessionFile?: string;
  remotePeer?: string;
  quoteSelectionEnabled?: boolean;
  onQuoteSelectionChange?: (enabled: boolean) => void;
  onOpenFile?: (filePath: string, page?: number, anchor?: string) => void;
  onSessionReloaded?: () => void;
  onUseSkill?: (skillName: string) => void;
  trust?: ProjectTrustStatus | null;
  onTrustProject?: () => void;
  onProjectTrustChanged?: (cwd: string, status: ProjectTrustStatus) => void;
}

export function UnifiedSettingsModal({
  initialTab = "general",
  onClose,
  cwd,
  sessionId,
  sessionFile,
  remotePeer,
  quoteSelectionEnabled,
  onQuoteSelectionChange,
  onOpenFile: _onOpenFile,
  onSessionReloaded,
  onUseSkill,
  trust,
  onTrustProject,
  onProjectTrustChanged,
}: UnifiedSettingsModalProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const dialogRef = useRef<HTMLDivElement>(null);
  const phoneContentRef = useRef<HTMLDivElement>(null);
  const phoneBackRef = useRef<HTMLButtonElement>(null);
  const keyboardNavigationRef = useRef(false);
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);
  const [visitedTabs, setVisitedTabs] = useState<Set<SettingsTab>>(() => new Set([initialTab]));
  const [popupFilePath, setPopupFilePath] = useState<string | null>(null);

  // Controllers to track dirty state and perform save / discard on tabs with explicit forms
  const modelsControllerRef = useRef<SettingsPanelController | null>(null);
  const agentsControllerRef = useRef<SettingsPanelController | null>(null);

  // Pending action when attempting to close or switch tab with unsaved changes
  const [pendingAction, setPendingAction] = useState<
    { type: "close" } | { type: "switchTab"; target: SettingsTab } | null
  >(null);
  const [actionSaving, setActionSaving] = useState(false);

  // Keep each panel's response local. A mutation invalidates only the opposite panel.
  const [skillsRefreshRevision, setSkillsRefreshRevision] = useState(0);
  const [pluginsRefreshRevision, setPluginsRefreshRevision] = useState(0);
  const notifySkillsChanged = useCallback(() => setSkillsRefreshRevision((current) => current + 1), []);
  const notifyPluginsChanged = useCallback(() => setPluginsRefreshRevision((current) => current + 1), []);

  const switchTab = useCallback((tab: SettingsTab) => {
    setActiveTab(tab);
    setVisitedTabs((prev) => new Set(prev).add(tab));
  }, []);

  const getActiveController = useCallback((): SettingsPanelController | null => {
    if (activeTab === "models") return modelsControllerRef.current;
    if (activeTab === "agents") return agentsControllerRef.current;
    return null;
  }, [activeTab]);

  const requestClose = useCallback(() => {
    const controller = getActiveController();
    if (controller?.isDirty()) {
      setPendingAction({ type: "close" });
      return;
    }
    onClose();
  }, [getActiveController, onClose]);

  const phone = usePhoneSettingsNavigation(
    isMobile,
    initialTab === "general",
    () => {
      if (getActiveController()?.isDirty()) {
        setPendingAction({ type: "close" });
        return false;
      }
      onClose();
      return true;
    },
    () => Boolean(popupFilePath) || Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]'))
      .some((dialog) => dialog !== dialogRef.current && dialog.getClientRects().length > 0),
  );
  const detailNavigation = useMemo(() => ({ openDetail: phone.openDetail, closeDetail: phone.closeDetail }), [phone.openDetail, phone.closeDetail]);
  const previousPhoneView = useRef({ isMobile, level: phone.level });

  useLayoutEffect(() => {
    const previous = previousPhoneView.current;
    previousPhoneView.current = { isMobile, level: phone.level };
    const content = phoneContentRef.current;
    if (!isMobile || !previous.isMobile || previous.level === phone.level || !content || keyboardNavigationRef.current
      || typeof content.animate !== "function" || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const depth = { home: 0, section: 1, detail: 2 };
    const forward = depth[phone.level] > depth[previous.level];
    const animation = content.animate(forward
      ? [{ transform: "translateX(100%)" }, { transform: "translateX(0)" }]
      : [{ transform: "translateX(-30%)", opacity: 0.4 }, { transform: "translateX(0)", opacity: 1 }],
    { duration: 280, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" });
    const title = dialogRef.current?.querySelector<HTMLElement>(".settings-phone-title");
    const titleAnimation = title?.animate?.([{ opacity: 0 }, { opacity: 1 }], { duration: 220 });
    return () => { animation.cancel(); titleAnimation?.cancel(); };
  }, [isMobile, phone.level]);

  useEffect(() => {
    const focused = document.activeElement;
    if (!isMobile || !(focused instanceof HTMLElement) || !dialogRef.current?.contains(focused) || focused.getClientRects().length > 0) return;
    if (phone.level === "home") dialogRef.current.querySelector<HTMLButtonElement>(".settings-phone-home-item")?.focus();
    else phoneBackRef.current?.focus();
  }, [isMobile, phone.level]);

  const requestSwitchTab = useCallback(
    (targetTab: SettingsTab) => {
      if (targetTab === activeTab) {
        phone.enterSection();
        return;
      }
      const controller = getActiveController();
      if (controller?.isDirty()) {
        setPendingAction({ type: "switchTab", target: targetTab });
        return;
      }
      switchTab(targetTab);
      phone.enterSection();
    },
    [activeTab, getActiveController, phone.enterSection, switchTab],
  );

  const handleContinueEditing = useCallback(() => {
    setPendingAction(null);
  }, []);

  const handleDiscardPending = useCallback(() => {
    const controller = getActiveController();
    controller?.discard();
    const action = pendingAction;
    setPendingAction(null);
    if (action?.type === "close") {
      onClose();
    } else if (action?.type === "switchTab") {
      switchTab(action.target);
      phone.enterSection();
    }
  }, [getActiveController, onClose, pendingAction, phone.enterSection, switchTab]);

  const handleSavePending = useCallback(async () => {
    const controller = getActiveController();
    if (!controller) {
      setPendingAction(null);
      return;
    }
    setActionSaving(true);
    try {
      const ok = await controller.save();
      if (ok) {
        const action = pendingAction;
        setPendingAction(null);
        if (action?.type === "close") {
          onClose();
        } else if (action?.type === "switchTab") {
          switchTab(action.target);
          phone.enterSection();
        }
      } else {
        // Stay on current panel so the error message is visible
        setPendingAction(null);
      }
    } catch {
      setPendingAction(null);
    } finally {
      setActionSaving(false);
    }
  }, [getActiveController, onClose, pendingAction, phone.enterSection, switchTab]);

  useEffect(() => {
    notifyEmbeddedModalState(true);
    return () => notifyEmbeddedModalState(false);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented && !e.isComposing && e.keyCode !== 229) {
        if (pendingAction) {
          e.preventDefault();
          setPendingAction(null);
          return;
        }
        if (popupFilePath) {
          e.preventDefault();
          setPopupFilePath(null);
          return;
        }
        e.preventDefault();
        requestClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [pendingAction, popupFilePath, requestClose]);

  // Order: 设置 | 常规 | 模型 | 技能 | 插件 | 子代理 | 提示词 | 收藏 | MCP | 右上角 ×
  const tabs: { id: SettingsTab; label: string; icon: typeof Sliders | typeof PiWebServerIcon }[] = useMemo(
    () => [
      { id: "general", label: t("settings.general"), icon: Sliders },
      { id: "models", label: t("common.models"), icon: Bot },
      { id: "skills", label: t("common.skills"), icon: Sparkles },
      { id: "plugins", label: t("common.plugins"), icon: Plug },
      { id: "agents", label: t("common.agents"), icon: Users },
      { id: "prompts", label: t("common.prompts"), icon: MessageSquareQuote },
      { id: "favorites", label: t("common.favorites"), icon: Star },
      { id: "mcp", label: t("common.mcp") || "MCP", icon: PiWebServerIcon },
    ],
    [t],
  );

  const sectionTitle = tabs.find((tab) => tab.id === activeTab)?.label ?? t("settings.title");
  const phoneTitle = phone.level === "home" ? t("settings.title") : phone.level === "detail" && phone.title ? phone.title : sectionTitle;
  const backTitle = phone.level === "detail" ? sectionTitle : t("settings.title");

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={t("settings.title")}
      data-phone-settings-level={isMobile ? phone.level : undefined}
      onKeyDownCapture={() => { keyboardNavigationRef.current = true; }}
      onPointerDownCapture={() => { keyboardNavigationRef.current = false; }}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 1000,
        background: "rgba(0,0,0,0.38)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) requestClose();
      }}
    >
      <div
        style={{
          width: isMobile ? "100vw" : 920,
          maxWidth: isMobile ? "100vw" : "calc(100vw - 16px)",
          height: isMobile ? "100dvh" : "82vh",
          maxHeight: isMobile ? "100dvh" : "calc(100dvh - 16px)",
          background: "var(--bg)",
          border: isMobile ? "none" : "1px solid var(--border)",
          borderRadius: isMobile ? 0 : 10,
          display: "flex",
          flexDirection: "column",
          boxShadow: isMobile ? "none" : "0 10px 36px rgba(0,0,0,0.22)",
          overflow: "hidden",
          paddingBottom: isMobile ? "env(safe-area-inset-bottom)" : undefined,
        }}
      >
        {/* Top Header: 设置 | 常规 | 模型 | 技能 | 插件 | 子代理 | 右上角 × */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: isMobile ? "0 10px" : "0 18px",
            paddingTop: isMobile ? "env(safe-area-inset-top)" : undefined,
            height: isMobile ? "calc(46px + env(safe-area-inset-top))" : 48,
            borderBottom: "1px solid var(--border)",
            background: "var(--bg-panel)",
            flexShrink: 0,
            gap: 8,
            position: "relative",
          }}
        >
          {/* Left: Title + Tabs */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: isMobile ? 8 : 16,
              minWidth: 0,
              flex: 1,
              overflowX: "auto",
              scrollbarWidth: "none",
            }}
          >
            {isMobile && phone.level !== "home" && (
              <button ref={phoneBackRef} type="button" className="settings-phone-back" onClick={phone.back} aria-label={`${t("files.back")}: ${backTitle}`}>
                <ChevronLeft size={19} aria-hidden="true" />
                <span>{backTitle}</span>
              </button>
            )}
            <span className={isMobile ? "settings-phone-title" : undefined} aria-live={isMobile ? "polite" : undefined} style={{ fontSize: isMobile ? 14 : 15, fontWeight: 700, color: "var(--text)", flexShrink: 0 }}>
              {isMobile ? phoneTitle : t("settings.title")}
            </span>

            {!isMobile && <nav
              aria-label={t("settings.title")}
              style={{
                display: "flex",
                alignItems: "center",
                gap: isMobile ? 2 : 4,
                overflowX: "auto",
                scrollbarWidth: "none",
                flexWrap: "nowrap",
              }}
            >
              {tabs.map((tab) => {
                const Icon = tab.icon;
                const isCurrent = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    type="button"
                    onClick={() => requestSwitchTab(tab.id)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: isMobile ? 4 : 6,
                      padding: isMobile ? "5px 8px" : "6px 12px",
                      borderRadius: 6,
                      border: "none",
                      background: isCurrent ? "var(--bg-selected, rgba(59, 130, 246, 0.12))" : "transparent",
                      color: isCurrent ? "var(--accent, #3b82f6)" : "var(--text-muted)",
                      fontSize: isMobile ? 12 : 13,
                      fontWeight: isCurrent ? 600 : 500,
                      cursor: "pointer",
                      whiteSpace: "nowrap",
                      flexShrink: 0,
                      transition: "background-color 0.12s ease, color 0.12s ease",
                    }}
                  >
                    <Icon size={isMobile ? 13 : 15} strokeWidth={isCurrent ? 2.2 : 1.8} />
                    <span>{tab.label}</span>
                  </button>
                );
              })}
            </nav>}
          </div>

          {/* Right: Close button */}
          <button
            type="button"
            onClick={requestClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            style={{
              background: "none",
              border: "none",
              color: "var(--text-muted)",
              cursor: "pointer",
              padding: "4px 6px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              borderRadius: 4,
            }}
          >
            <X size={18} strokeWidth={2} />
          </button>
        </div>

        {/* Tab Host Panes */}
        <SettingsDetailNavigationContext.Provider value={detailNavigation}>
        <div
          ref={phoneContentRef}
          data-phone-settings-content="true"
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            position: "relative",
          }}
        >
          {isMobile && phone.level === "home" && (
            <nav className="settings-phone-home" aria-label={t("settings.title")}>
              {tabs.map((tab) => {
                const Icon = tab.icon;
                return (
                  <button key={tab.id} type="button" className="settings-phone-home-item" onClick={() => requestSwitchTab(tab.id)}>
                    <Icon size={19} aria-hidden="true" />
                    <span>{tab.label}</span>
                    <ChevronRight size={18} aria-hidden="true" />
                  </button>
                );
              })}
            </nav>
          )}
          {visitedTabs.has("general") && (
            <div
              style={{
                display: activeTab === "general" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflowY: "auto",
                flexDirection: "column",
              }}
            >
              <GeneralConfig
                quoteSelectionEnabled={quoteSelectionEnabled}
                onQuoteSelectionChange={onQuoteSelectionChange}
                remotePeer={remotePeer}
              />
            </div>
          )}

          {visitedTabs.has("models") && (
            <div
              style={{
                display: activeTab === "models" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <ModelsConfig
                embedded
                onClose={onClose}
                sessionFile={sessionFile}
                cwd={cwd ?? ""}
                remotePeer={remotePeer}
                onOpenFile={setPopupFilePath}
                controllerRef={modelsControllerRef}
              />
            </div>
          )}

          {visitedTabs.has("skills") && (
            <div
              style={{
                display: activeTab === "skills" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <SkillsConfig
                embedded
                onClose={onClose}
                cwd={cwd ?? ""}
                sessionId={sessionId ?? null}
                remotePeer={remotePeer}
                revision={skillsRefreshRevision}
                onChanged={notifyPluginsChanged}
                onReloaded={onSessionReloaded}
                onOpenFile={setPopupFilePath}
                onUseSkill={onUseSkill}
              />
            </div>
          )}

          {visitedTabs.has("plugins") && (
            <div
              style={{
                display: activeTab === "plugins" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <PluginsConfig
                embedded
                onClose={onClose}
                cwd={cwd ?? ""}
                remotePeer={remotePeer}
                revision={pluginsRefreshRevision}
                onChanged={notifySkillsChanged}
                onOpenFile={setPopupFilePath}
                onReloaded={onSessionReloaded}
              />
            </div>
          )}

          {visitedTabs.has("agents") && (
            <div
              style={{
                display: activeTab === "agents" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <AgentsConfig
                embedded
                onClose={onClose}
                cwd={cwd ?? ""}
                sessionId={sessionId ?? null}
                remotePeer={remotePeer}
                onReloaded={onSessionReloaded}
                onOpenFile={setPopupFilePath}
                active={activeTab === "agents"}
                controllerRef={agentsControllerRef}
              />
            </div>
          )}

          {visitedTabs.has("prompts") && (
            <div
              style={{
                display: activeTab === "prompts" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <PromptsConfig
                embedded
                onClose={onClose}
                onOpenFile={setPopupFilePath}
                remotePeer={remotePeer}
              />
            </div>
          )}

          {visitedTabs.has("favorites") && (
            <div
              style={{
                display: activeTab === "favorites" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <FavoritesConfig
                embedded
                onClose={onClose}
                onOpenFile={setPopupFilePath}
                remotePeer={remotePeer}
                cwd={cwd}
                sessionId={sessionId ?? undefined}
              />
            </div>
          )}

          {visitedTabs.has("mcp") && (
            <div
              style={{
                display: activeTab === "mcp" && (!isMobile || phone.level !== "home") ? "flex" : "none",
                flex: 1,
                minHeight: 0,
                overflow: "hidden",
                flexDirection: "column",
              }}
            >
              <McpConfig
                cwd={cwd ?? null}
                onClose={onClose}
                embedded
                remotePeer={remotePeer}
                trust={trust ?? null}
                onTrustProject={onTrustProject}
                onProjectTrustChanged={onProjectTrustChanged}
              />
            </div>
          )}
        </div>
        </SettingsDetailNavigationContext.Provider>
      </div>

      {/* In-app confirmation dialog on unsaved changes */}
      {pendingAction && (
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="unsaved-changes-dialog-title"
          style={{
            position: "fixed",
            inset: 0,
            zIndex: 1200,
            background: "rgba(0,0,0,0.45)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget && !actionSaving) {
              handleContinueEditing();
            }
          }}
        >
          <div
            style={{
              width: 440,
              maxWidth: "100%",
              background: "var(--bg)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "20px 22px",
              boxShadow: "0 12px 36px rgba(0,0,0,0.28)",
              display: "flex",
              flexDirection: "column",
              gap: 14,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <h3
                id="unsaved-changes-dialog-title"
                style={{ margin: 0, fontSize: 16, fontWeight: 700, color: "var(--text)" }}
              >
                {t("settings.unsavedChangesTitle")}
              </h3>
              <button
                type="button"
                onClick={handleContinueEditing}
                disabled={actionSaving}
                style={{
                  background: "none",
                  border: "none",
                  color: "var(--text-muted)",
                  cursor: "pointer",
                  padding: 4,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 4,
                }}
                aria-label={t("i18n.close")}
              >
                <X size={16} />
              </button>
            </div>

            <p style={{ margin: 0, fontSize: 13, color: "var(--text-muted)", lineHeight: 1.5 }}>
              {t("settings.unsavedChangesDesc")}
            </p>

            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                gap: 8,
                marginTop: 6,
                flexWrap: "wrap",
              }}
            >
              <ConfigButton
                type="button"
                onClick={handleContinueEditing}
                disabled={actionSaving}
              >
                {t("settings.continueEditing")}
              </ConfigButton>

              <ConfigButton
                type="button"
                onClick={handleDiscardPending}
                disabled={actionSaving}
              >
                {pendingAction.type === "switchTab"
                  ? t("settings.discardAndSwitch")
                  : t("settings.discardAndClose")}
              </ConfigButton>

              <ConfigButton variant="primary"
                type="button"
                onClick={handleSavePending}
                disabled={actionSaving}
              >
                {actionSaving
                  ? t("i18n.saving")
                  : pendingAction.type === "switchTab"
                  ? t("settings.saveAndSwitch")
                  : t("settings.saveAndClose")}
              </ConfigButton>
            </div>
          </div>
        </div>
      )}

      {popupFilePath && (
        <FileViewerModal
          filePath={popupFilePath}
          cwd={cwd}
          remotePeer={remotePeer}
          sourceSessionId={sessionId}
          onOpenInReaderView={(targetPath, page, anchor) => {
            setPopupFilePath(null);
            onClose();
            _onOpenFile?.(targetPath, page, anchor);
          }}
          onClose={() => {
            setPopupFilePath(null);
            if (activeTab === "prompts") window.dispatchEvent(new CustomEvent(CUSTOM_PROMPTS_CHANGED_EVENT));
          }}
        />
      )}
    </div>
  );
}
