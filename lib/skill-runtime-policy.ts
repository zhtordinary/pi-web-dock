import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import type {
  PureResolvedSkillPolicy,
  SkillInvocationMode,
  SkillPolicyScope,
  SkillResourceState,
  SkillPolicyCatalog,
} from "./api-types";
import { getSkillPolicyKey, resolveSkillPolicy } from "./skill-policy";
import { parseFrontmatter } from "./frontmatter";

type SkillPolicyInput = Parameters<typeof resolveSkillPolicy>[0];

export { getSkillPolicyKey, resolveSkillPolicy } from "./skill-policy";
export type {
  PureResolvedSkillPolicy,
  SkillInvocationMode,
  SkillPolicyScope,
  SkillResourceState,
  SkillPolicyCatalog,
} from "./api-types";

export interface RuntimeSkillLike {
  name: string;
  description?: string;
  filePath: string;
  baseDir: string;
  disableModelInvocation?: boolean;
  declaresManualInvocation?: boolean;
  triggerMode?: "automatic" | "manual";
  sourceInfo?: {
    source?: string;
    scope?: string;
    origin?: "package" | "top-level";
    baseDir?: string;
    path?: string;
  };
  policy?: PureResolvedSkillPolicy;
  policyKey?: string;
  resourceState?: SkillResourceState;
  invocationMode?: SkillInvocationMode;
  availability?: "available" | "stale" | "unavailable";
  runtimeLoaded?: boolean;
  promptVisible?: boolean;
  commandUsable?: boolean;
  packageIdentity?: string;
  pluginResourceKey?: string;
  resourceKey?: string;
  resourceEnabled?: boolean;
  globalResourceEnabled?: boolean;
}

export interface RuntimeSkillPolicyContext {
  scope?: SkillPolicyScope;
  /** Explicit child capability boundary; false keeps noSkills/chatOnly closed. */
  runtimeSkillsEnabled?: boolean;
  /** Runtime catalog health; unlike runtimeSkillsEnabled this may recover after reload. */
  runtimeCatalogAvailable?: boolean;
  /** Child sessions fail closed if a later catalog refresh cannot be completed. */
  requireRuntimeCatalog?: boolean;
  entries?: unknown[];
  policies?: readonly unknown[];
  stale?: readonly unknown[];
  states?: Readonly<Record<string, unknown>>;
  globalInvocationModes?: Readonly<Record<string, SkillInvocationMode>>;
  projectInvocationModes?: Readonly<Record<string, SkillInvocationMode>>;
  cwd?: string;
  agentDir?: string;
  /** The unfiltered SDK list, retained so disabled resources can be rejected explicitly. */
  catalogSkills?: readonly RuntimeSkillLike[];
}

export interface RuntimePromptSnapshot {
  sha256: string;
  characters: number;
  estimatedTokens: number;
}

export interface RuntimeSkillObservation {
  status: "pending" | "accepted" | "rejected" | "settled";
  skillName: string;
  policyKey: string;
  bodySha256?: string;
  characters?: number;
  estimatedTokens?: number;
  baselineBefore: RuntimePromptSnapshot;
  baselineAfter?: RuntimePromptSnapshot;
  baselineUnchanged?: boolean;
  errorCode?: string;
  observedAt: string;
}

export interface SkillRuntimeEvidence {
  baseline?: RuntimePromptSnapshot;
  last?: RuntimeSkillObservation;
  activeCount: number;
}

export interface RuntimeSkillRoute {
  name: string;
  args: string;
  expandedText: string;
  skill: RuntimeSkillLike;
  policy: PureResolvedSkillPolicy;
  bodySha256: string;
  bodyCharacters: number;
  bodyEstimatedTokens: number;
}

export class SkillRuntimeRouteError extends Error {
  readonly code: "invalid" | "unknown" | "ambiguous" | "disabled" | "stale" | "unavailable" | "read-failed";
  readonly skillName: string;
  readonly policy?: PureResolvedSkillPolicy;

  constructor(
    code: SkillRuntimeRouteError["code"],
    skillName: string,
    message: string,
    policy?: PureResolvedSkillPolicy,
  ) {
    super(message);
    this.name = "SkillRuntimeRouteError";
    this.code = code;
    this.skillName = skillName;
    this.policy = policy;
  }
}

