import { MAX_TOOL_RESULT_IMAGE_BYTES } from "./tool-result-images";
import type { HistoryScope } from "./session-history-types";

export interface HistoryBase64Image { data: string; mime: string }

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function readBase64ImageBlock(block: unknown): HistoryBase64Image | null {
  if (!record(block) || block.type !== "image") return null;
  if (typeof block.data === "string" && typeof block.mimeType === "string") return { data: block.data, mime: block.mimeType };
  if (record(block.source) && block.source.type === "base64" && typeof block.source.data === "string"
    && typeof block.source.media_type === "string") return { data: block.source.data, mime: block.source.media_type };
  return null;
}

/** Shared media budget and syntax checks for historical user/assistant/tool images. */
export function decodeBoundedSessionImage(data: string): Uint8Array | null {
  if (data.length === 0 || data.length > Math.ceil(MAX_TOOL_RESULT_IMAGE_BYTES * 4 / 3) + 4
    || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null;
  const bytes = Buffer.from(data, "base64");
  if (bytes.length === 0 || bytes.length > MAX_TOOL_RESULT_IMAGE_BYTES) return null;
  return new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

export function historyImageUrl(scope: HistoryScope, entryId: string, blockIndex: number, leafId?: string | null): string {
  const query = new URLSearchParams({ blockIndex: String(blockIndex) });
  if (leafId !== undefined) query.set("leafId", leafId ?? "");
  return `/api/sessions/${encodeURIComponent(scope.sessionId)}/entries/${encodeURIComponent(entryId)}/image?${query}`;
}
