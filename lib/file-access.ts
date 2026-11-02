import { getAdditionalAllowedRoots } from "./allowed-roots";
import { isExistingPathWithinRoots, isPathWithinRoots } from "./path-security";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { getCustomPromptsFilePath } from "./custom-prompts-state";
import { listKnownProjects } from "./known-projects";
import { listAllSessions } from "./session-reader";
import { initializeFilePermissions, isFilePermissionsTarget, permissionRoots, readFilePermissions } from "./file-permissions";
export { allowFileRoot, normalizeSlashes } from "./allowed-roots";
export { isWindowsAbsolutePath } from "./paths";

/** Inventory for migration and trust-breadth checks; it does not authorize file access. */
export async function getKnownProjectRoots(): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const session of await listAllSessions({ readOnly: true })) {
    if (session.cwd) roots.add(session.cwd);
    if (session.projectRoot) roots.add(session.projectRoot);
  }
  for (const project of listKnownProjects()) roots.add(project.path);
  return roots;
}

export async function getAllowedFileRoots(access: "read" | "write" = "read"): Promise<Set<string>> {
  let policy = readFilePermissions();
  if (!policy) {
    const legacy = await getKnownProjectRoots();
    legacy.add(getAgentDir());
    legacy.add(getCustomPromptsFilePath());
    policy = initializeFilePermissions(
      [...legacy, ...getAdditionalAllowedRoots("read")],
      [...legacy, ...getAdditionalAllowedRoots("write")],
    );
  }
  // Re-read on every operation: revocation must not wait for a roots cache.
  return permissionRoots(policy, access);
}

/** Authorize a path lexically, without touching the filesystem. */
export function isFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isPathWithinRoots(target, allowedRoots);
}

/** Authorize an existing path after resolving symbolic links. */
export function isExistingFilePathAllowed(target: string, allowedRoots: Set<string>): boolean {
  return isExistingPathWithinRoots(target, allowedRoots);
}

export function isFileWriteAllowed(target: string, roots: Set<string>): boolean {
  return !isFilePermissionsTarget(target) && isFilePathAllowed(target, roots);
}

export { isFilePermissionsTarget } from "./file-permissions";
