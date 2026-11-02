import type {
  AgentSessionEvent,
  AgentSession,
  BashOperations,
  SessionManager,
  SettingsManager,
  SlashCommandInfo,
  Theme,
} from "@earendil-works/pi-coding-agent";
import type { AgentMessage as PiAgentMessage } from "@earendil-works/pi-agent-core";
import type { SessionTimingInfo } from "./session-timing";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import type { ExtensionUsageItem } from "./types";

export interface ContextUsage {
  percent: number | null;
  contextWindow: number;
  tokens: number | null;
}

/** Context recorded for one persisted compaction marker. */
export interface CompactionContextInfo {
  tokensBefore: number;
  contextWindow: number | null;
  provider?: string;
  model?: string;
}

export interface ModelLike {
  id: string;
  provider: string;
  contextWindow?: number;
}

export interface ResourceSourceInfo {
  path: string;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface ToolInfo {
  name: string;
  description: string;
  parameters?: unknown;
  promptGuidelines?: string[];
  sourceInfo: ResourceSourceInfo;
  /** How the model reaches the tool; absent means direct. */
  exposure?: "direct" | "model-only" | "codemode" | "deferred" | "hidden";
}

export interface NavigateTreeResult {
  editorText?: string;
  cancelled: boolean;
  aborted?: boolean;
}

/** Cumulative full-session token usage from the local session cost calculator. */
export interface SessionUsageTotals {
  inputTokens: number;
  cachedInputTokens: number;
  cacheWriteTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export type SessionCostStatus = "calculated" | "partial" | "unavailable";

export interface SessionCostSummary {
  amount: number | null;
  currency: string;
  status: SessionCostStatus;
  usage: SessionUsageTotals | null;
  sessionCount: number;
  models: string[];
  missingPriceModels: string[];
  /** Usage records that are still pending settlement, not missing a price. */
  pendingUsageCount: number;
  pendingUsageModels: string[];
  unavailableSessions: number;
}

export interface ExtensionCostSummary extends SessionCostSummary {
  id: string;
  historicalIncomplete: boolean;
  historicalEstimated?: boolean;
}

export interface SessionStatsInfo {
  sessionFile?: string;
  sessionId: string;
  sessionName?: string;
  userMessages: number;
  assistantMessages: number;
  toolCalls: number;
  toolResults: number;
  totalMessages: number;
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
  cost: number;
  /** Price status for the session-wide calculator. */
  costStatus?: SessionCostStatus;
  /** Models whose usage was excluded because no price was available. */
  missingPriceModels?: string[];
  /** Usage records that have not settled and are excluded from the lower-bound amount. */
  pendingUsageCount?: number;
  pendingUsageModels?: string[];
  parentCost?: SessionCostSummary;
  childCost?: SessionCostSummary;
  /** Main agent and compaction only; excludes auxiliary extension calls. */
  mainCost?: SessionCostSummary;
  /** Compaction calls across the parent session and subagents. */
  compactionCost?: SessionCostSummary;
  /** Recap and title calls across the parent session and subagents. */
  recapCost?: SessionCostSummary;
  /** Per-extension amounts already included in the total, priced by Reader. */
  extensionCosts?: ExtensionCostSummary[];
  totalCost?: SessionCostSummary;
  /** Runtime-reported extension totals; excluded from billing unless backed by events. */
  extensionUsages?: ExtensionUsageItem[];
  contextUsage?: ContextUsage;
  /** Timing of the viewed branch and the subagents it started. */
  timing?: SessionTimingInfo;
}

interface PromptTemplateLike {
  name: string;
  description?: string;
  sourceInfo: SlashCommandInfo["sourceInfo"];
}

interface SkillLike {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  sourceInfo: ResourceSourceInfo;
}

interface RuntimeExtensionLike {
  path: string;
  resolvedPath?: string;
  sourceInfo?: ResourceSourceInfo;
  tools?: Map<string, unknown>;
  commands?: Map<string, unknown>;
}

interface ResourceLoaderLike {
  getExtensions(): {
    extensions: RuntimeExtensionLike[];
    errors: Array<{ path: string; error: string }>;
  };
  getSkills(): { skills: SkillLike[] };
  getAgentsFiles(): { agentsFiles: Array<{ path: string; content: string }> };
  getSystemPrompt(): string | undefined;
  getSystemPromptSource(): { path: string } | undefined;
  getAppendSystemPrompt(): string[];
  getAppendSystemPromptSources(): Array<{ path: string }>;
}

interface ExtensionRunnerLike {
  getRegisteredCommands(): Array<{
    invocationName: string;
    description?: string;
    sourceInfo: SlashCommandInfo["sourceInfo"];
  }>;
  emit?(event: { type: "session_shutdown"; reason: "quit" }): Promise<unknown>;
  setUIContext?(uiContext?: unknown, mode?: "tui" | "rpc" | "json" | "print"): void;
}

type DialogOptionsLike = {
  signal?: AbortSignal;
  timeout?: number;
};

type WidgetOptionsLike = {
  placement?: "aboveEditor" | "belowEditor";
};

export interface ExtensionUiContextLike {
  select(title: string, options: string[], opts?: DialogOptionsLike): Promise<string | undefined>;
  confirm(title: string, message: string, opts?: DialogOptionsLike): Promise<boolean>;
  input(title: string, placeholder?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  editor(title: string, prefill?: string, opts?: DialogOptionsLike): Promise<string | undefined>;
  notify(message: string, type?: "info" | "warning" | "error"): void;
  onTerminalInput(): () => void;
  setStatus(key: string, text: string | undefined): void;
  setWorkingMessage(message?: string): void;
  setWorkingVisible(visible: boolean): void;
  setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
  setHiddenThinkingLabel(label?: string): void;
  setWidget(key: string, content: string[] | ((...args: never[]) => unknown) | undefined, options?: WidgetOptionsLike): void;
  setFooter(factory: unknown): void;
  setHeader(factory: unknown): void;
  setTitle(title: string): void;
  custom<T = unknown>(...args: unknown[]): Promise<T>;
  pasteToEditor(text: string): void;
  setEditorText(text: string): void;
  setEditorSuggestion(text: string | undefined): void;
  setExtensionUsage(key: string, usage?: Omit<ExtensionUsageItem, "key">): void;
  getEditorText(): string;
  addAutocompleteProvider(): void;
  setEditorComponent(): void;
  getEditorComponent(): undefined;
  readonly theme: Theme;
  getAllThemes(): unknown[];
  getTheme(name: string): undefined;
  setTheme(theme: unknown): { success: boolean; error?: string };
  getToolsExpanded(): boolean;
  setToolsExpanded(expanded: boolean): void;
}

export interface AgentSessionLike {
  readonly sessionId: string;
  readonly sessionFile: string | undefined;
  readonly isStreaming: boolean;
  readonly isCompacting: boolean;
  readonly autoCompactionEnabled: boolean;
  readonly autoRetryEnabled: boolean;
  readonly model: ModelLike | undefined;
  readonly modelRuntime: {
    getModel: (provider: string, modelId: string) => ModelLike | undefined;
    getModels?: (provider?: string) => readonly ModelLike[];
    refresh: (options?: { allowNetwork?: boolean }) => Promise<unknown>;
  };
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  /**
   * The prompt this session would send right now, rendered from its current options.
   *
   * Readable before the first run, unlike `agent.state.systemPrompt`, which replays the
   * transcript and is empty until a run persists a system message. It does not keep the
   * sections a `before_agent_start` handler changed for a finished run; the replay does.
   */
  readonly systemPrompt: string;
  readonly agent: {
    state?: {
      model?: ModelLike;
      messages?: PiAgentMessage[];
      /** Replayed from the transcript's system messages since Pi 0.86; never assign it. */
      systemPrompt?: string;
      thinkingLevel?: string;
      streamingMessage?: PiAgentMessage;
      /** The declared tools, with the descriptions `prepareLoadout` hooks set for the model. */
      readonly tools?: readonly { readonly name: string; readonly description: string }[];
    };
  };
  readonly extensionRunner: ExtensionRunnerLike;
  readonly promptTemplates: readonly PromptTemplateLike[];
  readonly resourceLoader: ResourceLoaderLike;

