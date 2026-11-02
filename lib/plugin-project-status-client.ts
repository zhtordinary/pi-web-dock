import type { PluginOverrideState, PluginProjectStatus } from "./api-types";

export function getPluginProjectStatus(
  scope: "global" | "project",
  globalDisabled: boolean | undefined,
  projectState: PluginOverrideState | undefined,
): PluginProjectStatus {
  if (scope === "project") return "project";
  const globalState: PluginOverrideState = globalDisabled ? "disabled" : "enabled";
  return (projectState ?? globalState) === globalState ? "matching" : "different";
}
