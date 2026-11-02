import { validateSessionMutationCommand, isSessionMutationReceipt, unknownSessionMutation, type SessionMutationAction, type SessionMutationCommand, type SessionMutationReceipt } from "./session-mutation-command";
import { isSessionMutationBridgeAuthenticationRequired, openSessionMutationBridge, type SessionMutationChannel } from "./session-mutation-bridge";

type Transport = SessionMutationChannel["request"];
import { SESSION_MUTATION_PROTOCOL, type SessionMutationIdentity, type SessionMutationRecoveryPage } from "./session-mutation-recovery";
export type MutationTarget = { id: string; url: string; name?: string };
export type RemoteMutationResult = SessionMutationReceipt & { notSent?: boolean; notSentReason?: "upgrade" | "unavailable" | "recoveryUnavailable" | "storageUnavailable" | "authenticationRequired"; authenticationRequired?: boolean; upgradeRequired?: boolean; previousOperation?: boolean; refreshUnavailable?: boolean };
export type PendingSessionMutation = { target: MutationTarget; command: SessionMutationCommand;
  receipt: SessionMutationReceipt; busy?: boolean; confirmed?: boolean; actionKnown?: boolean };
const STORAGE_KEY = "pi-web.pending-session-mutations.v2";
const LEGACY_KEY = "pi-web.pending-session-mutations.v1";
const settled = (receipt: SessionMutationReceipt) => ["completed", "failed", "conflict"].includes(receipt.status);
// Transport availability is not a business outcome. Once observed, a terminal
// receipt cannot be replaced by an offline/missing/stale read of the same ID.
const retainTerminalReceipt = (previous: SessionMutationReceipt | undefined, next: SessionMutationReceipt) =>
  previous && settled(previous) ? previous : next;

export async function reconcileSessionMutation(command: SessionMutationCommand, dependencies: {
  proxy: Transport; openBridge: () => Promise<SessionMutationChannel>; resume: boolean; continueOriginal?: boolean;
  now?: () => number; sleep?: (ms: number) => Promise<void>; observationMs?: number;
}): Promise<RemoteMutationResult> {
  const now = dependencies.now ?? Date.now;
  const sleep = dependencies.sleep ?? ((ms) => new Promise(resolve => setTimeout(resolve, ms)));
  const deadline = now() + (dependencies.observationMs ?? 15_000);
  let bridge: SessionMutationChannel | undefined;
  let transport = dependencies.proxy;
  const request = async (mode: "query" | "execute") => {
    try { return await transport(mode, command); } catch { return unknownSessionMutation(command); }
  };
  try {
    let result = await request(dependencies.resume ? "query" : "execute");
    if (result.status === "unknown") {
      try { bridge = await dependencies.openBridge(); transport = bridge.request; }
      catch (error) { return isSessionMutationBridgeAuthenticationRequired(error) ? { ...result, authenticationRequired: true } : result; }
      // The first POST may still be executing. Observe its original receipt.
      result = await request("query");
    }
    // Absence is an observation, not permission to retry. Only the explicit
    // continuation action can submit the saved command again. Atomic admission
    // of the SAME ID also covers an original request arriving after this read.
    if (result.status === "not_found" && dependencies.resume && dependencies.continueOriginal) result = await request("execute");
    while (["accepted", "running"].includes(result.status) && now() < deadline) {
      await sleep(Math.min(500, Math.max(0, deadline - now())));
      result = await request("query");
      if (result.status === "not_found") return unknownSessionMutation(command);
    }
    return ["accepted", "running"].includes(result.status) ? unknownSessionMutation(command) : result;
  } finally { bridge?.close(); }
}

