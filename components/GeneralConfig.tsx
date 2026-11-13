"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { Play, RotateCcw, Volume2, VolumeX } from "lucide-react";
import { useAudio } from "@/hooks/useAudio";
import { useI18n } from "@/hooks/useI18n";
import { useTheme } from "@/hooks/useTheme";
import { THEME_OPTIONS } from "@/lib/theme";
import { ConfigButton, ConfigSwitch } from "./SettingsUi";
import { ReaderFloatingSelect } from "./ReaderFloatingSelect";
import { ThemeIcon } from "@/components/ThemeIcon";
import {
  loadStoredQuoteShortcut,
  setStoredQuoteShortcut,
  QUOTE_SHORTCUT_CHANGED_EVENT,
  DEFAULT_QUOTE_SHORTCUT,
} from "@/lib/quote-context";
import {
  CHAT_CONTENT_WIDTH_DEFAULT,
  CHAT_CONTENT_WIDTH_MAX,
  CHAT_CONTENT_WIDTH_MIN,
  useChatAppearance,
} from "@/hooks/useChatAppearance";
import { getPushSubscription, pushPermission, requestPushSubscription, unsubscribePushSubscription } from "@/lib/push-client";
import type { Locale } from "@/lib/i18n/types";
import {
  loadSessionOpenScroll,
  setSessionOpenScroll,
  type SessionOpenScroll,
} from "@/lib/session-open-scroll-preference";

function apiFor(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  return `/api/remote/${path}?peer=${encodeURIComponent(peer)}`;
}

export const SESSION_OPEN_SCROLL_OPTIONS: { id: SessionOpenScroll; label: string }[] = [
  { id: "last-question", label: "settings.sessionOpenScrollLastQuestion" },
  { id: "answer-bottom", label: "settings.sessionOpenScrollAnswerBottom" },
];

export const THINKING_EXPANDED_STORAGE_KEY = "pi-thinking-expanded-default";
export const QUOTE_SELECTION_STORAGE_KEY = "pi-quote-selection-enabled";

export const THINKING_EXPANDED_CHANGED_EVENT = "pi-thinking-expanded-changed";
export const QUOTE_SELECTION_CHANGED_EVENT = "pi-quote-selection-changed";