type AnyRecord = Record<string, unknown>;

function asRecord(value: unknown): AnyRecord | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as AnyRecord : undefined;
}

function stringValue(...values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}

function pathOf(value: unknown): string | undefined {
  const item = asRecord(value);
  return stringValue(item?.filePath, item?.path, item?.location);
}

function normalizedPath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    return resolve(value);
  } catch {
    return undefined;
  }
}

function packageResourceKey(skill: RuntimeSkillLike): string | undefined {
  const explicit = stringValue(skill.pluginResourceKey, skill.resourceKey);
  if (explicit) return explicit.replaceAll("\\", "/");
  if (skill.sourceInfo?.origin !== "package" || !skill.sourceInfo.baseDir) return undefined;
  const key = relative(skill.sourceInfo.baseDir, skill.filePath).replaceAll("\\", "/");
  return key && key !== "." && !key.startsWith("../") && key !== ".." ? key : undefined;
}

function keyOf(skill: RuntimeSkillLike, context: RuntimeSkillPolicyContext): string {
  if (skill.policyKey) return skill.policyKey;
  const key = getSkillPolicyKey({
    filePath: skill.filePath,
    sourceInfo: skill.sourceInfo,
    pluginResourceKey: packageResourceKey(skill),
    cwd: context.cwd,
    agentDir: context.agentDir,
  });
  return key ?? `top-level:${resolve(skill.filePath)}`;
}

function exactPathMatch(a: unknown, b: string): boolean {
  const path = normalizedPath(pathOf(a));
  return Boolean(path && path === normalizedPath(b));
}

function exactPolicyMatch(value: unknown, policyKey: string, filePath: string): boolean {
  const item = asRecord(value);
  const nested = asRecord(item?.policy);
  const key = stringValue(item?.policyKey, item?.key, nested?.policyKey);
  return key === policyKey || exactPathMatch(item, filePath) || exactPathMatch(nested, filePath);
}

type SkillOwnership = "global" | "project";

function ownershipFromScope(value: unknown): SkillOwnership | undefined {
  if (value === "project") return "project";
  if (value === "user" || value === "global") return "global";
  return undefined;
}

/**
 * Resolve ownership from the actual discovered resource before consulting a
 * policy-key map. A package key is intentionally shared by its user and
 * project copies, so the key alone cannot decide whether a global mode is
 * applicable.
 */
function skillOwnership(skill: RuntimeSkillLike, context: RuntimeSkillPolicyContext): SkillOwnership | undefined {
  const catalog = context.catalogSkills?.find((candidate) => exactPathMatch(candidate, skill.filePath));
  const candidates: unknown[] = [
    skill.sourceInfo?.scope,
    catalog?.sourceInfo?.scope,
    skill.policy?.scope,
    catalog?.policy?.scope,
  ];
  for (const candidate of candidates) {
    const ownership = ownershipFromScope(candidate);
    if (ownership) return ownership;
  }
  return context.scope === "global" ? "global" : undefined;
}

function recordOwnership(record: AnyRecord): SkillOwnership | undefined {
  const nested = asRecord(record.policy);
  const sourceInfo = asRecord(record.sourceInfo);
  return ownershipFromScope(record.scope)
    ?? ownershipFromScope(sourceInfo?.scope)
    ?? ownershipFromScope(nested?.scope);
}

function matchingPolicyRecord(
  skill: RuntimeSkillLike,
  context: RuntimeSkillPolicyContext,
  policyKey: string,
  ownership: SkillOwnership | undefined,
): AnyRecord | undefined {
  const records = [...(context.policies ?? []), ...(context.entries ?? []), ...(context.stale ?? [])];
  const matches = records.map(asRecord).filter((item): item is AnyRecord => Boolean(item && exactPolicyMatch(item, policyKey, skill.filePath)));
  const compatible = matches.find((item) => {
    const recordScope = recordOwnership(item);
    return !ownership || !recordScope || recordScope === ownership;
  });
  return compatible ?? (ownership ? undefined : matches[0]);
}

