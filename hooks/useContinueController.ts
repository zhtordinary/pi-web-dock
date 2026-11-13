"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentMessage } from "@/lib/types";
import {
  CONTINUE_TEXT,
  continueRetryMode,
  errorKey,
  hasPreviousContinueWithoutOutput,
  lastAssistantClassification,
  lastUserMessageIsManual,
  nextBackoffDelayMs,
  type SchedulerState,
} from "@/lib/continue-logic";

/**
 * Continue-button / unattended auto-continue controller.
 *
 * Rules (agreed design):
 * - An errored empty assistant message classifies as transient / overflow / fatal.
 * - Manual mode: error shows the continue button; one click starts a flow that
 *   keeps auto-resending with backoff until real assistant output appears
 *   (honcho memory injections are custom messages and never count).
 * - Unattended: the flow starts automatically on transient errors.
 * - Overflow errors compact once first, never blind-retry.
 * - Aborted turns and any new manual user message cancel the current flow;
 *   the session-level unattended preference stays unchanged for later turns.
 * - Unattended flow stops after MAX_AUTO_ATTEMPTS with a visible notice.
 */

export type ContinueUiState =
  | { kind: "idle" }
  | { kind: "awaiting"; errorText: string | null }
  | { kind: "running"; errorText: string | null; auto: boolean; attempt: number; nextDelayMs: number | null }
  | { kind: "stopped"; errorText: string | null; reason: "limit" | "fatal" | "restart" };

interface Options {
  scopeKey: string;
  messages: AgentMessage[];
  agentRunning: boolean;
  isCompacting: boolean;
  onSendContinue: () => void;
  onRetryContinue: () => void;
  onCompact: () => void;
}

