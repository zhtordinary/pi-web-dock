// Types mirrored from pi-mono coding-agent session-manager

export interface SessionHeader {
  type: "session";
  version?: number;
  id: string;
  timestamp: string;
  cwd: string;
  parentSession?: string;
  /** Reader-only Talk Map context source; distinct from Pi's fork parent. */
  contextSourceSessionId?: string;
}

export interface SessionEntryBase {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
}

export interface TextContent {
  type: "text";
  text: string;
}

export interface ImageContent {
  type: "image";
  source: {
    type: "base64" | "url";
    media_type?: string;
    data?: string;
    url?: string;
  };
}

export interface ThinkingContent {
  type: "thinking";
  thinking: string;
  /** Historical content omitted from the initial response and loaded on demand. */
  deferred?: boolean;
}

export interface ToolCallContent {
  type: "toolCall";
  toolCallId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Client-only buffer for streamed tool input. Never persisted to session files. */
  rawInput?: string;
}

export type AssistantContentBlock = TextContent | ImageContent | ThinkingContent | ToolCallContent;

export interface AgentUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
}

/** Prompt and tool loadout carried by Pi >= 0.86 transcripts; never render as chat. */
export interface SystemMessage {
  role: "system";
  content: string | TextContent[];
  sections?: Record<string, string | null>;
  toolsAdded?: unknown[];
  toolsRemoved?: Array<{ name: string }>;
  timestamp?: number;
}

export type SessionMessage = AgentMessage | SystemMessage;

export interface ReaderMessageTiming {
  /** Optional entry/message identifier attached by Reader views. */
  id?: string;
  /** Reader-only outer JSONL entry time; producer message timestamp remains the start boundary. */
  entryTimestamp?: number;
  /**
   * Reader-only display/response anchor. Queued user messages retain their
   * producer enqueue timestamp, but are shown and timed from their persisted
   * outer JSONL entry time.
   */
  displayTimestamp?: number;
}

export interface UserMessage extends ReaderMessageTiming {
  role: "user";
  content: string | (TextContent | ImageContent)[];
  timestamp?: number;
}

export interface AssistantMessage extends ReaderMessageTiming {
  role: "assistant";
  content: AssistantContentBlock[];
  model: string;
  provider: string;
  stopReason?: string;
  errorMessage?: string;
  /** Milliseconds from the provider request start to this response, measured by Pi 1.1. */
  durationMs?: number;
  timestamp?: number;
  usage?: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: {
      input: number;
      output: number;
      cacheRead: number;
      cacheWrite: number;
      total: number;
    };
  };
}

export interface SessionUsageMetadata {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cacheWrite1h?: number;
  reasoning?: number;
  totalTokens?: number;
  cost?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cacheWrite1h?: number;
    total?: number;
  };
}

export interface ToolResultMessage extends ReaderMessageTiming {
  role: "toolResult";
  toolCallId: string;
  toolName?: string;
  content: (TextContent | ImageContent)[];
  /** Reader display-only marker; full text is loaded when its tool call expands. */
  deferredText?: boolean;
  /** Reader display-only source entry id for deferred result loading. */
  entryId?: string;
  usage?: AgentUsage;
  isError?: boolean;
  details?: unknown;
  /** Milliseconds spent executing this tool, measured by Pi 1.1. */
  durationMs?: number;
  timestamp?: number;
}

export interface CustomMessage extends ReaderMessageTiming {
  role: "custom";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  display: boolean;
  details?: unknown;
  timestamp?: number;
}

export interface BashExecutionMessage extends ReaderMessageTiming {
  role: "bashExecution";
  command: string;
  output: string;
  exitCode?: number;
  cancelled?: boolean;
  truncated?: boolean;
  fullOutputPath?: string;
  excludeFromContext?: boolean;
  timestamp?: number;
}

export type AgentMessage = UserMessage | AssistantMessage | ToolResultMessage | CustomMessage | BashExecutionMessage;

