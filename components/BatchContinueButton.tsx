"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { useI18n } from "@/hooks/useI18n";
import { useIsMobile } from "@/hooks/useIsMobile";
import { fetchSessionActivity, clearSessionActivityCache } from "@/lib/session-activity-fetch.ts";
import { openReaderEventSource } from "@/lib/reader-events-client.ts";
import type { SessionActivityItem, SessionActivityResponse } from "@/lib/session-activity-types.ts";
import {
  filterContinuableSessions,
  shouldShowBatchContinue,
  continueAllSessions,
  type BatchContinueResult,
} from "@/lib/batch-continue.ts";

export interface BatchContinueButtonProps {
  onContinued?: (results: BatchContinueResult) => void;
}

export function BatchContinueFeedback({ result, onClose }: { result: BatchContinueResult; onClose: () => void }) {
  const { t } = useI18n();
  const issues = result.issues.filter((issue) => issue.code !== "runtime_busy");
  if (issues.length === 0) return null;
  const uncertain = issues.filter((issue) => issue.uncertain).length;
  return (
    <div role="status" aria-live="polite" style={{ position: "fixed", top: 48, right: 12, zIndex: 500,
      width: "min(420px, calc(100vw - 24px))", maxHeight: "50vh", overflowY: "auto", padding: "10px 12px",
      borderRadius: 10, background: "var(--bg-panel)", color: "var(--text)", border: "1px solid var(--border)",
      boxShadow: "0 6px 24px rgba(0,0,0,.14)", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>
      <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
        <strong style={{ flex: 1 }}>{t("session.batchContinueResult", { accepted: result.succeeded.length, rejected: issues.length - uncertain, uncertain })}</strong>
        <button type="button" onClick={onClose} aria-label={t("session.batchContinueDismiss")}
          style={{ border: "none", background: "transparent", color: "var(--text-muted)", cursor: "pointer", padding: "0 4px", fontSize: 16 }}>×</button>
      </div>
      <p style={{ margin: "6px 0", color: "var(--text-muted)" }}>{t("session.batchContinueAcceptedHint")}</p>
      {uncertain > 0 && <p style={{ margin: "6px 0" }}>{t("session.batchContinueUncertainHint")}</p>}
      {issues.length > 0 && <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
        {issues.map((issue) => <li key={`${issue.deviceId}:${issue.sessionId}`}>
          {issue.label} · {t(issue.uncertain ? "session.batchContinueUncertain" : "session.batchContinueRejected")}: {issue.error}
        </li>)}
      </ul>}
    </div>
  );
}

export function BatchContinueButton({ onContinued }: BatchContinueButtonProps) {
  const { t } = useI18n();
  const isMobile = useIsMobile();
  const [sessions, setSessions] = useState<SessionActivityItem[]>([]);
  const [localDeviceId, setLocalDeviceId] = useState<string | undefined>();
  const [isContinuing, setIsContinuing] = useState(false);
  const [result, setResult] = useState<BatchContinueResult | null>(null);
  const continuingRef = useRef(false);
  const refreshTimerRef = useRef<number | null>(null);

  const refreshContinuableSessions = useCallback(async (force = false) => {
    try {
      const data = await fetchSessionActivity<SessionActivityResponse>(
        "/api/session-runs?scope=all",
        { force },
      );
      if (data?.device?.id) setLocalDeviceId(data.device.id);
      setSessions(filterContinuableSessions(data?.sessions));
    } catch {
      // Keep the last observed candidates until activity can be refreshed.
    }
  }, []);

  useEffect(() => {
    void refreshContinuableSessions();
    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === "visible") void refreshContinuableSessions(true);
    };
    window.addEventListener("focus", handleVisibilityOrFocus);
    document.addEventListener("visibilitychange", handleVisibilityOrFocus);

    const source = openReaderEventSource(["activity", "running", "peer_state"]);
    source.onopen = () => { void refreshContinuableSessions(); };
    source.onmessage = () => {
      if (refreshTimerRef.current !== null) return;
      refreshTimerRef.current = window.setTimeout(() => {
        refreshTimerRef.current = null;
        void refreshContinuableSessions(true);
      }, 500);
    };
    const intervalId = window.setInterval(() => {
      if (document.visibilityState === "visible") void refreshContinuableSessions();
    }, 15_000);

    return () => {
      window.removeEventListener("focus", handleVisibilityOrFocus);
      document.removeEventListener("visibilitychange", handleVisibilityOrFocus);
      source.close();
      window.clearInterval(intervalId);
      if (refreshTimerRef.current !== null) {
        window.clearTimeout(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
    };
  }, [refreshContinuableSessions]);

  const handleContinueAll = async () => {
    if (continuingRef.current || sessions.length === 0) return;
    continuingRef.current = true;
    setIsContinuing(true);
    setResult(null);
    try {
      const results = await continueAllSessions(sessions, localDeviceId);
      setResult(results);
      clearSessionActivityCache();
      window.dispatchEvent(new CustomEvent("reader:refresh-activity"));
      onContinued?.(results);
      await refreshContinuableSessions(true);
    } catch (error) {
      setResult({
        succeeded: [],
        failed: sessions.map((item) => item.session.id),
        issues: sessions.map((item) => ({ sessionId: item.session.id, deviceId: item.device.id, label: item.session.name || item.session.id,
          error: error instanceof Error ? error.message : String(error), uncertain: true })),
      });
    } finally {
      continuingRef.current = false;
      setIsContinuing(false);
    }
  };

  const count = sessions.length;
  const showButton = shouldShowBatchContinue(count) || isContinuing;
  const label = t(isContinuing ? "session.batchContinuing" : "session.batchContinueCount", { count });
  const title = t("session.batchContinueTitle", { count });

  return (
    <>
      {showButton && <button
        type="button"
        onClick={() => void handleContinueAll()}
        disabled={isContinuing}
        title={title}
        aria-label={title}
        data-action="batch-continue"
        style={{
          display: "flex", alignItems: "center", justifyContent: "center", gap: 6, height: "100%",
          padding: isMobile ? "0 8px" : "0 10px",
          background: isContinuing ? "rgba(234, 88, 12, 0.22)" : "rgba(234, 88, 12, 0.12)",
          border: "none", borderLeft: "1px solid var(--border)", color: "#ea580c",
          cursor: isContinuing ? "wait" : "pointer", flexShrink: 0, fontSize: 11, fontWeight: 600,
          whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums", transition: "background 0.15s, color 0.15s",
        }}
        onMouseEnter={(event) => { if (!isContinuing) event.currentTarget.style.background = "rgba(234, 88, 12, 0.22)"; }}
        onMouseLeave={(event) => { if (!isContinuing) event.currentTarget.style.background = "rgba(234, 88, 12, 0.12)"; }}
      >
        {isContinuing ? (
          <svg className="animate-spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" opacity="0.25" />
            <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <polyline points="5 2 11 7 5 12" />
            <line x1="2" y1="7" x2="10" y2="7" />
          </svg>
        )}
        {!isMobile ? <span>{label}</span> : <span style={{ fontSize: 11, fontWeight: 700 }}>{count}</span>}
      </button>}
      {result && result.issues.length > 0 && <BatchContinueFeedback result={result} onClose={() => setResult(null)} />}
    </>
  );
}
