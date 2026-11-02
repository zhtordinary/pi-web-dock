/** Browser-safe model-routing policy primitives shared by the settings UI and server runtime. */

export const DEFAULT_ROUTE_MAX_ATTEMPTS = 4;
export const MIN_ROUTE_MAX_ATTEMPTS = 1;
export const MAX_ROUTE_MAX_ATTEMPTS = 20;

/**
 * Keep retry spacing bounded and deterministic. The first failed retry waits
 * one second, then doubles until the eight-second cap. The unattended
 * scheduler may apply its own longer safety backoff around this delay.
 */
export function getModelRoutingRetryDelayMs(failedAttempt: number): number {
  const attempt = Math.max(1, Math.floor(Number.isFinite(failedAttempt) ? failedAttempt : 1));
  return Math.min(8_000, 1_000 * 2 ** (attempt - 1));
}

export function normalizeRouteMaxAttempts(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) return DEFAULT_ROUTE_MAX_ATTEMPTS;
  return Math.min(MAX_ROUTE_MAX_ATTEMPTS, Math.max(MIN_ROUTE_MAX_ATTEMPTS, Math.floor(numeric)));
}
