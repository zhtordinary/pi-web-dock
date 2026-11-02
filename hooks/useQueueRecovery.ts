"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { createQueueRecoveryClient, type QueueRecoveryClient, type QueueRecoveryInput, type QueueRecoveryState } from "@/lib/queue-recovery-client";

export type QueueRecoveryView = QueueRecoveryState & { client: QueueRecoveryClient | null };
const EMPTY: QueueRecoveryState = { entries: [], loading: false, busy: null, copy: null, error: null, warnings: [], notice: null };
export function useQueueRecovery(sessionId: string | null, peer: string | null, input: React.RefObject<QueueRecoveryInput | null> | undefined, onRestored: (operationId: string) => void, onSettled?: (operationId: string) => void, retainedOperation?: React.RefObject<string | null>) {
  const scopeKey = JSON.stringify([sessionId, peer]);
  const [savedView, saveView] = useState<{ scopeKey: string; view: QueueRecoveryView }>({ scopeKey, view: { ...EMPTY, client: null } });
  const setView = useCallback((view: QueueRecoveryView) => saveView({ scopeKey, view }), [scopeKey]);
  const active = useRef<QueueRecoveryClient | null>(null);
  const scope = useRef({ sessionId, peer });
  scope.current = { sessionId, peer };
  const restored = useRef(onRestored); restored.current = onRestored;
  const settled = useRef(onSettled); settled.current = onSettled;
  useEffect(() => {
    if (!sessionId) { active.current = null; setView({ ...EMPTY, client: null }); return; }
    let live = true;
    const client = createQueueRecoveryClient({
      sessionId, peer,
      isCurrent: () => live && scope.current.sessionId === sessionId && scope.current.peer === peer,
      input: () => input?.current ?? null,
      changed: state => setView({ ...state, client }),
      restored: operationId => restored.current(operationId),
      settled: operationId => settled.current?.(operationId),
      retainedOperation: () => retainedOperation?.current ?? null,
      download: (html, filename) => {
        const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
        const link = document.createElement("a"); link.href = url; link.download = filename;
        document.body.appendChild(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      },
    });
    active.current = client;
    setView({ ...EMPTY, client });
    void client.refresh();
    const refresh = () => { void client.refresh(); };
    window.addEventListener("focus", refresh);
    return () => { live = false; if (active.current === client) active.current = null; window.removeEventListener("focus", refresh); };
  }, [sessionId, peer, input, setView, retainedOperation]);
  const refresh = useCallback(() => { void active.current?.refresh(); }, []);
  const ensureAvailable = useCallback(async (expectedSessionId: string, expectedPeer: string | null) => {
    const client = active.current;
    if (!client || scope.current.sessionId !== expectedSessionId || scope.current.peer !== expectedPeer) {
      throw Object.assign(new Error("The conversation changed before queue recovery could be checked"), { notSent: true });
    }
    await client.ensureAvailable();
  }, []);
  return { view: savedView.scopeKey === scopeKey ? savedView.view : { ...EMPTY, client: null }, refresh, ensureAvailable };
}
