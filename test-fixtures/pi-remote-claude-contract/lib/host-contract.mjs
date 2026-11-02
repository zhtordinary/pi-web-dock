import { createHash } from "node:crypto";

export const REMOTE_HOST_CONTRACT_VERSION = 1;
// Same-process only: the Reader producer installs this exact registry on
// globalThis. The symbol itself is not an authority; consumers must validate
// the live binding, manager object, contract module and opaque scope below.
export const READER_HOST_BRIDGE_SYMBOL = Symbol.for("pi-remote-claude.reader-host-bridge.v1");
export const REMOTE_CONTROL_TOOL_NAMES = Object.freeze([
  "Agent", "get_subagent_result", "steer_subagent",
]);
export const REMOTE_HOST_ERROR_CODES = Object.freeze([
  "scope-missing", "scope-revoked", "scope-mismatch",
  "capability-unavailable", "policy-denied", "profile-denied",
  "model-denied", "tool-denied", "cwd-denied", "input-path-denied",
  "bash-unsupported", "invalid-request", "parent-not-owner",
  "task-not-found", "task-running", "cancelled", "task-failed",
  "model-unavailable", "unsupported", "idle-timeout",
  "handshake-timeout", "disconnected", "incompatible-version",
  "unknown-side-effect", "recovery-blocked",
]);

const CONTROL_SET = new Set(REMOTE_CONTROL_TOOL_NAMES);
const ORDINARY_SET = new Set(["read", "write", "edit", "grep", "find", "ls", "bash"]);
const scopes = new WeakMap();
const readerMarkers = new WeakMap();
const opaqueObjects = new WeakSet();

function bridgeMethod(value, name) {
  return value && typeof value[name] === "function" ? value[name].bind(value) : undefined;
}

/**
 * Return the Reader's same-process registry, or undefined for an ordinary Pi
 * session. A present but malformed bridge is a hard failure rather than a
 * reason to trust request fields or a stale local binding.
 */
export function readerHostBridge() {
  const bridge = globalThis[READER_HOST_BRIDGE_SYMBOL];
  if (bridge === undefined) return undefined;
  if (!isObject(bridge) || bridge.version !== 1 ||
      !bridgeMethod(bridge, "resolve") || !bridgeMethod(bridge, "resolveByHost") ||
      !bridgeMethod(bridge, "assert")) {
    throw error("scope-mismatch", "Reader host bridge is malformed or unsupported");
  }
  return bridge;
}

function bindingManager(binding) {
  return binding?.sessionManager ?? binding?.manager ?? binding?.liveSessionManager;
}