function rawSkill(skill: RuntimeSkillLike, context: RuntimeSkillPolicyContext): RuntimeSkillLike {
  return context.catalogSkills?.find((candidate) => exactPathMatch(candidate, skill.filePath)) ?? skill;
}

function mode(value: unknown): SkillInvocationMode | undefined {
  return value === "automatic" || value === "explicit-only" ? value : undefined;
}

function resourceState(value: unknown): SkillResourceState | undefined {
  if (value === "enabled" || value === "disabled") return value;
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  return undefined;
}

function recordResource(record: AnyRecord | undefined, key: string): SkillResourceState | undefined {
  return resourceState(record?.[key]);
}

function resourceDimension(record: AnyRecord | undefined, dimension: "global" | "project", legacyManual = false): SkillResourceState | undefined {
  if (!record) return undefined;
  const nested = asRecord(record.policy);
  const explicit = dimension === "global"
    ? recordResource(record, "globalResourceState") ?? recordResource(nested, "globalResourceState")
    : recordResource(record, "projectResourceState") ?? recordResource(nested, "projectResourceState");
  if (explicit) return explicit;
  const enabled = dimension === "global"
    ? record.globalResourceEnabled ?? record.globalEnabled ?? nested?.globalResourceEnabled ?? nested?.globalEnabled
    : record.projectResourceEnabled ?? record.projectEnabled ?? nested?.projectResourceEnabled ?? nested?.projectEnabled;
  // The old top-level global override was an invocation mode, so its
  // `disabled` value must not turn an otherwise enabled resource off. The
  // project field, however, has always represented a resource filter; keep
  // that dimension as a real resource state when the canonical catalog is not
  // available. Canonical attached policies take precedence in normal runs.
  if (
    dimension === "global"
    && record.globalInvocationOverride === "disabled"
    && record.globalResourceState === undefined
    && record.globalResourceEnabled === undefined
  ) return undefined;
  const explicitProjectResource = dimension === "project" && record.projectInvocationOverride !== undefined;
  const legacyGlobalMode = dimension === "global" && record.globalInvocationOverride === "disabled";
  if (enabled === false && legacyManual && !explicitProjectResource && !legacyGlobalMode) return "enabled";
  return resourceState(enabled)
    ?? resourceState(record.resourceState ?? nested?.resourceState);
}

