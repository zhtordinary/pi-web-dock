import { apiPathForPeer } from "./file-api";
import { fetchSessionActivity } from "./session-activity-fetch";
import type { SessionActivityItem, SessionActivityResponse } from "./session-activity-types";
import { getSessionFamily, type SessionFamily } from "./session-family";

export interface AgentFamilySnapshot {
  family: SessionFamily;
  items: SessionActivityItem[];
  runningSessionIds: Set<string>;
}

export async function loadAgentFamily(
  sessionId: string, deviceId: string, peer: string | undefined, includeHidden: boolean, archived: boolean,
): Promise<AgentFamilySnapshot> {
  const scopes = ["local", "favorites", "to_discuss", "to_revise", "completed", ...(includeHidden ? ["hidden"] : [])];
  const responses = await Promise.all(scopes.map((scope) => fetchSessionActivity<SessionActivityResponse>(
    apiPathForPeer(peer, `reader/session-catalog?scope=${scope}&local=1${archived ? "&archived=1" : ""}`),
  )));
  const items = new Map<string, SessionActivityItem>();
  for (const response of responses) {
    if (response?.device?.id !== deviceId || !Array.isArray(response.sessions)
      || response.metadataWarnings?.some((warning) => warning.deviceId === deviceId && warning.domain !== "viewed")) {
      throw new Error("Agent family observation unavailable");
    }
    for (const item of response.sessions) {
      if (item.device?.id !== deviceId || !item.session?.id) throw new Error("Agent family device mismatch");
      items.set(item.session.id, item);
    }
  }
  const all = [...items.values()];
  const family = getSessionFamily(all.map((item) => item.session), sessionId);
  if (!family) throw new Error("Agent family is not visible");
  return {
    family,
    items: all,
    runningSessionIds: new Set(all.filter((item) => item.execution?.active
      || item.status === "running" || item.status === "retrying" || item.status === "waiting_user").map((item) => item.session.id)),
  };
}
