import { realpathSync } from "node:fs";
import { getAgentDir, type InlineExtension, type ModelRuntime, type SessionManager } from "@earendil-works/pi-coding-agent";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

/**
 * Same-process bridge shared with pi-remote-claude. It deliberately contains
 * opaque package scopes and live Reader objects; it is never serialized into a
 * session, prompt, tool schema, JSONL entry, or wire request.
 */
export const REMOTE_CLAUDE_HOST_BRIDGE_KEY = Symbol.for("pi-remote-claude.reader-host-bridge.v1");
const REMOTE_PACKAGE_NAME = "pi-remote-claude";
export const REMOTE_CLAUDE_PROVIDER_ID = "claude-remote";
const REMOTE_CONTROL_TOOLS = ["Agent", "get_subagent_result", "steer_subagent"] as const;
const ORDINARY_TOOLS = ["read", "write", "edit", "grep", "find", "ls", "bash"] as const;
const BUILTIN_PROFILES = new Set(["general-purpose", "explore", "plan"]);
const MAX_INPUT_FILES = 8;
const MAX_INPUT_BYTES = 512 * 1024;
const DEFAULT_MAX_TURNS = 32;
const DEFAULT_MAX_CONCURRENT = 10;

export type RemoteHostContract = {
  readonly REMOTE_HOST_CONTRACT_VERSION: 1;
  bindRemoteHostScope(input: Record<string, unknown>): unknown;
  deriveRemoteHostScope(parent: unknown, input: Record<string, unknown>): unknown;
  registerReaderHostMarker(scope: unknown, marker: object): object;
  revokeRemoteHostScope(scope: unknown): void;
  assertRemoteHostOperation(scope: unknown, operation: string, request?: unknown): void;
  scopeSnapshot(scope: unknown): unknown;
  scopeActiveTools(scope: unknown): readonly string[];
  scopeHostIdentity(scope: unknown): object;
  scopePolicy(scope: unknown): unknown;
  policyDigest(policy: unknown): string;
};

export type RemoteHostPolicy = {
  orchestration: {
    enabled: boolean;
    allowedProfiles: readonly string[];
    allowedModels: readonly string[];
    childTools: readonly string[];
    maxConcurrent: number;
    maxTurns: number;
    maxInputFiles: number;
    maxInputBytes: number;
    allowWorktree: boolean;
    allowInheritedContext: boolean;
    allowCancellation: boolean;
  };
  ordinary: {
    allowedTools: readonly string[];
    readOnlyRoots: readonly string[];
    bash: "protected" | "disabled";
    policyDigest: string;
  };
};

export interface RemoteClaudeHostBinding {
  readonly sessionId: string;
  readonly hostIdentity: object;
  /** The exact SessionManager instance owned by this live AgentSession. */
  readonly sessionManager: SessionManager;
  readonly cwd: string;
  readonly agentDir: string;
  readonly activeTools: readonly string[];
  readonly parentSessionId?: string;
  readonly parentBinding?: RemoteClaudeHostBinding;
  readonly parentGeneration?: number;
  readonly scope: unknown;
  readonly readerMarker: object;
  readonly policy: RemoteHostPolicy;
  readonly generation: number;
  readonly contractVersion: 1;
  readonly builtInEnabled: boolean;
  /** Internal same-process contract handle; never serialize or expose to tools. */
  readonly contract: RemoteHostContract;
}

export interface InstallRemoteClaudeHostOptions {
  hostIdentity: object;
  sessionManager: SessionManager;
  sessionId: string;
  cwd: string;
  agentDir?: string;
  activeTools: readonly string[];
  modelRuntime?: Pick<ModelRuntime, "getModels"> | { getModels?: (provider?: string) => readonly { provider: string; id: string }[] };
  builtInEnabled: boolean;
  parent?: RemoteClaudeHostBinding;
  maxConcurrent?: number;
  maxTurns?: number;
  allowWorktree?: boolean;
  allowInheritedContext?: boolean;
  allowCancellation?: boolean;
  readOnlyRoots?: readonly string[];
  allowedProfiles?: readonly string[];
  allowedModels?: readonly string[];
  childTools?: readonly string[];
  replace?: boolean;
}

export type RemoteClaudeProviderModel = Readonly<{
  provider: string;
  id: string;
}>;

