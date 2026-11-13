import { BUILTIN_TOOLS, type ReaderNativeProfileOptions } from "./subagent-profile-types";

function resourceEnabled(value: unknown, fallback: boolean, projected: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return true;
  if (typeof value !== "string") return fallback;
  const normalized = value.trim().toLowerCase();
  // Older unprojected aliases treated every nonempty value other than none/false as enabled.
  return normalized ? !["none", "false", ...(projected ? ["off"] : [])].includes(normalized) : fallback;
}

function booleanValue(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function nestedReaderOptions(data: Record<string, unknown>): Record<string, unknown> | undefined {
  return data.reader && typeof data.reader === "object" && !Array.isArray(data.reader)
    ? data.reader as Record<string, unknown>
    : undefined;
}

export interface UnifiedSubagentDefaults {
  defaultContext: "fresh" | "fork";
  defaultAsync: boolean;
}

/** Resolve the user-facing context and execution defaults across runtimes. */
export function parseUnifiedSubagentDefaults(data: Record<string, unknown> | null): UnifiedSubagentDefaults {
  if (!data) return { defaultContext: "fresh", defaultAsync: true };
  const nested = nestedReaderOptions(data);
  const nestedContext = booleanValue(nested?.inheritContext);
  const legacyContext = booleanValue(data.inherit_context);
  let defaultContext: "fresh" | "fork" = "fresh";
  if (data.defaultContext === "fork" || data.defaultContext === "fresh") {
    defaultContext = data.defaultContext;
  } else if (nestedContext !== undefined) {
    defaultContext = nestedContext ? "fork" : "fresh";
  } else if (legacyContext !== undefined) {
    defaultContext = legacyContext ? "fork" : "fresh";
  }
  const defaultAsync = booleanValue(data.async)
    ?? booleanValue(nested?.runInBackground)
    ?? booleanValue(data.run_in_background)
    ?? true;
  return { defaultContext, defaultAsync };
}

/** Resolve Reader settings independently from pi-subagents' prompt mode. */
export function parseReaderNativeProfile(
  data: Record<string, unknown> | null,
  forceNativeResources = false,
): ReaderNativeProfileOptions | undefined {
  if (!data) return undefined;
  const nested = nestedReaderOptions(data);
  const defaults = parseUnifiedSubagentDefaults(data);
  const tools = Array.isArray(data.tools) ? data.tools : typeof data.tools === "string" ? data.tools.split(",") : [];
  const hasExplicitTools = Object.prototype.hasOwnProperty.call(data, "tools");
  const hasBuiltinTool = !hasExplicitTools || tools.some((tool) => {
    const name = String(tool).trim();
    return name === "all" || name === "*" || BUILTIN_TOOLS.some((builtin) => builtin === name);
  });
  const hasExtensionSelector = tools.some((tool) => String(tool).trim().toLowerCase().startsWith("ext:"));
  const projected = Boolean(nested) || [
    "load_skills", "load_extensions", "codemode", "mcp", "max_turns", "inherit_context", "run_in_background",
    "defaultContext", "async", "inheritSkills", "systemPromptMode",
  ].some((key) => Object.prototype.hasOwnProperty.call(data, key));
  const hasOptions = forceNativeResources || projected || hasExtensionSelector || ["skills", "extensions", "prompt_mode"]
    .some((key) => Object.prototype.hasOwnProperty.call(data, key));
  if (!hasOptions) return undefined;

  const source = nested ?? data;
  const codemode = source.codemode ?? data.codemode;
  const mcp = source.mcp ?? data.mcp;
  const maxTurns = source.maxTurns ?? data.max_turns;
  const promptMode = source.promptMode ?? data.prompt_mode;
  const loadSkills = forceNativeResources
    ? true
    : resourceEnabled(source.loadSkills ?? data.load_skills ?? data.skills ?? data.inheritSkills, true, projected);
  const loadExtensions = forceNativeResources
    ? true
    : resourceEnabled(source.loadExtensions ?? data.load_extensions ?? data.extensions, true, projected);
  const defaultCodemode = hasBuiltinTool || loadSkills || loadExtensions ? "inherit" : "off";
  return {
    loadSkills,
    loadExtensions,
    codemode: codemode === undefined
      ? defaultCodemode
      : codemode === "inherit" ? "inherit" : codemode === "on" || codemode === true ? "on" : "off",
    mcp: forceNativeResources
      ? "on"
      : mcp === undefined
        ? hasBuiltinTool || loadSkills || loadExtensions ? "on" : "off"
        : mcp === "on" || mcp === true ? "on" : "off",
    ...(typeof maxTurns === "number" && Number.isFinite(maxTurns) && maxTurns >= 1 ? { maxTurns: Math.floor(maxTurns) } : {}),
    ...(promptMode === "append" || promptMode === "replace" ? { promptMode } : {}),
    inheritContext: defaults.defaultContext === "fork",
    runInBackground: defaults.defaultAsync,
  };
}
