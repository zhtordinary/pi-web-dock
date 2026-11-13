import type { Dispatch, SetStateAction } from "react";
import type { QuestionAnalysisMode, QuestionAnalysisResult, QuestionRewriteResult } from "@/lib/question-analysis";

export type DraftAnalysisState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: QuestionAnalysisResult }
  | { status: "error"; message: string };

export type DraftRewriteState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; result: QuestionRewriteResult }
  | { status: "error"; message: string };

interface DraftPromptRequestControllerOptions {
  requestIdRef: { current: number };
  resolveSessionId: () => Promise<string>;
  send: (sessionId: string, payload: Record<string, unknown>) => Promise<unknown>;
  setAnalysis: Dispatch<SetStateAction<DraftAnalysisState>>;
  setRewrite: Dispatch<SetStateAction<DraftRewriteState>>;
  setSte100: Dispatch<SetStateAction<DraftRewriteState>>;
  noResultMessage: string;
  failedMessage: string;
}

export function resetDraftPromptRequest(
  requestIdRef: { current: number },
  setAnalysis: Dispatch<SetStateAction<DraftAnalysisState>>,
  setRewrite: Dispatch<SetStateAction<DraftRewriteState>>,
  setSte100: Dispatch<SetStateAction<DraftRewriteState>>,
): void {
  requestIdRef.current += 1;
  setAnalysis({ status: "idle" });
  setRewrite({ status: "idle" });
  setSte100({ status: "idle" });
}

export function stripTrailingTerms(draft: string, terms: string): string {
  const base = draft.trimEnd();
  const block = terms.trim();
  if (!block || !base.endsWith(block)) return base;
  const head = base.slice(0, base.length - block.length);
  return head ? head.trimEnd() : base;
}

/** Owns the cancelable analysis/rewrite/STE100 request lifecycle for ChatInput. */
export function createDraftPromptRequestController({
  requestIdRef,
  resolveSessionId,
  send,
  setAnalysis,
  setRewrite,
  setSte100,
  noResultMessage,
  failedMessage,
}: DraftPromptRequestControllerOptions) {
  const isCurrent = (requestId: number) => requestId === requestIdRef.current;
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : failedMessage;

  const begin = (kind: "analysis" | "rewrite" | "ste100"): number => {
    const requestId = ++requestIdRef.current;
    if (kind === "analysis") {
      setAnalysis({ status: "loading" });
      setRewrite({ status: "idle" });
      setSte100({ status: "idle" });
    } else if (kind === "rewrite") {
      setAnalysis((current) => current.status === "loading" ? { status: "idle" } : current);
      setRewrite({ status: "loading" });
      setSte100((current) => current.status === "loading" ? { status: "idle" } : current);
    } else {
      setAnalysis((current) => current.status === "loading" ? { status: "idle" } : current);
      setSte100({ status: "loading" });
      setRewrite((current) => current.status === "loading" ? { status: "idle" } : current);
    }
    return requestId;
  };

  const completeRewrite = async (requestId: number, question: string, terms: string): Promise<void> => {
    if (!isCurrent(requestId)) return;
    setRewrite({ status: "loading" });
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, { type: "rewrite_question", question, terms }) as QuestionRewriteResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setRewrite({ status: "ready", result });
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setRewrite({ status: "error", message: errorMessage(error) });
    }
  };

  const runAnalysis = async (mode: QuestionAnalysisMode, question: string): Promise<void> => {
    const requestId = begin("analysis");
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, {
        type: "analyze_question_draft",
        question,
        contextMode: mode,
      }) as QuestionAnalysisResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setAnalysis({ status: "ready", result });
      if (!isCurrent(requestId)) return;
      await completeRewrite(requestId, stripTrailingTerms(question, result.text).trim(), result.text);
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setAnalysis({ status: "error", message: errorMessage(error) });
    }
  };

  const runRewrite = async (question: string, terms: string): Promise<void> => {
    const requestId = begin("rewrite");
    await completeRewrite(requestId, question, terms);
  };

  const runSte100 = async (question: string): Promise<void> => {
    const requestId = begin("ste100");
    try {
      const sessionId = await resolveSessionId();
      if (!isCurrent(requestId)) return;
      const result = await send(sessionId, { type: "rewrite_ste100", question }) as QuestionRewriteResult;
      if (!isCurrent(requestId)) return;
      if (!result?.text?.trim()) throw new Error(noResultMessage);
      if (!isCurrent(requestId)) return;
      setSte100({ status: "ready", result });
    } catch (error) {
      if (!isCurrent(requestId)) return;
      setSte100({ status: "error", message: errorMessage(error) });
    }
  };

  return {
    reset: () => resetDraftPromptRequest(requestIdRef, setAnalysis, setRewrite, setSte100),
    runAnalysis,
    runRewrite,
    runSte100,
  };
}