export type RemoteClaudeProviderAssociationInput = {
  providerSessionId: string;
  /** The live AgentSession object. This identity is intentionally opaque. */
  hostIdentity: object;
  /** The exact SessionManager owned by hostIdentity. */
  sessionManager: SessionManager;
  /** The model currently selected by hostIdentity. */
  model: RemoteClaudeProviderModel;
};

export interface RemoteClaudeProviderAssociation {
  readonly providerSessionId: string;
  readonly binding: RemoteClaudeHostBinding;
  readonly generation: number;
  readonly model: RemoteClaudeProviderModel;
}

export interface RemoteClaudeProviderAssociationLease extends RemoteClaudeProviderAssociation {
  /** Release only this request's alias association. */
  dispose(): void;
}

interface RemoteClaudeHostBridge {
  readonly version: 1;
  resolve(sessionId: string): RemoteClaudeHostBinding | undefined;
  resolveByHost(hostIdentity: object): RemoteClaudeHostBinding | undefined;
  resolveByManager(sessionManager: object): RemoteClaudeHostBinding | undefined;
  assert(binding: RemoteClaudeHostBinding, operation: string, request?: Record<string, unknown>): void;
  associateProviderSession(input: RemoteClaudeProviderAssociationInput): RemoteClaudeProviderAssociationLease;
  resolveProviderSession(providerSessionId: string): RemoteClaudeProviderAssociation | undefined;
}

interface RemoteClaudeHostRegistry extends RemoteClaudeHostBridge {
  bindings: Map<string, RemoteClaudeHostBinding>;
  byHost: WeakMap<object, RemoteClaudeHostBinding>;
  byManager: WeakMap<object, RemoteClaudeHostBinding>;
  generationBySession: Map<string, number>;
  providerAssociations: Map<string, RemoteClaudeProviderAssociationRecord>;
}

function canonicalLivePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  try { return realpathSync(value); } catch { return undefined; }
}

interface RemoteClaudeProviderAssociationRecord {
  providerSessionId: string;
  binding: RemoteClaudeHostBinding;
  generation: number;
  model: RemoteClaudeProviderModel;
  leases: Set<symbol>;
}

const contractCache = new Map<string, Promise<RemoteHostContract>>();

function providerModel(value: unknown): RemoteClaudeProviderModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { provider?: unknown; id?: unknown };
  if (typeof candidate.provider !== "string" || !candidate.provider
    || typeof candidate.id !== "string" || !candidate.id) return undefined;
  return { provider: candidate.provider, id: candidate.id };
}

function sameProviderModel(left: RemoteClaudeProviderModel, right: RemoteClaudeProviderModel): boolean {
  return left.provider === right.provider && left.id === right.id;
}

/** Read the model from the live AgentSession object, never from request data. */
function liveHostModel(hostIdentity: object): RemoteClaudeProviderModel | undefined {
  try {
    const candidate = hostIdentity as { model?: unknown; getModel?: () => unknown };
    const direct = providerModel(candidate.model);
    if (direct) return direct;
    if (typeof candidate.getModel === "function") return providerModel(candidate.getModel());
  } catch {
    // A disposed or partially torn-down AgentSession is not a trusted host.
  }
  return undefined;
}

function dropProviderAssociationsForBinding(root: RemoteClaudeHostRegistry, binding: RemoteClaudeHostBinding): void {
  for (const [providerSessionId, association] of root.providerAssociations) {
    if (association.binding === binding) root.providerAssociations.delete(providerSessionId);
  }
}

function assertProviderAssociationLive(
  root: RemoteClaudeHostRegistry,
  association: RemoteClaudeProviderAssociationRecord,
): void {
  const { binding } = association;
  if (association.generation !== binding.generation) {
    throw new Error("Remote Claude provider session association generation is stale");
  }
  const currentModel = liveHostModel(binding.hostIdentity);
  if (!currentModel || !sameProviderModel(currentModel, association.model)) {
    throw new Error("Remote Claude provider session model is no longer current");
  }
  root.assert(binding, "side-ask", {
    sessionManager: binding.sessionManager,
    hostIdentity: binding.hostIdentity,
    sessionId: binding.sessionId,
    generation: binding.generation,
  });
}

