"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import { stripAnsi } from "@/lib/ansi";
import { apiPathForPeer } from "@/lib/file-api";
import { AnsiText } from "@/components/AnsiText";
import type { ExtensionWidgetItem } from "@/lib/types";
import { asyncMetadataKey } from "@/lib/async-metadata-key";

export const WIDGET_UPDATE_IDLE_MS = 1100;

export function formatExtensionWidgetContent(lines: string[]): string {
  return lines.join("\n");
}

const ASYNC_STATUS_WIDGET_PREFIX = "PI_SUBAGENT_ASYNC_JSON:";
const ASYNC_STATUS_KIND = "pi-subagents.async-status-snapshot";

type AsyncStatusState =
  | "queued"
  | "running"
  | "complete"
  | "failed"
  | "partial"
  | "paused"
  | "stopped"
  | "rejected";

interface AsyncStatusActivity {
  state?: string;
  currentTool?: string;
  lastActivityAt?: number;
  currentToolStartedAt?: number;
  turnCount?: number;
  toolCount?: number;
}

interface AsyncStatusHostStep {
  kind?: string;
  provider?: string;
  role?: string;
  state: string;
  verdict?: string;
  reasonCode?: string;
  detail?: string;
  target?: string;
  stale?: boolean;
  report?: string;
}

interface AsyncStatusNode {
  id: string;
  kind: "subagent" | "workflow" | "step" | "host-step";
  label: string;
  state: AsyncStatusState;
  startedAt?: number;
  updatedAt?: number;
  endedAt?: number;
  agent?: string;
  model?: string;
  modelProvider?: string;
  thinking?: string;
  activity?: AsyncStatusActivity;
  hostStep?: AsyncStatusHostStep;
  children?: AsyncStatusNode[];
}

export interface AsyncStatusSnapshot {
  kind: typeof ASYNC_STATUS_KIND;
  version: 1;
  omitted: { runs: number; children: number; byteLimitExceeded: boolean };
  runs: AsyncStatusNode[];
}

export type AsyncStatusModelMetadata = Record<string, {
  model?: string;
  modelProvider?: string;
  thinking?: string;
  agent?: string;
}>;

export function mergeAsyncStatusModelMetadata(
  previous: AsyncStatusModelMetadata,
  next: AsyncStatusModelMetadata,
  requestedIds?: readonly string[],
): AsyncStatusModelMetadata {
  const requested = requestedIds ? new Set(requestedIds) : undefined;
  const merged: AsyncStatusModelMetadata = {};
  for (const [key, value] of Object.entries(previous)) {
    if (!requested || requested.has(key)) merged[key] = value;
  }
  for (const [key, value] of Object.entries(next)) {
    if (requested && !requested.has(key)) continue;
    merged[key] = merged[key] ? { ...merged[key], ...value } : value;
  }
  return merged;
}

const ASYNC_STATUS_STATES = new Set<AsyncStatusState>([
  "queued",
  "running",
  "complete",
  "failed",
  "partial",
  "paused",
  "stopped",
  "rejected",
]);
const ASYNC_STATUS_TERMINAL_STATES = new Set<AsyncStatusState>([
  "complete",
  "failed",
  "partial",
  "stopped",
  "rejected",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseAsyncStatusActivity(value: unknown): AsyncStatusActivity | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (value.state !== undefined && typeof value.state !== "string") return null;
  if (value.currentTool !== undefined && typeof value.currentTool !== "string") return null;
  if (value.lastActivityAt !== undefined && typeof value.lastActivityAt !== "number") return null;
  if (value.currentToolStartedAt !== undefined && typeof value.currentToolStartedAt !== "number") return null;
  if (value.turnCount !== undefined && typeof value.turnCount !== "number") return null;
  if (value.toolCount !== undefined && typeof value.toolCount !== "number") return null;
  return {
    state: value.state,
    currentTool: value.currentTool,
    lastActivityAt: value.lastActivityAt,
    currentToolStartedAt: value.currentToolStartedAt,
    turnCount: value.turnCount,
    toolCount: value.toolCount,
  };
}

function parseAsyncStatusHostStep(value: unknown): AsyncStatusHostStep | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (typeof value.state !== "string") return null;
  if (value.kind !== undefined && typeof value.kind !== "string") return null;
  if (value.verdict !== undefined && typeof value.verdict !== "string") return null;
  if (value.provider !== undefined && typeof value.provider !== "string") return null;
  if (value.role !== undefined && typeof value.role !== "string") return null;
  if (value.reasonCode !== undefined && typeof value.reasonCode !== "string") return null;
  if (value.detail !== undefined && typeof value.detail !== "string") return null;
  if (value.target !== undefined && typeof value.target !== "string") return null;
  if (value.stale !== undefined && typeof value.stale !== "boolean") return null;
  if (value.report !== undefined && typeof value.report !== "string") return null;
  return {
    kind: value.kind,
    state: value.state,
    verdict: value.verdict,
    provider: value.provider,
    role: value.role,
    reasonCode: value.reasonCode,
    detail: value.detail,
    target: value.target,
    stale: value.stale,
    report: value.report,
  };
}

