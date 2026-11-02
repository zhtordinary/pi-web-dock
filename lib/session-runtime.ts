import { isSessionMissingError } from "./agent-client";
import { readSessionFastMode, type FastModeSelection } from "./fast-mode";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export interface RuntimeCompactionSettingsManager {
  applyOverrides(overrides: { compaction: { enabled: boolean } }): void;
}

/** Apply a current-session compaction choice without marking global settings dirty. */
export function applyRuntimeCompactionOverride(
  settingsManager: RuntimeCompactionSettingsManager,
  enabled: boolean,
): void {
  settingsManager.applyOverrides({ compaction: { enabled } });
}

export interface TransientSessionCommandOptions<T> {
  sessionId: string | null;
  isNew: boolean;
  promoted: boolean;
  ensureSession: () => Promise<string | null>;
  resetSession: () => void;
  send: (sessionId: string) => Promise<T>;
}

/** Retry one command after an unpersisted draft runtime was evicted. */
export async function sendTransientSessionCommand<T>(
  options: TransientSessionCommandOptions<T>,
): Promise<{ sessionId: string; result: T }> {
  const initialSessionId = options.sessionId ?? await options.ensureSession();
  if (!initialSessionId) throw new Error("Unable to create a session");

  try {
    return { sessionId: initialSessionId, result: await options.send(initialSessionId) };
  } catch (error) {
    if (!options.isNew || options.promoted || !isSessionMissingError(error)) throw error;
    options.resetSession();
    const recoveredSessionId = await options.ensureSession();
    if (!recoveredSessionId) throw error;
    return { sessionId: recoveredSessionId, result: await options.send(recoveredSessionId) };
  }
}

export interface TransientSessionRecreationOptions {
  toolNames?: string[];
  strictToolAllowlist?: boolean;
  initialModel?: { provider: string; modelId: string };
  thinkingLevel?: ThinkingLevel;
  fastMode?: FastModeSelection;
  contextSourceSessionId?: string;
}

type SessionManagerSnapshot = {
  getHeader: () => unknown;
  getEntries: () => readonly unknown[];
};

/** Preserve draft-only lineage and Fast mode when a chat-only runtime is rebuilt. */
export function buildTransientSessionRecreationOptions(
  manager: SessionManagerSnapshot,
  options: Omit<TransientSessionRecreationOptions, "fastMode" | "contextSourceSessionId">,
): TransientSessionRecreationOptions {
  const header = manager.getHeader();
  const rawContextSourceSessionId = header && typeof header === "object"
    ? (header as { contextSourceSessionId?: unknown }).contextSourceSessionId
    : undefined;
  const contextSourceSessionId = typeof rawContextSourceSessionId === "string"
    ? rawContextSourceSessionId.trim()
    : "";
  const fastMode = readSessionFastMode(manager.getEntries());

  return {
    ...options,
    ...(fastMode !== "default" ? { fastMode } : {}),
    ...(contextSourceSessionId ? { contextSourceSessionId } : {}),
  };
}
