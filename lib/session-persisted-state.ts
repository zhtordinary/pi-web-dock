import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { StringDecoder } from "node:string_decoder";
import { isAbsolute, join } from "node:path";
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { getProjectTrustStatus } from "./project-trust";
import { PROJECT_SETTINGS_MAX_BYTES, readRegularFileText } from "./regular-file";
import { readSessionAutoCompaction, SESSION_AUTO_COMPACTION_TYPE } from "./session-auto-compaction";

const MAX_STATE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_STATE_LINE_BYTES = 8 * 1024 * 1024;
const MAX_STATE_ENTRIES = 10_000;

function readInheritedCompaction(cwd: unknown, agentDir: string): boolean {
  if (typeof cwd !== "string" || !isAbsolute(cwd)) throw new Error("Persisted session cwd is unavailable");
  const projectTrusted = getProjectTrustStatus(cwd, agentDir).trusted;
  const settings = SettingsManager.fromStorage({
    withLock(scope, read) {
      const path = scope === "global" ? join(agentDir, "settings.json") : join(cwd, ".pi", "settings.json");
      const text = readRegularFileText(path, PROJECT_SETTINGS_MAX_BYTES);
      if (text !== undefined) {
        const value: unknown = JSON.parse(text.replace(/^\uFEFF/, ""));
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid inherited session settings");
        const compaction = (value as { compaction?: unknown }).compaction;
        if (compaction !== undefined && (!compaction || typeof compaction !== "object" || Array.isArray(compaction)
          || ((compaction as { enabled?: unknown }).enabled !== undefined
            && typeof (compaction as { enabled?: unknown }).enabled !== "boolean"))) {
          throw new Error("Invalid inherited automatic compaction state");
        }
      }
      if (read(text) !== undefined) throw new Error("Session settings observation cannot write");
    },
  }, { projectTrusted });
  const errors = settings.drainErrors();
  if (errors.length) throw errors[0].error;
  return settings.getCompactionEnabled();
}

/** Observe session overrides or their effective inherited settings without creating a runtime or writing files. */
export async function readPersistedSessionState(filePath: string, sessionId: string, agentDir = getAgentDir()): Promise<{
  autoCompactionEnabled: boolean;
  autoCompactionSource?: "inherited";
}> {
  const file = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.size === 0 || before.size > MAX_STATE_FILE_BYTES) {
      throw new Error("Persisted session state is unavailable");
    }
    const entries: unknown[] = [];
    let headerRead = false;
    let cwd: unknown;
    const consume = (line: string) => {
      if (Buffer.byteLength(line) > MAX_STATE_LINE_BYTES) throw new Error("Persisted session state exceeds its read limit");
      if (!line.trim()) return;
      const entry: unknown = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("Invalid persisted session state");
      const value = entry as { type?: unknown; id?: unknown; customType?: unknown; cwd?: unknown };
      if (!headerRead) {
        if (value.type !== "session" || value.id !== sessionId) throw new Error("Persisted session identity changed");
        headerRead = true;
        cwd = value.cwd;
      } else if (value.type === "session") {
        throw new Error("Conflicting persisted session identity");
      } else if (value.type === "custom" && value.customType === SESSION_AUTO_COMPACTION_TYPE) {
        entries.push(entry);
        if (entries.length > MAX_STATE_ENTRIES) throw new Error("Persisted session state exceeds its read limit");
      }
    };
    const decoder = new StringDecoder("utf8");
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let pending = "";
    let position = 0;
    while (position < before.size) {
      const { bytesRead } = await file.read(buffer, 0, Math.min(buffer.length, before.size - position), position);
      if (!bytesRead) throw new Error("Persisted session changed during the state read");
      position += bytesRead;
      pending += decoder.write(buffer.subarray(0, bytesRead));
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending) > MAX_STATE_LINE_BYTES) throw new Error("Persisted session state exceeds its read limit");
    }
    pending += decoder.end();
    if (pending) consume(pending);
    const after = await file.stat();
    const path = await lstat(filePath);
    if (!headerRead || !path.isFile() || before.dev !== after.dev || before.ino !== after.ino
      || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs
      || path.dev !== after.dev || path.ino !== after.ino || path.size !== after.size
      || path.mtimeMs !== after.mtimeMs || path.ctimeMs !== after.ctimeMs) {
      throw new Error("Persisted session changed during the state read");
    }
    const autoCompactionEnabled = readSessionAutoCompaction(entries);
    if (autoCompactionEnabled !== undefined) return { autoCompactionEnabled };
    return { autoCompactionEnabled: readInheritedCompaction(cwd, agentDir), autoCompactionSource: "inherited" };
  } finally {
    await file.close();
  }
}
