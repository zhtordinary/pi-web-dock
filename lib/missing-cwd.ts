// Shared wire helpers for a session whose recorded project folder no longer exists.
export const CWD_MISSING_REASON = "cwd-missing" as const;

export function cwdMissingBody(cwd: string): { error: string; reason: typeof CWD_MISSING_REASON; cwd: string } {
  return { error: `Directory does not exist: ${cwd}`, reason: CWD_MISSING_REASON, cwd };
}

export function missingCwdFromBody(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const value = body as { reason?: unknown; cwd?: unknown };
  return value.reason === CWD_MISSING_REASON && typeof value.cwd === "string" && value.cwd ? value.cwd : null;
}

export function missingCwdFromError(error: unknown): string | null {
  if (error && typeof error === "object") {
    const value = error as { reason?: unknown; cwd?: unknown };
    if (value.reason === CWD_MISSING_REASON && typeof value.cwd === "string" && value.cwd) return value.cwd;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = /^Directory does not exist: (.+)$/u.exec(message.trim());
  return match?.[1] ?? null;
}
