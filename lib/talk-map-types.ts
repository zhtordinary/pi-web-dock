import { stripHiddenUserQuestion } from "./session-hover-preview.ts";

export const TALK_MAP_SCHEMA_VERSION = 1 as const;

export interface TalkMapInjectPromptInput {
  sourceDevice: string;
  sourceSessionId: string;
  sourceTitle: string;
  sourcePath: string;
  sourceProject: string;
}

export type TalkMapSourceInfoInput = TalkMapInjectPromptInput;

function singleLine(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[\r\n]+/g, " ");
  return normalized || fallback;
}

export function buildTalkMapSourceInfo(input: TalkMapSourceInfoInput): string {
  const cleanTitle = stripHiddenUserQuestion(input.sourceTitle) || input.sourceSessionId || "未命名会话";
  return [
    `来源设备：${singleLine(input.sourceDevice, "本机")}`,
    `来源 Session ID：${singleLine(input.sourceSessionId, "未知")}`,
    `来源会话文件（仅供定位）：${singleLine(input.sourcePath, "（路径不可用）")}`,
    `来源会话标题：${singleLine(cleanTitle, "未命名会话")}`,
    `来源项目：${singleLine(input.sourceProject, "（路径不可用）")}`,
  ].join("\n");
}

export function buildTalkMapInjectPrompt(input: TalkMapInjectPromptInput): string {
  return [
    "请基于来源会话继续处理。",
    "",
    buildTalkMapSourceInfo(input),
    "",
    "本次具体要求：",
  ].join("\n");
}

export type TalkMapEdgeType = "related" | "lineage";

export interface TalkMapCamera {
  x: number;
  y: number;
  zoom: number;
}

export type TalkMapLayoutMode = "free" | "subprojects";
export type TalkMapLayoutSort = "status" | "asked" | "manual";

/** Map-owned presentation state; session assignment remains Reader-owned. */
export interface TalkMapLayoutState {
  mode: TalkMapLayoutMode;
  sort: TalkMapLayoutSort;
  manualOrder: string[];
}

export interface TalkMapCardState {
  x: number;
  y: number;
  hidden?: boolean;
}

export interface TalkMapGhostCardState {
  label: string;
  body?: string;
  x: number;
  y: number;
  createdAt: string;
}

/** Map-owned reference to a Pi-owned recap; never stores recap text. */
export interface TalkMapDigestState {
  source: "session-recap";
  status: "derived" | "unavailable";
  updatedAt?: string;
}

export interface TalkMapEdge {
  id: string;
  source: string;
  target: string;
  type: TalkMapEdgeType;
  createdAt: string;
}

export interface TalkMapRelationQuery {
  sessionId?: string;
  type?: TalkMapEdgeType;
}

export interface TalkMapFrame {
  id: string;
  label: string;
  kind: "worktree";
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TalkMapBoard {
  schemaVersion: typeof TALK_MAP_SCHEMA_VERSION;
  boardKey: string;
  projectRoot: string;
  deviceId: string;
  revision: number;
  updatedAt: string;
  camera: TalkMapCamera;
  layout: TalkMapLayoutState;
  cards: Record<string, TalkMapCardState>;
  ghosts: Record<string, TalkMapGhostCardState>;
  digests: Record<string, TalkMapDigestState>;
  edges: TalkMapEdge[];
  frames: TalkMapFrame[];
}

export type TalkMapMutation =
  | { op: "set-layout"; layout: TalkMapLayoutState }
  | { op: "upsert-card"; sessionId: string; x: number; y: number }
  | { op: "append-session"; sessionId: string }
  | { op: "upsert-edge"; source: string; target: string; type: "related" }
  | { op: "delete-edge"; edgeId: string }
  | { op: "upsert-frame"; frame: TalkMapFrame }
  | { op: "delete-frame"; frameId: string }
  | { op: "upsert-ghost"; ghostId?: string; ghost: TalkMapGhostCardState }
  | { op: "delete-ghost"; ghostId: string }
  | { op: "set-camera"; camera: TalkMapCamera }
  | { op: "reset-view"; camera: TalkMapCamera; cards: Record<string, { x: number; y: number }> };

export function defaultTalkMapCamera(): TalkMapCamera {
  return { x: 0, y: 0, zoom: 1 };
}

export function defaultTalkMapLayout(): TalkMapLayoutState {
  return { mode: "subprojects", sort: "manual", manualOrder: [] };
}

export function defaultTalkMapPosition(index: number): { x: number; y: number } {
  const safeIndex = Number.isFinite(index) && index >= 0 ? Math.floor(index) : 0;
  return {
    x: 64 + (safeIndex % 3) * 515,
    y: 64 + Math.floor(safeIndex / 3) * 224,
  };
}
