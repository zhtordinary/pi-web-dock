import type { QuickAskRunSnapshot } from "./quick-ask-log";

/** A cancelled run remains occupied until its tools and owned work have settled. */
export function isQuickAskRunActive(run: Pick<QuickAskRunSnapshot, "status" | "settling">): boolean {
  return run.status === "running" || run.settling === true;
}
