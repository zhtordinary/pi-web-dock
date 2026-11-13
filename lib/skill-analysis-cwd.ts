import { homedir } from "node:os";
import { isExistingDirectory } from "@/lib/file-access";
import { hasParentDirectorySegment } from "@/lib/path-security";

/** Choose an existing directory for post-install Skill analysis. */
export function resolveAnalysisCwd(cwd: string | undefined): { cwd: string; rejected: boolean } {
  const fallback = homedir();
  if (!cwd || cwd === fallback) return { cwd: fallback, rejected: false };
  return !hasParentDirectorySegment(cwd) && isExistingDirectory(cwd)
    ? { cwd, rejected: false } : { cwd: fallback, rejected: true };
}