function policyInputFor(skill: RuntimeSkillLike, context: RuntimeSkillPolicyContext): SkillPolicyInput {
  const subject = rawSkill(skill, context);
  const policyKey = keyOf(subject, context);
  const ownership = skillOwnership(subject, context);
  const record = matchingPolicyRecord(subject, context, policyKey, ownership);
  const attached = subject.policy;
  const state = asRecord(context.states?.[policyKey]) ?? asRecord(context.states?.[subject.filePath]);
  const stateValue = context.states?.[policyKey] ?? context.states?.[subject.filePath];
  const legacyManual = subject.declaresManualInvocation ?? subject.disableModelInvocation ?? false;
  const globalResourceState = ownership === "project"
    ? undefined
    : resourceDimension(record, "global", legacyManual)
      ?? resourceDimension(state, "global")
      ?? (subject.globalResourceEnabled === undefined ? undefined : resourceState(subject.globalResourceEnabled));
  const projectResourceState = resourceDimension(record, "project", legacyManual)
    ?? resourceDimension(state, "project")
    ?? (context.scope === "project" && subject.resourceEnabled !== undefined ? resourceState(subject.resourceEnabled) : undefined);
  const effectiveResourceState = resourceState(attached?.resourceState)
    ?? resourceState(record?.resourceState)
    ?? resourceState(stateValue)
    ?? resourceDimension(state, context.scope === "project" ? "project" : "global")
    ?? (context.scope === "project"
      ? globalResourceState === "disabled" || projectResourceState === "disabled"
        ? "disabled"
        : projectResourceState ?? globalResourceState
      : globalResourceState)
    ?? (subject.resourceEnabled === undefined ? "enabled" : resourceState(subject.resourceEnabled) ?? "enabled");
  // Resolve raw configured modes before consulting an already-resolved
  // retained catalog policy. The attached explicit-only value is only a final
  // fallback: a newer automatic mode, legacy override, frontmatter marker, or
  // trigger analysis must always win over the retained value.
  const attachedInvocationMode = mode(attached?.invocationMode) ?? mode(subject.invocationMode);
  const rawGlobalInvocationMode = ownership === "project"
    ? undefined
    : mode(attached?.globalInvocationMode)
      ?? mode(record?.globalInvocationMode)
      ?? context.globalInvocationModes?.[policyKey];
  const rawProjectInvocationMode = mode(attached?.projectInvocationMode)
    ?? mode(record?.projectInvocationMode)
    ?? (record?.projectInvocationOverride === "enabled" ? "automatic" : record?.projectInvocationOverride === "disabled" ? "explicit-only" : undefined)
    ?? context.projectInvocationModes?.[policyKey];
  const legacyGlobalInvocationOverride = ownership !== "project"
    && (record?.globalInvocationOverride === "enabled" || record?.globalInvocationOverride === "disabled")
    ? record.globalInvocationOverride
    : undefined;
  const explicitOnlyCatalogFallback = attachedInvocationMode === "explicit-only"
    && rawGlobalInvocationMode === undefined
    && rawProjectInvocationMode === undefined
    && legacyGlobalInvocationOverride === undefined
    && !legacyManual
    && subject.triggerMode === undefined;
  const globalInvocationMode = ownership === "project"
    ? undefined
    : rawGlobalInvocationMode
      ?? (explicitOnlyCatalogFallback ? "explicit-only" : undefined);
  const projectInvocationMode = rawProjectInvocationMode
    ?? (context.scope === "project" && explicitOnlyCatalogFallback ? "explicit-only" : undefined);
  const availability = attached?.availability
    ?? (record?.availability === "stale" || record?.availability === "unavailable" ? record.availability : undefined)
    ?? "available";
  const pluginResourceKey = stringValue(
    attached?.pluginResourceKey,
    record?.pluginResourceKey,
    record?.resourceKey,
    packageResourceKey(subject),
  );
  return {
    policyKey,
    scope: context.scope ?? "global",
    resourceState: effectiveResourceState,
    ...(globalResourceState ? { globalResourceState } : {}),
    ...(projectResourceState ? { projectResourceState } : {}),
    ...(globalInvocationMode ? { globalInvocationMode } : {}),
    ...(projectInvocationMode ? { projectInvocationMode } : {}),
    ...(legacyGlobalInvocationOverride ? { legacyGlobalInvocationOverride } : {}),
    declaresManualInvocation: legacyManual,
    ...(subject.triggerMode ? { triggerMode: subject.triggerMode } : {}),
    availability,
    ...(stringValue(attached?.packageIdentity, record?.packageIdentity, subject.packageIdentity) ? { packageIdentity: stringValue(attached?.packageIdentity, record?.packageIdentity, subject.packageIdentity) } : {}),
    ...(pluginResourceKey ? { pluginResourceKey } : {}),
    ...(stringValue(record?.staleReason, attached?.staleReason) ? { staleReason: stringValue(record?.staleReason, attached?.staleReason) } : {}),
  } as SkillPolicyInput;
}

export function resolveRuntimeSkillPolicy(skill: RuntimeSkillLike, context: RuntimeSkillPolicyContext = {}): PureResolvedSkillPolicy {
  return resolveSkillPolicy(policyInputFor(skill, context));
}

function runtimeCatalogUnavailable(context: RuntimeSkillPolicyContext): boolean {
  return context.runtimeSkillsEnabled === false
    || (context.requireRuntimeCatalog === true && context.runtimeCatalogAvailable === false);
}

export function filterRuntimeSkills<T extends RuntimeSkillLike>(skills: readonly T[], context: RuntimeSkillPolicyContext = {}): T[] {
  if (runtimeCatalogUnavailable(context)) return [];
  if (!context.catalogSkills) context.catalogSkills = skills;
  return skills.flatMap((skill) => {
    const policy = resolveRuntimeSkillPolicy(skill, context);
    if (!policy.runtimeLoaded) return [];
    return [{
      ...skill,
      policy,
      policyKey: policy.policyKey,
      resourceState: policy.resourceState,
      invocationMode: policy.invocationMode,
      availability: policy.availability,
      runtimeLoaded: policy.runtimeLoaded,
      promptVisible: policy.promptVisible,
      commandUsable: policy.commandUsable,
      disableModelInvocation: policy.invocationMode === "explicit-only",
    } as T];
  });
}