type Capability = "supported" | "upgrade_required" | "unavailable" | "authentication_required";
export function createRemoteSessionMutationClient(options: {
  storage?: Pick<Storage, "getItem" | "setItem">;
  legacyStorage?: Pick<Storage, "getItem" | "setItem">;
  uuid?: () => string;
  proxy?: Transport;
  capability?: (target: MutationTarget) => Promise<Capability>;
  discovery?: (target: MutationTarget, after?: string) => Promise<SessionMutationRecoveryPage>;
  acknowledge?: (target: MutationTarget, identity: SessionMutationIdentity, reviewedUnknown: boolean) => Promise<boolean>;
  openBridge?: (deviceId: string, origin: string) => Promise<SessionMutationChannel>;
} = {}) {
  const pending = new Map<string, PendingSessionMutation>();
  const inFlight = new Map<string, Promise<RemoteMutationResult>>();
  const sessions = new Map<string, Promise<RemoteMutationResult>>();
  const listeners = new Set<() => void>();
  const storage = options.storage;
  const keyOf = (command: SessionMutationIdentity) => `${command.deviceId}\0${command.operationId}`;
  const targetOf = (value: MutationTarget): MutationTarget => {
    const url = new URL(value.url);
    if (!["http:", "https:"].includes(url.protocol) || !value.id) throw new Error("Invalid remote target");
    return { id: value.id, url: url.origin, ...(value.name ? { name: value.name } : {}) };
  };
  const save = () => {
    let persisted = false;
    try {
      if (storage) {
        storage.setItem(STORAGE_KEY, JSON.stringify([...pending.values()].map(({ busy: _busy, ...item }) => { void _busy; return item; })));
        persisted = true;
        storage.setItem(LEGACY_KEY, "[]");
        options.legacyStorage?.setItem(LEGACY_KEY, "[]");
      }
    } catch { /* Server discovery is authoritative if browser storage is full/unavailable. */ }
    for (const listener of listeners) listener();
    return persisted;
  };
  const remember = (target: MutationTarget, command: SessionMutationCommand, receipt = unknownSessionMutation(command)) => {
    const key = keyOf(command);
    const existing = pending.get(key);
    const retained = retainTerminalReceipt(existing?.receipt, receipt);
    if (existing) Object.assign(existing, { target: targetOf(target), command, receipt: retained, confirmed: settled(retained) });
    else pending.set(key, { target: targetOf(target), command, receipt: retained, confirmed: settled(retained) });
  };
  // v2 survives tab closure; v1 remains readable during an upgrade. Invalid
  // browser data is never treated as authority to execute another operation.
  try {
    const raw = storage?.getItem(STORAGE_KEY);
    if (raw) for (const item of JSON.parse(raw)) {
      const command = validateSessionMutationCommand(item.command);
      if (item.target?.id !== command.deviceId || !isSessionMutationReceipt(item.receipt, command)) continue;
      remember(item.target, command, item.receipt);
      if (item.actionKnown === false) pending.get(keyOf(command))!.actionKnown = false;
      if (item.confirmed && settled(item.receipt)) pending.get(keyOf(command))!.confirmed = true;
    }
  } catch { /* Recovery list below can rediscover receipts without browser IDs. */ }
  for (const legacy of new Set([storage, options.legacyStorage])) {
    try {
      const raw = legacy?.getItem(LEGACY_KEY);
      if (raw) for (const [, item] of JSON.parse(raw)) {
        const command = validateSessionMutationCommand(item.command);
        if (!pending.has(keyOf(command))) remember({ id: command.deviceId, url: item.targetOrigin }, command);
      }
    } catch { /* Server-backed discovery remains available. */ }
  }
  const bridge = (target: MutationTarget) => (options.openBridge ?? openSessionMutationBridge)(target.id, target.url);
  const endpoint = (target: MutationTarget, query: Record<string, string> = {}) => `/api/remote/session-mutations?${new URLSearchParams({ peer: target.id, ...query })}`;
  const fetchJson = async (target: MutationTarget, query: Record<string, string>, body?: unknown) => {
    const response = await fetch(endpoint(target, query), { method: body === undefined ? "GET" : "POST",
      headers: { "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(12_000), cache: "no-store" });
    const value: unknown = await response.json().catch(() => null);
    return { response, value };
  };
  const capability = options.capability ?? (async (target: MutationTarget): Promise<Capability> => {
    try {
      const { response, value } = await fetchJson(target, { capabilities: "1" });
      const data = value as { protocol?: number; deviceId?: string; error?: string } | null;
      if (response.ok && data?.protocol === SESSION_MUTATION_PROTOCOL && data.deviceId === target.id) return "supported";
      if ([404, 405].includes(response.status) || (response.ok && data?.protocol !== SESSION_MUTATION_PROTOCOL)
        || data?.error === "Mutation receipt unavailable") return "upgrade_required";
    } catch { /* Browser direct transport may still reach the same device. */ }
    try { const channel = await bridge(target); const supported = channel.protocol === SESSION_MUTATION_PROTOCOL; channel.close(); return supported ? "supported" : "upgrade_required"; }
    catch (error) { return isSessionMutationBridgeAuthenticationRequired(error) ? "authentication_required"
      : (error as { code?: string }).code === "UPGRADE_REQUIRED" ? "upgrade_required" : "unavailable"; }
  });
  const transport = (target: MutationTarget): Transport => options.proxy ?? (async (mode, command) => {
    const { response, value } = await fetchJson(target, mode === "query" ? { operationId: command.operationId, deviceId: command.deviceId, sessionId: command.sessionId } : {}, mode === "execute" ? command : undefined);
    return response.ok && isSessionMutationReceipt(value, command) ? value : unknownSessionMutation(command);
  });
  const discovery = options.discovery ?? (async (target: MutationTarget, after = "") => {
    try {
      const { response, value } = await fetchJson(target, { recovery: "1", after });
      if (response.ok && Array.isArray((value as SessionMutationRecoveryPage)?.operations)) return value as SessionMutationRecoveryPage;
    } catch { /* fall through to the independent transport */ }
    const channel = await bridge(target);
    try { if (!channel.recovery) throw new Error("Recovery list unavailable"); return await channel.recovery(after); }
    finally { channel.close(); }
  });
  const acknowledge = options.acknowledge ?? (async (target: MutationTarget, identity: SessionMutationIdentity, reviewedUnknown: boolean) => {
    try {
      const { response, value } = await fetchJson(target, {}, { ...identity, action: "acknowledge", reviewedUnknown });
      if (response.ok && (value as { acknowledged?: boolean })?.acknowledged) return true;
    } catch { /* fall through */ }
    const channel = await bridge(target);
    try { return await channel.acknowledge?.(identity, reviewedUnknown) ?? false; }
    finally { channel.close(); }
  });
  const discover = async (target: MutationTarget) => {
    let after = "";
    const cursors = new Set<string>();
    do {
      const page = await discovery(target, after);
      for (const item of page.operations) {
        const identity = item.receipt;
        const command = validateSessionMutationCommand(item.command ?? { operationId: identity.operationId, deviceId: identity.deviceId, sessionId: identity.sessionId, op: "delete", force: false });
        if (command.deviceId !== target.id || !isSessionMutationReceipt(item.receipt, command)) throw new Error("Invalid recovery identity");
        remember(target, command, item.receipt);
        pending.get(keyOf(command))!.actionKnown = Boolean(item.command);
      }
      after = page.nextCursor ?? "";
      if (after && cursors.has(after)) throw new Error("Invalid recovery cursor");
      cursors.add(after);
    } while (after);
    save();
  };
  const finish = async (item: PendingSessionMutation, receipt: RemoteMutationResult, acknowledgeResolved = false) => {
    // Transport/auth failures are not durable business outcomes or reusable credentials.
    const { authenticationRequired, ...observed } = receipt;
    const retained = retainTerminalReceipt(item.receipt, observed);
    const refreshUnavailable = retained !== observed && retained.status !== observed.status;
    item.receipt = retained; item.busy = false; item.confirmed = settled(retained);
    if (item.confirmed) {
      try { if (acknowledgeResolved && await acknowledge(item.target, item.command, false)) pending.delete(keyOf(item.command)); } catch { /* A confirmed fact can be re-acknowledged; never execute it again. */ }
    }
    save();
    return { ...retained, ...(refreshUnavailable ? { refreshUnavailable: true } : {}), ...(authenticationRequired ? { authenticationRequired: true } : {}) };
  };
  const query = async (operationId: string, deviceId: string): Promise<RemoteMutationResult> => {
    const key = keyOf({ operationId, deviceId, sessionId: "" });
    const item = pending.get(key);
    if (!item) throw new Error("Recovery operation not found");
    const running = inFlight.get(key); if (running) return running;
    item.busy = true; save();
    const task = reconcileSessionMutation(item.command, { proxy: transport(item.target), resume: true, openBridge: () => bridge(item.target) })
      .then(receipt => finish(item, receipt)).finally(() => { inFlight.delete(key); item.busy = false; save(); });
    inFlight.set(key, task);
    return task;
  };
  const continueOriginal = async (operationId: string, deviceId: string): Promise<RemoteMutationResult> => {
    const key = keyOf({ operationId, deviceId, sessionId: "" });
    const item = pending.get(key);
    if (!item) throw new Error("Recovery operation not found");
    const running = inFlight.get(key); if (running) return running;
    if (settled(item.receipt)) return item.receipt;
    if (item.actionKnown === false) throw new Error("The original command is unavailable; inspect the target device");
    item.busy = true;
    const persisted = save();
    const task = (async (): Promise<RemoteMutationResult> => {
      const supported = await capability(item.target);
      if (supported !== "supported") return { ...item.receipt, notSent: true,
        notSentReason: supported === "authentication_required" ? "authenticationRequired" : supported === "upgrade_required" ? "upgrade" : "unavailable",
        authenticationRequired: supported === "authentication_required", upgradeRequired: supported === "upgrade_required" };
      const receipt = await finish(item, await reconcileSessionMutation(item.command, {
        proxy: transport(item.target), resume: true, continueOriginal: persisted, openBridge: () => bridge(item.target),
      }));
      return receipt.status === "not_found" && !persisted
        ? { ...receipt, notSent: true, notSentReason: "storageUnavailable" } : receipt;
    })().finally(() => { inFlight.delete(key); item.busy = false; save(); });
    inFlight.set(key, task);
    return task;
  };
  const execute = async (target: MutationTarget, op: SessionMutationAction, sessionId: string, name?: string, force = false): Promise<RemoteMutationResult> => {
    target = targetOf(target);
    const intent = { deviceId: target.id, sessionId, op, ...(op === "rename" ? { name } : {}), force };
    const blocked = () => [...pending.values()].find(item => item.command.deviceId === target.id && item.command.sessionId === sessionId && !item.confirmed);
    const prior = blocked();
    if (prior) return { ...await query(prior.command.operationId, target.id), previousOperation: true };
    // No POST and no pending reservation are made on an old/unreachable peer.
    const supported = await capability(target);
    const notSent = (notSentReason: RemoteMutationResult["notSentReason"], error: string, upgradeRequired = false): RemoteMutationResult => ({ ...unknownSessionMutation({ ...intent, operationId: "not-sent" }, error), status: "failed", notSent: true, notSentReason, upgradeRequired, ...(notSentReason === "authenticationRequired" ? { authenticationRequired: true } : {}) });
    if (supported !== "supported") return notSent(supported === "authentication_required" ? "authenticationRequired" : supported === "upgrade_required" ? "upgrade" : "unavailable", "Target capability is unavailable; no mutation was sent", supported === "upgrade_required");
    try { await discover(target); } catch (error) { return notSent(isSessionMutationBridgeAuthenticationRequired(error) ? "authenticationRequired" : "recoveryUnavailable", "Recovery records are unavailable; no mutation was sent"); }
    const discovered = blocked();
    if (discovered) return { ...await query(discovered.command.operationId, target.id), previousOperation: true };
    const command = validateSessionMutationCommand({ ...intent, operationId: (options.uuid ?? (() => crypto.randomUUID()))() });
    remember(target, command); const item = pending.get(keyOf(command))!;
    item.busy = true;
    // Persist the ID before a request can be left in flight across reload. A
    // server list cannot discover a POST which has not reached admission yet.
    if (!save()) {
      pending.delete(keyOf(command)); save();
      return notSent("storageUnavailable", "Browser recovery storage is unavailable; no mutation was sent");
    }
    const task = reconcileSessionMutation(command, { proxy: transport(target), resume: false, openBridge: () => bridge(target) })
      .then(receipt => finish(item, receipt, true)).finally(() => { inFlight.delete(keyOf(command)); item.busy = false; save(); });
    inFlight.set(keyOf(command), task);
    return task;
  };
  const perform = (target: MutationTarget, op: SessionMutationAction, sessionId: string, name?: string, force = false): Promise<RemoteMutationResult> => {
    const key = `${target.id}\0${sessionId}`;
    const previous = sessions.get(key);
    if (previous) return previous.then(receipt => ({ ...receipt, previousOperation: true }));
    const task = execute(target, op, sessionId, name, force).finally(() => sessions.delete(key));
    sessions.set(key, task); return task;
  };
  return Object.assign(perform, {
    snapshot: () => [...pending.values()].map(item => ({ ...item })),
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    query,
    continueOriginal,
    recover: async (targets: MutationTarget[] = []) => {
      const all = new Map([...pending.values()].map(item => [item.target.id, item.target]));
      for (const target of targets) all.set(target.id, targetOf(target));
      const unavailableTargets: MutationTarget[] = [];
      const authenticationRequiredTargets: MutationTarget[] = [];
      await Promise.all([...all.values()].map(async target => { try {
        const supported = [...pending.values()].some(item => item.target.id === target.id) ? "supported" : await capability(target);
        if (supported === "supported") await discover(target);
        else {
          unavailableTargets.push(target);
          if (supported === "authentication_required") authenticationRequiredTargets.push(target);
        }
      } catch (error) {
        unavailableTargets.push(target); // Known local IDs remain queryable.
        if (isSessionMutationBridgeAuthenticationRequired(error)) authenticationRequiredTargets.push(target);
      } }));
      await Promise.all([...pending.values()].map(async item => {
        try {
          const receipt = await query(item.command.operationId, item.target.id);
          if (receipt.refreshUnavailable || receipt.authenticationRequired) unavailableTargets.push(item.target);
          if (receipt.authenticationRequired) authenticationRequiredTargets.push(item.target);
        } catch (error) {
          unavailableTargets.push(item.target);
          if (isSessionMutationBridgeAuthenticationRequired(error)) authenticationRequiredTargets.push(item.target);
        }
      }));
      save();
      return { unavailableTargets: [...new Map(unavailableTargets.map(target => [target.id, target])).values()],
        authenticationRequiredTargets: [...new Map(authenticationRequiredTargets.map(target => [target.id, target])).values()] };
    },
    review: async (operationId: string, deviceId: string) => {
      const item = pending.get(keyOf({ operationId, deviceId, sessionId: "" }));
      if (!item || item.busy || item.receipt.status === "not_found") return false;
      // Explicit user review affects tracking only, never outcome or execution.
      const acknowledged = await acknowledge(item.target, item.command, true);
      if (acknowledged) { pending.delete(keyOf(item.command)); save(); }
      return acknowledged;
    },
  });
}