export function loadStoredThinkingExpanded(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return localStorage.getItem(THINKING_EXPANDED_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

export interface GeneralConfigProps {
  quoteSelectionEnabled?: boolean;
  onQuoteSelectionChange?: (enabled: boolean) => void;
  remotePeer?: string;
}

export function GeneralConfig({ quoteSelectionEnabled = true, onQuoteSelectionChange, remotePeer }: GeneralConfigProps) {
  const { t, locale, setLocale, supportedLocales } = useI18n();
  const { preference, setThemePreference } = useTheme();
  const { width: chatWidth, setWidth: setChatWidth } = useChatAppearance();
  const { soundSettings, updateSoundSettings, playPreviewSound } = useAudio();

  const [thinkingExpanded, setThinkingExpanded] = useState(() => loadStoredThinkingExpanded());
  const [quoteSelection, setQuoteSelection] = useState(() => {
    if (typeof window === "undefined") return quoteSelectionEnabled;
    try {
      const stored = localStorage.getItem(QUOTE_SELECTION_STORAGE_KEY);
      return stored !== null ? stored === "true" : quoteSelectionEnabled;
    } catch {
      return quoteSelectionEnabled;
    }
  });
  const [sessionOpenScroll, setSessionOpenScrollState] = useState<SessionOpenScroll>(() => loadSessionOpenScroll());
  const [quoteShortcut, setQuoteShortcut] = useState(() => loadStoredQuoteShortcut());
  const [autoCompactionDefault, setAutoCompactionDefault] = useState<boolean | null>(null);
  const [autoCompactionSaving, setAutoCompactionSaving] = useState(false);
  const [autoCompactionError, setAutoCompactionError] = useState<string | null>(null);
  const [pushPermissionState, setPushPermissionState] = useState<NotificationPermission | "unsupported" | "remote-disabled">("unsupported");
  const [pushSubscribed, setPushSubscribed] = useState(false);
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);

  // A browser service worker and its VAPID subscription belong to this
  // origin. A remote Reader cannot safely reuse or replace that subscription.
  const refreshPushState = useCallback(async () => {
    if (remotePeer) {
      setPushPermissionState("remote-disabled");
      setPushSubscribed(false);
      return;
    }
    setPushPermissionState(pushPermission());
    const subscription = await getPushSubscription();
    setPushSubscribed(Boolean(subscription));
  }, [remotePeer]);

  useEffect(() => {
    void refreshPushState();
    window.addEventListener("focus", refreshPushState);
    return () => window.removeEventListener("focus", refreshPushState);
  }, [refreshPushState]);

  const handlePushSubscribe = useCallback(async () => {
    if (remotePeer || pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    try {
      if (!await requestPushSubscription(locale)) throw new Error(t("settings.pushUnavailable"));
      await refreshPushState();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  }, [locale, pushBusy, refreshPushState, remotePeer, t]);

  const handlePushUnsubscribe = useCallback(async () => {
    if (remotePeer || pushBusy) return;
    setPushBusy(true);
    setPushError(null);
    try {
      if (!await unsubscribePushSubscription()) throw new Error(t("settings.pushUnsubscribeFailed"));
      await refreshPushState();
    } catch (error) {
      setPushError(error instanceof Error ? error.message : String(error));
    } finally {
      setPushBusy(false);
    }
  }, [pushBusy, refreshPushState, remotePeer, t]);

  const handleThinkingChange = useCallback((checked: boolean) => {
    setThinkingExpanded(checked);
    try {
      localStorage.setItem(THINKING_EXPANDED_STORAGE_KEY, String(checked));
      window.dispatchEvent(new Event(THINKING_EXPANDED_CHANGED_EVENT));
    } catch {
      // LocalStorage access denied or quota exceeded
    }
  }, []);

  const handleSessionOpenScrollChange = useCallback((value: SessionOpenScroll) => {
    setSessionOpenScrollState(value);
    setSessionOpenScroll(value);
  }, []);

  const handleQuoteSelectionChange = useCallback((enabled: boolean) => {
    setQuoteSelection(enabled);
    try {
      localStorage.setItem(QUOTE_SELECTION_STORAGE_KEY, String(enabled));
      window.dispatchEvent(new CustomEvent(QUOTE_SELECTION_CHANGED_EVENT, { detail: enabled }));
    } catch {
      // LocalStorage access denied or quota exceeded
    }
    onQuoteSelectionChange?.(enabled);
  }, [onQuoteSelectionChange]);

  const handleQuoteShortcutChange = useCallback((newShortcut: string) => {
    if (newShortcut.toLowerCase().includes("shift+r")) return;
    setQuoteShortcut(newShortcut);
    setStoredQuoteShortcut(newShortcut);
    if (typeof window !== "undefined") {
      window.dispatchEvent(new CustomEvent(QUOTE_SHORTCUT_CHANGED_EVENT, { detail: { shortcut: newShortcut } }));
    }
  }, []);


  useEffect(() => {
    let cancelled = false;
    void fetch(apiFor(remotePeer, "settings/compaction"))
      .then(async (response) => {
        const data = await response.json() as { enabled?: unknown; error?: string };
        if (!response.ok || typeof data.enabled !== "boolean") {
          throw new Error(data.error ?? `HTTP ${response.status}`);
        }
        if (!cancelled) setAutoCompactionDefault(data.enabled);
      })
      .catch((error) => {
        if (!cancelled) setAutoCompactionError(error instanceof Error ? error.message : String(error));
      });
    return () => { cancelled = true; };
  }, [remotePeer]);

  const handleAutoCompactionDefaultChange = useCallback(async (enabled: boolean) => {
    setAutoCompactionSaving(true);
    setAutoCompactionError(null);
    try {
      const response = await fetch(apiFor(remotePeer, "settings/compaction"), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled }),
      });
      const data = await response.json() as { enabled?: unknown; error?: string };
      if (!response.ok || typeof data.enabled !== "boolean") {
        throw new Error(data.error ?? `HTTP ${response.status}`);
      }
      setAutoCompactionDefault(data.enabled);
    } catch (error) {
      setAutoCompactionError(error instanceof Error ? error.message : String(error));
    } finally {
      setAutoCompactionSaving(false);
    }
  }, [remotePeer]);

  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [activeSection, setActiveSection] = useState("general-sec-appearance");
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => setIsMobile(typeof window !== "undefined" && window.innerWidth < 640);
    check();
    window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

  const TOC_ITEMS = [
    { id: "general-sec-appearance", labelKey: "settings.tocAppearance" },
    { id: "general-sec-chat", labelKey: "settings.tocChat" },
    { id: "general-sec-sound", labelKey: "settings.tocSound" },
    { id: "general-sec-push", labelKey: "settings.tocPush" },
    { id: "general-sec-language", labelKey: "settings.tocLanguage" },
  ] as const;

  const scrollToSection = useCallback((sectionId: string) => {
    setActiveSection(sectionId);
    const target = document.getElementById(sectionId);
    if (target) {
      target.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  }, []);

  const handleContentScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const scrollPos = container.scrollTop + 100;
    for (let i = TOC_ITEMS.length - 1; i >= 0; i--) {
      const el = document.getElementById(TOC_ITEMS[i].id);
      if (el && el.offsetTop <= scrollPos) {
        setActiveSection(TOC_ITEMS[i].id);
        break;
      }
    }
  }, [TOC_ITEMS]);

  return (
    <div style={{ display: "flex", flex: 1, height: "100%", minHeight: 0, overflow: "hidden" }}>
      {!isMobile && (
        <nav
          aria-label={t("settings.general")}
          style={{
            width: 130,
            flexShrink: 0,
            borderRight: "1px solid var(--border)",
            padding: "18px 8px 18px 12px",
            display: "flex",
            flexDirection: "column",
            gap: 4,
            background: "var(--bg-panel, rgba(0,0,0,0.02))",
            overflowY: "auto",
          }}
        >
          <div style={{ padding: "0 6px 8px", fontSize: 11, fontWeight: 600, color: "var(--text-dim)", letterSpacing: "0.5px" }}>
            {t("settings.general")}
          </div>
          {TOC_ITEMS.map((item) => {
            const active = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => scrollToSection(item.id)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  padding: "7px 10px",
                  borderRadius: 6,
                  fontSize: 12,
                  border: "none",
                  background: active ? "var(--bg-selected, rgba(59,130,246,0.12))" : "transparent",
                  color: active ? "var(--accent, #3b82f6)" : "var(--text-muted)",
                  fontWeight: active ? 600 : 400,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s ease",
                }}
              >
                <span>{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>
      )}

      <div
        ref={scrollContainerRef}
        onScroll={handleContentScroll}
        style={{ padding: "20px 24px", overflowY: "auto", flex: 1, display: "flex", flexDirection: "column", gap: 28 }}
      >
        <div>
          <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0, color: "var(--text)" }}>
            {t("settings.general")}
          </h2>
        </div>

        {/* 外观 */}
        <section id="general-sec-appearance" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <div>
          <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>
            {t("settings.appearance")}
          </h3>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "5px 0 0" }}>
            {t("settings.appearanceDescription")}
          </p>
        </div>
        <div role="radiogroup" aria-label={t("settings.appearance")} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {THEME_OPTIONS.map((option) => {
            const selected = preference === option.id;
            return (
              <label
                key={option.id}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 7,
                  padding: "8px 10px",
                  border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                  borderRadius: 7,
                  color: selected ? "var(--text)" : "var(--text-muted)",
                  background: selected ? "var(--bg-selected)" : "transparent",
                  cursor: "pointer",
                  fontSize: 12,
                }}
              >
                <input
                  type="radio"
                  name="theme"
                  value={option.id}
                  checked={selected}
                  onChange={() => setThemePreference(option.id)}
                />
                <ThemeIcon preference={option.id} />
                <span>{t(option.label)}</span>
              </label>
            );
          })}
        </div>
      </section>

      {/* 对话 */}
      <section id="general-sec-chat" style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>
          {t("settings.chat")}
        </h3>

        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {/* 打开会话时的定位 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <span style={{ display: "block", fontSize: 13, color: "var(--text)" }}>
                {t("settings.sessionOpenScroll")}
              </span>
              <span style={{ display: "block", marginTop: 4, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>
                {t("settings.sessionOpenScrollDescription")}
              </span>
            </div>
            <div
              role="radiogroup"
              aria-label={t("settings.sessionOpenScroll")}
              style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
            >
              {SESSION_OPEN_SCROLL_OPTIONS.map((option) => {
                const selected = sessionOpenScroll === option.id;
                return (
                  <label
                    key={option.id}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      gap: 7,
                      padding: "8px 10px",
                      border: `1px solid ${selected ? "var(--accent)" : "var(--border)"}`,
                      borderRadius: 7,
                      color: selected ? "var(--text)" : "var(--text-muted)",
                      background: selected ? "var(--bg-selected)" : "transparent",
                      cursor: "pointer",
                      fontSize: 12,
                    }}
                  >
                    <input
                      type="radio"
                      name="sessionOpenScroll"
                      value={option.id}
                      checked={selected}
                      onChange={() => handleSessionOpenScrollChange(option.id)}
                    />
                    <span>{t(option.label)}</span>
                  </label>
                );
              })}
            </div>
          </div>

          {/* 新会话默认自动压缩 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, color: "var(--text)" }}>
                {t("settings.autoCompactionDefault")}
              </span>
              <span style={{ display: "block", marginTop: 4, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>
                {t("settings.autoCompactionDefaultDescription")}
              </span>
            </div>
            <ConfigSwitch
              checked={autoCompactionDefault === true}
              disabled={autoCompactionDefault === null || autoCompactionSaving}
              label={t("settings.autoCompactionDefault")}
              onChange={(enabled) => void handleAutoCompactionDefaultChange(enabled)}
            />
          </div>
          {autoCompactionError && (
            <p role="alert" style={{ margin: "-6px 0 0", color: "#ef4444", fontSize: 11 }}>
              {t("settings.autoCompactionLoadFailed")} {autoCompactionError}
            </p>
          )}
          {/* 默认展开思考块 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              {t("settings.thinkingExpandedDefault")}
            </span>
            <ConfigSwitch
              checked={thinkingExpanded}
              label={t("settings.thinkingExpandedDefault")}
              onChange={handleThinkingChange}
            />
          </div>

          {/* 选中文字时显示提问浮窗 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, color: "var(--text)" }}>
              {t("settings.quoteSelection")}
            </span>
            <ConfigSwitch
              checked={quoteSelection}
              label={t("settings.quoteSelection")}
              onChange={handleQuoteSelectionChange}
            />
          </div>

          {/* 在当前对话询问快捷键 */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}>
            <div style={{ minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, color: "var(--text)" }}>
                {t("settings.quoteShortcut")}
              </span>
              <span style={{ display: "block", marginTop: 4, fontSize: 11, lineHeight: 1.45, color: "var(--text-muted)" }}>
                {t("settings.quoteShortcutDesc")}
              </span>
            </div>
            <ReaderFloatingSelect
              appearance="field"
              containerStyle={{ width: "auto" }}
              triggerStyle={{ fontFamily: "var(--font-mono)" }}
              value={quoteShortcut}
              onChange={handleQuoteShortcutChange}
              ariaLabel={t("settings.quoteShortcut")}
              options={[
                { value: "Mod+e", label: "⌘E / Ctrl+E (" + t("i18n.default") + ")" },
                { value: "Alt+e", label: "⌥E / Alt+E" },
                { value: "Mod+k", label: "⌘K / Ctrl+K" },
              ]}
            />
          </div>

          {/* 聊天内容宽度 */}
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: "var(--text)" }}>
                {t("settings.chatContentWidth")}
              </span>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, fontFamily: "var(--font-mono)", color: "var(--text-muted)" }}>
                  {chatWidth}%
                </span>
                <ConfigButton variant="ghost" size="small" className="config-button-icon"
                  type="button"
                  title={t("settings.resetChatContentWidth")}
                  aria-label={t("settings.resetChatContentWidth")}
                  disabled={chatWidth === CHAT_CONTENT_WIDTH_DEFAULT}
                  onClick={() => setChatWidth(CHAT_CONTENT_WIDTH_DEFAULT)}
                >
                  <RotateCcw size={14} />
                </ConfigButton>
              </div>
            </div>
            <input
              type="range"
              min={CHAT_CONTENT_WIDTH_MIN}
              max={CHAT_CONTENT_WIDTH_MAX}
              step={5}
              value={chatWidth}
              aria-label={t("settings.chatContentWidth")}
              onChange={(e) => setChatWidth(Number(e.target.value))}
              style={{ width: "100%", accentColor: "var(--accent, #3b82f6)", cursor: "pointer" }}
            />
          </div>

        </div>
      </section>

      {/* 提示音 */}
      <section id="general-sec-sound" style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 16 }}>
          <div>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {soundSettings.enabled ? (
                <Volume2 size={16} strokeWidth={2} style={{ color: "var(--accent, #3b82f6)" }} />
              ) : (
                <VolumeX size={16} strokeWidth={2} style={{ color: "var(--text-dim)" }} />
              )}
              <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>
                {t("settings.soundTitle")}
              </h3>
            </div>
            <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "5px 0 0" }}>
              {t("settings.soundDescription")}
            </p>
          </div>
          <ConfigSwitch
            checked={soundSettings.enabled}
            label={t("settings.soundTitle")}
            onChange={(enabled) => updateSoundSettings({ enabled })}
          />
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 10,
            opacity: soundSettings.enabled ? 1 : 0.45,
            pointerEvents: soundSettings.enabled ? "auto" : "none",
            transition: "opacity 0.15s ease",
          }}
        >
          {/* 完成提示音 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                {t("settings.soundDone")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>
                {t("settings.soundDoneDesc")}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <ConfigButton size="small"
                type="button"
                onClick={() => void playPreviewSound("done")}
                title={t("settings.soundPreviewDone")}
              >
                <Play size={11} fill="currentColor" />
                <span>{t("settings.soundPreview")}</span>
              </ConfigButton>
              <ConfigSwitch
                checked={soundSettings.done}
                label={t("settings.soundDone")}
                onChange={(done) => updateSoundSettings({ done })}
              />
            </div>
          </div>

          {/* 报错失败提示音 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                {t("settings.soundError")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>
                {t("settings.soundErrorDesc")}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <ConfigButton size="small"
                type="button"
                onClick={() => void playPreviewSound("error")}
                title={t("settings.soundPreviewError")}
              >
                <Play size={11} fill="currentColor" />
                <span>{t("settings.soundPreview")}</span>
              </ConfigButton>
              <ConfigSwitch
                checked={soundSettings.error}
                label={t("settings.soundError")}
                onChange={(error) => updateSoundSettings({ error })}
              />
            </div>
          </div>

          {/* 等待交互提示音 */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "10px 14px",
              background: "var(--bg-panel)",
              border: "1px solid var(--border)",
              borderRadius: 8,
              gap: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <span style={{ display: "block", fontSize: 13, fontWeight: 500, color: "var(--text)" }}>
                {t("settings.soundWait")}
              </span>
              <span style={{ display: "block", marginTop: 2, fontSize: 11, color: "var(--text-muted)" }}>
                {t("settings.soundWaitDesc")}
              </span>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
              <ConfigButton size="small"
                type="button"
                onClick={() => void playPreviewSound("wait")}
                title={t("settings.soundPreviewWait")}
              >
                <Play size={11} fill="currentColor" />
                <span>{t("settings.soundPreview")}</span>
              </ConfigButton>
              <ConfigSwitch
                checked={soundSettings.wait}
                label={t("settings.soundWait")}
                onChange={(wait) => updateSoundSettings({ wait })}
              />
            </div>
          </div>
        </div>
      </section>

      {/* Web Push */}
      <section id="general-sec-push" aria-labelledby="general-web-push-heading" style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <div>
          <h3 id="general-web-push-heading" style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>
            {t("settings.pushTitle")}
          </h3>
          <p style={{ fontSize: 12, color: "var(--text-muted)", margin: "5px 0 0", lineHeight: 1.45 }}>
            {t("settings.pushDescription")}
          </p>
        </div>
        <div role="status" aria-live="polite" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
          <span style={{ fontSize: 12, color: pushPermissionState === "denied" ? "#dc2626" : "var(--text-muted)" }}>
            {pushPermissionState === "remote-disabled"
              ? t("settings.pushRemoteDisabled")
              : pushPermissionState === "unsupported"
                ? t("settings.pushUnsupported")
                : pushPermissionState === "denied"
                  ? t("settings.pushDenied")
                  : pushSubscribed ? t("settings.pushSubscribed") : t("settings.pushNotSubscribed")}
          </span>
          {pushSubscribed ? (
            <ConfigButton type="button" onClick={() => void handlePushUnsubscribe()} disabled={pushBusy} aria-busy={pushBusy}>
              {pushBusy ? t("settings.pushWorking") : t("settings.pushUnsubscribe")}
            </ConfigButton>
          ) : pushPermissionState !== "unsupported" && pushPermissionState !== "denied" && pushPermissionState !== "remote-disabled" ? (
            <ConfigButton variant="primary" type="button" onClick={() => void handlePushSubscribe()} disabled={pushBusy} aria-busy={pushBusy}>
              {pushBusy ? t("settings.pushWorking") : t("settings.pushSubscribe")}
            </ConfigButton>
          ) : null}
        </div>
        {pushError && <p role="alert" style={{ margin: 0, color: "#dc2626", fontSize: 11 }}>{pushError}</p>}
      </section>


      {/* 语言 */}
      <section id="general-sec-language" style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0, color: "var(--text)" }}>
          {t("common.language")}
        </h3>
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {supportedLocales.map((loc) => {
            const isSelected = locale === loc.id;
            return (
              <button
                key={loc.id}
                type="button"
                onClick={() => setLocale(loc.id as Locale)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  padding: "10px 14px",
                  borderRadius: 8,
                  border: isSelected ? "1px solid var(--accent, #3b82f6)" : "1px solid var(--border)",
                  background: isSelected ? "var(--bg-selected, rgba(59, 130, 246, 0.08))" : "var(--bg-panel)",
                  color: "var(--text)",
                  fontSize: 13,
                  cursor: "pointer",
                  textAlign: "left",
                  transition: "all 0.15s ease",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <div
                    style={{
                      width: 16,
                      height: 16,
                      borderRadius: "50%",
                      border: isSelected ? "5px solid var(--accent, #3b82f6)" : "1px solid var(--border)",
                      backgroundColor: "var(--bg)",
                    }}
                  />
                  <span style={{ fontWeight: isSelected ? 600 : 400 }}>{loc.label}</span>
                </div>
                <span style={{ fontSize: 11, color: "var(--text-muted)", fontFamily: "var(--font-mono)" }}>
                  {loc.id}
                </span>
              </button>
            );
          })}
        </div>
      </section>
      </div>
    </div>
  );
}
