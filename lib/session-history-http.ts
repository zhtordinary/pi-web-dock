import {
  HistoryReadError,
  parseHistoryRequest,
  readHistoryPage,
  searchHistory,
  type HistoryProjection,
} from "./session-history";
import type { HistorySearchOptions } from "./session-history-types";
import { entryToUiMessage } from "./session-reader";
import { decodeBoundedSessionImage, readBase64ImageBlock } from "./session-history-media";
import { TOOL_RESULT_IMAGE_MIMES } from "./tool-result-images";

export type HistoryProjectionLoader = (sessionId: string, leafId?: string | null) => Promise<HistoryProjection>;
type RouteContext = { params: Promise<{ id: string }> };
const HEADERS = { "Cache-Control": "private, no-store" };

export function historyReadFailure(error: unknown): Response {
  if (error instanceof HistoryReadError) {
    return Response.json({ error: error.message, code: error.code, revision: error.revision }, {
      status: error.status, headers: HEADERS,
    });
  }
  if (error instanceof Error && "code" in error && error.code === "ENOENT") {
    return Response.json({ error: "Session not found", code: "history_session_not_found" }, { status: 404, headers: HEADERS });
  }
  return Response.json({ error: "Unable to read session history", code: "history_read_failed" }, { status: 500, headers: HEADERS });
}

function assertNotCancelled(request: Request): void {
  if (request.signal.aborted) throw new HistoryReadError(499, "history_cancelled", "History request was cancelled");
}

/** The production route and HTTP behavior tests execute this same handler. */
export function createHistoryGet(load: HistoryProjectionLoader) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
      assertNotCancelled(request);
      const options = parseHistoryRequest(new URL(request.url).searchParams);
      const { id } = await context.params;
      const projection = await load(id, options.leafId);
      assertNotCancelled(request);
      return Response.json(readHistoryPage(projection, options), { headers: HEADERS });
    } catch (error) {
      return historyReadFailure(error);
    }
  };
}

/** Images retain the existing MIME/byte protections and selected-branch membership. */
export function createHistoryImageGet(load: HistoryProjectionLoader) {
  return async (request: Request, context: { params: Promise<{ id: string; entryId: string }> }): Promise<Response> => {
    try {
      assertNotCancelled(request);
      const { id, entryId } = await context.params;
      const url = new URL(request.url);
      url.searchParams.set("mode", "content");
      url.searchParams.set("entryId", entryId);
      const options = parseHistoryRequest(url.searchParams);
      if (options.mode !== "content" || options.path !== undefined || (options.surface !== undefined && options.surface !== "source")) {
        throw new HistoryReadError(400, "history_invalid_request", "Image blockIndex is required");
      }
      const projection = await load(id, options.leafId);
      assertNotCancelled(request);
      const index = projection.positions.get(entryId);
      if (index === undefined) throw new HistoryReadError(404, "history_entry_not_on_branch", "Image entry is not on the selected branch");
      const message = entryToUiMessage(projection.entries[index], {});
      const image = message && message.role !== "bashExecution" && Array.isArray(message.content)
        ? readBase64ImageBlock(message.content[options.blockIndex ?? 0]) : null;
      if (!image) throw new HistoryReadError(404, "history_image_not_found", "Message image not found");
      if (!TOOL_RESULT_IMAGE_MIMES.has(image.mime)) throw new HistoryReadError(415, "history_image_unsupported", "Unsupported image type");
      const bytes = decodeBoundedSessionImage(image.data);
      if (!bytes) throw new HistoryReadError(413, "history_image_too_large", "Invalid or oversized image data");
      const body = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(body).set(bytes);
      return new Response(body, { headers: {
        ...HEADERS, "Content-Type": image.mime, "Content-Length": String(bytes.byteLength),
        "X-Content-Type-Options": "nosniff",
      } });
    } catch (error) {
      return historyReadFailure(error);
    }
  };
}

/** Count-only callers use the same branch/body projection, not the global file/title search. */
export function createSessionSearchGet(load: HistoryProjectionLoader) {
  return async (request: Request, context: RouteContext): Promise<Response> => {
    try {
      assertNotCancelled(request);
      const url = new URL(request.url);
      url.searchParams.set("mode", "search");
      const options = parseHistoryRequest(url.searchParams);
      if (options.mode !== "search") throw new HistoryReadError(400, "history_invalid_request", "Search mode is required");
      if (options.q.trim().length < 2) {
        return Response.json({ total: 0, contentTotal: 0, snippets: [] }, { headers: HEADERS });
      }
      const { id } = await context.params;
      const projection = await load(id, options.leafId);
      assertNotCancelled(request);
      const page = searchHistory(projection, { ...options, limit: 3 } satisfies HistorySearchOptions);
      return Response.json({
        total: page.total, contentTotal: page.total,
        snippets: page.matches.map((match) => `${match.before}${match.match}${match.after}`),
        revision: page.revision, leafId: page.leafId,
      }, { headers: HEADERS });
    } catch (error) {
      return historyReadFailure(error);
    }
  };
}
