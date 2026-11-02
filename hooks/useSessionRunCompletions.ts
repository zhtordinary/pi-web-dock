"use client";

import { useEffect, useRef } from "react";
import { openReaderEventSource } from "@/lib/reader-events-client";
import { fetchSessionActivity } from "@/lib/session-activity-fetch";
import { completedSessionRuns, type InitialSessionRunStart } from "@/lib/session-run-completion";
import { applySessionActivityEvent, type SessionActivityEventPayload } from "@/lib/session-activity-client";
import type { SessionActivityItem, SessionActivityResponse } from "@/lib/session-activity-types";

/** The global registry owns completion even when no ChatWindow is mounted. */
export function useSessionRunCompletions(
  scope: "local" | "all",
  onComplete: (item: SessionActivityItem) => void,
): void {
  const onCompleteRef = useRef(onComplete);
  onCompleteRef.current = onComplete;
  useEffect(() => {
    let snapshot: SessionActivityResponse | null = null;
    // Only pre-inventory starts: one per device/session, drained when snapshots carry their run.
    let initialStarts: InitialSessionRunStart[] = [];
    let cancelled = false;
    let inFlight = false;
    let dirty = false;
    let revision = 0;
    const refresh = async () => {
      if (cancelled) return;
      if (inFlight) { dirty = true; return; }
      inFlight = true;
      dirty = false;
      const requestedRevision = revision;
      try {
        let next = await fetchSessionActivity<SessionActivityResponse>(
          `/api/session-runs?scope=${scope}&view=completion&refresh=1`, { force: true },
        );
        if (cancelled || requestedRevision !== revision || !next?.sessions) return;
        // A temporarily offline peer has no fresh inventory; retain its last observed runs.
        const offline = new Set(next.devices.filter((device) => device.online === false).map((device) => device.id));
        if (snapshot && offline.size) {
          next = { ...next, sessions: [...next.sessions, ...snapshot.sessions
            .filter((item) => offline.has(item.device.id))
            .map((item) => ({ ...item, device: { ...item.device, online: false } }))] };
        }
        const completed = completedSessionRuns(snapshot, next, initialStarts);
        snapshot = next;
        initialStarts = initialStarts.filter((start) => !next.sessions.some((item) => (
          item.device.online !== false && item.device.id === start.device && item.session.id === start.sessionId
          && (item.latestRun?.runId === start.runId || item.runs.some((run) => run.runId === start.runId))
        )));
        for (const item of completed) onCompleteRef.current(item);
      } catch {
        // Keep the last good snapshot; a failed read is not a terminal transition.
      } finally {
        inFlight = false;
        if (dirty && !cancelled) void refresh();
      }
    };
    const source = openReaderEventSource(["activity", "peer_state", "activity_meta"]);
    source.onopen = () => { void refresh(); };
    source.onmessage = (message: MessageEvent<string>) => {
      try {
        const event = JSON.parse(message.data) as SessionActivityEventPayload;
        // A live start can precede its snapshot, including a short foreground turn.
        if (event.type === "activity" && event.kind !== "session" && event.status === "running" && !event.replay
          && typeof event.device === "string" && event.device
          && typeof event.sessionId === "string" && event.sessionId
          && typeof event.runId === "string" && event.runId) {
          if (!snapshot) {
            initialStarts = initialStarts.filter((start) => start.device !== event.device || start.sessionId !== event.sessionId);
            initialStarts.push({ device: event.device, sessionId: event.sessionId, runId: event.runId });
          } else {
            const item = snapshot.sessions.find((candidate) => candidate.session.id === event.sessionId
              && candidate.device.id === event.device);
            if (item && (item.latestRun?.runId !== event.runId || item.latestRun?.status === "running")) {
              snapshot = applySessionActivityEvent(snapshot, event).response;
            }
          }
        }
        revision += 1;
        void refresh();
      } catch { /* Malformed broker messages cannot change completion state. */ }
    };
    void refresh();
    // Hidden documents still observe completions; audio/notification eligibility is separate.
    const timer = window.setInterval(() => { void refresh(); }, 15_000);
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      initialStarts = [];
      source.close();
      window.clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [scope]);
}
