import type { ProjectTrustStatus } from "@/lib/api-types";

/**
 * The page's trust status for a settings panel's folder, as one string that
 * changes whenever the decision does. Settings keeps every section it has shown
 * mounted, so trusting from Settings › MCP leaves Skills, Agents and Plugins
 * describing the folder as it was; each panel whose answer depends on trust
 * loads again, in place, when this changes. Empty without a status.
 */
export function projectTrustReloadKey(trust: ProjectTrustStatus | null | undefined): string {
  if (!trust) return "";
  return JSON.stringify([trust.requiresTrust, trust.trusted, trust.decision, trust.decisionPath ?? null, trust.inherited]);
}
