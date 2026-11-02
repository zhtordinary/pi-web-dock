import type { HiddenState } from "./hidden-state.ts";
import type { SessionRecapSummary } from "./session-recap.ts";
import type { SessionInfo } from "./types";
import type { SubprojectDefinition, SubprojectSortSetting } from "./subproject-state.ts";

export type { SessionRecapSummary };

export type SessionRunStatus = "running" | "completed" | "failed" | "aborted" | "unknown";
export type SubagentTerminalState = "completed" | "failed" | "partial" | "stopped" | "rejected";

export type SessionActivityStatus =
  | "running"
  | "retrying"
  | "waiting_user"
  | "just_completed"
  | "idle"
  | "failed"
  | "aborted"
  | "unknown";

export interface SessionRunRecord {
  runId: string;
  sessionId: string;
  cwd: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  status: SessionRunStatus;
  error?: string;
}

export interface SessionActivityDevice {
  id: string;
  name: string;
  url?: string;
  online?: boolean;
  lastSeenAt?: string;
  error?: string;
}

export interface SessionActivityItem {
  device: SessionActivityDevice;
  session: SessionInfo;
  /** 会话是否被数据所属设备收藏；普通聚合页也透传，供星标按钮使用。 */
  favorite?: boolean;
  /** 会话所属收纳分类（待讨论、待修改、已完成）。 */
  category?: "to_discuss" | "to_revise" | "completed";
  projectKey: string;
  /** 数据所属设备上的项目级隐藏标记，不含会话或设备级隐藏。 */
  projectHidden?: boolean;
  projectLabel: string;
  status: SessionActivityStatus;
  /** Terminal result of a delegated pi-subagents run owned by this session. */
  subagentTerminalState?: SubagentTerminalState;
  subagentTerminalAt?: number;
  /** 会话所在设备进程的无人值守开关；无人值守会话失败音不播（状态照常显示）。 */
  unattended?: boolean;
  modelName?: string;
  lastUserMessage?: string;
  /** ISO time of the latest substantive user question; continuation prompts excluded. */
  lastAskedAt?: string;
  /** Legacy eager value from older peers; current rows load cost lazily. */
  totalCost?: number;
  lastRecap?: SessionRecapSummary;
  /** ISO time of the newest user or assistant message; run lifecycle timestamps do not replace it. */
  lastActivityAt: string;
  /** Live observation is separate from immutable historical run identity. */
  currentActivity?: { active: boolean; runId: string | null };
  execution?: import("./session-execution").SessionExecutionState;
  latestRun: SessionRunRecord | null;
  runs: SessionRunRecord[];
  /** waiting_user 时挂起的 extension UI 请求 id（ask_user 弹窗等）；跨设备聚合时透传。 */
  waitingRequestIds?: string[];
}

export interface SessionActivitySubproject extends SubprojectDefinition {
  deviceId: string;
}

export interface SessionActivitySubprojectSortSetting extends SubprojectSortSetting {
  deviceId: string;
}

export interface KnownProjectEntry {
  /** 数据所属设备上的项目级隐藏标记。 */
  hidden?: boolean;
  deviceId: string;
  path: string;
  key: string;
  label: string;
  addedAt: string;
  /** True when the saved project path resolves inside a Git repository; absent until this process has probed it. */
  isGit?: boolean;
}

export interface SessionActivityResponse {
  metadataWarnings?: import("./catalog-metadata").CatalogMetadataWarning[];
  schemaVersion: 1;
  /** Read-only run observation across storage categories; not a sidebar list. */
  view?: "completion";
  scope: "local" | "all" | "hidden" | "favorites" | "to_discuss" | "to_revise" | "completed";
  generatedAt: string;
  device: SessionActivityDevice;
  devices: SessionActivityDevice[];
  sessions: SessionActivityItem[];
  knownProjects?: KnownProjectEntry[];
  /** Definitions owned by response.device; assignments ride on SessionInfo.subprojectId. */
  subprojects?: SessionActivitySubproject[];
  /** Project-scoped bucket ordering owned by each response device. */
  subprojectSortSettings?: SessionActivitySubprojectSortSetting[];
  /** 当前 Reader 服务端已读状态；聚合页按入口设备的视角裁决。 */
  viewedAt?: Record<string, number>;
  /** 隐藏收纳清单（scope=hidden 必带合并后清单；scope=local 带本机清单）。 */
  hidden?: HiddenState;
}