function sameStrings(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  const a = [...new Set(left)].sort();
  const b = [...new Set(right)].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Resolve and validate a live Reader binding for the actual AgentSession.
 * Missing session entries return undefined so ordinary non-Reader Pi sessions
 * retain their normal provider path. Once an entry exists, every identity and
 * module boundary is checked before a consumer may use its scope.
 */
export function resolveReaderHostBinding(bridge, expected) {
  if (!bridge || !isObject(expected) || typeof expected.sessionId !== "string" || !expected.sessionId) {
    throw error("scope-mismatch", "a live Reader session and bridge are required");
  }
  const binding = bridge.resolve(expected.sessionId);
  if (binding === undefined) return undefined;
  if (!isObject(binding) || binding.sessionId !== expected.sessionId ||
      !isObject(binding.hostIdentity) || !isObject(binding.scope) || !isObject(binding.readerMarker) ||
      !isObject(binding.contract) || !Number.isSafeInteger(binding.generation) || binding.generation < 1 ||
      !Array.isArray(binding.activeTools) || !binding.activeTools.every(tool => typeof tool === "string")) {
    throw error("scope-mismatch", "Reader host binding is malformed");
  }
  if (bridge.resolveByHost(binding.hostIdentity) !== binding) {
    throw error("scope-mismatch", "Reader host binding is not the current host entry");
  }
  const manager = bindingManager(binding);
  if (!manager || manager !== expected.sessionManager) {
    throw error("scope-mismatch", "Reader host binding is not associated with the live SessionManager");
  }
  if (typeof manager.getSessionId !== "function" || manager.getSessionId() !== binding.sessionId) {
    throw error("scope-mismatch", "Reader SessionManager does not identify the bound session");
  }
  if (typeof binding.cwd !== "string" || !binding.cwd.startsWith("/") ||
      typeof binding.agentDir !== "string" || !binding.agentDir.startsWith("/")) {
    throw error("cwd-denied", "Reader host binding paths are invalid");
  }
  if (expected.cwd !== undefined && expected.cwd !== binding.cwd) {
    throw error("cwd-denied", "Reader host binding cwd does not match the live session");
  }
  if (expected.agentDir !== undefined && expected.agentDir !== binding.agentDir) {
    throw error("cwd-denied", "Reader host binding agentDir does not match the live session");
  }
  // The producer must have loaded this package's canonical contract module.
  // A duplicate module instance would make opaque scopes unverifiable.
  if (binding.contract.REMOTE_HOST_CONTRACT_VERSION !== REMOTE_HOST_CONTRACT_VERSION ||
      binding.contract.bindRemoteHostScope !== bindRemoteHostScope ||
      binding.contract.scopeSnapshot !== scopeSnapshot ||
      binding.contract.assertRemoteHostOperation !== assertRemoteHostOperation) {
    throw error("incompatible-version", "Reader host contract module instance is not canonical");
  }
  const snapshot = scopeSnapshot(binding.scope);
  if (snapshot.sessionId !== binding.sessionId || snapshot.cwd !== binding.cwd ||
      snapshot.agentDir !== binding.agentDir || !sameStrings(snapshot.activeTools, binding.activeTools) ||
      scopeHostIdentity(binding.scope) !== binding.hostIdentity ||
      !isTrustedReaderHostMarker(binding.scope, binding.readerMarker)) {
    throw error("scope-mismatch", "Reader scope is not the current binding scope");
  }
  try {
    if (policyDigest(binding.policy) !== policyDigest(scopePolicy(binding.scope))) {
      throw error("policy-denied", "Reader binding policy is not the live scope policy");
    }
  } catch (cause) {
    if (cause instanceof RemoteHostError) throw cause;
    throw error("scope-mismatch", "Reader binding policy is malformed");
  }
  const parentSessionId = snapshot.parentSessionId;
  if (binding.parentSessionId !== parentSessionId) {
    throw error("scope-mismatch", "Reader parent lineage does not match the live scope");
  }
  if (parentSessionId !== undefined) {
    const parent = bridge.resolve(parentSessionId);
    if (!parent || parent === binding || (binding.parentBinding !== undefined && binding.parentBinding !== parent) ||
        (binding.parentGeneration !== undefined && binding.parentGeneration !== parent.generation)) {
      throw error("scope-revoked", "Reader parent binding is no longer current");
    }
    try { scopeSnapshot(parent.scope); } catch { throw error("scope-revoked", "Reader parent scope is revoked"); }
  }
  return binding;
}

/** Assert current registry ownership and then the package's opaque scope rule. */
export function assertReaderHostBinding(bridge, binding, operation, request = undefined) {
  if (!bridge || !binding) throw error("scope-missing", "Reader host binding is unavailable");
  if (typeof operation !== "string" || !operation) throw error("invalid-request", "Reader host operation is required");
  bridge.assert(binding, operation, request);
  return binding;
}

export class RemoteHostError extends Error {
  constructor(code, message = code, details = undefined) {
    super(message);
    this.name = "RemoteHostError";
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

function error(code, message, details) {
  return new RemoteHostError(code, message, details);
}

function isObject(value) {
  return value !== null && (typeof value === "object" || typeof value === "function");
}

function opaqueObject(label) {
  const value = Object.create(null);
  Object.defineProperty(value, "toJSON", {
    value() { throw new TypeError(`${label} is not serializable`); },
    enumerable: false,
    configurable: false,
  });
  Object.freeze(value);
  opaqueObjects.add(value);
  return value;
}

function positiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw error("invalid-request", `${name} must be a finite positive integer`);
  }
  return value;
}

function list(value, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) ||
      !value.every(item => typeof item === "string" && item.length > 0)) {
    throw error("invalid-request", `${name} must be an array of non-empty strings`);
  }
  return Object.freeze([...new Set(value)]);
}

