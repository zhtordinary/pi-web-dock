export const BUILTIN_RUNTIME_EXTENSION_NAMES = {
  fastMode: "pi-web-fast-mode",
  compactionModel: "pi-web-compaction-model",
  projectCommandEnvironment: "pi-web-project-command-environment",
  sessionControl: "pi-web-session-control",
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
  source: "reader";
  origin: "inline" | "builtin";
  scope: "session";
  status: "reader-provided";
  capabilities: readonly BuiltinRuntimeExtensionCapability[];
}

export const BUILTIN_RUNTIME_EXTENSIONS = [
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.compactionModel,
    labelKey: "compactionModel.name",
    descriptionKey: "compactionModel.description",
    source: "reader",
    origin: "inline",
    scope: "session",
    status: "reader-provided",
    capabilities: [{ kind: "hook", name: "session_before_compact" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.fastMode,
    labelKey: "i18n.builtinRuntimeExtensionFastMode",
    descriptionKey: "i18n.builtinRuntimeExtensionFastModeDescription",
    source: "reader",
    origin: "inline",
    scope: "session",
    status: "reader-provided",
    capabilities: [{ kind: "hook", name: "before_provider_request" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.projectCommandEnvironment,
    labelKey: "i18n.builtinRuntimeExtensionProjectCommandEnvironment",
    descriptionKey: "i18n.builtinRuntimeExtensionProjectCommandEnvironmentDescription",
    source: "reader",
    origin: "inline",
    scope: "session",
    status: "reader-provided",
    capabilities: [{ kind: "tool", name: "bash" }],
  },
  {
    id: BUILTIN_RUNTIME_EXTENSION_NAMES.sessionControl,
    labelKey: "i18n.builtinRuntimeExtensionSessionControl",
    descriptionKey: "i18n.builtinRuntimeExtensionSessionControlDescription",
    source: "reader",
    origin: "inline",
    scope: "session",
    status: "reader-provided",
    capabilities: [{ kind: "tool", name: "session_control" }],
  },
] as const satisfies readonly BuiltinRuntimeExtensionInfo[];