function parseAsyncStatusNode(value: unknown): AsyncStatusNode | null {
  if (!isRecord(value)
    || typeof value.id !== "string"
    || typeof value.label !== "string"
    || !["subagent", "workflow", "step", "host-step"].includes(String(value.kind))
    || !ASYNC_STATUS_STATES.has(value.state as AsyncStatusState)) return null;

  if (value.startedAt !== undefined && typeof value.startedAt !== "number") return null;
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "number") return null;
  if (value.endedAt !== undefined && typeof value.endedAt !== "number") return null;
  if (value.agent !== undefined && typeof value.agent !== "string") return null;
  if (value.model !== undefined && typeof value.model !== "string") return null;
  if (value.modelProvider !== undefined && typeof value.modelProvider !== "string") return null;
  if (value.thinking !== undefined && typeof value.thinking !== "string") return null;

  const activity = parseAsyncStatusActivity(value.activity);
  if (activity === null) return null;

  const hostStep = parseAsyncStatusHostStep(value.hostStep);
  if (hostStep === null) return null;

  const children = value.children === undefined
    ? undefined
    : Array.isArray(value.children)
      ? value.children.map(parseAsyncStatusNode)
      : null;
  if (children === null || (children !== undefined && children.some((child) => child === null))) return null;

  return {
    id: value.id,
    kind: value.kind as AsyncStatusNode["kind"],
    label: value.label,
    state: value.state as AsyncStatusState,
    startedAt: value.startedAt,
    updatedAt: value.updatedAt,
    endedAt: value.endedAt,
    agent: value.agent,
    model: value.model,
    modelProvider: value.modelProvider,
    thinking: value.thinking,
    activity: activity ?? undefined,
    hostStep: hostStep ?? undefined,
    children: children as AsyncStatusNode[] | undefined,
  };
}

export function parseAsyncStatusSnapshot(lines: readonly string[]): AsyncStatusSnapshot | null {
  const content = stripAnsi(formatExtensionWidgetContent([...lines])).trim();
  if (!content.startsWith(ASYNC_STATUS_WIDGET_PREFIX)) return null;

  try {
    const value: unknown = JSON.parse(content.slice(ASYNC_STATUS_WIDGET_PREFIX.length));
    if (!isRecord(value)
      || value.kind !== ASYNC_STATUS_KIND
      || value.version !== 1
      || !Array.isArray(value.runs)
      || !isRecord(value.omitted)
      || typeof value.omitted.runs !== "number"
      || typeof value.omitted.children !== "number"
      || typeof value.omitted.byteLimitExceeded !== "boolean") return null;
    const runs = value.runs.map(parseAsyncStatusNode);
    if (runs.some((run) => run === null)) return null;
    return {
      kind: ASYNC_STATUS_KIND,
      version: 1,
      runs: runs as AsyncStatusNode[],
      omitted: {
        runs: value.omitted.runs,
        children: value.omitted.children,
        byteLimitExceeded: value.omitted.byteLimitExceeded,
      },
    };
  } catch {
    return null;
  }
}

