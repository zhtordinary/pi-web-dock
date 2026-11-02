"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import {
  emptySessionDetailsSnapshot,
  ensureSessionCost,
  ensureSessionPreview,
  ensureSessionUserQuestions,
  readSessionDetails,
  sessionDetailsKey,
  subscribeSessionDetails,
  type SessionDetailsRequest,
} from "@/lib/session-details-client";

interface Options {
  sessionId: string | null;
  version?: string;
  costView?: SessionDetailsRequest["costView"];
  modelConfigRevision?: number;
  peer?: string;
  deviceId?: string;
  loadCost?: boolean;
  loadPreview?: boolean;
  loadUserQuestions?: boolean;
}

export function useSessionDetails({ sessionId, version = "", costView, peer, deviceId, modelConfigRevision, loadCost = false, loadPreview = false, loadUserQuestions = false }: Options) {
  const request = useMemo<SessionDetailsRequest | null>(
    () => sessionId ? { sessionId, version, costView, peer, deviceId, modelConfigRevision } : null,
    [costView, deviceId, modelConfigRevision, peer, sessionId, version],
  );
  const key = request ? sessionDetailsKey(request) : "";
  const snapshot = useSyncExternalStore(
    (listener) => request ? subscribeSessionDetails(key, listener) : () => {},
    () => request ? readSessionDetails(key) : emptySessionDetailsSnapshot,
    () => emptySessionDetailsSnapshot,
  );

  useEffect(() => {
    if (!request || !loadCost) return;
    void ensureSessionCost(request);
  }, [loadCost, request, snapshot.cost]);
  useEffect(() => {
    if (!request || !loadPreview) return;
    void ensureSessionPreview(request);
  }, [loadPreview, request, snapshot.preview]);
  useEffect(() => {
    if (!request || !loadUserQuestions) return;
    void ensureSessionUserQuestions(request);
  }, [loadUserQuestions, request, snapshot.userQuestions]);

  return snapshot;
}
