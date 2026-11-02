import type { AgentMessage } from "./types";
import type { TranscriptView } from "./transcript-store";

const KEY = "pi-web-hidden-continue-errors-v2";
export function retryDisplayScope(sessionId: string, peer: string | null): string {
  return JSON.stringify([peer, sessionId]);
}
export function readHiddenRetryErrors(scope: string): Set<string> {
  try {
    const ids = JSON.parse(sessionStorage.getItem(KEY) ?? "{}")[scope];
    return new Set(Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : []);
  } catch { return new Set(); }
}
export function rememberHiddenRetryError(scope: string, entryId: string): void {
  try {
    const state = JSON.parse(sessionStorage.getItem(KEY) ?? "{}");
    state[scope] = [...new Set([...readHiddenRetryErrors(scope), entryId])];
    sessionStorage.setItem(KEY, JSON.stringify(state));
  } catch { /* Display still updates in memory when browser storage is unavailable. */ }
}
export function latestRetryErrorEntry(messages: readonly AgentMessage[], entryIds: readonly string[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return (message.stopReason === "error" || message.stopReason === "aborted") && entryIds[index] ? entryIds[index] : null;
  }
  return null;
}
/** Filter the display only after the single transcript has been projected. */
export function hideRetriedErrors(view: TranscriptView, hidden: ReadonlySet<string>): TranscriptView {
  const indices = view.entryIds.map((_, index) => index).filter((index) => !hidden.has(view.entryIds[index]));
  const entryIds = indices.map((index) => view.entryIds[index]);
  return { ...view, messages: indices.map((index) => view.messages[index]), entryIds,
    messageIndexByEntryId: new Map(entryIds.map((id, index) => [id, index])) };
}
