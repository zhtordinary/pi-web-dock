import { encodeFilePathForApi, getFileDirectory } from "./file-paths.ts";

export type FileApiType = "read" | "download" | "meta" | "preview" | "watch" | "write";

const NO_SOURCE_SESSION = "_";

export function apiPathForPeer(peer: string | undefined, path: string): string {
  if (!peer) return `/api/${path}`;
  const [route, query] = path.split("?", 2);
  return `/api/remote/${route}?${query ? `${query}&` : ""}peer=${encodeURIComponent(peer)}`;
}

export function fileApiPath(
  filePath: string,
  type: FileApiType,
  sourceSessionId?: string | null,
  peer?: string,
  params: Record<string, string | number | undefined> = {},
): string {
  const searchParams = new URLSearchParams({ type });
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) searchParams.set(key, String(value));
  }
  return apiPathForPeer(peer, `files/${encodeFilePathForApi(filePath)}?${searchParams.toString()}`);
}

/**
 * Build a trailing-slash base URL so srcDoc relative assets keep local/remote
 * session context while resolving through Reader's safe resource proxy.
 */
export function htmlPreviewResourceBase(
  filePath: string,
  sourceSessionId?: string | null,
  peer?: string,
): string {
  const session = encodeURIComponent(sourceSessionId || NO_SOURCE_SESSION);
  const directory = encodeFilePathForApi(getFileDirectory(filePath));
  const resourcePath = `${session}/${directory ? `${directory}/` : ""}`;

  if (peer) return `/api/remote/html-preview/${encodeURIComponent(peer)}/${resourcePath}`;
  return `/api/html-preview/${resourcePath}`;
}