function associateProviderSession(
  root: RemoteClaudeHostRegistry,
  input: RemoteClaudeProviderAssociationInput,
): RemoteClaudeProviderAssociationLease {
  if (typeof input?.providerSessionId !== "string"
    || input.providerSessionId.length === 0
    || input.providerSessionId.length > 4096) {
    throw new Error("Remote Claude provider session id is invalid");
  }
  if (!input.hostIdentity || typeof input.hostIdentity !== "object"
    || !input.sessionManager || typeof input.sessionManager !== "object") {
    throw new Error("Remote Claude provider session requires a live AgentSession and SessionManager");
  }
  const requestedModel = providerModel(input.model);
  if (!requestedModel) throw new Error("Remote Claude provider session model is invalid");
  const binding = root.byHost.get(input.hostIdentity);
  if (!binding) throw new Error("Remote Claude provider session host binding is unavailable");
  if (binding.sessionManager !== input.sessionManager) {
    throw new Error("Remote Claude provider session manager does not match the live host binding");
  }
  const currentModel = liveHostModel(binding.hostIdentity);
  if (!currentModel || !sameProviderModel(currentModel, requestedModel)) {
    throw new Error("Remote Claude provider session model does not match the live AgentSession");
  }
  root.assert(binding, "side-ask", {
    sessionManager: input.sessionManager,
    hostIdentity: input.hostIdentity,
    sessionId: binding.sessionId,
    generation: binding.generation,
  });

  const existing = root.providerAssociations.get(input.providerSessionId);
  if (existing) {
    assertProviderAssociationLive(root, existing);
    if (existing.binding !== binding || existing.generation !== binding.generation
      || !sameProviderModel(existing.model, requestedModel)) {
      throw new Error("Remote Claude provider session association conflicts with the live host binding");
    }
  }
  const association = existing ?? {
    providerSessionId: input.providerSessionId,
    binding,
    generation: binding.generation,
    model: Object.freeze({ ...requestedModel }),
    leases: new Set<symbol>(),
  } satisfies RemoteClaudeProviderAssociationRecord;
  if (!existing) root.providerAssociations.set(input.providerSessionId, association);
  const leaseToken = Symbol(`remote-claude-provider:${input.providerSessionId}`);
  association.leases.add(leaseToken);
  let disposed = false;
  const lease: RemoteClaudeProviderAssociationLease = {
    providerSessionId: association.providerSessionId,
    binding: association.binding,
    generation: association.generation,
    model: association.model,
    dispose() {
      if (disposed) return;
      disposed = true;
      const current = root.providerAssociations.get(association.providerSessionId);
      if (current !== association) return;
      association.leases.delete(leaseToken);
      if (association.leases.size === 0) root.providerAssociations.delete(association.providerSessionId);
    },
  };
  return Object.freeze(lease);
}

function resolveProviderSession(
  root: RemoteClaudeHostRegistry,
  providerSessionId: string,
): RemoteClaudeProviderAssociation | undefined {
  if (typeof providerSessionId !== "string" || providerSessionId.length === 0) return undefined;
  const association = root.providerAssociations.get(providerSessionId);
  if (!association) return undefined;
  assertProviderAssociationLive(root, association);
  return Object.freeze({
    providerSessionId: association.providerSessionId,
    binding: association.binding,
    generation: association.generation,
    model: association.model,
  });
}

function ensureProviderAssociationApi(root: RemoteClaudeHostRegistry): RemoteClaudeHostRegistry {
  if (!(root.providerAssociations instanceof Map)) root.providerAssociations = new Map();
  if (typeof root.associateProviderSession !== "function") {
    root.associateProviderSession = (input) => associateProviderSession(root, input);
  }
  if (typeof root.resolveProviderSession !== "function") {
    root.resolveProviderSession = (providerSessionId) => resolveProviderSession(root, providerSessionId);
  }
  return root;
}

