import { apiPathForPeer } from "./file-api";
import type { HistoryPage, HistoryRequest } from "./session-history-types";
import { isHistoryOrderKey } from "./transcript-order";
import type { TranscriptScope } from "./session-view-cache";
export type HistoryControllerScope = TranscriptScope;
export type HistoryFetcher = (scope: TranscriptScope, request: HistoryRequest, signal: AbortSignal) => Promise<HistoryPage>;
export class HistoryTransportError extends Error {
  constructor(message: string, readonly failure: { code?: string; status?: number; kind: string; message: string; retryable: boolean }) { super(message); }
}
function failureFromResponse(status: number, body: unknown): HistoryTransportError {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const message = typeof value.error === "string" ? value.error : `History request failed (${status})`;
  return new HistoryTransportError(message, { status, code: typeof value.code === "string" ? value.code : undefined, message, kind: status === 404 ? "not_found" : "http", retryable: status >= 500 });
}
function buildHistoryPath(scope: HistoryControllerScope, request: HistoryRequest): string {
  const params = new URLSearchParams({ mode: request.mode });
  if (scope.leafId !== undefined) params.set("leafId", scope.leafId === null ? "" : scope.leafId);
  // SAFETY: HistoryRequest is a discriminated JSON transport object; this read-only lookup cannot mutate or reinterpret its fields.
  const options = request as unknown as Record<string, unknown>;
  for (const name of ["turns", "from", "to", "limit", "revision", "cursor", "offset", "around", "before", "after", "q", "entryId", "surface", "path", "blockIndex"]) {
    const value = options[name];
    if (value !== undefined) params.set(name, String(value));
  }
  return apiPathForPeer(scope.peer ?? undefined, `sessions/${encodeURIComponent(scope.sessionId)}/history?${params.toString()}`);
}

export async function fetchSessionHistory(
  scope: HistoryControllerScope,
  request: HistoryRequest,
  signal: AbortSignal,
): Promise<HistoryPage> {
  const response = await fetch(buildHistoryPath(scope, request), { signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]), cache: "no-store", headers: { Accept: "application/json" } });
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) throw failureFromResponse(response.status, body);
  if (!body || typeof body !== "object" || typeof (body as { kind?: unknown }).kind !== "string") {
    throw new HistoryTransportError("History response was malformed", { kind: "unknown", message: "History response was malformed", retryable: true });
  }
  const page = body as HistoryPage;
  if (page.kind === "window" && (!Array.isArray(page.items) || page.items.some(item => !item || !isHistoryOrderKey(item.orderKey) || typeof item.entryId !== "string" || typeof item.role !== "string" || !["placeholder", "answer", "full"].includes(item.contentState)))
    || page.kind === "index" && (!Array.isArray(page.nodes) || page.nodes.some(node => !node || !isHistoryOrderKey(node.orderKey)))) {
    throw new HistoryTransportError("History row identity was malformed", { kind: "unknown", message: "History row identity was malformed", retryable: true });
  }
  if (page.kind !== "window" || !page.items.some((item) => item.message && "content" in item.message)) return page;
  // Remote history routes run on the peer and therefore emit local-looking
  // media URLs. Rebind only our own /api/sessions URLs through the current peer
  // proxy; external URLs and already-rewritten URLs remain untouched.
  const items = page.items.map((item) => {
    const message = item.message;
    if (!message || !("content" in message) || !Array.isArray(message.content)) return item;
    let changed = false;
    const content = message.content.map((block) => {
      if (block.type !== "image" || block.source.type !== "url" || typeof block.source.url !== "string" || !block.source.url.startsWith("/api/sessions/")) return block;
      changed = true;
      return { ...block, source: { ...block.source, url: apiPathForPeer(scope.peer ?? undefined, block.source.url.slice(5)) } };
    });
    if (!changed) return item;
    // SAFETY: only URL-backed image blocks are rewritten; all message/content union members retain their original shape.
    return { ...item, message: { ...message, content } as typeof message };
  });
  return items === page.items ? page : { ...page, items };
}