  readonly bindExtensions?: unknown;
  dispose(): void;
  reload(options?: { beforeSessionStart?: () => void | Promise<void> }): Promise<void>;
  subscribe(listener: (event: AgentSessionEvent) => void): () => void;
  prompt(text: string, options?: {
    images?: Array<{ type: "image"; data: string; mimeType: string }>;
    streamingBehavior?: "steer" | "followUp";
    source?: "interactive" | "rpc";
    /** Called once the SDK accepts the input; a rejected prompt only rejects the returned promise. */
    preflightResult?: (disposition: "handled" | "queued" | "started") => void;
  }): Promise<void>;
  sendCustomMessage<T = unknown>(message: {
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: T;
  }, options?: {
    triggerTurn?: boolean;
    deliverAs?: "steer" | "followUp" | "nextTurn";
  }): Promise<void>;
  abort(): Promise<void>;
  executeBash(command: string, onChunk?: (chunk: string) => void, options?: {
    excludeFromContext?: boolean;
    operations?: BashOperations;
  }): Promise<{ output: string; exitCode?: number; cancelled?: boolean; truncated?: boolean; fullOutputPath?: string }>;
  abortBash(): void;
  readonly isBashRunning: boolean;
  setModel(model: ModelLike): Promise<void>;
  navigateTree(targetId: string, options?: { summarize?: boolean }): Promise<NavigateTreeResult>;
  setThinkingLevel(level: string): void;
  compact(customInstructions?: string): Promise<unknown>;
  setSessionName(name: string): void;
  getSessionStats(): Omit<SessionStatsInfo, "sessionName">;
  getLastAssistantText(): string | undefined;
  setAutoCompactionEnabled(enabled: boolean): void;
  setAutoRetryEnabled(enabled: boolean): void;
  steer(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<"handled" | "queued">;
  followUp(text: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<"handled" | "queued">;
  readonly pendingMessageCount: number;
  getSteeringMessages(): readonly string[];
  getFollowUpMessages(): readonly string[];
  clearQueue(): { steering: string[]; followUp: string[] };
  getAllTools(): ToolInfo[];
  getActiveToolNames(): string[];
  setActiveToolsByName(names: string[]): void;
  abortCompaction(): void;
  getContextUsage(): ContextUsage | undefined;
}