function normalizePolicy(policy) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw error("invalid-request", "remote host policy is required");
  }
  const orchestration = policy.orchestration ?? {};
  const ordinary = policy.ordinary ?? {};
  if (!orchestration || typeof orchestration !== "object" || Array.isArray(orchestration) ||
      !ordinary || typeof ordinary !== "object" || Array.isArray(ordinary)) {
    throw error("invalid-request", "remote host policy sections must be objects");
  }
  if (typeof orchestration.enabled !== "boolean") {
    throw error("invalid-request", "orchestration.enabled must be boolean");
  }
  const result = {
    orchestration: Object.freeze({
      enabled: orchestration.enabled,
      allowedProfiles: list(orchestration.allowedProfiles ?? [], "orchestration.allowedProfiles"),
      allowedModels: list(orchestration.allowedModels ?? [], "orchestration.allowedModels"),
      childTools: list(orchestration.childTools ?? [], "orchestration.childTools"),
      maxConcurrent: positiveInteger(orchestration.maxConcurrent, "orchestration.maxConcurrent"),
      maxTurns: positiveInteger(orchestration.maxTurns, "orchestration.maxTurns"),
      maxInputFiles: positiveInteger(orchestration.maxInputFiles ?? 8, "orchestration.maxInputFiles"),
      maxInputBytes: positiveInteger(orchestration.maxInputBytes ?? 512 * 1024, "orchestration.maxInputBytes"),
      allowWorktree: Boolean(orchestration.allowWorktree),
      allowInheritedContext: Boolean(orchestration.allowInheritedContext),
      allowCancellation: Boolean(orchestration.allowCancellation),
    }),
    ordinary: Object.freeze({
      allowedTools: list(ordinary.allowedTools ?? [], "ordinary.allowedTools"),
      readOnlyRoots: list(ordinary.readOnlyRoots ?? [], "ordinary.readOnlyRoots"),
      bash: ordinary.bash === "protected" ? "protected" : "disabled",
      policyDigest: typeof ordinary.policyDigest === "string" ? ordinary.policyDigest : "",
    }),
  };
  if (result.orchestration.childTools.some(tool => !ORDINARY_SET.has(tool))) {
    throw error("invalid-request", "orchestration.childTools contains an unsupported tool");
  }
  if (result.ordinary.allowedTools.some(tool => !ORDINARY_SET.has(tool))) {
    throw error("invalid-request", "ordinary.allowedTools contains an unsupported tool");
  }
  return result;
}

function validateScopeInput(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw error("invalid-request", "remote host scope input is required");
  }
  if (!isObject(input.hostIdentity)) throw error("scope-missing", "a live host identity is required");
  if (typeof input.sessionId !== "string" || input.sessionId.length < 1 || input.sessionId.length > 4096) {
    throw error("invalid-request", "scope sessionId is invalid");
  }
  if (typeof input.cwd !== "string" || typeof input.agentDir !== "string" ||
      !input.cwd.startsWith("/") || !input.agentDir.startsWith("/")) {
    throw error("cwd-denied", "scope cwd and agentDir must be absolute trusted paths");
  }
  if (!Array.isArray(input.activeTools) || !input.activeTools.every(tool => typeof tool === "string")) {
    throw error("invalid-request", "scope activeTools must be an array");
  }
  return {
    hostIdentity: input.hostIdentity,
    sessionId: input.sessionId,
    cwd: input.cwd,
    agentDir: input.agentDir,
    activeTools: Object.freeze([...new Set(input.activeTools)]),
    policy: normalizePolicy(input.policy),
    parent: input.parent,
  };
}