function registry(): RemoteClaudeHostRegistry {
  const root = globalThis as typeof globalThis & { [REMOTE_CLAUDE_HOST_BRIDGE_KEY]?: RemoteClaudeHostRegistry };
  const existing = root[REMOTE_CLAUDE_HOST_BRIDGE_KEY];
  if (existing
    && existing.version === 1
    && existing.bindings instanceof Map
    && existing.byHost
    && existing.byManager
    && existing.generationBySession instanceof Map
    && typeof existing.resolveByManager === "function") {
    return ensureProviderAssociationApi(existing);
  }
  const created: RemoteClaudeHostRegistry = {
    version: 1,
    bindings: new Map(),
    byHost: new WeakMap(),
    byManager: new WeakMap(),
    generationBySession: new Map(),
    providerAssociations: new Map(),
    resolve(sessionId) { return this.bindings.get(sessionId); },
    resolveByHost(hostIdentity) { return this.byHost.get(hostIdentity); },
    resolveByManager(sessionManager) { return this.byManager.get(sessionManager); },
    assert(binding, operation, request) {
      const current = this.bindings.get(binding.sessionId);
      if (current !== binding
        || this.byHost.get(binding.hostIdentity) !== binding
        || this.byManager.get(binding.sessionManager) !== binding) {
        throw new Error("Remote Claude Reader host binding is no longer current");
      }
      const manager = binding.sessionManager as { getSessionId?: () => unknown; getCwd?: () => unknown };
      if (typeof manager.getSessionId !== "function" || manager.getSessionId() !== binding.sessionId) {
        throw new Error("Remote Claude Reader SessionManager identity is no longer current");
      }
      if (typeof manager.getCwd !== "function" || canonicalLivePath(manager.getCwd()) !== binding.cwd) {
        throw new Error("Remote Claude Reader SessionManager cwd is no longer current");
      }
      const requestObject = request && typeof request === "object" ? request : undefined;
      const requestManager = requestObject?.sessionManager;
      if (requestManager !== undefined && requestManager !== binding.sessionManager) {
        throw new Error("Remote Claude Reader SessionManager does not match the live binding");
      }
      const requestHost = requestObject?.hostIdentity;
      if (requestHost !== undefined && requestHost !== binding.hostIdentity) {
        throw new Error("Remote Claude Reader host identity does not match the live binding");
      }
      const requestSessionId = requestObject?.sessionId;
      if (requestSessionId !== undefined && requestSessionId !== binding.sessionId) {
        throw new Error("Remote Claude Reader session identity does not match the live binding");
      }
      const requestGeneration = requestObject?.generation;
      if (requestGeneration !== undefined && requestGeneration !== binding.generation) {
        throw new Error("Remote Claude Reader host generation is stale");
      }
      if (binding.parentSessionId !== undefined) {
        const parent = this.bindings.get(binding.parentSessionId);
        if (!parent || parent === binding || this.byHost.get(parent.hostIdentity) !== parent
          || this.byManager.get(parent.sessionManager) !== parent
          || (binding.parentBinding !== undefined && binding.parentBinding !== parent)
          || (binding.parentGeneration !== undefined && binding.parentGeneration !== parent.generation)) {
          throw new Error("Remote Claude Reader parent binding is no longer current");
        }
        try { parent.contract.assertRemoteHostOperation(parent.scope, "side-ask"); }
        catch { throw new Error("Remote Claude Reader parent binding is no longer live"); }
      }
      binding.contract.assertRemoteHostOperation(binding.scope, operation, request);
    },
    associateProviderSession(input) { return associateProviderSession(this, input); },
    resolveProviderSession(providerSessionId) { return resolveProviderSession(this, providerSessionId); },
  };
  root[REMOTE_CLAUDE_HOST_BRIDGE_KEY] = created;
  return created;
}

async function loadRemoteHostContract(agentDir: string): Promise<RemoteHostContract> {
  const resolvedAgentDir = realpathSync(agentDir);
  const packageRoot = realpathSync(join(resolvedAgentDir, "packages", REMOTE_PACKAGE_NAME));
  const contractPath = realpathSync(join(packageRoot, "lib", "host-contract.mjs"));
  if (!contractPath.startsWith(`${packageRoot}${sep}`)) throw new Error("Remote Claude host contract escaped its package root");
  let pending = contractCache.get(contractPath);
  if (!pending) {
    pending = import(pathToFileURL(contractPath).href).then((module) => module as RemoteHostContract);
    contractCache.set(contractPath, pending);
  }
  return pending;
}

function finitePositive(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && value! >= 1 ? Math.min(value!, maximum) : fallback;
}

function normalizedTools(activeTools: readonly string[]): string[] {
  return [...new Set(activeTools.filter((name): name is string => typeof name === "string" && name.length > 0))];
}

