/**
 * Select the durable path and public runtime labels for a safe-history read.
 *
 * Keeping this decision dependency-free makes the live and persisted branches
 * executable in a small contract test, and prevents a successful response
 * from advertising a null path that callers cannot use for older history.
 */
export type SafeHistoryRuntimeSource = {
  runtimeStatus: "live" | "not_live";
  coverageSource: "live-memory" | "persisted-jsonl";
  sessionFilePath: string | null;
};

function usablePath(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "";
}

export function resolveSafeHistorySource(input: {
  runtimeAlive: boolean;
  liveSessionFile?: unknown;
  managerSessionFile?: unknown;
  persistedSessionFile?: unknown;
}): SafeHistoryRuntimeSource | null {
  const filePath = input.runtimeAlive
    ? usablePath(input.liveSessionFile)
      || usablePath(input.managerSessionFile)
      || usablePath(input.persistedSessionFile)
    : usablePath(input.persistedSessionFile);
  if (!filePath && !input.runtimeAlive) return null;
  return input.runtimeAlive
    ? { runtimeStatus: "live", coverageSource: "live-memory", sessionFilePath: filePath || null }
    : { runtimeStatus: "not_live", coverageSource: "persisted-jsonl", sessionFilePath: filePath };
}
