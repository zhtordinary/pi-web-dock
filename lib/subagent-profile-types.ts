export type AgentScope = "builtin" | "runtime" | "global" | "project" | "workspace";
export type SubagentBuiltinKind = "reader";
export type SubagentModelSource = "profile" | "override" | "default" | "parent";
export type SubagentModelSourceScope = "user" | "project" | "provider";

export const VALID_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = typeof VALID_THINKING_LEVELS[number];
export type ReaderSubagentCodemode = "inherit" | "on" | "off";
export type ReaderSubagentMcp = "on" | "off";

/** Reader-native capability settings; context and background are projected from the profile-wide defaults. */
export interface ReaderNativeProfileOptions {
  loadSkills: boolean;
  loadExtensions: boolean;
  codemode: ReaderSubagentCodemode;
  mcp: ReaderSubagentMcp;
  maxTurns?: number;
  promptMode?: "append" | "replace";
  inheritContext: boolean;
  runInBackground: boolean;
}

export const BUILTIN_TOOLS = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;
export const READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

export interface SubagentProfile {
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  /** Whether the native Agent declares an explicit tools allowlist. */
  toolsExplicit?: boolean;
  enabled: boolean;
  scope: AgentScope;
  builtinKind?: SubagentBuiltinKind;
  runtimeKind?: "native" | "external-cli" | "external-job";
  /** Effective model projection; absent when the resolver has only a bare ID or no model. */
  model?: string;
  modelId?: string;
  modelProvider?: string;
  modelSource?: SubagentModelSource;
  modelSourceScope?: SubagentModelSourceScope;
  /** Editable Pi/Reader user override, deliberately separate from the effective model. */
  modelOverride?: string;
  /** Reader-native execution options, kept separate from pi-subagents fields. */
  reader?: ReaderNativeProfileOptions;
  thinking?: string;
  /** false explicitly clears a native runtime profile pin and follows the parent session. */
  thinkingOverride?: string | false;
  systemPromptMode?: "append" | "replace";
  defaultContext: "fresh" | "fork";
  defaultAsync: boolean;
  inheritProjectContext: boolean;
  inheritGlobalContext: boolean;
  inheritSkills: boolean;
  acceptanceRole?: "read-only" | "writer";
  /** Source identity used only while saving a copy; never a filesystem path. */
  copyFrom?: { scope: AgentScope; name: string };
  filePath?: string;
}