function verifyParent(parent, input) {
  if (parent === undefined) return;
  const parentMeta = scopes.get(parent);
  if (!parentMeta || parentMeta.revoked) throw error("scope-revoked", "parent remote host scope is revoked");
  // A child is a separate live AgentSession/host object.  Parent lineage is
  // the authority; equal host identities are neither required nor sufficient.
  if (!isObject(input.hostIdentity) || input.hostIdentity === parentMeta.hostIdentity) {
    throw error("scope-mismatch", "child scope requires an independent live host identity");
  }
  const parentPolicy = parentMeta.policy;
  if (!input.activeTools.every(tool => parentMeta.activeTools.includes(tool))) {
    throw error("capability-unavailable", "child active tools exceed the parent active set");
  }
  const child = input.policy;
  if (child.orchestration.enabled && !parentPolicy.orchestration.enabled) {
    throw error("capability-unavailable", "child orchestration exceeds parent capability");
  }
  const subset = (values, ceiling) => values.every(value => ceiling.includes(value));
  if (!subset(child.orchestration.allowedProfiles, parentPolicy.orchestration.allowedProfiles) ||
      !subset(child.orchestration.allowedModels, parentPolicy.orchestration.allowedModels) ||
      !subset(child.orchestration.childTools, parentPolicy.orchestration.childTools) ||
      !subset(child.ordinary.allowedTools, parentPolicy.ordinary.allowedTools) ||
      child.orchestration.maxConcurrent > parentPolicy.orchestration.maxConcurrent ||
      child.orchestration.maxTurns > parentPolicy.orchestration.maxTurns ||
      child.orchestration.maxInputFiles > parentPolicy.orchestration.maxInputFiles ||
      child.orchestration.maxInputBytes > parentPolicy.orchestration.maxInputBytes ||
      (child.ordinary.bash === "protected" && parentPolicy.ordinary.bash !== "protected") ||
      (child.orchestration.allowWorktree && !parentPolicy.orchestration.allowWorktree) ||
      (child.orchestration.allowInheritedContext && !parentPolicy.orchestration.allowInheritedContext) ||
      (child.orchestration.allowCancellation && !parentPolicy.orchestration.allowCancellation)) {
    throw error("policy-denied", "child scope exceeds its parent capability ceiling");
  }
}

export function bindRemoteHostScope(input) {
  const normalized = validateScopeInput(input);
  verifyParent(normalized.parent, normalized);
  const scope = opaqueObject("RemoteHostScope");
  scopes.set(scope, { ...normalized, revoked: false });
  return scope;
}

export function deriveRemoteHostScope(parent, input) {
  if (!scopes.has(parent)) throw error("scope-missing", "parent remote host scope is missing");
  return bindRemoteHostScope({ ...input, parent });
}

export function scopeSnapshot(scope) {
  const meta = metadata(scope);
  return Object.freeze({
    sessionId: meta.sessionId,
    cwd: meta.cwd,
    agentDir: meta.agentDir,
    activeTools: [...meta.activeTools],
    orchestrationEnabled: meta.policy.orchestration.enabled,
    policyDigest: meta.policy.ordinary.policyDigest,
    parentSessionId: meta.parent ? scopes.get(meta.parent)?.sessionId : undefined,
  });
}

/**
 * Register an opaque marker installed by the trusted Reader host adapter.
 * Ordinary extensions do not receive a marker from this package and therefore
 * cannot unlock the model-only control projection.  The marker itself is not
 * serializable and is never accepted from a wire/request snapshot.
 */
