import { homedir } from "node:os";
import { isExistingFilePathAllowed } from "@/lib/file-access";

/**
 * Choose the directory used to load skills for post-install analysis.
 *
 * Loading settings, project resources and model services for an arbitrary
 * caller-supplied path would cross the API's trust boundary, so only a path
 * that passes the same allowed-root check already applied to project installs
 * is used; everything else falls back to the fixed home context.
 */
export function resolveAnalysisCwd(
  cwd: string | undefined,
  allowedRoots: Set<string>,
): { cwd: string; rejected: boolean } {
  const fallback = homedir();
  if (!cwd || cwd === fallback) return { cwd: fallback, rejected: false };
  return isExistingFilePathAllowed(cwd, allowedRoots)
    ? { cwd, rejected: false }
    : { cwd: fallback, rejected: true };
}