function formatAsyncStatusId(id: string): string {
  const value = id.trim();
  if (/^[0-9a-f]{8}-[0-9a-f-]+$/i.test(value)) return value.slice(0, 8);
  return value.length > 28 ? `${value.slice(0, 25)}…` : value;
}

function splitAsyncModelReference(value: string | undefined): { provider?: string; model?: string; thinking?: string } {
  const trimmed = value?.trim();
  if (!trimmed) return {};
  const thinkingMatch = trimmed.match(/:(off|minimal|low|medium|high|xhigh|max)$/i);
  const withoutThinking = thinkingMatch ? trimmed.slice(0, thinkingMatch.index) : trimmed;
  const slashIndex = withoutThinking.indexOf("/");
  return {
    ...(slashIndex > 0 ? { provider: withoutThinking.slice(0, slashIndex), model: withoutThinking.slice(slashIndex + 1) } : { model: withoutThinking }),
    ...(thinkingMatch ? { thinking: thinkingMatch[1].toLowerCase() } : {}),
  };
}

export function formatCompactModelLabel(node: AsyncStatusNode): string | null {
  const parsed = splitAsyncModelReference(node.model);
  const model = parsed.model;
  if (!model) return null;
  const thinking = node.thinking?.trim() || parsed.thinking;
  const provider = node.modelProvider?.trim() || parsed.provider;
  const prefix = provider ? `${provider}/` : "";
  const suffix = thinking ? ` (${thinking})` : "";
  return `${prefix}${model}${suffix}`;
}

function formatAsyncModelDetails(node: AsyncStatusNode): string[] {
  const compact = formatCompactModelLabel(node);
  return compact ? [compact] : [];
}

export function collectAsyncStatusIds(snapshot: AsyncStatusSnapshot): string[] {
  const ids = new Set<string>();
  const visit = (runId: string, node: AsyncStatusNode, path: readonly string[]) => {
    ids.add(asyncMetadataKey(runId, path));
    for (const child of node.children ?? []) visit(runId, child, [...path, child.id]);
  };
  for (const run of snapshot.runs) visit(run.id, run, []);
  return [...ids];
}

function applyAsyncStatusModelMetadata(
  node: AsyncStatusNode,
  metadata: AsyncStatusModelMetadata,
  runId: string,
  path: readonly string[],
): AsyncStatusNode {
  const model = metadata[asyncMetadataKey(runId, path)];
  return {
    ...node,
    ...(model ? {
      ...(node.agent === undefined && model.agent !== undefined ? { agent: model.agent } : {}),
      ...(node.model === undefined && model.model !== undefined ? { model: model.model } : {}),
      ...(node.modelProvider === undefined && model.modelProvider !== undefined ? { modelProvider: model.modelProvider } : {}),
      ...(node.thinking === undefined && model.thinking !== undefined ? { thinking: model.thinking } : {}),
    } : {}),
    ...(node.children ? { children: node.children.map((child) => applyAsyncStatusModelMetadata(child, metadata, runId, [...path, child.id])) } : {}),
  };
}

export function formatAgentGroupLabel(label: string): string {
  const trimmed = label.trim();
  const suffixMatch = trimmed.match(/,\s*\+(\d+)\s+more$/);
  const extraCount = suffixMatch ? Number.parseInt(suffixMatch[1], 10) : 0;
  const cleanLabel = suffixMatch
    ? trimmed.slice(0, suffixMatch.index ?? trimmed.length)
    : trimmed;
  const names = cleanLabel.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length < 2) return trimmed;
  if (names.every((name) => name === names[0])) {
    return `${names[0]} ×${names.length + extraCount}`;
  }

  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const seen = new Set<string>();
  const compacted = names.flatMap((name) => {
    if (seen.has(name)) return [];
    seen.add(name);
    const count = counts.get(name) ?? 1;
    return [count > 1 ? `${name} ×${count}` : name];
  });
  return `${compacted.join(", ")}${suffixMatch ? `, +${extraCount} more` : ""}`;
}

function formatAsyncTaskCount(count: number): string {
  return `${count} task${count === 1 ? "" : "s"}`;
}

