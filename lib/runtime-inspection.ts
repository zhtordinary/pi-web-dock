import { createHash } from "node:crypto";
import type { AgentSessionLike, ResourceSourceInfo, ToolInfo } from "./pi-types";
import type { PureResolvedSkillPolicy, SkillRuntimeEvidence } from "./skill-runtime-policy";

export interface PromptRange {
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

export interface RuntimePromptCost {
  provider: string;
  model: string;
  amount: number | null;
  currency: string;
  status: "calculated" | "unavailable";
}

export interface RuntimeContextSource {
  kind: "agent-file" | "system-prompt-file" | "append-system-prompt";
  path: string;
  characters?: number;
  sha256?: string;
  inSystemPrompt: boolean;
  promptRange?: PromptRange;
}

export interface RuntimeToolInspection {
  name: string;
  description: string;
  active: boolean;
  mentionedInSystemPrompt: boolean;
  parameters: unknown;
  promptGuidelines: string[];
  sourceInfo: ResourceSourceInfo | null;
}

export interface RuntimeSkillInspection {
  name: string;
  description: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation: boolean;
  promptVisible: boolean;
  policyKey?: string;
  resourceState?: "enabled" | "disabled";
  invocationMode?: "automatic" | "explicit-only";
  availability?: "available" | "stale" | "unavailable";
  runtimeLoaded?: boolean;
  commandUsable?: boolean;
  invocationModeSource?: string;
  promptRange?: PromptRange;
  sourceInfo: ResourceSourceInfo | null;
}

export interface RuntimeExtensionInspection {
  status: "loaded" | "failed";
  path: string;
  resolvedPath?: string;
  sourceInfo: ResourceSourceInfo | null;
  registeredTools: string[];
  registeredCommands: string[];
  error?: string;
}

export interface RuntimeInspection {
  version: 1;
  sessionId: string;
  cwd: string;
  capturedAt: string;
  snapshotId: string;
  evidence: {
    basis: "agent-session-runtime";
    systemPromptSource: "agent.state.systemPrompt";
    providerRequestCaptured: false;
    note: string;
  };
  systemPrompt: {
    characters: number;
    lines: number;
    sha256: string;
    /** Conservative SDK-compatible estimate, not provider tokenizer output. */
    estimatedTokens?: number;
    estimatedInputCost?: RuntimePromptCost;
  };
  contextSources: RuntimeContextSource[];
  tools: RuntimeToolInspection[];
  skills: RuntimeSkillInspection[];
  extensions: RuntimeExtensionInspection[];
  skillRuntime?: SkillRuntimeEvidence;
  errors: string[];
}

type PromptSkill = {
  name: string;
  location: string;
  range: PromptRange;
};

type ExtensionLike = {
  path: string;
  resolvedPath?: string;
  sourceInfo?: ResourceSourceInfo;
  tools?: Map<string, unknown>;
  commands?: Map<string, unknown>;
};

type ExtensionLoadResultLike = {
  extensions: ExtensionLike[];
  errors: Array<{ path: string; error: string }>;
};

export function estimateSystemPromptTokens(prompt: string): number {
  return Math.ceil(prompt.length / 4);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function lineNumberAt(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") line += 1;
  }
  return line;
}

function promptRange(text: string, start: number, end: number): PromptRange {
  return {
    startLine: lineNumberAt(text, start),
    endLine: lineNumberAt(text, Math.max(start, end - 1)),
    startOffset: start,
    endOffset: end,
  };
}

function findRange(text: string, value: string, from = 0): PromptRange | undefined {
  if (!value) return undefined;
  const start = text.indexOf(value, from);
  return start < 0 ? undefined : promptRange(text, start, start + value.length);
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function parsePromptSkills(text: string): PromptSkill[] {
  const sectionStart = text.indexOf("<available_skills>");
  if (sectionStart < 0) return [];
  const sectionEnd = text.indexOf("</available_skills>", sectionStart);
  if (sectionEnd < 0) return [];
  const section = text.slice(sectionStart, sectionEnd);
  const result: PromptSkill[] = [];
  const pattern = /<skill>\s*<name>([\s\S]*?)<\/name>\s*<description>[\s\S]*?<\/description>\s*<location>([\s\S]*?)<\/location>[\s\S]*?<\/skill>/g;
  for (const match of section.matchAll(pattern)) {
    const location = decodeXml(match[2].trim());
    const start = sectionStart + (match.index ?? 0);
    result.push({
      name: decodeXml(match[1].trim()),
      location,
      range: promptRange(text, start, start + match[0].length),
    });
  }
  return result;
}

function sourceInfoOf(value: unknown): ResourceSourceInfo | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Partial<ResourceSourceInfo>;
  if (
    typeof source.path !== "string"
    || typeof source.source !== "string"
    || (source.scope !== "user" && source.scope !== "project" && source.scope !== "temporary")
    || (source.origin !== "package" && source.origin !== "top-level")
  ) return null;
  return {
    path: source.path,
    source: source.source,
    scope: source.scope,
    origin: source.origin,
    ...(typeof source.baseDir === "string" ? { baseDir: source.baseDir } : {}),
  };
}

function asError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function promptMentionsTool(text: string, name: string): boolean {
  const marker = `- ${name}:`;
  return text.split("\n").some((line) => line.trimStart().startsWith(marker));
}

export function buildRuntimeInspection(
  inner: AgentSessionLike,
  capturedAt = new Date().toISOString(),
  promptOverride?: string,
  skillRuntime?: SkillRuntimeEvidence,
): RuntimeInspection {
  const prompt = promptOverride ?? inner.agent.state?.systemPrompt ?? "";
  const promptHash = sha256(prompt);
  const errors: string[] = [];
  const loader = inner.resourceLoader;

  let skills: Array<{
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    disableModelInvocation: boolean;
    sourceInfo?: ResourceSourceInfo;
  }> = [];
  try {
    if (typeof loader.getSkills === "function") skills = loader.getSkills().skills;
    else errors.push("skills: loader evidence unavailable");
  } catch (error) {
    errors.push(`skills: ${asError(error)}`);
  }

  let extensions: ExtensionLoadResultLike = { extensions: [], errors: [] };
  try {
    if (typeof loader.getExtensions === "function") extensions = loader.getExtensions() as ExtensionLoadResultLike;
    else errors.push("extensions: loader evidence unavailable");
  } catch (error) {
    errors.push(`extensions: ${asError(error)}`);
  }

  let agentsFiles: Array<{ path: string; content: string }> = [];
  try {
    if (typeof loader.getAgentsFiles === "function") agentsFiles = loader.getAgentsFiles().agentsFiles;
    else errors.push("agent files: loader evidence unavailable");
  } catch (error) {
    errors.push(`agent files: ${asError(error)}`);
  }

  let baseSystemPrompt: string | undefined;
  let baseSystemPromptPath: string | undefined;
  try {
    if (typeof loader.getSystemPrompt === "function") baseSystemPrompt = loader.getSystemPrompt();
    if (typeof loader.getSystemPromptSource === "function") baseSystemPromptPath = loader.getSystemPromptSource()?.path;
    if (typeof loader.getSystemPrompt !== "function" || typeof loader.getSystemPromptSource !== "function") errors.push("system prompt source: loader evidence unavailable");
  } catch (error) {
    errors.push(`system prompt source: ${asError(error)}`);
  }

  let appendSystemPrompts: string[] = [];
  let appendSystemPromptSources: Array<{ path: string }> = [];
  try {
    if (typeof loader.getAppendSystemPrompt === "function") appendSystemPrompts = loader.getAppendSystemPrompt();
    if (typeof loader.getAppendSystemPromptSources === "function") appendSystemPromptSources = loader.getAppendSystemPromptSources();
    if (typeof loader.getAppendSystemPrompt !== "function" || typeof loader.getAppendSystemPromptSources !== "function") errors.push("appended system prompt sources: loader evidence unavailable");
  } catch (error) {
    errors.push(`appended system prompt sources: ${asError(error)}`);
  }

  const contextSources: RuntimeContextSource[] = [];
  let agentFileSearchFrom = 0;
  for (const file of agentsFiles) {
    const opening = `<project_instructions path="${file.path}">`;
    const openingStart = prompt.indexOf(opening, agentFileSearchFrom);
    const closing = "</project_instructions>";
    const closingStart = openingStart >= 0 ? prompt.indexOf(closing, openingStart) : -1;
    const end = closingStart >= 0 ? closingStart + closing.length : -1;
    const range = openingStart >= 0 && end >= 0 ? promptRange(prompt, openingStart, end) : undefined;
    if (openingStart >= 0) agentFileSearchFrom = end >= 0 ? end : openingStart + opening.length;
    contextSources.push({
      kind: "agent-file",
      path: file.path,
      characters: file.content.length,
      sha256: sha256(file.content),
      inSystemPrompt: Boolean(range),
      ...(range ? { promptRange: range } : {}),
    });
  }

  if (baseSystemPromptPath) {
    const range = baseSystemPrompt ? findRange(prompt, baseSystemPrompt) : undefined;
    contextSources.push({
      kind: "system-prompt-file",
      path: baseSystemPromptPath,
      ...(baseSystemPrompt !== undefined ? { characters: baseSystemPrompt.length, sha256: sha256(baseSystemPrompt) } : {}),
      inSystemPrompt: Boolean(range),
      ...(range ? { promptRange: range } : {}),
    });
  }

  let appendSearchFrom = 0;
  for (let index = 0; index < appendSystemPromptSources.length; index += 1) {
    const content = appendSystemPrompts[index] ?? "";
    const source = appendSystemPromptSources[index];
    if (!source?.path) continue;
    const range = findRange(prompt, content, appendSearchFrom);
    if (range) appendSearchFrom = range.endOffset;
    contextSources.push({
      kind: "append-system-prompt",
      path: source.path,
      characters: content.length,
      sha256: sha256(content),
      inSystemPrompt: Boolean(range),
      ...(range ? { promptRange: range } : {}),
    });
  }

  const promptSkills = parsePromptSkills(prompt);
  const promptSkillByPath = new Map(promptSkills.map((skill) => [skill.location, skill]));
  const promptSkillByName = new Map(promptSkills.map((skill) => [skill.name, skill]));
  const runtimeSkills: RuntimeSkillInspection[] = skills.map((skill) => {
    const evidence = promptSkillByPath.get(skill.filePath) ?? promptSkillByName.get(skill.name);
    const policy = (skill as typeof skill & { policy?: PureResolvedSkillPolicy }).policy;
    const invocationMode = policy?.invocationMode ?? (skill.disableModelInvocation ? "explicit-only" : "automatic");
    const promptVisible = Boolean(evidence) && policy?.promptVisible !== false && invocationMode === "automatic";
    return {
      name: skill.name,
      description: skill.description,
      filePath: skill.filePath,
      baseDir: skill.baseDir,
      disableModelInvocation: skill.disableModelInvocation,
      promptVisible,
      ...(policy ? {
        policyKey: policy.policyKey,
        resourceState: policy.resourceState,
        invocationMode: policy.invocationMode,
        availability: policy.availability,
        runtimeLoaded: policy.runtimeLoaded,
        commandUsable: policy.commandUsable,
        invocationModeSource: policy.invocationModeSource,
      } : {}),
      ...(evidence ? { promptRange: evidence.range } : {}),
      sourceInfo: sourceInfoOf(skill.sourceInfo),
    };
  });

  const activeToolNames = new Set<string>();
  try {
    if (typeof inner.getActiveToolNames === "function") {
      for (const name of inner.getActiveToolNames()) activeToolNames.add(name);
    } else {
      errors.push("tools: active tool evidence unavailable");
    }
  } catch (error) {
    errors.push(`tools: ${asError(error)}`);
  }
  let allTools: ToolInfo[] = [];
  try {
    if (typeof inner.getAllTools === "function") allTools = inner.getAllTools();
    else errors.push("tools: tool definition evidence unavailable");
  } catch (error) {
    errors.push(`tools: ${asError(error)}`);
  }
  const runtimeTools: RuntimeToolInspection[] = allTools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    active: activeToolNames.has(tool.name),
    mentionedInSystemPrompt: promptMentionsTool(prompt, tool.name),
    parameters: tool.parameters ?? null,
    promptGuidelines: tool.promptGuidelines ?? [],
    sourceInfo: sourceInfoOf(tool.sourceInfo),
  }));

  const runtimeExtensions: RuntimeExtensionInspection[] = extensions.extensions.map((extension) => ({
    status: "loaded",
    path: extension.path,
    ...(extension.resolvedPath ? { resolvedPath: extension.resolvedPath } : {}),
    sourceInfo: sourceInfoOf(extension.sourceInfo),
    registeredTools: extension.tools ? [...extension.tools.keys()] : [],
    registeredCommands: extension.commands ? [...extension.commands.keys()] : [],
  }));
  for (const failure of extensions.errors) {
    runtimeExtensions.push({
      status: "failed",
      path: failure.path,
      sourceInfo: null,
      registeredTools: [],
      registeredCommands: [],
      error: failure.error,
    });
  }

  const snapshotId = `${capturedAt}:${promptHash.slice(0, 16)}`;
  return {
    version: 1,
    sessionId: inner.sessionId,
    cwd: inner.sessionManager.getCwd(),
    capturedAt,
    snapshotId,
    evidence: {
      basis: "agent-session-runtime",
      systemPromptSource: "agent.state.systemPrompt",
      providerRequestCaptured: false,
      note: "同一 AgentSession 快照生成；Reader skill runtime 只记录本地 baseline 与 dynamic 观测，providerRequestCaptured=false。",
    },
    systemPrompt: {
      characters: prompt.length,
      lines: prompt.length === 0 ? 0 : prompt.split("\n").length,
      sha256: promptHash,
      estimatedTokens: estimateSystemPromptTokens(prompt),
    },
    contextSources,
    tools: runtimeTools,
    skills: runtimeSkills,
    extensions: runtimeExtensions,
    ...(skillRuntime ? { skillRuntime } : {}),
    errors,
  };
}