export function runtimeSkillCommandEntries<T extends RuntimeSkillLike>(skills: readonly T[], context: RuntimeSkillPolicyContext = {}): T[] {
  if (runtimeCatalogUnavailable(context)) return [];
  return skills.filter((skill) => resolveRuntimeSkillPolicy(skill, context).commandUsable);
}

export function parseSkillCommand(text: string): { name: string; args: string } | null {
  if (!text.startsWith("/skill:")) return null;
  // Keep the admission parser byte-for-byte compatible with Pi's native
  // `_expandSkillCommand`: it uses the first literal space as the delimiter.
  // In particular, a tab is part of the skill name to the SDK and must not be
  // silently accepted here as an explicit dynamic invocation.
  const spaceIndex = text.indexOf(" ");
  const name = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
  if (!name || /[\r\n]/.test(name)) {
    throw new SkillRuntimeRouteError("invalid", name, "skill command must use /skill:<name> [args]");
  }
  const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
  return { name, args };
}

function readSkillBody(skill: RuntimeSkillLike): { body: string; hash: string } {
  const source = readFileSync(skill.filePath, "utf8");
  const body = parseFrontmatter(source).rest.trim();
  return { body, hash: createHash("sha256").update(body).digest("hex") };
}

export function routeSkillCommand(
  text: string,
  options: { skills: readonly RuntimeSkillLike[]; context?: RuntimeSkillPolicyContext },
): RuntimeSkillRoute | null {
  const parsed = parseSkillCommand(text);
  if (!parsed) return null;
  const context = options.context ?? {};
  if (runtimeCatalogUnavailable(context)) {
    throw new SkillRuntimeRouteError("unavailable", parsed.name, `Skill /skill:${parsed.name} is unavailable`);
  }
  // Admission is performed against the SDK's live resource list. The policy
  // catalog may retain disabled/explicit-only records that the SDK loader has
  // filtered or may contain the same resource with policy annotations; union
  // both views by resolved path so explicit-only skills remain slash-usable
  // and disabled/stale resources are still rejected with their real status.
  const candidates = [...options.skills, ...(context.catalogSkills ?? [])]
    .filter((skill) => skill.name === parsed.name)
    .filter((skill, index, all) => all.findIndex((candidate) => {
      const left = normalizedPath(candidate.filePath);
      const right = normalizedPath(skill.filePath);
      return left && right ? left === right : candidate === skill;
    }) === index);
  if (candidates.length === 0) throw new SkillRuntimeRouteError("unavailable", parsed.name, `Skill /skill:${parsed.name} is unavailable`);
  if (candidates.length !== 1) throw new SkillRuntimeRouteError("ambiguous", parsed.name, `Skill /skill:${parsed.name} is ambiguous`);
  const skill = candidates[0];
  const policy = resolveRuntimeSkillPolicy(skill, context);
  if (policy.availability !== "available") {
    throw new SkillRuntimeRouteError(policy.availability, parsed.name, `Skill /skill:${parsed.name} is ${policy.availability}`, policy);
  }
  if (policy.resourceState === "disabled") {
    throw new SkillRuntimeRouteError("disabled", parsed.name, `Skill /skill:${parsed.name} is disabled`, policy);
  }
  if (!policy.commandUsable) {
    throw new SkillRuntimeRouteError("unavailable", parsed.name, `Skill /skill:${parsed.name} is not command-usable`, policy);
  }
  let body: string;
  let bodyHash: string;
  try {
    ({ body, hash: bodyHash } = readSkillBody(skill));
  } catch (error) {
    throw new SkillRuntimeRouteError("read-failed", parsed.name, `Skill /skill:${parsed.name} could not be read: ${error instanceof Error ? error.message : String(error)}`, policy);
  }
  const block = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
  return {
    name: parsed.name,
    args: parsed.args,
    expandedText: parsed.args ? `${block}\n\n${parsed.args}` : block,
    skill,
    policy,
    bodySha256: bodyHash,
    bodyCharacters: body.length,
    bodyEstimatedTokens: Math.ceil(body.length / 4),
  };
}

