import { toSlashPath } from "./paths";
import { getFilePermissionsPath, grantFilePermissions, readFilePermissions } from "./file-permissions";

declare global {
  var __piAllowedRootsCache: { roots: Set<string>; expiresAt: number } | undefined;
  var __piPendingFileGrants: Map<string, { read: Set<string>; write: Set<string> }> | undefined;
}

export function normalizeSlashes(filePath: string): string {
  return toSlashPath(filePath);
}

function pendingGrants(): { read: Set<string>; write: Set<string> } {
  globalThis.__piPendingFileGrants ??= new Map();
  const key = getFilePermissionsPath();
  let pending = globalThis.__piPendingFileGrants.get(key);
  if (!pending) {
    pending = { read: new Set(), write: new Set() };
    globalThis.__piPendingFileGrants.set(key, pending);
  }
  return pending;
}

/** Grants made before first-use migration are materialized in that same policy file. */
export function getAdditionalAllowedRoots(access: "read" | "write" = "read"): Set<string> {
  return pendingGrants()[access];
}

export function allowFileRoot(root: string, access: "read" | "read-write" = "read-write"): void {
  if (!root) return;
  const normalized = normalizeSlashes(root);
  if (readFilePermissions()) {
    grantFilePermissions(normalized, access);
    return;
  }
  const pending = pendingGrants();
  pending.read.add(normalized);
  if (access === "read-write") pending.write.add(normalized);
}