export type ExtensionUiRequest = { runtimeGeneration?: string; createdAt?: number } & (
  | {
      type: "extension_ui_request";
      id: string;
      method: "select";
      title: string;
      options: string[];
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "confirm";
      title: string;
      message: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "input";
      title: string;
      placeholder?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "editor";
      title: string;
      prefill?: string;
      timeout?: number;
      expiresAt?: number;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "notify";
      message: string;
      notifyType?: "info" | "warning" | "error";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setStatus";
      statusKey: string;
      statusText?: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setWidget";
      widgetKey: string;
      widgetLines?: string[];
      widgetPlacement?: "aboveEditor" | "belowEditor";
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setExtensionUsage";
      usageKey: string;
      usage?: Omit<ExtensionUsageItem, "key">;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "setTitle";
      title: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_text";
      text: string;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "set_editor_suggestion";
      suggestion: string | null;
    }
  | {
      type: "extension_ui_request";
      id: string;
      method: "custom";
      lines: string[];
      closed?: boolean;
    });

export type BlockingExtensionUiRequest = Extract<
  ExtensionUiRequest,
  { method: "select" | "confirm" | "input" | "editor" | "custom" }
>;

export type ExtensionUiResponse =
  | { type: "extension_ui_response"; id: string; value: string }
  | { type: "extension_ui_response"; id: string; confirmed: boolean }
  | { type: "extension_ui_response"; id: string; cancelled: true };

export interface ExtensionStatusItem {
  key: string;
  text: string;
}

export interface ExtensionUsageItem {
  key: string;
  label: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  cost: number;
  calls: number;
  model?: string;
}

export interface ExtensionWidgetItem {
  key: string;
  lines: string[];
  placement: "aboveEditor" | "belowEditor";
}

export interface SessionMessageEntry extends SessionEntryBase {
  type: "message";
  message: SessionMessage;
}

export interface ThinkingLevelChangeEntry extends SessionEntryBase {
  type: "thinking_level_change";
  thinkingLevel: string;
}

export interface ModelChangeEntry extends SessionEntryBase {
  type: "model_change";
  provider: string;
  modelId: string;
}

/** Model usage outside the conversation, such as prompt-cache warming. */
export interface UsageEntry extends SessionEntryBase {
  type: "usage";
  kind: string;
  provider: string;
  model: string;
  usage: AgentUsage;
  note?: string;
}

export interface CompactionEntry extends SessionEntryBase {
  type: "compaction";
  summary: string;
  firstKeptEntryId: string;
  tokensBefore: number;
  details?: unknown;
  usage?: SessionUsageMetadata;
  provider?: string;
  model?: string;
  fromHook?: boolean;
}

export interface BranchSummaryEntry extends SessionEntryBase {
  type: "branch_summary";
  fromId: string;
  summary: string;
  details?: unknown;
  usage?: SessionUsageMetadata;
  provider?: string;
  model?: string;
  fromHook?: boolean;
}

export interface CustomEntry extends SessionEntryBase {
  type: "custom";
  customType: string;
  data?: unknown;
}

export interface CustomMessageEntry extends SessionEntryBase {
  type: "custom_message";
  customType: string;
  content: string | (TextContent | ImageContent)[];
  details?: unknown;
  display: boolean;
}

/** Append-only edit of an earlier entry's model context. */
export interface ContextEditEntry extends SessionEntryBase {
  type: "context_edit";
  targetId: string;
  replacement: { content: unknown } | null;
}

export interface LabelEntry extends SessionEntryBase {
  type: "label";
  targetId: string;
  label: string | undefined;
}

export interface SessionInfoEntry extends SessionEntryBase {
  type: "session_info";
  name?: string;
}

export type SessionEntry =
  | SessionMessageEntry
  | ThinkingLevelChangeEntry
  | ModelChangeEntry
  | UsageEntry
  | CompactionEntry
  | BranchSummaryEntry
  | CustomEntry
  | CustomMessageEntry
  | ContextEditEntry
  | LabelEntry
  | SessionInfoEntry;

export type FileEntry = SessionHeader | SessionEntry;

export type SubagentSessionStatus = "starting" | "queued" | "running" | "completed" | "failed" | "aborted" | "interrupted";

export interface BranchPreview {
  role?: "user" | "assistant";
  text: string;
}