function sameToolSet(left: readonly string[], right: readonly string[]): boolean {
  const a = new Set(left);
  const b = new Set(right);
  return a.size === b.size && [...a].every((name) => b.has(name));
}

function modelNames(runtime: InstallRemoteClaudeHostOptions["modelRuntime"]): string[] {
  try {
    const models = runtime?.getModels?.() ?? [];
    return [...new Set(models.flatMap((model) => [
      `${model.provider}/${model.id}`,
      model.id,
    ]))];
  } catch {
    return [];
  }
}

function trustedPolicy(options: InstallRemoteClaudeHostOptions, activeTools: readonly string[]): RemoteHostPolicy {
  const active = normalizedTools(activeTools);
  const controlsActive = REMOTE_CONTROL_TOOLS.every((tool) => active.includes(tool));
  const ordinary = active.filter((tool): tool is typeof ORDINARY_TOOLS[number] =>
    (ORDINARY_TOOLS as readonly string[]).includes(tool) && tool !== "bash",
  );
  const ordinarySet = new Set<string>(ordinary);
  const allowedProfiles = [...new Set((options.allowedProfiles ?? [...BUILTIN_PROFILES]).filter((name) => BUILTIN_PROFILES.has(name)))];
  const allowedModels = [...new Set(options.allowedModels ?? modelNames(options.modelRuntime))];
  const policy: RemoteHostPolicy = {
    orchestration: {
      enabled: options.builtInEnabled && controlsActive && allowedModels.length > 0,
      allowedProfiles,
      allowedModels,
      childTools: [...new Set((options.childTools ?? ordinary).filter((tool) => ordinarySet.has(tool)))],
      maxConcurrent: finitePositive(options.maxConcurrent, DEFAULT_MAX_CONCURRENT, 32),
      maxTurns: finitePositive(options.maxTurns, DEFAULT_MAX_TURNS, 1024),
      maxInputFiles: MAX_INPUT_FILES,
      maxInputBytes: MAX_INPUT_BYTES,
      allowWorktree: options.allowWorktree === true,
      allowInheritedContext: options.allowInheritedContext === true,
      allowCancellation: options.allowCancellation !== false,
    },
    ordinary: {
      allowedTools: ordinary,
      readOnlyRoots: [...new Set((options.readOnlyRoots ?? []).filter((root) => typeof root === "string" && root.startsWith("/")))],
      bash: "disabled",
      policyDigest: "",
    },
  };
  return policy;
}

function unindexBinding(root: RemoteClaudeHostRegistry, binding: RemoteClaudeHostBinding): void {
  if (root.bindings.get(binding.sessionId) === binding) root.bindings.delete(binding.sessionId);
  if (root.byHost.get(binding.hostIdentity) === binding) root.byHost.delete(binding.hostIdentity);
  if (root.byManager.get(binding.sessionManager) === binding) root.byManager.delete(binding.sessionManager);
}

function revokeBinding(root: RemoteClaudeHostRegistry, binding: RemoteClaudeHostBinding): void {
  dropProviderAssociationsForBinding(root, binding);
  unindexBinding(root, binding);
  try { binding.contract.revokeRemoteHostScope(binding.scope); } catch { /* already revoked */ }
}

function installInRegistry(binding: RemoteClaudeHostBinding): RemoteClaudeHostBinding {
  const root = registry();
  root.bindings.set(binding.sessionId, binding);
  root.byHost.set(binding.hostIdentity, binding);
  root.byManager.set(binding.sessionManager, binding);
  root.generationBySession.set(binding.sessionId, binding.generation);
  return binding;
}

