"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { loadAgentFamily, type AgentFamilySnapshot } from "@/lib/agent-family";
import type { SessionActivityItem } from "@/lib/session-activity-types";
import { AgentSessionPanel } from "./AgentSessionPanel";

export function AgentFamilyMenu({
  sessionId, deviceId, peer, includeHidden, archived, onSelectSession,
}: {
  sessionId: string;
  deviceId: string;
  peer?: string;
  includeHidden: boolean;
  archived: boolean;
  onSelectSession: (item: SessionActivityItem) => void;
}) {
  const { t } = useI18n();
  const [snapshot, setSnapshot] = useState<AgentFamilySnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    let disposed = false;
    let inFlight = false;
    const refresh = async () => {
      if (inFlight || document.hidden) return;
      inFlight = true;
      try {
        const result = await loadAgentFamily(sessionId, deviceId, peer, includeHidden, archived);
        if (!disposed) { setSnapshot(result); setFailed(false); }
      } catch {
        if (!disposed) { setSnapshot(null); setFailed(true); }
      } finally {
        inFlight = false;
      }
    };
    void refresh();
    const timer = window.setInterval(() => { void refresh(); }, 5_000);
    document.addEventListener("visibilitychange", refresh);
    return () => { disposed = true; window.clearInterval(timer); document.removeEventListener("visibilitychange", refresh); };
  }, [sessionId, deviceId, peer, includeHidden, archived, revision]);

  if (failed) {
    return <div role="alert" style={{ padding: 16, background: "var(--bg-panel)", color: "var(--text-muted)" }}>
      {t("sessionActivity.loadFailed")}{" "}
      <button type="button" onClick={() => { setFailed(false); setRevision((value) => value + 1); }}>{t("sessionActivity.refresh")}</button>
    </div>;
  }
  if (!snapshot) return <div role="status" style={{ padding: 16, background: "var(--bg-panel)", color: "var(--text-muted)" }}>{t("sessionActivity.loading")}</div>;
  return <AgentSessionPanel
    rootSession={snapshot.family.root}
    subagents={snapshot.family.subagents}
    selectedSessionId={sessionId}
    runningSessionIds={snapshot.runningSessionIds}
    onSelectSession={(session) => {
      const item = snapshot.items.find((candidate) => candidate.session.id === session.id);
      if (item) onSelectSession(item);
    }}
  />;
}