export interface SessionTreeNode {
  entry: SessionEntry;
  children: SessionTreeNode[];
  label?: string;
  compressedEntryIds?: string[];
  branchPreview?: BranchPreview;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  name?: string;
  created: string;
  modified: string;
  messageCount: number;
  firstMessage: string;
  /** True while the sidebar has header/stat metadata only. */
  detailsPending?: boolean;
  parentSessionId?: string; // fork source or subagent parent
  relation?:
    | { kind: "fork"; originSessionId?: string }
    | { kind: "subagent"; parentSessionId: string; profile: string; description: string; status: SubagentSessionStatus };
  /** Reader-only Talk Map context source; does not represent a Pi fork. */
  contextSourceSessionId?: string;
  /** Main repo root shared by all worktrees of this cwd (cwd itself for non-git dirs).
   *  Always set by the server; optional because the client builds transient
   *  SessionInfo objects before the first refresh. Fall back to cwd. */
  projectRoot?: string;
  /** Stable server-computed project identity for grouping and comparison.
   *  Unlike projectRoot, Windows keys are case- and separator-insensitive.
   *  Internal only: use projectRoot/cwd for display and filesystem operations. */
  projectKey?: string;
  /** Server-derived classification overlay; never persisted to Pi JSONL. */
  subprojectId?: string;
  /** True when cwd resolves inside a Git repository, including detached HEAD. */
  isGit?: boolean;
  /** Current git branch for any git repo (undefined for non-git or detached HEAD) */
  branch?: string;
  /** True when cwd is a linked git worktree (not the main checkout) */
  isWorktree?: boolean;
  /** Backward-compatible branch label for existing Reader sidebar/Talk Map consumers. */
  worktreeBranch?: string;
  /** True when the session file lives under agent/archived_sessions */
  archived?: boolean;
  /** True while the runtime session exists only in memory and its JSONL file
   *  has not been created yet. Disk-backed actions must wait until this clears. */
  transient?: boolean;
}

export interface SessionContext {
  messages: AgentMessage[];
  entryIds: string[]; // parallel to messages — the session entry id for each message
  thinkingLevel: string;
  model: { provider: string; modelId: string } | null;
  /** Oldest raw entry included in an optional paged response. */
  oldestEntryId?: string | null;
  /** True when older entries remain before the current response window. */
  hasMore?: boolean;
}

/** Display-only history metadata for the manual top-of-transcript expansion. */
export interface SessionHistoryInfo {
  hasEarlierHistory: boolean;
  /** True when the selected branch contains a Pi compaction entry. */
  hasCompaction: boolean;
  totalMessages: number;
}

/** Device that owns a session-content search hit. */
export interface SessionSearchDevice {
  id: string;
  name: string;
  url?: string;
  online?: boolean;
  lastSeenAt?: string;
  error?: string;
}

/** Session-content search hit (see app/api/sessions/search/route.ts). */
export interface SessionSearchResult extends SessionInfo {
  /** Device that owns this session; present for local and aggregate searches. */
  device?: SessionSearchDevice;
  /** Activity timestamp used by the activity time filter and result ordering. */
  activityAt?: string;
  /** Up to 3 short text excerpts around message/title matches. */
  snippets: string[];
  /** Total occurrences across visible message text and session titles. */
  matchCount: number;
  /** Occurrences inside user/assistant text; title matches are excluded. */
  contentMatchCount: number;
  /** Occurrences inside session names and persisted recap titles. */
  titleMatchCount?: number;
  /** True when the query matched the session ID; contentMatchCount may be zero. */
  idMatch?: boolean;
  /** Whether data-owner device marked this session as favorite. */
  favorite?: boolean;
}

export type SessionSearchMatchFilter = "all" | "content" | "title" | "id";

export type SessionSearchMatchSource = "content" | "title" | "id";

export function sessionSearchResultSources(
  hit: Pick<SessionSearchResult, "contentMatchCount" | "titleMatchCount" | "idMatch">,
): SessionSearchMatchSource[] {
  return [
    ...(hit.contentMatchCount > 0 ? ["content" as const] : []),
    ...((hit.titleMatchCount ?? 0) > 0 ? ["title" as const] : []),
    ...(hit.idMatch ? ["id" as const] : []),
  ];
}

export function sessionSearchResultMatchesFilter(
  hit: Pick<SessionSearchResult, "contentMatchCount" | "titleMatchCount" | "idMatch">,
  filter: SessionSearchMatchFilter,
): boolean {
  if (filter === "content") return hit.contentMatchCount > 0;
  if (filter === "title") return (hit.titleMatchCount ?? 0) > 0;
  if (filter === "id") return Boolean(hit.idMatch);
  return true;
}
