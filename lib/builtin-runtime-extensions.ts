export const BUILTIN_RUNTIME_EXTENSION_NAMES = {
  fastMode: "pi-web-fast-mode",
  compactionModel: "pi-web-compaction-model",
  projectCommandEnvironment: "pi-web-project-command-environment",
  projectCommandPowerShell: "pi-web-project-command-powershell",
  sessionControl: "pi-web-session-control",
  subagents: "pi-web-subagents",
  exactSystemPrompt: "pi-web-exact-system-prompt",
  imageGenerationOutput: "pi-web-image-generation-output",
  mcpHost: "pi-web-mcp-host",
  readOnlyMcp: "pi-web-read-only-mcp",
  subagentMcpPolicy: "pi-web-subagent-mcp-policy",
  subagentSkills: "pi-web-subagent-skills",
  subagentStop: "pi-web-subagent-stop",
  remoteClaudeGuard: "pi-web-remote-claude-host-guard",
  readerChildExtensions: "pi-web-reader-child-extensions",
} as const;

export type BuiltinRuntimeExtensionId = typeof BUILTIN_RUNTIME_EXTENSION_NAMES[keyof typeof BUILTIN_RUNTIME_EXTENSION_NAMES];
export type BuiltinRuntimeExtensionCapabilityKind = "hook" | "tool" | "command";

export interface BuiltinRuntimeExtensionCapability {
  kind: BuiltinRuntimeExtensionCapabilityKind;
  name: string;
}

export interface BuiltinRuntimeExtensionInfo {
  id: BuiltinRuntimeExtensionId;
  labelKey: string;
  descriptionKey: string;
  category: "capability" | "infrastructure";
  sourcePath: string;
  source: "reader";
  origin: "inline" | "builtin";
  scope: "session";
  status: "reader-provided";
  capabilities: readonly BuiltinRuntimeExtensionCapability[];
}

const readerInline = { source: "reader", origin: "inline", scope: "session", status: "reader-provided" } as const;

export const BUILTIN_RUNTIME_EXTENSIONS = [
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.compactionModel,
    labelKey: "compactionModel.name",
    descriptionKey: "compactionModel.description",
    category: "capability",
    sourcePath: "lib/compaction-model-extension.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "session_before_compact" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.fastMode,
    labelKey: "i18n.builtinRuntimeExtensionFastMode",
    descriptionKey: "i18n.builtinRuntimeExtensionFastModeDescription",
    category: "capability",
    sourcePath: "lib/fast-mode.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "before_provider_request" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandEnvironment,
    labelKey: "i18n.builtinRuntimeExtensionProjectCommandEnvironment",
    descriptionKey: "i18n.builtinRuntimeExtensionProjectCommandEnvironmentDescription",
    category: "capability",
    sourcePath: "lib/project-command-env.ts",
    ...readerInline,
    capabilities: [{ kind: "tool", name: "bash" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandPowerShell,
    labelKey: "i18n.builtinRuntimeExtensionPowerShell",
    descriptionKey: "i18n.builtinRuntimeExtensionPowerShellDescription",
    category: "capability",
    sourcePath: "lib/project-command-env.ts",
    ...readerInline,
    capabilities: [{ kind: "tool", name: "powershell" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.sessionControl,
    labelKey: "i18n.builtinRuntimeExtensionSessionControl",
    descriptionKey: "i18n.builtinRuntimeExtensionSessionControlDescription",
    category: "capability",
    sourcePath: "lib/session-control.ts",
    ...readerInline,
    capabilities: [{ kind: "tool", name: "session_control" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.subagents,
    labelKey: "i18n.builtinRuntimeExtensionSubagents",
    descriptionKey: "i18n.builtinRuntimeExtensionSubagentsDescription",
    category: "capability",
    sourcePath: "lib/subagent-extension.ts",
    ...readerInline,
    capabilities: [{ kind: "tool", name: "Agent" }, { kind: "tool", name: "get_subagent_result" }, { kind: "tool", name: "steer_subagent" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.exactSystemPrompt,
    labelKey: "i18n.builtinRuntimeExtensionExactPrompt",
    descriptionKey: "i18n.builtinRuntimeExtensionExactPromptDescription",
    category: "infrastructure",
    sourcePath: "lib/exact-system-prompt.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "before_agent_start" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.imageGenerationOutput,
    labelKey: "i18n.builtinRuntimeExtensionImageOutput",
    descriptionKey: "i18n.builtinRuntimeExtensionImageOutputDescription",
    category: "infrastructure",
    sourcePath: "lib/image-generation-output-extension.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "tool_result" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.mcpHost,
    labelKey: "i18n.builtinRuntimeExtensionMcpHost",
    descriptionKey: "i18n.builtinRuntimeExtensionMcpHostDescription",
    category: "infrastructure",
    sourcePath: "lib/mcp-host.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "session_start" }, { kind: "hook", name: "session_shutdown" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.readOnlyMcp,
    labelKey: "i18n.builtinRuntimeExtensionReadOnlyMcp",
    descriptionKey: "i18n.builtinRuntimeExtensionReadOnlyMcpDescription",
    category: "infrastructure",
    sourcePath: "lib/mcp-read-only-policy.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "tool_call" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.subagentMcpPolicy,
    labelKey: "i18n.builtinRuntimeExtensionSubagentMcp",
    descriptionKey: "i18n.builtinRuntimeExtensionSubagentMcpDescription",
    category: "infrastructure",
    sourcePath: "lib/mcp-read-only-policy.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "tool_call" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.subagentSkills,
    labelKey: "i18n.builtinRuntimeExtensionSubagentSkills",
    descriptionKey: "i18n.builtinRuntimeExtensionSubagentSkillsDescription",
    category: "infrastructure",
    sourcePath: "lib/subagent-skills.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "before_agent_start" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.subagentStop,
    labelKey: "i18n.builtinRuntimeExtensionSubagentStop",
    descriptionKey: "i18n.builtinRuntimeExtensionSubagentStopDescription",
    category: "infrastructure",
    sourcePath: "lib/subagent-stop-bridge.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "session_shutdown" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.remoteClaudeGuard,
    labelKey: "i18n.builtinRuntimeExtensionRemoteClaude",
    descriptionKey: "i18n.builtinRuntimeExtensionRemoteClaudeDescription",
    category: "infrastructure",
    sourcePath: "lib/remote-claude-host.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "tool_call" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.readerChildExtensions,
    labelKey: "i18n.builtinRuntimeExtensionChildBridge",
    descriptionKey: "i18n.builtinRuntimeExtensionChildBridgeDescription",
    category: "infrastructure",
    sourcePath: "lib/reader-child-extensions.ts",
    ...readerInline,
    capabilities: [{ kind: "hook", name: "session_start" }, { kind: "hook", name: "session_shutdown" }],
  },
] as const satisfies readonly BuiltinRuntimeExtensionInfo[];
