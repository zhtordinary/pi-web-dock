import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  getAgentDir,
  initTheme,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { createPiWebBuiltinExtensions } from "./builtin-extensions";
import { createCompactionModelExtension } from "./compaction-model-extension";
import { acquireSessionRuntimeOwnership, type SessionRuntimeOwnership } from "./session-runtime-ownership";
import type { McpHost } from "./mcp-host";
import type { AgentSessionLike } from "./pi-types";
import {
  subagentNotificationText,
  subagentToolDetails,
  type ResumeSubagentRequest,
  type StartSubagentRequest,
  type SubagentExecution,
  type SubagentExtensionRuntime,
} from "./subagent-extension";
import {
  readSubagentRun,
  hasSubagentResourceSnapshot,
  readSubagentSessionResources,
  resolveSubagentProfile,
  subagentExtensionLoaderOptions,
  subagentToolOptions,
  SUBAGENT_CONTROL_TOOL_NAMES,
  SUBAGENT_META_TYPE,
  SUBAGENT_STATUS_TYPE,
  SUBAGENT_RESULT_TYPE,
  selectSubagentExtensionTools,
  subagentNameList,
  withSubagentExtensionTools,
  type SubagentMetadata,
  type SubagentResultMetadata,
  type SubagentRunInfo,
} from "./subagents";
import type { SessionEntry } from "./types";
import { buildSubagentPromptPlan } from "./subagent-prompt";
import { createSubagentSkillsBinding } from "./subagent-skills";
import { appendSubagentInputFiles, loadSubagentInputFiles, subagentInputLimits } from "./subagent-input";
import { projectTrustReloadOptions } from "./project-trust";
import { getProjectTrustStatus } from "./project-trust";
import { createSubagentMcpPolicyExtension } from "./mcp-read-only-policy";
import { resolveShellTools } from "./powershell-settings";
import {
  filterRuntimeSkills,
  loadSkillPolicyCatalog,
  resolveRuntimeSkillPolicy,
  type RuntimeSkillLike,
  type RuntimeSkillPolicyContext,
} from "./skill-runtime-policy";
import { getSkillInvocationModes } from "./skill-policy";
import { isBuiltInSubagentsEnabled, readSubagentSettings } from "./subagent-settings";
import { SubagentQueue } from "./subagent-queue";
import { addWorktree, removeWorktree } from "./worktree";
import { randomUUID } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import {
  assertRemoteClaudeHost,
  createRemoteClaudeHostGuardExtension,
  installRemoteClaudeHost,
  REMOTE_CLAUDE_PROVIDER_ID,
  resolveRemoteClaudeHost,
  revokeRemoteClaudeHost,
  type RemoteClaudeHostBinding,
} from "./remote-claude-host";

interface HostSession {
  readonly inner: AgentSessionLike;
  readonly sessionFile: string;
  readonly cwd: string;
  isAlive(): boolean;
  isRunning(): boolean;
  isStopRequested?(): boolean;
  waitUntilReady(): Promise<void>;
  admitSubagentExecution?(completion: Promise<unknown>, cancel: () => void): void;
  prepareMcpForRun?(signal: AbortSignal): Promise<boolean>;
}

import { readerRuntimeProjectRoot } from './reader-execution-cwd';

export interface SubagentRuntimeDependencies {
  getSession(sessionId: string): HostSession | undefined;
  registerSession(
    inner: AgentSessionLike,
    options?: {
      exactSystemPrompt?: string;
      chatOnly?: boolean;
      remoteHost?: RemoteClaudeHostBinding;
      mcpHost?: McpHost;
      skillRuntimeContext?: RuntimeSkillPolicyContext;
      runtimeOwnership?: SessionRuntimeOwnership;
    },
  ): HostSession | void;
  reopenSession(sessionId: string, sessionFile: string, parentSessionId?: string): Promise<HostSession>;
  resolveSessionPath(sessionId: string): Promise<string | null>;
  invalidateSessionList(): void;
  isBuiltInSubagentsEnabled?(): boolean;
}

