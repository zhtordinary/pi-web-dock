import type { McpServerConfig, McpServerEntry } from "@earendil-works/pi-coding-agent";
import { forgetMcpEntryStatuses } from "./mcp-status";

/** One extension-owned MCP server currently registered in a Pi Web session. */
export interface McpExtensionServerRecord {
  sessionId: string;
  cwd: string;
  name: string;
  sourcePath: string;
  config: McpServerConfig;
  updatedAt: number;
}

const STORE_KEY: symbol = Symbol.for("pi-web:mcp-extension-servers");

type SessionRecords = Map<string, McpExtensionServerRecord>;
type ExtensionStore = Map<string, SessionRecords>;

function store(): ExtensionStore {
  const global = globalThis as Record<symbol, ExtensionStore | undefined>;
  return (global[STORE_KEY] ??= new Map());
}

function sessionKey(sessionId: string, cwd: string): string {
  return `${sessionId}\0${cwd}`;
}

function recordKey(entry: Pick<McpServerEntry, "name" | "source">): string {
  return `${entry.source}\0${entry.name}`;
}

function hasRegistration(recordKeyValue: string, exceptSession?: string): boolean {
  for (const [session, records] of store()) {
    if (session === exceptSession) continue;
    for (const record of records.values()) {
      if (`${record.sourcePath}\0${record.name}` === recordKeyValue) return true;
    }
  }
  return false;
}

/**
 * Records the extension registrations visible to one session. The registry is
 * runtime-only, so it never writes a package or MCP configuration file.
 */
export function recordMcpExtensionServers(
  sessionId: string,
  cwd: string,
  entries: readonly McpServerEntry[],
): void {
  const key = sessionKey(sessionId, cwd);
  const current = new Map<string, McpExtensionServerRecord>();
  const updatedAt = Date.now();
  for (const entry of entries) {
    if (entry.scope !== "extension") continue;
    current.set(recordKey(entry), {
      sessionId,
      cwd,
      name: entry.name,
      sourcePath: entry.source,
      config: entry.config,
      updatedAt,
    });
  }

  const previous = store().get(key);
  if (previous) {
    for (const record of previous.values()) {
      const recordKeyValue = `${record.sourcePath}\0${record.name}`;
      if (!current.has(recordKeyValue) && !hasRegistration(recordKeyValue, key)) {
        forgetMcpEntryStatuses({ scope: "extension", sourcePath: record.sourcePath, name: record.name });
      }
    }
  }
  if (current.size === 0) store().delete(key);
  else store().set(key, current);
}

/** Removes one session's registrations and their session status records. */
export function forgetMcpExtensionServers(sessionId: string, cwd: string): void {
  const key = sessionKey(sessionId, cwd);
  const previous = store().get(key);
  if (!previous) return;
  store().delete(key);
  for (const record of previous.values()) {
    const recordKeyValue = `${record.sourcePath}\0${record.name}`;
    if (!hasRegistration(recordKeyValue)) forgetMcpEntryStatuses({ scope: "extension", sourcePath: record.sourcePath, name: record.name });
  }
}

/** Returns the latest registration for each extension source/name pair. */
export function readMcpExtensionServers(): McpExtensionServerRecord[] {
  const latest = new Map<string, McpExtensionServerRecord>();
  for (const records of store().values()) {
    for (const record of records.values()) {
      const key = `${record.sourcePath}\0${record.name}`;
      const previous = latest.get(key);
      if (!previous || previous.updatedAt <= record.updatedAt) latest.set(key, record);
    }
  }
  return [...latest.values()].sort((a, b) => a.name.localeCompare(b.name) || a.sourcePath.localeCompare(b.sourcePath));
}

/** Finds an extension server for an OAuth/test route without trusting browser-supplied config. */
export function findMcpExtensionServer(name: string): McpExtensionServerRecord | undefined {
  return readMcpExtensionServers().find((record) => record.name === name);
}

/** For tests and dev reloads. */
export function clearMcpExtensionServers(): void {
  for (const key of [...store().keys()]) {
    const [sessionId, cwd] = key.split("\0", 2);
    if (sessionId !== undefined && cwd !== undefined) forgetMcpExtensionServers(sessionId, cwd);
  }
  store().clear();
}