export async function installRemoteClaudeHost(options: InstallRemoteClaudeHostOptions): Promise<RemoteClaudeHostBinding | null> {
  if (!options.hostIdentity || typeof options.hostIdentity !== "object") return null;
  if (!options.sessionManager || typeof options.sessionManager !== "object") return null;
  if (!options.sessionId || !options.cwd.startsWith("/")) return null;
  const agentDir = options.agentDir ?? getAgentDir();
  let contract: RemoteHostContract;
  try {
    contract = await loadRemoteHostContract(agentDir);
  } catch {
    return null;
  }
  const root = registry();
  const existing = [
    root.bindings.get(options.sessionId),
    root.byHost.get(options.hostIdentity),
    root.byManager.get(options.sessionManager),
  ].filter((binding, index, all): binding is RemoteClaudeHostBinding => Boolean(binding) && all.indexOf(binding) === index);
  if (existing.length === 1 && !options.replace
    && existing[0].sessionId === options.sessionId
    && existing[0].hostIdentity === options.hostIdentity
    && existing[0].sessionManager === options.sessionManager) return existing[0];
  if (options.parent) {
    const parent = root.bindings.get(options.parent.sessionId);
    if (parent !== options.parent
      || root.byHost.get(options.parent.hostIdentity) !== options.parent
      || root.byManager.get(options.parent.sessionManager) !== options.parent) return null;
  }
  const activeTools = normalizedTools(options.activeTools);
  const policy = trustedPolicy(options, activeTools);
  policy.ordinary.policyDigest = contract.policyDigest(policy);
  let cwd: string;
  let canonicalAgentDir: string;
  try {
    cwd = realpathSync(options.cwd);
    canonicalAgentDir = realpathSync(agentDir);
  } catch {
    return null;
  }
  const input = {
    hostIdentity: options.hostIdentity,
    sessionId: options.sessionId,
    cwd,
    agentDir: canonicalAgentDir,
    activeTools,
    policy,
  } satisfies Record<string, unknown>;
  let scope: unknown;
  try {
    scope = options.parent
      ? contract.deriveRemoteHostScope(options.parent.scope, input)
      : contract.bindRemoteHostScope(input);
  } catch {
    return null;
  }
  for (const stale of existing) revokeBinding(root, stale);
  const readerMarker = Object.freeze(Object.create(null)) as object;
  try {
    contract.registerReaderHostMarker(scope, readerMarker);
  } catch {
    try { contract.revokeRemoteHostScope(scope); } catch { /* preserve the original setup failure */ }
    return null;
  }
  const previousGeneration = Math.max(
    root.generationBySession.get(options.sessionId) ?? 0,
    ...existing.map((binding) => binding.generation),
  );
  const generation = Math.max(previousGeneration + 1, (options.parent?.generation ?? 0) + 1, 1);
  const binding: RemoteClaudeHostBinding = {
    sessionId: options.sessionId,
    hostIdentity: options.hostIdentity,
    sessionManager: options.sessionManager,
    cwd: input.cwd as string,
    agentDir: input.agentDir as string,
    activeTools,
    ...(options.parent ? {
      parentSessionId: options.parent.sessionId,
      parentBinding: options.parent,
      parentGeneration: options.parent.generation,
    } : {}),
    scope,
    readerMarker,
    policy,
    generation,
    contractVersion: 1,
    builtInEnabled: options.builtInEnabled,
    contract,
  };
  try {
    return installInRegistry(binding);
  } catch {
    try { contract.revokeRemoteHostScope(scope); } catch { /* preserve the original setup failure */ }
    return null;
  }
}

export function resolveRemoteClaudeHost(sessionId: string): RemoteClaudeHostBinding | undefined {
  return registry().resolve(sessionId);
}

export function resolveRemoteClaudeHostByIdentity(hostIdentity: object): RemoteClaudeHostBinding | undefined {
  return registry().resolveByHost(hostIdentity);
}

export function resolveRemoteClaudeHostByManager(sessionManager: object): RemoteClaudeHostBinding | undefined {
  return registry().resolveByManager(sessionManager);
}

export function assertRemoteClaudeHost(binding: RemoteClaudeHostBinding, operation: string, request: Record<string, unknown> = {}): void {
  registry().assert(binding, operation, request);
}

/** Associate a provider alias with the exact live Reader host for one request. */
export function associateRemoteClaudeProviderSession(
  input: RemoteClaudeProviderAssociationInput,
): RemoteClaudeProviderAssociationLease {
  return registry().associateProviderSession(input);
}

/** Resolve and revalidate a provider alias before the plugin performs a turn. */
export function resolveRemoteClaudeProviderSession(
  providerSessionId: string,
): RemoteClaudeProviderAssociation | undefined {
  return registry().resolveProviderSession(providerSessionId);
}

export function revokeRemoteClaudeHost(binding: RemoteClaudeHostBinding | undefined): void {
  if (!binding) return;
  const root = registry();
  if (root.bindings.get(binding.sessionId) !== binding
    || root.byHost.get(binding.hostIdentity) !== binding
    || root.byManager.get(binding.sessionManager) !== binding) return;
  revokeBinding(root, binding);
}