export interface SubagentController {
  readonly extensionRuntime: SubagentExtensionRuntime;
  get(sessionId: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<SubagentRunInfo | null>;
  steer(sessionId: string, message: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<void>;
  abort(sessionId: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<void>;
}

type StoredSubagentExecution = {
  run: SubagentRunInfo;
  completion: Promise<SubagentRunInfo>;
  abortRequested: boolean;
  /** Set once the turn limit closes the run; later steering must not reopen it. */
  turnLimitReached?: boolean;
  cancelQueued?: () => boolean;
  remoteHost?: RemoteClaudeHostBinding;
  mcpWait?: AbortController;
};

declare global {
  var __piSubagentRuns: Map<string, StoredSubagentExecution> | undefined;
  var __piSubagentQueue: SubagentQueue<SubagentRunInfo> | undefined;
  var __piSubagentConsumedResults: Map<string, string> | undefined;
}
const SUBAGENT_CONTEXT_LIMIT = 50_000;
const PARENT_IDLE_POLL_MS = 200;
const THINKING_LEVELS = new Set<ThinkingLevel>(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const TURN_LIMIT_INSTRUCTION = "You have reached your turn limit. Wrap up immediately and provide your final answer now.";

/** Wait for child MCP servers through the same wrapper path as a direct prompt. */
async function prepareChildMcp(session: HostSession | void, stored: StoredSubagentExecution): Promise<void> {
  if (!session?.prepareMcpForRun) return;
  const controller = new AbortController();
  stored.mcpWait = controller;
  try {
    if (stored.abortRequested) controller.abort();
    const ready = await session.prepareMcpForRun(controller.signal);
    if (ready && !stored.abortRequested && !controller.signal.aborted) return;
    stored.abortRequested = true;
    throw new Error("Stopped while connecting MCP servers");
  } finally {
    if (stored.mcpWait === controller) stored.mcpWait = undefined;
  }
}

/** SDK 1.1 resolves prompt() for provider stops; inspect the persisted assistant message. */
function lastAssistantStop(sessionManager: { getEntries?: () => unknown }): { aborted?: true; error?: string } | undefined {
  const entries = sessionManager.getEntries?.();
  if (!Array.isArray(entries)) return undefined;
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as { type?: unknown; message?: { role?: unknown; stopReason?: unknown; errorMessage?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    if (entry.message.stopReason === "aborted") return { aborted: true };
    if (entry.message.stopReason !== "error") return undefined;
    return { error: typeof entry.message.errorMessage === "string" && entry.message.errorMessage ? entry.message.errorMessage : "Provider returned an error" };
  }
  return undefined;
}

function assistantTextFromEntries(entries: readonly unknown[]): string | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index] as { type?: unknown; message?: { role?: unknown; content?: unknown } };
    if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
    const content = entry.message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter((block): block is { type?: unknown; text?: unknown } => typeof block === "object" && block !== null)
          .filter((block) => block.type === "text" && typeof block.text === "string")
          .map((block) => block.text as string)
          .join("")
        : "";
    if (text.trim()) return text.trim();
  }
  return undefined;
}

function assistantTextForRun(
  inner: AgentSessionLike,
  sessionManager: { getEntries?: () => unknown },
  baselineEntryCount: number,
  previousText?: string,
): string | undefined {
  const entries = sessionManager.getEntries?.();
  if (Array.isArray(entries)) {
    const appended = assistantTextFromEntries(entries.slice(baselineEntryCount));
    if (appended) return appended;
  }
  const current = inner.getLastAssistantText?.()?.trim();
  return current && current !== previousText?.trim() ? current : undefined;
}

function turnLimitError(turnLimit: number, undelivered: readonly string[]): string {
  const error = `Subagent reached its turn limit (${turnLimit}) without completing the task.`;
  if (undelivered.length === 0) return error;
  return `${error} These queued messages were not delivered:\n${undelivered.map((text) => `- ${text}`).join("\n")}`;
}

interface TurnLimitGuard {
  reached(): boolean;
  undelivered(): readonly string[];
  dispose(): void;
}

function installTurnLimitGuard(
  inner: AgentSessionLike,
  turnLimit: number | undefined,
  stored: StoredSubagentExecution,
): TurnLimitGuard {
  if (!turnLimit) return { reached: () => false, undelivered: () => [], dispose: () => {} };
  // SAFETY: AgentSessionLike exposes the SDK Agent only through a reduced Reader type;
  // Pi 1.1's runtime Agent still owns the public finishTurn/queue-mode hooks used here.
  const turnLimitAgent = inner.agent as unknown as {
    finishTurn?: (turn: { message: { stopReason?: string }; toolResults: Array<{ toolCallId: string }> }, signal?: AbortSignal) => Promise<{ action?: string } | undefined> | { action?: string } | undefined;
    steeringMode?: unknown;
    hasQueuedMessages?: () => boolean;
  };
  const previousFinishTurn = turnLimitAgent.finishTurn;
  const previousSteeringMode = turnLimitAgent.steeringMode;
  const terminatingTools = new Set<string>();
  let turnCount = 0;
  let hardLimitReached = false;
  let undelivered: string[] = [];
  const unsubscribeTools = inner.subscribe((event) => {
    // SAFETY: AgentSessionLike's event union is intentionally narrower than the
    // SDK 1.1 event payload; these fields are read only after checking the type.
    const candidate = event as unknown as { type?: string; toolCallId?: string; result?: { terminate?: boolean } };
    if (candidate.type === "tool_execution_end" && candidate.toolCallId && candidate.result?.terminate === true) {
      terminatingTools.add(candidate.toolCallId);
    }
  });
  turnLimitAgent.finishTurn = async (turn, signal) => {
    const decision = previousFinishTurn
      ? await previousFinishTurn(turn, signal)
      : undefined;
    const toolsContinue = turn.toolResults.some((message) => !terminatingTools.has(message.toolCallId));
    terminatingTools.clear();
    if (signal?.aborted || decision?.action === "end"
      || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return decision;
    const needsAnotherTurn = toolsContinue || decision?.action === "continue" || turnLimitAgent.hasQueuedMessages?.() === true;
    if (!needsAnotherTurn) return decision;
    turnCount += 1;
    if (turnCount < turnLimit) return decision;
    if (turnCount > turnLimit) {
      hardLimitReached = true;
      stored.turnLimitReached = true;
      const queue = inner.clearQueue();
      undelivered = [...queue.steering, ...queue.followUp];
      return { action: "end" };
    }
    turnLimitAgent.steeringMode = "all";
    await inner.steer(TURN_LIMIT_INSTRUCTION);
    return decision;
  };
  return {
    reached: () => hardLimitReached,
    undelivered: () => undelivered,
    dispose: () => {
      turnLimitAgent.finishTurn = previousFinishTurn;
      turnLimitAgent.steeringMode = previousSteeringMode;
      unsubscribeTools();
    },
  };
}
export function activeSubagentIdsForParent(parentSessionId: string): string[] {
  return [...(globalThis.__piSubagentRuns?.values() ?? [])]
    .filter(({ run }) => run.parentSessionId === parentSessionId && (run.status === "running" || run.status === "queued"))
    .map(({ run }) => run.sessionId);
}

function getSubagentRuns(): Map<string, StoredSubagentExecution> {
  if (!globalThis.__piSubagentRuns) globalThis.__piSubagentRuns = new Map();
  return globalThis.__piSubagentRuns;
}

function getSubagentQueue(): SubagentQueue<SubagentRunInfo> {
  if (!globalThis.__piSubagentQueue) globalThis.__piSubagentQueue = new SubagentQueue();
  return globalThis.__piSubagentQueue;
}

type SubagentRunIdentity = Pick<SubagentRunInfo, "sessionId" | "completedAt">;

/**
 * Background runs whose terminal result the parent already collected with `get_subagent_result`,
 * keyed by subagent session ID and holding the collected run's `completedAt`. `resume` reruns
 * the same session ID, so the mark must name the run: a parent that polls *after* a run's
 * notification was delivered leaves a mark nothing consumes, and a bare session ID would let it
 * swallow the next run's notification (#987). `resume` deliberately does not clear the entry:
 * the parent can collect a run and resume it in the same turn while that run's notification is
 * still held, and the mark must keep suppressing it. Only background runs are recorded — a
 * foreground run never notifies — and each session holds at most one entry.
 */
function getConsumedSubagentResults(): Map<string, string> {
  // A hot reload can leave the pre-#987 Set on globalThis; replace it rather than call Map methods on it.
  if (!(globalThis.__piSubagentConsumedResults instanceof Map)) globalThis.__piSubagentConsumedResults = new Map();
  return globalThis.__piSubagentConsumedResults;
}

function markResultConsumed(run: SubagentRunIdentity): void {
  // A terminal run without `completedAt` (interrupted) never notifies, so there is nothing to drop.
  if (!run.completedAt) return;
  getConsumedSubagentResults().set(run.sessionId, run.completedAt);
}

/** Take the mark only when it names this very run; a mark left by an earlier run is ignored. */
function takeResultConsumed(run: SubagentRunIdentity): boolean {
  const consumed = getConsumedSubagentResults();
  if (!run.completedAt || consumed.get(run.sessionId) !== run.completedAt) return false;
  consumed.delete(run.sessionId);
  return true;
}

/**
 * A run lives in `getSubagentRuns()` from dispatch until its result entry is written, so a
 * persisted `running` / `queued` status reaching `get()` without that entry (and without a running
 * wrapper) was left by a process that stopped mid-run and will never be finished. Report it as
 * `interrupted` so `get_subagent_result({ wait: true })` returns instead of polling forever, and
 * `resume` can pick the session up again.
 */
function settleOrphanedRun(run: SubagentRunInfo): SubagentRunInfo {
  return run.status === "running" || run.status === "queued" ? { ...run, status: "interrupted" } : run;
}

function findSubagentModel(runtime: ModelRuntime, reference: string) {
  const slash = reference.indexOf("/");
  if (slash > 0) return runtime.getModel(reference.slice(0, slash), reference.slice(slash + 1));
  const matches = runtime.getModels().filter((model) => model.id === reference);
  if (matches.length > 1) throw new Error(`Subagent model is ambiguous; use provider/modelId: ${reference}`);
  return matches[0];
}

/** Resolve a full model ID before treating the final colon as a thinking suffix. */
export function parseSubagentModel(runtime: ModelRuntime, value: string | undefined) {
  if (!value?.trim()) return undefined;
  const requested = value.trim();
  const exact = findSubagentModel(runtime, requested);
  if (exact) return { model: exact };
  const colon = requested.lastIndexOf(":");
  const level = requested.slice(colon + 1) as ThinkingLevel;
  if (colon > 0 && THINKING_LEVELS.has(level)) {
    const model = findSubagentModel(runtime, requested.slice(0, colon));
    if (model) return { model, thinkingLevel: level };
  }
  throw new Error(`Subagent model not found: ${requested}`);
}

/**
 * The model the child is expected to run (the call's, else the profile's, else the parent's),
 * looked up early to size `input_files` before a worktree or child session exists (#1199). It
 * never throws: the child's model is resolved for real, and a bad reference refused, only after
 * the child's services have refreshed the shared runtime from models.json and registered its
 * extensions' providers. A reference this lookup misses leaves the files the flat limit.
 */
function expectedSubagentModel(
  runtime: ModelRuntime,
  callModel: string | undefined,
  profileModel: string | undefined,
  parentModel: AgentSessionLike["model"],
) {
  try {
    const reference = callModel?.trim() || profileModel?.trim();
    return reference ? parseSubagentModel(runtime, reference)?.model : parentModel;
  } catch {
    return undefined;
  }
}

function parentContextText(parent: HostSession): string {
  const messages = parent.inner.sessionManager.buildSessionContext().messages;
  const serialized = JSON.stringify(messages);
  if (serialized.length <= SUBAGENT_CONTEXT_LIMIT) return serialized;
  return `${serialized.slice(0, SUBAGENT_CONTEXT_LIMIT)}\n[Parent context truncated]`;
}

export async function createSubagentSkillRuntimeContext(options: {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
  loadSkills: boolean;
  projectTrusted: boolean;
}): Promise<RuntimeSkillPolicyContext> {
  const scope = options.projectTrusted ? ("project" as const) : ("global" as const);
  const base = {
    scope,
    cwd: options.cwd,
    agentDir: options.agentDir,
  } satisfies Pick<RuntimeSkillPolicyContext, "scope" | "cwd" | "agentDir">;
  if (!options.loadSkills) {
    // A noSkills/chatOnly child still receives the SDK boundary patch, but its
    // capability is explicitly closed. Do not let a parent catalog or mode map
    // make a new child discoverable by accident.
    return {
      ...base,
      runtimeSkillsEnabled: false,
      runtimeCatalogAvailable: false,
      requireRuntimeCatalog: true,
      entries: [],
      policies: [],
      stale: [],
      catalogSkills: [],
      globalInvocationModes: {},
      projectInvocationModes: {},
    };
  }

  let catalog: Awaited<ReturnType<typeof loadSkillPolicyCatalog>>;
  try {
    catalog = await loadSkillPolicyCatalog(options.cwd, scope);
  } catch (error) {
    throw new Error(`Reader Skill runtime policy unavailable for subagent: ${error instanceof Error ? error.message : String(error)}`);
  }
  return {
    ...base,
    runtimeSkillsEnabled: true,
    runtimeCatalogAvailable: true,
    requireRuntimeCatalog: true,
    entries: [],
    policies: catalog.skills.map((skill) => skill.policy),
    stale: catalog.stale,
    catalogSkills: catalog.skills as RuntimeSkillLike[],
    globalInvocationModes: getSkillInvocationModes(options.settingsManager.getGlobalSettings(), "global"),
    projectInvocationModes: options.projectTrusted
      ? getSkillInvocationModes(options.settingsManager.getProjectSettings(), "project", options.cwd)
      : {},
  };
}

export function permittedSubagentSkillNames(
  names: readonly string[] | undefined,
  context: RuntimeSkillPolicyContext,
): string[] | undefined {
  if (names === undefined) return undefined;
  const candidates = context.catalogSkills ?? [];
  return subagentNameList(names).filter((name) => {
    const matches = candidates.filter((skill) => skill.name === name);
    return matches.length === 1 && resolveRuntimeSkillPolicy(matches[0], context).runtimeLoaded;
  });
}

async function cleanupWorktree(
  parentCwd: string,
  worktree: { path: string; branch: string } | undefined,
): Promise<string | undefined> {
  if (!worktree) return undefined;
  try {
    await removeWorktree(parentCwd, worktree.path);
    return undefined;
  } catch (error) {
    return `Worktree retained at ${worktree.path}: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * pi creates a session file only once the session holds a user or assistant message, so a run
 * that ended before its prompt reached the model (stopped while queued or connecting MCP servers,
 * a provider without credentials) kept its metadata and result in memory only. Once the idle
 * child's wrapper was released, `get_subagent_result` and `resume` answered `Subagent not found`
 * for an id the parent had been given, and the session left the sidebar. Write the file when the
 * child is dispatched; `setSessionFile()` reloads it, so pi appends every later entry to it.
 */
function persistChildSession(sessionManager: SessionManager): void {
  const sessionFile = sessionManager.getSessionFile();
  const header = sessionManager.getHeader();
  if (!sessionFile || !header || existsSync(sessionFile)) return;
  const lines = [header, ...sessionManager.getEntries()].map((entry) => JSON.stringify(entry));
  writeFileSync(sessionFile, `${lines.join("\n")}\n`, { flag: "wx", mode: 0o600 });
  sessionManager.setSessionFile(sessionFile);
}

/**
 * Writes a settled run's result entry, which `readSubagentRun()` reads back, and returns the run as
 * recorded. An isolated run's entry keeps whether its worktree path still exists now, which decides
 * what the parent is told about it, live and read back alike (#1202): a checkout removed during
 * the run is gone though git's removal then failed, and a resumed run removes nothing.
 */
function recordResult(sessionManager: SessionManager, run: SubagentRunInfo): SubagentRunInfo {
  const recorded = run.worktreePath ? { ...run, worktreeExists: existsSync(run.worktreePath) } : run;
  const entry: SubagentResultMetadata = {
    version: 1,
    status: recorded.status as SubagentResultMetadata["status"],
    completedAt: recorded.completedAt!,
    ...(recorded.result ? { result: recorded.result } : {}),
    ...(recorded.error ? { error: recorded.error } : {}),
    ...(recorded.worktreeCleanupError ? { worktreeCleanupError: recorded.worktreeCleanupError } : {}),
    ...(recorded.worktreeExists !== undefined ? { worktreeExists: recorded.worktreeExists } : {}),
  };
  sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, entry);
  return recorded;
}

export function createSubagentController(
  dependencies: SubagentRuntimeDependencies,
): SubagentController {
  async function start(request: StartSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    if (!parent.sessionFile) throw new Error("Parent session must be persisted before starting a subagent");

    let isolatedWorktree: { path: string; branch: string } | undefined;
    let childRemoteHost: RemoteClaudeHostBinding | undefined;
    let runtimeOwnership: SessionRuntimeOwnership | undefined;
    let unregisteredInner: AgentSessionLike | undefined;
    try {
      const parentUsesRemoteClaude = parent.inner.model?.provider === REMOTE_CLAUDE_PROVIDER_ID;
      const parentRemoteHost = parentUsesRemoteClaude ? resolveRemoteClaudeHost(parentSessionId) : undefined;
      if (parentUsesRemoteClaude && !parentRemoteHost) {
        throw new Error("capability-unavailable: remote Claude parent host binding is unavailable");
      }
      const profile = resolveSubagentProfile(parent.cwd, request.profile);
      if (!profile) throw new Error(`Unknown or disabled subagent profile: ${request.profile}`);

      const runInBackground = request.runInBackground ?? profile.runInBackground;
      const isolation = profile.isolation === "off" ? undefined : request.isolation ?? profile.isolation;
      const inheritContext = request.inheritContext ?? profile.inheritContext;
      const parentModelRuntime = (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime;
      const callModel = request.model?.trim() ? parseSubagentModel(parentModelRuntime, request.model) : undefined;
      const profileModel = !callModel ? parseSubagentModel(parentModelRuntime, profile.model) : undefined;
      const selectedModel = callModel?.model ?? profileModel?.model;
      const selectedModelName = selectedModel
        ? `${selectedModel.provider}/${selectedModel.id}`
        : parent.inner.model ? `${parent.inner.model.provider}/${parent.inner.model.id}` : undefined;
      const rawMaxTurns = request.maxTurns ?? profile.maxTurns;
      const effectiveProfileTools = parentRemoteHost
        ? profile.tools.filter((tool) => parentRemoteHost.policy.orchestration.childTools.includes(tool))
        : profile.tools;
      if (parentRemoteHost) {
        assertRemoteClaudeHost(parentRemoteHost, "start-child", {
          readerMarker: parentRemoteHost.readerMarker,
          parentSessionId,
          parentToolCallId: request.parentToolCallId,
          toolName: "Agent",
        });
        if (!parentRemoteHost.policy.orchestration.allowedProfiles.includes(profile.name)) {
          throw new Error("profile-denied: subagent profile is not approved for claude-remote");
        }
        if (selectedModelName && parentRemoteHost.policy.orchestration.allowedModels.length > 0
          && !parentRemoteHost.policy.orchestration.allowedModels.includes(selectedModelName)) {
          throw new Error("model-denied: subagent model is not approved for claude-remote");
        }
        if (rawMaxTurns !== undefined && (!Number.isSafeInteger(rawMaxTurns) || rawMaxTurns < 1
          || rawMaxTurns > parentRemoteHost.policy.orchestration.maxTurns)) {
          throw new Error("invalid-request: max_turns must be a finite positive integer within the parent limit");
        }
        if (inheritContext && !parentRemoteHost.policy.orchestration.allowInheritedContext) {
          throw new Error("policy-denied: inherited context is not allowed for this parent");
        }
        if (isolation === "worktree" && !parentRemoteHost.policy.orchestration.allowWorktree) {
          throw new Error("policy-denied: isolated worktrees are not allowed for this parent");
        }
      } else if (rawMaxTurns !== undefined && (!Number.isFinite(rawMaxTurns) || rawMaxTurns < 0)) {
        throw new Error("max_turns must be a non-negative number");
      }
      const turnLimit = parentRemoteHost
        ? (rawMaxTurns ?? parentRemoteHost.policy.orchestration.maxTurns)
        : rawMaxTurns && rawMaxTurns > 0 ? Math.floor(rawMaxTurns) : undefined;
      if (isolation === "worktree") {
        isolatedWorktree = await addWorktree(parent.cwd, `pi-web-agent-${randomUUID()}`);
      }
      const childCwd = isolatedWorktree?.path ?? parent.cwd;
      const childProjectRoot = await readerRuntimeProjectRoot(childCwd);

      const agentDir = getAgentDir();
      const childProjectTrust = getProjectTrustStatus(childCwd, agentDir);
      const settingsManager = SettingsManager.create(childCwd, agentDir, {
        projectTrusted: childProjectTrust.trusted,
      });
      const childSkillRuntimeContext = await createSubagentSkillRuntimeContext({
        cwd: childCwd,
        agentDir,
        settingsManager,
        loadSkills: profile.loadSkills,
        projectTrusted: childProjectTrust.trusted,
      });
      const inheritedParentContext = inheritContext
        ? `The following is the active conversation context from the parent session. Use it only as background for the delegated task:\n${parentContextText(parent)}`
        : undefined;
      const inputFiles = loadSubagentInputFiles(childCwd, request.inputFiles ?? []);
      const promptPlan = buildSubagentPromptPlan({
        profileSystemPrompt: profile.systemPrompt,
        tools: effectiveProfileTools,
        loadSkills: profile.loadSkills,
        loadExtensions: profile.loadExtensions,
        promptMode: profile.promptMode,
        task: appendSubagentInputFiles(request.task, inputFiles),
        inheritedParentContext,
      });
      const parentCodemodeEnabled = parent.inner.getActiveToolNames().includes("codemode");
      const wantsCodemode = profile.codemode === "on"
        || (profile.codemode === "inherit" && parentCodemodeEnabled);
      if (promptPlan.chatOnly && profile.codemode === "on") {
        throw new Error("Code mode cannot be enabled for a chat-only subagent profile");
      }
      // Inherit follows the parent only when the profile already has ordinary tools;
      // tools:none remains chat-only and cannot gain a script capability.
      const codemodeEnabled = !promptPlan.chatOnly && wantsCodemode;
      if (promptPlan.chatOnly && profile.mcp === "on") {
        throw new Error("MCP cannot be enabled for a chat-only subagent profile");
      }
      const mcpEnabled = profile.mcp === "on";
      const selectedSkillNames = permittedSubagentSkillNames(profile.skills, childSkillRuntimeContext);
      const subagentSkillsBinding = createSubagentSkillsBinding({
        loadSkills: profile.loadSkills,
        skills: selectedSkillNames,
        exactSystemPrompt: promptPlan.exactSystemPrompt,
      });
      const originalSkillsOverride = subagentSkillsBinding.loaderOptions.skillsOverride;
      const runtimeSkillsOverride = profile.loadSkills
        ? ((base: Parameters<NonNullable<typeof originalSkillsOverride>>[0]) => {
            const projected = originalSkillsOverride ? originalSkillsOverride(base) : base;
            return {
              ...projected,
              skills: filterRuntimeSkills(projected.skills as RuntimeSkillLike[], childSkillRuntimeContext) as typeof projected.skills,
            };
          })
        : undefined;
      const childSkillLoaderOptions = runtimeSkillsOverride
        ? { ...subagentSkillsBinding.loaderOptions, skillsOverride: runtimeSkillsOverride }
        : subagentSkillsBinding.loaderOptions;
      const { chatOnly, appendSystemPrompt, delegatedTask } = promptPlan;
      const builtinResources = codemodeEnabled || mcpEnabled
        ? await createPiWebBuiltinExtensions({ agentDir })
        : undefined;
      const builtinExtensionNames = new Set<string>([
        ...(codemodeEnabled ? ["codemode"] : []),
        ...(mcpEnabled ? ["tool-search", "mcp", "pi-web-mcp-host"] : []),
      ]);
      const childBuiltinFactories = builtinResources?.extensions.filter((extension) => builtinExtensionNames.has(extension.name)) ?? [];
      const mcpScope: { tools: readonly string[]; allExtensionTools?: boolean } = { tools: [] };
      const childInnerRef: { current?: AgentSessionLike } = {};
      if (!chatOnly) initTheme();
      const childExtensionFactories = [
        createCompactionModelExtension(settingsManager),
        ...childBuiltinFactories,
        ...(subagentSkillsBinding.loaderOptions.extensionFactories ?? []),
        ...(parentRemoteHost ? [createRemoteClaudeHostGuardExtension()] : []),
        ...(mcpEnabled ? [createSubagentMcpPolicyExtension(() => ({
          tools: childInnerRef.current?.getActiveToolNames() ?? mcpScope.tools,
          ...(mcpScope.allExtensionTools ? { allExtensionTools: true } : {}),
        }))] : []),
      ];
      const services = await createAgentSessionServices({
        cwd: childCwd,
        agentDir,
        modelRuntime: parentModelRuntime,
        settingsManager,
        resourceLoaderOptions: {
          ...subagentExtensionLoaderOptions({ ...profile, mcp: mcpEnabled, codemode: codemodeEnabled }),
          ...childSkillLoaderOptions,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(chatOnly || promptPlan.exactSystemPrompt !== undefined
            ? {
                systemPrompt: " ",
                systemPromptOverride: () => undefined,
              }
            : {}),
          appendSystemPrompt,
          extensionFactories: childExtensionFactories,
        },
        ...((profile.loadExtensions || profile.loadSkills || codemodeEnabled || mcpEnabled)
          ? { resourceLoaderReloadOptions: projectTrustReloadOptions(childCwd, agentDir) }
          : {}),
      });

      if (codemodeEnabled && !services.resourceLoader.getExtensions().extensions.some((extension) => extension.tools.has("codemode"))) {
        throw new Error("Code mode is unavailable: builtin:codemode was not registered");
      }

      const allExtensionTools = profile.loadExtensions && profile.extensionTools === undefined;
      const extensionToolNames = profile.loadExtensions
        ? profile.extensionTools !== undefined
          ? selectSubagentExtensionTools(
            services.resourceLoader.getExtensions().extensions,
            profile.extensionTools,
            profile.disallowedExtensionTools,
          )
          : services.resourceLoader.getExtensions().extensions.flatMap((extension) => [...extension.tools.keys()])
        : [];
      const activeTools = resolveShellTools(
        withSubagentExtensionTools(effectiveProfileTools, extensionToolNames),
        settingsManager.getDefaultTools(),
      ).filter((tool) => !SUBAGENT_CONTROL_TOOL_NAMES.includes(tool as typeof SUBAGENT_CONTROL_TOOL_NAMES[number]));
      if (codemodeEnabled && !activeTools.includes("codemode")) activeTools.push("codemode");
      mcpScope.tools = activeTools;
      mcpScope.allExtensionTools = allExtensionTools;
      subagentSkillsBinding.setActiveToolsGetter(() => activeTools);

      const sessionManager = isolatedWorktree
        ? SessionManager.create(childCwd, undefined, { parentSession: parent.sessionFile })
        : SessionManager.create(parent.cwd, undefined, { parentSession: parent.sessionFile });
      runtimeOwnership = acquireSessionRuntimeOwnership(sessionManager.getSessionFile()!);
      const createdAt = new Date().toISOString();
      const metadata: SubagentMetadata = {
        version: 1,
        parentSessionId,
        parentSessionPath: parent.sessionFile,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: request.description.trim() || profile.displayName,
        task: request.task,
        runInBackground,
        createdAt,
        resourceSnapshot: {
          version: 1,
          appendSystemPrompt: [...appendSystemPrompt],
          tools: [...activeTools],
          loadSkills: profile.loadSkills,
          loadExtensions: profile.loadExtensions,
          ...(codemodeEnabled ? { codemode: true as const } : {}),
          ...(mcpEnabled ? { mcp: true as const } : {}),
          ...(allExtensionTools ? { allExtensionTools: true as const } : {}),
          ...(profile.skills !== undefined ? { skills: [...profile.skills] } : {}),
          ...(profile.extensions !== undefined ? { extensions: [...profile.extensions] } : {}),
          ...(turnLimit !== undefined ? { maxTurns: turnLimit } : {}),
          ...(promptPlan.exactSystemPrompt !== undefined ? { exactSystemPrompt: promptPlan.exactSystemPrompt } : {}),
        },
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };
      sessionManager.appendCustomEntry(SUBAGENT_META_TYPE, metadata);
      sessionManager.appendSessionInfo(metadata.description);

      const parentModel = parent.inner.model as ReturnType<ModelRuntime["getModel"]>;
      const thinking = request.thinking
        ?? callModel?.thinkingLevel
        ?? profile.thinking
        ?? profileModel?.thinkingLevel
        ?? parent.inner.agent.state?.thinkingLevel;
      if (thinking && !THINKING_LEVELS.has(thinking as ThinkingLevel)) {
        throw new Error(`Invalid subagent thinking level: ${thinking}`);
      }
      const { session: inner } = await createAgentSessionFromServices({
        services,
        sessionManager,
        model: selectedModel ?? parentModel,
        ...(thinking ? { thinkingLevel: thinking as ThinkingLevel } : {}),
        ...subagentToolOptions({ tools: activeTools, allExtensionTools, mcp: mcpEnabled }),
      });
      unregisteredInner = inner;
      childInnerRef.current = inner;
      if (parentRemoteHost) {
        childRemoteHost = (await installRemoteClaudeHost({
          hostIdentity: inner as unknown as object,
          sessionManager: inner.sessionManager,
          sessionId: inner.sessionId,
          cwd: childCwd,
          agentDir,
          readOnlyRoots: [childProjectRoot],
          activeTools: [...activeTools, ...extensionToolNames],
          modelRuntime: parentModelRuntime,
          builtInEnabled: true,
          parent: parentRemoteHost,
          maxConcurrent: parentRemoteHost.policy.orchestration.maxConcurrent,
          maxTurns: turnLimit,
          allowWorktree: isolation === "worktree",
          allowInheritedContext: inheritContext,
          allowCancellation: true,
          allowedProfiles: [profile.name],
          allowedModels: selectedModelName ? [selectedModelName] : parentRemoteHost.policy.orchestration.allowedModels,
          childTools: activeTools,
        })) ?? undefined;
        if (!childRemoteHost) throw new Error("capability-unavailable: Reader host scope could not be installed for child session");
      }
      const childOwnership = runtimeOwnership;
      // Registration owns cleanup even if wrapper setup fails after it starts extension teardown.
      runtimeOwnership = undefined;
      unregisteredInner = undefined;
      const childSession = dependencies.registerSession(inner, {
        ...(promptPlan.exactSystemPrompt !== undefined
          ? { exactSystemPrompt: promptPlan.exactSystemPrompt }
          : {}),
        chatOnly,
        ...(childRemoteHost ? { remoteHost: childRemoteHost } : {}),
        ...(builtinResources?.mcpHost ? { mcpHost: builtinResources.mcpHost } : {}),
        skillRuntimeContext: childSkillRuntimeContext,
        runtimeOwnership: childOwnership,
      });
      if (!childSession) runtimeOwnership = childOwnership;
      persistChildSession(sessionManager);
      const initialRun: SubagentRunInfo = {
        sessionId: inner.sessionId,
        sessionPath: inner.sessionFile ?? sessionManager.getSessionFile() ?? "",
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        profile: profile.name,
        description: metadata.description,
        task: request.task,
        runInBackground,
        status: "queued",
        createdAt,
        ...(isolatedWorktree ? { worktreePath: isolatedWorktree.path, worktreeBranch: isolatedWorktree.branch } : {}),
      };

      let resolveCompletion!: (run: SubagentRunInfo) => void;
      const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
        ...(childRemoteHost ? { remoteHost: childRemoteHost } : {}),
      };
      childSession?.admitSubagentExecution?.(completion, handleParentAbort);
      getSubagentRuns().set(initialRun.sessionId, stored);
      request.onUpdate?.(initialRun);
      dependencies.invalidateSessionList();

      function handleParentAbort() {
        stored.abortRequested = true;
        if (stored.run.status === "queued") stored.cancelQueued?.();
        else if (stored.mcpWait) stored.mcpWait.abort();
        else void inner.abort();
      }
      if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

      const runBaselineEntries = sessionManager.getEntries();
      const runBaselineEntryCount = runBaselineEntries.length;
      const previousAssistantText = assistantTextFromEntries(runBaselineEntries);
      const execute = async (): Promise<SubagentRunInfo> => {
        if (stored.abortRequested) {
          const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
          sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt });
          await cleanupWorktree(parent.cwd, isolatedWorktree);
          stored.run = result;
          request.onUpdate?.(result);
          getSubagentRuns().delete(initialRun.sessionId);
          revokeRemoteClaudeHost(resolveRemoteClaudeHost(inner.sessionId) ?? childRemoteHost);
          dependencies.invalidateSessionList();
          return result;
        }
        stored.run = { ...stored.run, status: "running" };
        sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
        request.onUpdate?.(stored.run);
        dependencies.invalidateSessionList();
        let result: SubagentRunInfo;
        const turnLimitGuard = installTurnLimitGuard(inner, turnLimit, stored);
        try {
          await prepareChildMcp(childSession, stored);
          if (stored.abortRequested) throw new Error("Stopped before subagent prompt");
          await inner.prompt(delegatedTask, { source: "rpc" });
          const text = assistantTextForRun(inner, sessionManager, runBaselineEntryCount, previousAssistantText);
          const stop = stored.abortRequested ? undefined : lastAssistantStop(sessionManager);
          const aborted = stored.abortRequested || stop?.aborted === true;
          const errorMessage = aborted ? undefined : stop?.error
            ?? (turnLimitGuard.reached() && turnLimit ? turnLimitError(turnLimit, turnLimitGuard.undelivered()) : undefined);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } catch (error) {
          const text = assistantTextForRun(inner, sessionManager, runBaselineEntryCount, previousAssistantText);
          const aborted = stored.abortRequested || request.signal?.aborted;
          const errorMessage = aborted ? undefined : turnLimitGuard.reached() && turnLimit
            ? turnLimitError(turnLimit, turnLimitGuard.undelivered())
            : error instanceof Error ? error.message : String(error);
          result = {
            ...initialRun,
            status: aborted ? "aborted" : "failed",
            completedAt: new Date().toISOString(),
            ...(text ? { result: text } : {}),
            ...(errorMessage ? { error: errorMessage } : {}),
          };
        } finally {
          turnLimitGuard.dispose();
          request.signal?.removeEventListener("abort", handleParentAbort);
        }

        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        if (cleanupError) result = { ...result, worktreeCleanupError: cleanupError };
        result = recordResult(sessionManager, result);
        stored.run = result;
        request.onUpdate?.(result);
        getSubagentRuns().delete(initialRun.sessionId);
        revokeRemoteClaudeHost(resolveRemoteClaudeHost(inner.sessionId) ?? childRemoteHost);
        dependencies.invalidateSessionList();
        return result;
      };

      const finishQueuedAbort = async () => {
        if (stored.run.status !== "queued") return;
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        const cleanupError = await cleanupWorktree(parent.cwd, isolatedWorktree);
        const finalResult = cleanupError ? { ...result, worktreeCleanupError: cleanupError } : result;
        sessionManager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: finalResult.completedAt, ...(cleanupError ? { worktreeCleanupError: cleanupError } : {}) });
        stored.run = finalResult;
        request.onUpdate?.(finalResult);
        getSubagentRuns().delete(initialRun.sessionId);
        revokeRemoteClaudeHost(resolveRemoteClaudeHost(inner.sessionId) ?? childRemoteHost);
        dependencies.invalidateSessionList();
      };
      const queued = getSubagentQueue().enqueue(
        parentSessionId,
        readSubagentSettings().maxConcurrent,
        execute,
        (state) => {
          if (state === "queued") {
            sessionManager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
          }
          request.onUpdate?.({ ...stored.run, status: state });
          stored.run = { ...stored.run, status: state };
          dependencies.invalidateSessionList();
        },
        finishQueuedAbort,
      );
      stored.cancelQueued = queued.cancel;
      if (stored.abortRequested) queued.cancel();
      const unhostedOwnership = runtimeOwnership;
      runtimeOwnership = undefined;
      // Queue settlement includes cancellation cleanup and the final result append.
      void queued.promise.then((run) => resolveCompletion(run ?? stored.run), (error) => {
        resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) });
      }).finally(() => unhostedOwnership?.release());

      return { run: stored.run, completion: stored.completion };
    } catch (error) {
      try { unregisteredInner?.dispose(); }
      finally { runtimeOwnership?.release(); }
      revokeRemoteClaudeHost(childRemoteHost
        ? resolveRemoteClaudeHost(childRemoteHost.sessionId) ?? childRemoteHost
        : undefined);
      if (isolatedWorktree) {
        try { await removeWorktree(parent.cwd, isolatedWorktree.path); } catch { /* preserve setup failure and avoid force deletion */ }
      }
      throw error;
    }
  }

  async function resume(request: ResumeSubagentRequest): Promise<SubagentExecution> {
    const enabled = dependencies.isBuiltInSubagentsEnabled ?? isBuiltInSubagentsEnabled;
    if (!enabled()) throw new Error("Pi Web built-in sub-agents are disabled");
    const parentSessionId = request.parentContext.sessionManager.getSessionId();
    const parent = dependencies.getSession(parentSessionId);
    const parentUsesRemoteClaude = parent?.inner.model?.provider === REMOTE_CLAUDE_PROVIDER_ID;
    const parentRemoteHost = parentUsesRemoteClaude ? resolveRemoteClaudeHost(parentSessionId) : undefined;
    if (parentUsesRemoteClaude && !parentRemoteHost) {
      throw new Error("capability-unavailable: remote Claude parent host binding is unavailable");
    }
    if (parentRemoteHost) {
      assertRemoteClaudeHost(parentRemoteHost, "resume-child", {
        readerMarker: parentRemoteHost.readerMarker,
        parentSessionId,
        parentToolCallId: request.parentToolCallId,
        toolName: "Agent",
      });
    }
    const existing = await get(request.sessionId, request.parentContext);
    if (!existing) throw new Error(`Subagent not found: ${request.sessionId}`);
    if (existing.parentSessionId !== parentSessionId) throw new Error("Subagent does not belong to this parent session");
    if (existing.status === "running" || existing.status === "queued") throw new Error("Subagent is already running");
    if (!parent?.isAlive()) throw new Error("Parent session is no longer available");
    const sessionPath = existing.sessionPath || await dependencies.resolveSessionPath(request.sessionId);
    if (!sessionPath) throw new Error(`Subagent session file not found: ${request.sessionId}`);
    let wrapper = dependencies.getSession(request.sessionId);
    if (!wrapper?.isAlive()) wrapper = await dependencies.reopenSession(request.sessionId, sessionPath, parentSessionId);
    if (!wrapper.isAlive()) throw new Error("Subagent session is no longer available");
    if (wrapper.isRunning()) throw new Error("Subagent is already running");
    // A present snapshot is authoritative. A malformed one must never fall back to
    // reopening the ordinary session with the host's current tools.
    const resumeEntries = wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[];
    const hasResumeSnapshot = hasSubagentResourceSnapshot(resumeEntries);
    const resumeResources = readSubagentSessionResources(resumeEntries);
    if (hasResumeSnapshot && !resumeResources) throw new Error("Invalid subagent resource snapshot");
    const resumeTurnLimit = resumeResources?.maxTurns;

    let resumedRemoteHost: RemoteClaudeHostBinding | undefined;
    try {
      resumedRemoteHost = parentRemoteHost
        ? (await installRemoteClaudeHost({
            hostIdentity: wrapper.inner as unknown as object,
            sessionManager: wrapper.inner.sessionManager,
            sessionId: request.sessionId,
            cwd: wrapper.cwd,
            agentDir: getAgentDir(),
            activeTools: wrapper.inner.getActiveToolNames(),
            modelRuntime: (parent.inner as unknown as { modelRuntime: ModelRuntime }).modelRuntime,
            builtInEnabled: true,
            parent: parentRemoteHost,
            maxConcurrent: parentRemoteHost.policy.orchestration.maxConcurrent,
            maxTurns: parentRemoteHost.policy.orchestration.maxTurns,
            allowWorktree: Boolean(existing.worktreePath),
            allowInheritedContext: true,
            allowCancellation: true,
            allowedProfiles: [existing.profile],
            allowedModels: parentRemoteHost.policy.orchestration.allowedModels,
            childTools: wrapper.inner.getActiveToolNames(),
          })) ?? undefined
        : undefined;
      if (parentRemoteHost && !resumedRemoteHost) throw new Error("capability-unavailable: Reader host scope could not be reinstalled");
      if (resumedRemoteHost && typeof (wrapper as HostSession & { setRemoteClaudeHostBinding?: (binding: RemoteClaudeHostBinding) => void }).setRemoteClaudeHostBinding === "function") {
        (wrapper as HostSession & { setRemoteClaudeHostBinding(binding: RemoteClaudeHostBinding): void }).setRemoteClaudeHostBinding(resumedRemoteHost);
      }
    } catch (error) {
      revokeRemoteClaudeHost(resumedRemoteHost
        ? resolveRemoteClaudeHost(resumedRemoteHost.sessionId) ?? resumedRemoteHost
        : undefined);
      throw error;
    }

    const runInBackground = request.runInBackground ?? existing.runInBackground;
    const initialRun: SubagentRunInfo = {
      ...existing,
      parentToolCallId: request.parentToolCallId,
      task: request.task,
      description: request.description.trim() || existing.description,
      runInBackground,
      status: "queued",
      completedAt: undefined,
      result: undefined,
      error: undefined,
      resumed: true,
    };
    const manager = wrapper.inner.sessionManager;
    const runBaselineEntries = manager.getEntries();
    const runBaselineEntryCount = runBaselineEntries.length;
    const previousAssistantText = assistantTextFromEntries(runBaselineEntries);
    let resolveCompletion!: (run: SubagentRunInfo) => void;
    const completion = new Promise<SubagentRunInfo>((resolve) => { resolveCompletion = resolve; });
      const stored: StoredSubagentExecution = {
        run: initialRun,
        completion,
        abortRequested: false,
        ...(resumedRemoteHost ? { remoteHost: resumedRemoteHost } : {}),
      };
    wrapper.admitSubagentExecution?.(completion, handleParentAbort);
    getSubagentRuns().set(request.sessionId, stored);
    request.onUpdate?.(initialRun);
    dependencies.invalidateSessionList();
    function handleParentAbort() {
      stored.abortRequested = true;
      if (stored.run.status === "queued") stored.cancelQueued?.();
      else if (stored.mcpWait) stored.mcpWait.abort();
      else void wrapper!.inner.abort();
    }
    if (!runInBackground) request.signal?.addEventListener("abort", handleParentAbort, { once: true });

    const execute = async (): Promise<SubagentRunInfo> => {
      if (stored.abortRequested) {
        const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
        manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt });
        stored.run = result;
        getSubagentRuns().delete(request.sessionId);
        revokeRemoteClaudeHost(resolveRemoteClaudeHost(request.sessionId) ?? resumedRemoteHost);
        return result;
      }
      stored.run = { ...stored.run, status: "running" };
      manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "running" });
      request.onUpdate?.(stored.run);
      let result: SubagentRunInfo;
      const turnLimitGuard = installTurnLimitGuard(wrapper!.inner, resumeTurnLimit, stored);
      try {
        await prepareChildMcp(wrapper, stored);
        if (stored.abortRequested) throw new Error("Stopped before subagent prompt");
        await wrapper!.inner.prompt(request.task, { source: "rpc" });
        const text = assistantTextForRun(wrapper!.inner, manager, runBaselineEntryCount, previousAssistantText);
        const stop = stored.abortRequested ? undefined : lastAssistantStop(manager);
        const aborted = stored.abortRequested || stop?.aborted === true;
        const providerError = aborted ? undefined : stop?.error;
        const errorMessage = aborted ? undefined : providerError
          ?? (turnLimitGuard.reached() && resumeTurnLimit ? turnLimitError(resumeTurnLimit, turnLimitGuard.undelivered()) : undefined);
        result = {
          ...initialRun,
          status: aborted ? "aborted" : errorMessage ? "failed" : "completed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
        };
      } catch (error) {
        const text = assistantTextForRun(wrapper!.inner, manager, runBaselineEntryCount, previousAssistantText);
        const aborted = stored.abortRequested || request.signal?.aborted;
        const errorMessage = aborted ? undefined : turnLimitGuard.reached() && resumeTurnLimit
          ? turnLimitError(resumeTurnLimit, turnLimitGuard.undelivered())
          : error instanceof Error ? error.message : String(error);
        result = {
          ...initialRun,
          status: aborted ? "aborted" : "failed",
          completedAt: new Date().toISOString(),
          ...(text ? { result: text } : {}),
          ...(errorMessage ? { error: errorMessage } : {}),
        };
      } finally {
        turnLimitGuard.dispose();
        request.signal?.removeEventListener("abort", handleParentAbort);
      }
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, {
        version: 1,
        status: result.status as "completed" | "failed" | "aborted",
        completedAt: result.completedAt!,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      revokeRemoteClaudeHost(resolveRemoteClaudeHost(request.sessionId) ?? resumedRemoteHost);
      dependencies.invalidateSessionList();
      return result;
    };
    const finishQueuedAbort = () => {
      if (stored.run.status !== "queued") return;
      const result: SubagentRunInfo = { ...initialRun, status: "aborted", completedAt: new Date().toISOString() };
      manager.appendCustomEntry(SUBAGENT_RESULT_TYPE, { version: 1, status: "aborted", completedAt: result.completedAt });
      stored.run = result;
      request.onUpdate?.(result);
      getSubagentRuns().delete(request.sessionId);
      revokeRemoteClaudeHost(resolveRemoteClaudeHost(request.sessionId) ?? resumedRemoteHost);
      dependencies.invalidateSessionList();
    };
    const queued = getSubagentQueue().enqueue(parentSessionId, readSubagentSettings().maxConcurrent, execute, (state) => {
      if (state === "queued") manager.appendCustomEntry(SUBAGENT_STATUS_TYPE, { version: 1, status: "queued" });
      stored.run = { ...stored.run, status: state };
      request.onUpdate?.(stored.run);
      dependencies.invalidateSessionList();
    }, finishQueuedAbort);
    stored.cancelQueued = queued.cancel;
    if (stored.abortRequested) queued.cancel();
    void queued.promise.then((run) => resolveCompletion(run ?? stored.run), (error) => resolveCompletion({ ...initialRun, status: "failed", completedAt: new Date().toISOString(), error: error instanceof Error ? error.message : String(error) }));
    return { run: stored.run, completion };
  }

  function authorizeParent(
    run: SubagentRunInfo,
    parentContext: StartSubagentRequest["parentContext"] | undefined,
    operation: "get-result" | "steer-child" | "abort-child",
  ): void {
    // Every Reader session has a host binding so the remote provider can
    // discover its live manager. That binding alone is not remote lineage:
    // ordinary local subagents have no child binding and must keep the normal
    // RPC surface. Only an active child binding with this exact parent turns
    // on parent ownership checks.
    const childHost = resolveRemoteClaudeHost(run.sessionId);
    if (!childHost || childHost.parentSessionId !== run.parentSessionId) return;
    const parentHost = resolveRemoteClaudeHost(run.parentSessionId);
    if (!parentHost) throw new Error("capability-unavailable: remote Claude parent host binding is unavailable");
    // Validate the child entry too: its parent generation may have become
    // stale even while the parent session itself remains registered.
    assertRemoteClaudeHost(childHost, "side-ask");
    const parentId = parentContext?.sessionManager.getSessionId();
    if (parentId !== run.parentSessionId) throw new Error("parent-not-owner: subagent belongs to another parent session");
    assertRemoteClaudeHost(parentHost, operation, {
      readerMarker: parentHost.readerMarker,
      parentSessionId: parentId,
      toolName: operation === "get-result" ? "get_subagent_result" : "steer_subagent",
    });
  }

  async function get(sessionId: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<SubagentRunInfo | null> {
    const stored = getSubagentRuns().get(sessionId);
    if (stored) {
      authorizeParent(stored.run, parentContext, "get-result");
      return stored.run;
    }
    const wrapper = dependencies.getSession(sessionId);
    if (wrapper?.isAlive()) {
      const run = readSubagentRun(
        wrapper.inner.sessionManager.getEntries() as unknown as SessionEntry[],
        sessionId,
        wrapper.sessionFile,
      );
      if (run && wrapper.isRunning()) {
        const current = { ...run, status: "running" as const };
        authorizeParent(current, parentContext, "get-result");
        return current;
      }
      if (run) {
        const settled = settleOrphanedRun(run);
        authorizeParent(settled, parentContext, "get-result");
        return settled;
      }
    }
    const sessionPath = await dependencies.resolveSessionPath(sessionId);
    if (!sessionPath) return null;
    const manager = SessionManager.open(sessionPath);
    const run = readSubagentRun(manager.getEntries() as unknown as SessionEntry[], sessionId, sessionPath);
    const settled = run && settleOrphanedRun(run);
    if (settled) authorizeParent(settled, parentContext, "get-result");
    return settled;
  }

  async function steer(sessionId: string, message: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<void> {
    const stored = getSubagentRuns().get(sessionId);
    const owned = stored?.run ?? await get(sessionId, parentContext);
    if (owned) authorizeParent(owned, parentContext, "steer-child");
    const wrapper = dependencies.getSession(sessionId);
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored?.turnLimitReached) throw new Error("Subagent reached its turn limit and is stopping; resume it to continue");
    if (!message.trim()) throw new Error("Steering message is required");
    await wrapper.inner.steer(message.trim());
  }

  async function notifyParent(run: SubagentRunInfo): Promise<void> {
    if (takeResultConsumed(run)) return;
    let parent = dependencies.getSession(run.parentSessionId);
    if (!parent?.isAlive()) {
      const sessionFile = await dependencies.resolveSessionPath(run.parentSessionId);
      if (!sessionFile) throw new Error(`Parent session not found: ${run.parentSessionId}`);
      parent = await dependencies.reopenSession(run.parentSessionId, sessionFile);
    }
    await parent.waitUntilReady();
    // The parent may still be inside the `get_subagent_result` call that collects this result,
    // and `deliverAs: "followUp"` would only queue the message until that turn ends anyway.
    // Hold the notification until the parent is idle and re-check the mark, so a result the
    // parent already consumed never triggers a duplicate turn.
    while (parent.isAlive() && parent.isRunning()) {
      if (takeResultConsumed(run)) return;
      await new Promise<void>((resolve) => { setTimeout(resolve, PARENT_IDLE_POLL_MS); });
    }
    if (takeResultConsumed(run)) return;
    if (!parent.isAlive()) throw new Error(`Parent session is no longer available: ${run.parentSessionId}`);
    await parent.inner.sendCustomMessage({
      customType: "pi-web:subagent-notification",
      content: subagentNotificationText(run),
      display: true,
      details: subagentToolDetails(run),
    }, parent.isStopRequested?.() ? { triggerTurn: false } : { deliverAs: "followUp", triggerTurn: true });
  }

  async function abort(sessionId: string, parentContext?: StartSubagentRequest["parentContext"]): Promise<void> {
    const wrapper = dependencies.getSession(sessionId);
    const stored = getSubagentRuns().get(sessionId);
    const owned = stored?.run ?? await get(sessionId, parentContext);
    if (owned) authorizeParent(owned, parentContext, "abort-child");
    if (stored?.run.status === "queued") {
      stored.abortRequested = true;
      if (!stored.cancelQueued?.()) throw new Error("Subagent is no longer queued");
      return;
    }
    if (stored?.mcpWait) {
      stored.abortRequested = true;
      stored.mcpWait.abort();
      return;
    }
    if (!wrapper?.isAlive() || !wrapper.isRunning()) throw new Error("Subagent is not running");
    if (stored) stored.abortRequested = true;
    await wrapper.inner.abort();
  }

  return {
    extensionRuntime: { start, resume, get, steer, notifyParent, markResultConsumed },
    get,
    steer,
    abort,
  };
}
