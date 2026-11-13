import type { LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { SessionEntry } from "./types";

/** Persistent authority ceiling for a session created by a Side Ask. */
export interface SideAskPeerOwnership {
  version: 1;
  sourceSessionId: string;
  activeTools: string[];
  callableTools: string[];
}

export const SIDE_ASK_PEER_OWNERSHIP = "pi-web:side-ask-peer-ownership";
export const SIDE_ASK_CHILD = "quick_ask_child";
export const SIDE_ASK_NATIVE_CHILD = "reader.side_ask_child";

/** Ensure delegated create_session uses the ownership-aware Reader tool. */
export function preferSideAskSessionControl(base: LoadExtensionsResult): LoadExtensionsResult {
  const control = base.extensions.find((extension) => extension.path === "<inline:pi-web-session-control>");
  if (!control) return base;
  const firstOwner = base.extensions.find((extension) => extension.tools.has("session_control"));
  return firstOwner && firstOwner !== control
    ? { ...base, extensions: [control, ...base.extensions.filter((extension) => extension !== control)] }
    : base;
}

export function readSideAskPeerOwnership(entries: readonly SessionEntry[]): SideAskPeerOwnership | undefined {
  const entry = entries.find((item) => item.type === "custom" && item.customType === SIDE_ASK_PEER_OWNERSHIP);
  if (!entry || entry.type !== "custom") return undefined;
  const value = entry.data as Partial<SideAskPeerOwnership> | undefined;
  if (!value || value.version !== 1 || typeof value.sourceSessionId !== "string" || !value.sourceSessionId
    || !Array.isArray(value.activeTools) || !value.activeTools.every((name) => typeof name === "string")
    || !Array.isArray(value.callableTools) || !value.callableTools.every((name) => typeof name === "string")) {
    throw new Error("Invalid Side Ask peer ownership record");
  }
  return value as SideAskPeerOwnership;
}
