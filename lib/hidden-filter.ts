import { isHidden } from "./hidden-state";
import { localDeviceIdentity, readActivityConfig } from "./activity-peers";
import type { SessionInfo } from "./types";

/** 本机设备 id（与会话活动聚合 /api/session-runs 同源，读同一份 peers 配置）。 */
export function localDeviceId(): string {
  return localDeviceIdentity(readActivityConfig(), new Date().toISOString()).id;
}

/**
 * 过滤本机会话列表：被隐藏的会话/项目/设备（联动语义）不出现。
 * 供原始会话侧栏（/api/sessions）与内容搜索（/api/sessions/search）使用；
 * 活动聚合在 /api/session-runs 内按同规则过滤。
 */
export function filterHiddenSessions(sessions: SessionInfo[]): SessionInfo[] {
  const deviceId = localDeviceId();
  return sessions.filter((session) => !isHidden(deviceId, session.id, session.projectRoot ?? session.cwd));
}

/** 与 filterHiddenSessions 互逆：只保留被会话/项目/设备标记收纳的条目。 */
export function selectHiddenSessions(sessions: SessionInfo[]): SessionInfo[] {
  const deviceId = localDeviceId();
  return sessions.filter((session) => isHidden(deviceId, session.id, session.projectRoot ?? session.cwd));
}