export function registerReaderHostMarker(scope, marker) {
  const meta = metadata(scope);
  if (!isObject(marker)) throw error("scope-missing", "a live Reader host marker is required");
  readerMarkers.set(marker, meta.hostIdentity);
  return marker;
}

export function isTrustedReaderHostMarker(scope, marker) {
  const meta = scopes.get(scope);
  return Boolean(meta && !meta.revoked && readerMarkers.get(marker) === meta.hostIdentity);
}

function metadata(scope) {
  const meta = scopes.get(scope);
  if (!meta) throw error("scope-missing", "remote host scope is missing");
  if (meta.revoked) throw error("scope-revoked", "remote host scope has been revoked");
  return meta;
}

function requestHasMarker(meta, request) {
  return readerMarkers.get(request?.readerMarker) === meta.hostIdentity;
}

export function assertRemoteHostOperation(scope, operation, request = undefined) {
  const meta = metadata(scope);
  if (!["declare-control-tool", "ordinary-tool", "start-child", "get-result", "steer-child", "resume-child", "abort-child", "side-ask"].includes(operation)) {
    throw error("invalid-request", "unknown remote host operation");
  }
  if (operation === "ordinary-tool") {
    const name = request?.toolName ?? request?.name;
    if (typeof name !== "string" || !ORDINARY_SET.has(name) || !meta.policy.ordinary.allowedTools.includes(name) ||
        !meta.activeTools.includes(name)) {
      throw error("tool-denied", "ordinary tool is not active in this trusted scope");
    }
    if (name === "bash" && meta.policy.ordinary.bash !== "protected") {
      throw error("bash-unsupported", "Bash has no trusted no-write execution adapter");
    }
    return;
  }
  if (operation === "side-ask") return;
  if (!meta.policy.orchestration.enabled) throw error("capability-unavailable", "Reader orchestration is not enabled");
  if (!requestHasMarker(meta, request)) throw error("scope-mismatch", "trusted Reader host marker is required");
  const controlName = request?.toolName;
  if (operation === "declare-control-tool" || controlName !== undefined) {
    if (!CONTROL_SET.has(controlName) || !meta.activeTools.includes(controlName)) {
      throw error("capability-unavailable", "Reader control tool is not active in this scope");
    }
  }
  if (request?.parentSessionId !== undefined && request.parentSessionId !== meta.sessionId) {
    throw error("parent-not-owner", "operation does not belong to the current parent session");
  }
}

export function projectRemoteTools(scope, tools, readerMarker = undefined) {
  const meta = metadata(scope);
  if (!Array.isArray(tools)) throw error("invalid-request", "tool projection requires an array");
  const projected = [];
  for (const tool of tools) {
    if (!tool || typeof tool.name !== "string") continue;
    if (ORDINARY_SET.has(tool.name)) {
      if (meta.policy.ordinary.allowedTools.includes(tool.name) && meta.activeTools.includes(tool.name)) projected.push(tool);
      continue;
    }
    if (CONTROL_SET.has(tool.name) && meta.policy.orchestration.enabled && meta.activeTools.includes(tool.name) &&
        (readerMarker === undefined ? false : readerMarkers.get(readerMarker) === meta.hostIdentity)) {
      projected.push(tool);
    }
  }
  return projected;
}

export function revokeRemoteHostScope(scope) {
  const meta = scopes.get(scope);
  if (!meta) return;
  meta.revoked = true;
}

export function scopePolicy(scope) {
  const meta = metadata(scope);
  return meta.policy;
}

export function scopeActiveTools(scope) {
  return [...metadata(scope).activeTools];
}

export function scopeHostIdentity(scope) {
  return metadata(scope).hostIdentity;
}

export function policyDigest(policy) {
  const normalized = normalizePolicy(policy);
  return createHash("sha256").update(JSON.stringify({
    orchestration: normalized.orchestration,
    ordinary: normalized.ordinary,
  })).digest("hex");
}

export { normalizePolicy };