export function promptSnapshot(prompt: string): RuntimePromptSnapshot {
  return {
    sha256: createHash("sha256").update(prompt).digest("hex"),
    characters: prompt.length,
    estimatedTokens: Math.ceil(prompt.length / 4),
  };
}

function sameSnapshot(a: RuntimePromptSnapshot, b: RuntimePromptSnapshot): boolean {
  return a.sha256 === b.sha256 && a.characters === b.characters && a.estimatedTokens === b.estimatedTokens;
}

export class SkillRuntimeTracker {
  private readonly active = new Map<string, RuntimeSkillObservation>();
  private baseline?: RuntimePromptSnapshot;
  private latest: RuntimeSkillObservation | undefined;

  begin(route: RuntimeSkillRoute, baselinePrompt: string): string {
    const token = randomUUID();
    const baselineBefore = promptSnapshot(baselinePrompt);
    if (!this.baseline) this.baseline = baselineBefore;
    const observation: RuntimeSkillObservation = {
      status: "pending",
      skillName: route.name,
      policyKey: route.policy.policyKey,
      bodySha256: route.bodySha256,
      characters: route.bodyCharacters,
      estimatedTokens: route.bodyEstimatedTokens,
      baselineBefore,
      observedAt: new Date().toISOString(),
    };
    this.active.set(token, observation);
    this.latest = observation;
    return token;
  }

  settle(token: string, baselinePrompt: string, status: "accepted" | "settled" = "settled", errorCode?: string): void {
    const observation = this.active.get(token);
    if (!observation) return;
    const baselineAfter = promptSnapshot(baselinePrompt);
    const settled = {
      ...observation,
      status,
      baselineAfter,
      baselineUnchanged: sameSnapshot(observation.baselineBefore, baselineAfter),
      ...(errorCode ? { errorCode } : {}),
      observedAt: new Date().toISOString(),
    } satisfies RuntimeSkillObservation;
    this.active.delete(token);
    this.latest = settled;
  }

  settleAll(baselinePrompt: string): void {
    for (const token of [...this.active.keys()]) this.settle(token, baselinePrompt);
  }

  reject(skillName: string, policy: PureResolvedSkillPolicy | undefined, baselinePrompt: string, errorCode: string): void {
    const baselineBefore = promptSnapshot(baselinePrompt);
    if (!this.baseline) this.baseline = baselineBefore;
    this.latest = {
      status: "rejected",
      skillName,
      policyKey: policy?.policyKey ?? "top-level:unknown",
      baselineBefore,
      baselineAfter: baselineBefore,
      baselineUnchanged: true,
      errorCode,
      observedAt: new Date().toISOString(),
    };
  }

  snapshot(baselinePrompt?: string): SkillRuntimeEvidence {
    if (!this.baseline && baselinePrompt !== undefined) this.baseline = promptSnapshot(baselinePrompt);
    return {
      ...(this.baseline ? { baseline: this.baseline } : {}),
      ...(this.latest ? { last: this.latest } : {}),
      activeCount: this.active.size,
    };
  }
}

/** Delegate to the Skills API's canonical catalog so runtime and UI share one policy result. */
export async function loadSkillPolicyCatalog(cwd: string, scope: SkillPolicyScope = "project"): Promise<SkillPolicyCatalog> {
  const service = await import("./skills-service");
  if (typeof service.loadSkillPolicyCatalog === "function") {
    return service.loadSkillPolicyCatalog(cwd, scope) as unknown as Promise<SkillPolicyCatalog>;
  }
  const response = await service.loadSkillsWithInstallInfo(cwd, scope);
  const skills = response.skills.filter(
    (skill): skill is SkillPolicyCatalog["skills"][number] => Boolean(skill.policy),
  );
  const stale: SkillPolicyCatalog["stale"] = (response as unknown as {
    stalePolicies?: SkillPolicyCatalog["stale"];
  }).stalePolicies ?? [];
  return {
    skills,
    stale,
    viewScope: scope,
    projectResourcesLoaded: response.projectResourcesLoaded,
  };
}
