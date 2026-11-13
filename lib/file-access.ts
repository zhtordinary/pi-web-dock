import { statSync } from "node:fs";
import { listKnownProjects } from "./known-projects";
import { listAllSessions } from "./session-reader";

export { isWindowsAbsolutePath, toSlashPath as normalizeSlashes } from "./paths";

/** Existing project directories inform trust breadth, not file access. */
export async function getKnownProjectRoots(): Promise<Set<string>> {
  const roots = new Set<string>();
  for (const session of await listAllSessions({ readOnly: true })) {
    if (session.cwd) roots.add(session.cwd);
    if (session.projectRoot) roots.add(session.projectRoot);
  }
  for (const project of listKnownProjects()) roots.add(project.path);
  return roots;
}

export function isExistingDirectory(directory: string): boolean {
  try { return statSync(directory).isDirectory(); } catch { return false; }
}