export function useContinueController({
  scopeKey,
  messages,
  agentRunning,
  isCompacting,
  onSendContinue,
  onRetryContinue,
  onCompact,
}: Options) {
  const [ui, setUi] = useState<ContinueUiState>({ kind: "idle" });
  const [unattended, setUnattended] = useState(true);

  const serverStateKnownRef = useRef(false);
  const flowActiveRef = useRef(false); // continue flow started (button or unattended)
  const resumeRequiredRef = useRef(false); // restart recovery needs an explicit click
  const autoCountRef = useRef(0); // auto-sent continues in the current flow
  const backoffRef = useRef(0); // next backoff index
  const processedKeyRef = useRef<string | null>(null); // last handled error key
  const compactedKeyRef = useRef<string | null>(null); // error key already compacted
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const unattendedRef = useRef(unattended);
  const optsRef = useRef({ onSendContinue, onRetryContinue, onCompact });
  optsRef.current = { onSendContinue, onRetryContinue, onCompact };
  unattendedRef.current = unattended;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  // Unmount / session switch cleanup.
  useEffect(() => clearTimer, [clearTimer]);

  const resetFlow = useCallback(() => {
    clearTimer();
    flowActiveRef.current = false;
    resumeRequiredRef.current = false;
    autoCountRef.current = 0;
    backoffRef.current = 0;
    compactedKeyRef.current = null;
    processedKeyRef.current = null;
  }, [clearTimer]);

  useEffect(() => {
    resetFlow();
    serverStateKnownRef.current = false;
    setUi({ kind: "idle" });
  }, [scopeKey, resetFlow]);

  const applyUnattendedState = useCallback((state: SchedulerState | null) => {
    serverStateKnownRef.current = true;
    if (!state) {
      resetFlow();
      setUi((current) => current.kind === "running" ? { kind: "idle" } : current);
      return;
    }
    if (state.active) {
      resumeRequiredRef.current = false;
      // Server owns retry timing. Replacing the local timer matters after a
      // tab remount: nextDelayMs is a snapshot, while nextRetryAt preserves
      // time already spent away from this page.
      clearTimer();
      setUi((current) => current.kind === "running"
        ? { ...current, attempt: state.attempt, nextDelayMs: state.nextDelayMs }
        : {
            kind: "running",
            errorText: state.errorMessage,
            auto: true,
            attempt: state.attempt,
            nextDelayMs: state.nextDelayMs,
          });
      flowActiveRef.current = true;
      backoffRef.current = state.attempt;
      autoCountRef.current = state.attempt;
      if (state.nextDelayMs != null) {
        const deadline = typeof state.nextRetryAt === "number"
          ? state.nextRetryAt
          : Date.now() + state.nextDelayMs;
        countdownTimerRef.current = setInterval(() => {
          const remaining = Math.max(0, deadline - Date.now());
          setUi((current) => current.kind === "running" ? { ...current, nextDelayMs: remaining } : current);
        }, 250);
      }
      return;
    }
    // Server stopped the flow (idle / limit / fatal / manual / restart).
    if (state.reason === "limit") {
      clearTimer();
      flowActiveRef.current = false;
      setUi({ kind: "stopped", reason: "limit", errorText: state.errorMessage });
    } else if (state.reason === "fatal") {
      clearTimer();
      flowActiveRef.current = false;
      setUi({ kind: "stopped", reason: "fatal", errorText: state.errorMessage });
    } else if (state.reason === "restart") {
      clearTimer();
      flowActiveRef.current = false;
      resumeRequiredRef.current = true;
      setUi({ kind: "stopped", reason: "restart", errorText: state.errorMessage });
    } else {
      resetFlow();
      setUi({ kind: "idle" });
    }
  }, [clearTimer, resetFlow]);

  const toggleUnattended = useCallback(() => {
    setUnattended((prev) => {
      const next = !prev;
      if (!next) resetFlow();
      return next;
    });
  }, [resetFlow]);

  /** Manual continue click: send a first continue, or retry the existing one. */
  const triggerContinue = useCallback(() => {
    clearTimer();
    resumeRequiredRef.current = false;
    // Mirrors the server's continueRetryMode: a failed assistant tail or a
    // continue user tail with no effective output is retried in place, never
    // by appending another user message.
    const retryPrevious = flowActiveRef.current || continueRetryMode(messages) !== "none";
    flowActiveRef.current = true;
    backoffRef.current = 0;
    setUi({
      kind: "running",
      errorText: null,
      auto: unattendedRef.current,
      attempt: autoCountRef.current,
      nextDelayMs: null,
    });
    if (retryPrevious) optsRef.current.onRetryContinue();
    else optsRef.current.onSendContinue();
  }, [clearTimer, messages]);

  /**
   * "停止自动继续": cancel the pending auto-retry countdown and switch
   * unattended off. Turning the mode off also clears the server scheduler
   * (useAgentSession syncs set_unattended(false)), so the retry stops even
   * when this page was closed during the wait. The error tail stays visible
   * as a manual continue button.
   */
  const stopAutoRetry = useCallback(() => {
    setUnattended(false);
    resetFlow();
    setUi({ kind: "idle" });
  }, [resetFlow]);

  // Manual recovery uses the transcript; unattended execution uses the server snapshot.
  useEffect(() => {
    if (unattendedRef.current && serverStateKnownRef.current) return;
    // A manual (non-continue) user message cancels only the current automatic
    // flow. Do this before the running guard so the old timer and attempt
    // counter are gone while the new prompt is still in flight. Keep the
    // session-level unattended preference enabled for the next turn.
    if (lastUserMessageIsManual(messages)) {
      if (resumeRequiredRef.current || flowActiveRef.current || ui.kind !== "idle") {
        resetFlow();
        setUi({ kind: "idle" });
      }
      return;
    }

    // Wait until the agent is fully idle and any compaction finished.
    if (agentRunning || isCompacting) return;

    // A persisted retry found after process restart is paused until the user
    // explicitly clicks Continue; do not let the transcript effect auto-start it.
    if (resumeRequiredRef.current) return;

    const last = lastAssistantClassification(messages);
    if (!last || last.kind === "none") {
      // Real output happened (or no assistant message): flow resolved.
      if (flowActiveRef.current || ui.kind !== "idle") {
        resetFlow();
        setUi({ kind: "idle" });
      }
      return;
    }

    const key = errorKey(last.msg);
    if (processedKeyRef.current === key) return; // already handled this error
    processedKeyRef.current = key;

    const errText = last.msg.errorMessage ?? null;

    if (last.kind === "overflow") {
      if (compactedKeyRef.current !== key) {
        compactedKeyRef.current = key;
        optsRef.current.onCompact();
      } else {
        // Compacted once and still overflowing: give up on auto handling.
        flowActiveRef.current = false;
        setUi({
          kind: "stopped",
          reason: "fatal",
          errorText: errText ?? "Context overflow could not be recovered by compaction.",
        });
      }
      return;
    }

    if (last.kind === "fatal" && !unattendedRef.current) {
      clearTimer();
      flowActiveRef.current = false;
      setUi({ kind: "stopped", reason: "fatal", errorText: errText ?? "Unrecoverable error." });
      return;
    }

    // No client-owned unattended countdown: only the server can schedule work.
    if (unattendedRef.current) return;
    const wasFlowActive = flowActiveRef.current;
    const retryPrevious = wasFlowActive || hasPreviousContinueWithoutOutput(messages);
    if (!wasFlowActive) {
      // Manual mode, flow not started: show the button and wait for the click.
      setUi({ kind: "awaiting", errorText: errText });
      return;
    }
    const delay = nextBackoffDelayMs(backoffRef.current);
    backoffRef.current += 1;
    autoCountRef.current += 1;

    setUi({
      kind: "running",
      errorText: errText,
      auto: false,
      attempt: autoCountRef.current,
      nextDelayMs: delay,
    });
    const startedAt = Date.now();
    clearTimer();
    countdownTimerRef.current = setInterval(() => {
      const remaining = Math.max(0, delay - (Date.now() - startedAt));
      setUi((current) => current.kind === "running" ? { ...current, nextDelayMs: remaining } : current);
    }, 250);
    timerRef.current = setTimeout(() => {
      clearTimer();
      if (retryPrevious) optsRef.current.onRetryContinue();
      else optsRef.current.onSendContinue();
    }, delay);
  }, [messages, agentRunning, isCompacting, unattended, clearTimer, resetFlow, ui.kind]);

  const syncUnattendedEnabled = useCallback((enabled: boolean) => {
    setUnattended(enabled);
    unattendedRef.current = enabled;
  }, []);

  return {
    continueUi: ui,
    unattended,
    toggleUnattended,
    triggerContinue,
    stopAutoRetry,
    syncUnattendedState: applyUnattendedState,
    syncUnattendedEnabled,
  };
}

export { CONTINUE_TEXT };