export async function refreshRemoteClaudeHost(
  binding: RemoteClaudeHostBinding | undefined,
  options: { activeTools: readonly string[]; modelRuntime?: InstallRemoteClaudeHostOptions["modelRuntime"] },
): Promise<RemoteClaudeHostBinding | null> {
  if (!binding) return null;
  const root = registry();
  if (root.bindings.get(binding.sessionId) !== binding
    || root.byHost.get(binding.hostIdentity) !== binding
    || root.byManager.get(binding.sessionManager) !== binding) return null;
  const activeTools = normalizedTools(options.activeTools);
  // Do not rotate an otherwise identical live scope on every prompt. Rotating
  // would revoke child lineage between continuous turns; only a real active-set
  // change requires a new generation.
  if (sameToolSet(binding.activeTools, activeTools)) return binding;
  const parent = binding.parentSessionId ? root.bindings.get(binding.parentSessionId) : undefined;
  if (binding.parentSessionId && !parent) return null;
  return installRemoteClaudeHost({
    hostIdentity: binding.hostIdentity,
    sessionManager: binding.sessionManager,
    sessionId: binding.sessionId,
    cwd: binding.cwd,
    agentDir: binding.agentDir,
    activeTools,
    modelRuntime: options.modelRuntime,
    builtInEnabled: binding.builtInEnabled,
    ...(parent ? { parent } : {}),
    maxConcurrent: binding.policy.orchestration.maxConcurrent,
    maxTurns: binding.policy.orchestration.maxTurns,
    allowWorktree: binding.policy.orchestration.allowWorktree,
    allowInheritedContext: binding.policy.orchestration.allowInheritedContext,
    allowCancellation: binding.policy.orchestration.allowCancellation,
    readOnlyRoots: binding.policy.ordinary.readOnlyRoots,
    allowedProfiles: binding.policy.orchestration.allowedProfiles,
    allowedModels: binding.policy.orchestration.allowedModels,
    childTools: binding.policy.orchestration.childTools,
    replace: true,
  });
}

/**
 * Child sessions use this guard even when their profile disables normal extension
 * loading. It is deliberately inert for ordinary local sessions without a live
 * Reader remote binding and never owns/revokes the binding.
 */
export function createRemoteClaudeHostGuardExtension(): InlineExtension {
  return {
    name: "pi-web-remote-claude-host-guard",
    hidden: true,
    factory: (pi) => {
      pi.on("tool_call", (event, context) => {
        const manager = (context as unknown as { sessionManager?: object } | undefined)?.sessionManager;
        if (!manager) return;
        const binding = resolveRemoteClaudeHostByManager(manager);
        if (!binding) return;
        const provider = (context as unknown as { model?: { provider?: unknown } } | undefined)?.model?.provider;
        // Root bindings are installed for ordinary Reader sessions as well. Keep
        // the remote policy inert until the actual model is claude-remote; a
        // child binding remains guarded through its explicit remote lineage.
        if (provider !== REMOTE_CLAUDE_PROVIDER_ID && binding.parentSessionId === undefined) return;
        const toolName = (event as unknown as { toolName?: unknown }).toolName;
        if (typeof toolName !== "string") return;
        const operation = toolName === "Agent"
          ? "start-child"
          : toolName === "get_subagent_result"
            ? "get-result"
            : toolName === "steer_subagent"
              ? "steer-child"
              : "ordinary-tool";
        try {
          assertRemoteClaudeHost(binding, operation, {
            sessionManager: manager,
            hostIdentity: binding.hostIdentity,
            sessionId: binding.sessionId,
            generation: binding.generation,
            toolName,
            ...(operation !== "ordinary-tool" ? { readerMarker: binding.readerMarker, parentSessionId: binding.sessionId } : {}),
          });
        } catch (error) {
          return { block: true, reason: error instanceof Error ? error.message : "Remote Reader host policy denied tool execution" };
        }
      });
    },
  };
}

export function remoteClaudeHostBridge(): RemoteClaudeHostBridge {
  return registry();
}

export function remoteClaudeControlTools(): readonly string[] {
  return REMOTE_CONTROL_TOOLS;
}