function asyncStatusDurationMs(node: AsyncStatusNode, nowMs: number): number | null {
  if (typeof node.startedAt !== "number" || !Number.isFinite(node.startedAt)) return null;
  const end = ASYNC_STATUS_TERMINAL_STATES.has(node.state)
    ? node.endedAt ?? node.updatedAt
    : nowMs;
  if (typeof end !== "number" || !Number.isFinite(end) || end < node.startedAt) return null;
  return end - node.startedAt;
}

function formatDurationMs(durationMs: number): string {
  const totalSeconds = Math.floor(Math.max(0, durationMs) / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const seconds = totalSeconds % 60;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m ${seconds}s`;
  const minutes = totalMinutes % 60;
  return `${Math.floor(totalMinutes / 60)}h ${minutes}m ${seconds}s`;
}

export function formatAsyncStatusDuration(node: AsyncStatusNode, nowMs: number): string | null {
  const durationMs = asyncStatusDurationMs(node, nowMs);
  return durationMs === null ? null : formatDurationMs(durationMs);
}

function hasLiveAsyncStatusDuration(node: AsyncStatusNode): boolean {
  if (!ASYNC_STATUS_TERMINAL_STATES.has(node.state) && typeof node.startedAt === "number") return true;
  return node.children?.some(hasLiveAsyncStatusDuration) ?? false;
}

function getWorkflowTotal(
  node: AsyncStatusNode,
  allowWorkflowTotal: boolean,
): { turnCount: number; toolCount: number } | undefined {
  const children = node.children ?? [];
  if (!allowWorkflowTotal || node.kind !== "workflow" || children.length < 2) return undefined;

  const childMetrics = children.map((child) => ({
    turnCount: child.activity?.turnCount,
    toolCount: child.activity?.toolCount,
  }));
  if (childMetrics.some(({ turnCount, toolCount }) => turnCount === undefined || toolCount === undefined)) {
    return undefined;
  }

  const turnCount = childMetrics.reduce((total, metrics) => total + metrics.turnCount!, 0);
  const toolCount = childMetrics.reduce((total, metrics) => total + metrics.toolCount!, 0);
  if (node.activity?.turnCount !== turnCount || node.activity?.toolCount !== toolCount) return undefined;
  return { turnCount, toolCount };
}

export function extractAgentsFromWorkflowLabel(label: string, count: number): string[] {
  const trimmed = label.trim();
  const suffixMatch = trimmed.match(/,\s*\+(\d+)\s+more$/);
  const clean = suffixMatch ? trimmed.slice(0, suffixMatch.index ?? trimmed.length) : trimmed;
  const names = clean.split(",").map((name) => name.trim()).filter(Boolean);
  if (names.length === count && names.every((n) => /^[a-zA-Z0-9._-]+$/.test(n))) {
    return names;
  }
  return [];
}

function AsyncStatusStepView({
  step,
  fallbackAgent,
  nowMs,
}: {
  step: AsyncStatusNode;
  fallbackAgent?: string;
  nowMs: number;
}) {
  const activity = step.activity;
  const durationText = formatAsyncStatusDuration(step, nowMs);
  const hostStep = step.hostStep;
  const modelBadge = formatCompactModelLabel(step);
  const isLeaf = !step.children || step.children.length === 0;
  const agentBadge = step.agent || fallbackAgent || (step.kind === "host-step" ? (hostStep?.kind || "host") : undefined);
  const showAgentBadge = Boolean(agentBadge && agentBadge !== step.label);
  const metrics = isLeaf && (activity?.turnCount !== undefined || activity?.toolCount !== undefined)
    ? [activity?.turnCount !== undefined && `${activity.turnCount} turns`, activity?.toolCount !== undefined && `${activity.toolCount} tools`].filter(Boolean).join(" · ")
    : null;

  const extraDetails = [
    activity?.state && `activity: ${activity.state}`,
    activity?.currentTool && `tool: ${activity.currentTool}`,
    hostStep?.provider && `provider: ${hostStep.provider}`,
    hostStep?.role,
    hostStep?.target,
    hostStep?.detail,
    hostStep?.reasonCode && `reason: ${hostStep.reasonCode}`,
    hostStep?.report && `out: ${hostStep.report}`,
    hostStep?.stale && "stale",
  ].filter((value): value is string => Boolean(value));

  const hasSecondLine = Boolean(metrics || modelBadge || extraDetails.length > 0);

  return (
    <li className="async-status-node async-status-step-item" data-state={step.state} data-kind={step.kind}>
      <div className="async-status-node-row async-status-step-row">
        <span className="async-status-node-status-dot" aria-hidden="true" />
        <span className="async-status-node-kind">{step.kind}</span>
        <span className="async-status-node-label async-status-step-label">{step.label}</span>
        {showAgentBadge && (
          <>
            <span className="async-status-step-sep">·</span>
            <span className="async-status-agent-badge">[{agentBadge}]</span>
          </>
        )}
        <span className="async-status-step-sep">·</span>
        <span className="async-status-node-id-label">id: {formatAsyncStatusId(step.id)}</span>
        {durationText && (
          <span className="async-status-duration async-status-step-duration" data-duration={durationText} title={`Duration: ${durationText}`}>
            {durationText}
          </span>
        )}
        <span className="async-status-state async-status-step-state">{step.state}</span>
      </div>
      {hasSecondLine && (
        <div className="async-status-node-detail async-status-step-detail">
          {modelBadge && <span className="async-status-model-detail">{modelBadge}</span>}
          {metrics && (
            <>
              {modelBadge && <span className="async-status-step-sep">·</span>}
              <span className="async-status-step-metrics">{metrics}</span>
            </>
          )}
          {extraDetails.length > 0 && (
            <>
              {(modelBadge || metrics) && <span className="async-status-step-sep">·</span>}
              <span>{extraDetails.join(" · ")}</span>
            </>
          )}
        </div>
      )}
      {step.children && step.children.length > 0 && (
        <ul className="async-status-tree async-status-step-children">
          {step.children.map((child, index) => (
            <AsyncStatusStepView key={`${child.id}-${index}`} step={child} nowMs={nowMs} />
          ))}
        </ul>
      )}
    </li>
  );
}

function AsyncStatusNodeView({
  node,
  allowWorkflowTotal,
  nowMs,
}: {
  node: AsyncStatusNode;
  allowWorkflowTotal: boolean;
  nowMs: number;
}) {
  const activity = node.activity;
  const durationText = formatAsyncStatusDuration(node, nowMs);
  const hostStep = node.hostStep;
  const children = node.children ?? [];
  const workflowTotal = getWorkflowTotal(node, allowWorkflowTotal);
  const workflowAgents = node.kind === "workflow" ? extractAgentsFromWorkflowLabel(node.label, children.length) : [];
  const isAgentListWorkflow = workflowAgents.length > 0;
  const completedChildrenCount = children.filter((child) => child.state === "complete").length;
  const runningChildrenCount = children.filter((child) => child.state === "running").length;

  const details = [
    activity?.state && `activity: ${activity.state}`,
    activity?.currentTool && `tool: ${activity.currentTool}`,
    !children.length && activity?.turnCount !== undefined && `${activity.turnCount} turns`,
    !children.length && activity?.toolCount !== undefined && `${activity.toolCount} tools`,
    workflowTotal && `Workflow total: ${workflowTotal.turnCount} turns · ${workflowTotal.toolCount} tools`,
    hostStep?.kind,
    hostStep?.provider && `provider: ${hostStep.provider}`,
    hostStep?.role,
    hostStep?.target,
    hostStep?.detail,
    hostStep?.reasonCode && `reason: ${hostStep.reasonCode}`,
    hostStep?.report && `out: ${hostStep.report}`,
    hostStep?.stale && "stale",
  ].filter((value): value is string => Boolean(value));

  return (
    <li className="async-status-node async-status-card" data-state={node.state} data-kind={node.kind}>
      <div className="async-status-node-row async-status-card-header">
        <span className="async-status-node-kind">{node.kind}</span>
        <span className="async-status-node-id-label async-status-card-id">id: {formatAsyncStatusId(node.id)}</span>
        {durationText && (
          <span className="async-status-duration async-status-card-duration" data-duration={durationText} title={`Duration: ${durationText}`}>
            {durationText}
          </span>
        )}
        <span className="async-status-card-task-count">{formatAsyncTaskCount(children.length)}</span>
      </div>
      {details.length > 0 && (
        <div className="async-status-node-detail async-status-card-meta">{details.join(" · ")}</div>
      )}
      {children.length > 0 && (
        <ul className="async-status-tree async-status-card-steps">
          {children.map((child, index) => (
            <AsyncStatusStepView
              key={`${child.id}-${index}`}
              step={child}
              fallbackAgent={isAgentListWorkflow ? workflowAgents[index] : undefined}
              nowMs={nowMs}
            />
          ))}
        </ul>
      )}
      {children.length > 1 && (
        <div className="async-status-card-footer">
          <span>
            Progress: {completedChildrenCount}/{children.length} completed
            {runningChildrenCount > 0 ? ` (${runningChildrenCount} running)` : ""}
          </span>
        </div>
      )}
    </li>
  );
}

export function AsyncStatusSnapshotContent({
  snapshot,
  modelMetadata = {},
}: {
  snapshot: AsyncStatusSnapshot;
  modelMetadata?: AsyncStatusModelMetadata;
}) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  const hasLiveDuration = snapshot.runs.some(hasLiveAsyncStatusDuration);

  useEffect(() => {
    if (!hasLiveDuration) return;
    setNowMs(Date.now());
    const timer = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasLiveDuration]);

  const omitted = snapshot.omitted.runs + snapshot.omitted.children;
  const allowWorkflowTotal = snapshot.omitted.children === 0 && !snapshot.omitted.byteLimitExceeded;
  const runs = Object.keys(modelMetadata).length > 0
    ? snapshot.runs.map((run) => applyAsyncStatusModelMetadata(run, modelMetadata, run.id, []))
    : snapshot.runs;
  return (
    <div className="async-status-snapshot">
      {runs.length > 0 ? (
        <ul className="async-status-tree async-status-cards">
          {runs.map((run, index) => (
            <AsyncStatusNodeView
              key={`${run.id}-${index}`}
              node={run}
              allowWorkflowTotal={allowWorkflowTotal}
              nowMs={nowMs}
            />
          ))}
        </ul>
      ) : (
        <div className="async-status-empty">No async runs</div>
      )}
      {(omitted > 0 || snapshot.omitted.byteLimitExceeded) && (
        <div className="async-status-omitted">
          {omitted > 0 ? `${omitted} items omitted` : "Output truncated"}
        </div>
      )}
    </div>
  );
}

export function snapshotExtensionWidgetContents(
  widgets: ExtensionWidgetItem[],
): Map<string, string[]> {
  return new Map(widgets.map((widget) => [widget.key, [...widget.lines]]));
}

export function getUpdatedExtensionWidgetKeys(
  previous: ReadonlyMap<string, readonly string[]> | null,
  next: ReadonlyMap<string, readonly string[]>,
): string[] {
  if (!previous) return [];
  return Array.from(next, ([key, lines]) => {
    const previousLines = previous.get(key);
    if (!previousLines || previousLines.length !== lines.length) {
      return previousLines ? key : null;
    }
    return lines.some((line, index) => line !== previousLines[index]) ? key : null;
  }).filter((key): key is string => key !== null);
}

function hasExtensionWidgetContent(widget: ExtensionWidgetItem): boolean {
  return widget.lines.some((line) => stripAnsi(line).trim().length > 0);
}

export function getVisibleExtensionWidgets(
  widgets: readonly ExtensionWidgetItem[],
): ExtensionWidgetItem[] {
  return widgets.filter(hasExtensionWidgetContent);
}

export function getExpandedExtensionWidget(
  widgets: readonly ExtensionWidgetItem[],
  key: string | null,
): ExtensionWidgetItem | undefined {
  if (key === null) return undefined;
  return widgets.find((widget) => widget.key === key && hasExtensionWidgetContent(widget));
}

export function getNextExpandedWidgetKey(
  currentKey: string | null,
  requestedKey: string,
): string | null {
  return currentKey === requestedKey ? null : requestedKey;
}

export function ExtensionWidgets({
  widgets,
  sessionId,
  remotePeer,
}: {
  widgets: ExtensionWidgetItem[];
  sessionId?: string;
  remotePeer?: string;
}) {
  const { t } = useI18n();
  const idPrefix = useId();
  const previousContentsRef = useRef<Map<string, string[]> | null>(null);
  const updateClearTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const expandedPanelRef = useRef<HTMLDivElement>(null);
  const triggerGroupRef = useRef<HTMLDivElement>(null);
  // Widgets stay collapsed until the user opens them.
  const [expandedWidgetKey, setExpandedWidgetKey] = useState<string | null>(null);
  const [updatingWidgetKeys, setUpdatingWidgetKeys] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [modelMetadata, setModelMetadata] = useState<AsyncStatusModelMetadata>({});
  const modelMetadataScopeRef = useRef<string | null>(null);

  useEffect(() => {
    const nextContents = snapshotExtensionWidgetContents(widgets);
    const updatedKeys = getUpdatedExtensionWidgetKeys(
      previousContentsRef.current,
      nextContents,
    );
    previousContentsRef.current = nextContents;

    for (const [key, timer] of updateClearTimersRef.current) {
      if (nextContents.has(key)) continue;
      clearTimeout(timer);
      updateClearTimersRef.current.delete(key);
    }

    setUpdatingWidgetKeys((current) => {
      const next = new Set(Array.from(current).filter((key) => nextContents.has(key)));
      for (const key of updatedKeys) next.add(key);
      if (
        next.size === current.size
        && Array.from(next).every((key) => current.has(key))
      ) return current;
      return next;
    });

    for (const key of updatedKeys) {
      const currentTimer = updateClearTimersRef.current.get(key);
      if (currentTimer) clearTimeout(currentTimer);
      updateClearTimersRef.current.set(key, setTimeout(() => {
        updateClearTimersRef.current.delete(key);
        setUpdatingWidgetKeys((current) => {
          if (!current.has(key)) return current;
          const next = new Set(current);
          next.delete(key);
          return next;
        });
      }, WIDGET_UPDATE_IDLE_MS));
    }
  }, [widgets]);

  useEffect(() => () => {
    for (const timer of updateClearTimersRef.current.values()) clearTimeout(timer);
    updateClearTimersRef.current.clear();
  }, []);

  useEffect(() => {
    if (expandedWidgetKey !== null && !getExpandedExtensionWidget(widgets, expandedWidgetKey)) {
      setExpandedWidgetKey(null);
    }
  }, [expandedWidgetKey, widgets]);

  useEffect(() => {
    if (expandedWidgetKey === null) return;
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (expandedPanelRef.current?.contains(target) || triggerGroupRef.current?.contains(target)) return;
      setExpandedWidgetKey(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, [expandedWidgetKey]);

  const visibleWidgets = getVisibleExtensionWidgets(widgets);
  const expandedWidget = getExpandedExtensionWidget(visibleWidgets, expandedWidgetKey);
  const expandedSnapshot = expandedWidget ? parseAsyncStatusSnapshot(expandedWidget.lines) : null;
  const asyncSnapshotIdsKey = expandedSnapshot ? collectAsyncStatusIds(expandedSnapshot).join(",") : "";
  const asyncSnapshotContentKey = expandedWidget ? expandedWidget.lines.join("\n") : "";

  useEffect(() => {
    let cancelled = false;
    if (!sessionId || !asyncSnapshotIdsKey) {
      modelMetadataScopeRef.current = null;
      setModelMetadata({});
      return () => { cancelled = true; };
    }

    const requestedIds = asyncSnapshotIdsKey.split(",").filter(Boolean);
    const scopeKey = `${remotePeer ?? ""}\u0000${sessionId}`;
    const sameScope = modelMetadataScopeRef.current === scopeKey;
    modelMetadataScopeRef.current = scopeKey;
    setModelMetadata((current) => mergeAsyncStatusModelMetadata(
      sameScope ? current : {},
      {},
      requestedIds,
    ));

    const params = new URLSearchParams({ sessionId, ids: asyncSnapshotIdsKey });
    fetch(apiPathForPeer(remotePeer, `subagents/async-metadata?${params.toString()}`), { cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) return {};
        const value: unknown = await response.json();
        if (!value || typeof value !== "object" || Array.isArray(value)) return {};
        const models = (value as { models?: unknown }).models;
        return models && typeof models === "object" && !Array.isArray(models)
          ? models as AsyncStatusModelMetadata
          : {};
      })
      .then((models) => {
        if (!cancelled) {
          setModelMetadata((current) => mergeAsyncStatusModelMetadata(current, models, requestedIds));
        }
      })
      .catch(() => {
        // Keep the last successful metadata through a transient refresh failure.
      });
    return () => { cancelled = true; };
  }, [asyncSnapshotContentKey, asyncSnapshotIdsKey, remotePeer, sessionId]);

  if (visibleWidgets.length === 0) return null;

  const toggleWidget = (widget: ExtensionWidgetItem) => {
    setExpandedWidgetKey((current) => getNextExpandedWidgetKey(current, widget.key));
  };

  return (
    <>
      {expandedWidget && (
        <div ref={expandedPanelRef} className="extension-widget-panels">
          {(() => {
            const widget = expandedWidget;
            const index = visibleWidgets.indexOf(widget);
            const triggerId = `${idPrefix}-trigger-${index}`;
            const panelId = `${idPrefix}-panel-${index}`;
            return (
              <section
                key={widget.key}
                id={panelId}
                className="extension-widget-panel"
                aria-labelledby={triggerId}
              >
                <div className="extension-widget-panel-heading">{widget.key}</div>
                {(() => {
                  const snapshot = parseAsyncStatusSnapshot(widget.lines);
                  return snapshot ? (
                    <AsyncStatusSnapshotContent snapshot={snapshot} modelMetadata={modelMetadata} />
                  ) : (
                    <pre className="extension-widget-content">
                      <AnsiText text={formatExtensionWidgetContent(widget.lines)} />
                    </pre>
                  );
                })()}
              </section>
            );
          })()}
        </div>
      )}
      <div ref={triggerGroupRef} className="extension-widget-triggers" aria-label={t("chat.extensionWidgets")}>
        {visibleWidgets.map((widget, index) => {
          const expandable = widget.lines.length > 0;
          const expanded = expandable && widget.key === expandedWidget?.key;
          const updating = updatingWidgetKeys.has(widget.key);
          const lineCountLabel = t(
            widget.lines.length === 1 ? "chat.extensionWidgetLine" : "chat.extensionWidgetLines",
            { count: widget.lines.length },
          );
          const placementLabel = t(
            widget.placement === "belowEditor"
              ? "chat.extensionWidgetBelow"
              : "chat.extensionWidgetAbove",
          );
          const triggerId = `${idPrefix}-trigger-${index}`;
          const panelId = `${idPrefix}-panel-${index}`;
          const content = (
            <>
              <span className="extension-widget-update-pulse" aria-hidden="true" />
              <span className="extension-widget-placement" aria-hidden="true">
                <svg
                  className="extension-widget-placement-icon"
                  viewBox="0 0 8 6"
                  width="8"
                  height="6"
                  data-direction={widget.placement === "belowEditor" ? "down" : "up"}
                  focusable="false"
                >
                  <path
                    d={widget.placement === "belowEditor"
                      ? "M0 0h8L4 6z"
                      : "M4 0l4 6H0z"}
                  />
                </svg>
              </span>
              <span className="extension-widget-key">{widget.key}</span>
            </>
          );

          return expandable ? (
            <button
              key={widget.key}
              id={triggerId}
              type="button"
              className={`extension-widget-trigger${expanded ? " is-expanded" : ""}${updating ? " is-updating" : ""}`}
              aria-controls={panelId}
              aria-expanded={expanded}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel} - ${expanded ? t("i18n.collapse") : t("i18n.expand")}`}
              onClick={() => toggleWidget(widget)}
            >
              {content}
            </button>
          ) : (
            <div
              key={widget.key}
              className={`extension-widget-trigger${updating ? " is-updating" : ""}`}
              aria-label={`${placementLabel}: ${widget.key}, ${lineCountLabel}`}
              title={`${widget.key} - ${placementLabel}`}
            >
              {content}
            </div>
          );
        })}
      </div>
    </>
  );
}
