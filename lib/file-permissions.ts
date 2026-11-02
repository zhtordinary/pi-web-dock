import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import defaults from "./file-permissions.defaults.json";
import { readRegularFileText } from "./regular-file";
import { writePrivateFileAtomicSync } from "./atomic-file";
import { withStateFileTransaction } from "./state-file-transaction";
import { isExistingPathWithinRoots, isPathWithinRoots, hasParentDirectorySegment } from "./path-security";
import { samePath } from "./paths";

export interface FilePermissionLists {
  read: string[];
  write: string[];
}

export interface FilePermissions extends FilePermissionLists {
  version: 1;
  previous?: FilePermissionLists;
}

export interface FilePermissionsSnapshot {
  policy: FilePermissions;
  revision: string;
}

export function getFilePermissionsPath(): string {
  const file = process.env.PI_WEB_FILE_PERMISSIONS_FILE
    ?? path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "pi-web-reader", "file-permissions.json");
  if (!path.isAbsolute(file)) throw new Error("File permissions configuration path must be absolute");
  return file;
}

function expandRoot(root: string): string {
  if (root === "~") return homedir();
  return root.startsWith("~/") ? path.join(homedir(), root.slice(2)) : root;
}

function validLists(value: unknown): value is FilePermissionLists {
  if (!value || typeof value !== "object") return false;
  const lists = value as Partial<FilePermissionLists>;
  return Array.isArray(lists.read) && Array.isArray(lists.write)
    && [...lists.read, ...lists.write].every((root) => typeof root === "string" && Boolean(root)
      && !root.includes("\0") && !hasParentDirectorySegment(root)
      && (root === "~" || root.startsWith("~/") || path.isAbsolute(root)));
}

function parsePermissions(text: string): FilePermissions {
  const value = JSON.parse(text) as Partial<FilePermissions> | null;
  if (!value || value.version !== 1
    || Object.keys(value).some((key) => !["version", "read", "write", "previous"].includes(key))
    || (value.previous !== undefined && (!validLists(value.previous)
      || Object.keys(value.previous).some((key) => key !== "read" && key !== "write")))
    || !validLists(value)) {
    throw new Error("Expected version: 1 and read/write arrays of absolute or ~/ paths");
  }
  return value as FilePermissions;
}

function markInitialized(file: string): void {
  try { writeFileSync(`${file}.initialized`, "1\n", { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (!lstatSync(`${file}.initialized`).isFile()) throw new Error("Invalid file permissions marker");
  }
}

/** Missing is distinct from an unreadable, dangling, non-regular or corrupt policy. */
export function readFilePermissionsSnapshot(): FilePermissionsSnapshot | undefined {
  const file = getFilePermissionsPath();
  try {
    const text = readRegularFileText(file, 1024 * 1024);
    if (text !== undefined) {
      const policy = parsePermissions(text);
      markInitialized(file);
      return { policy, revision: createHash("sha256").update(text).digest("hex") };
    }
    try { lstatSync(file); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try { lstatSync(`${file}.initialized`); }
        catch (markerError) {
          if ((markerError as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw markerError;
        }
        throw new Error("File permissions configuration was removed");
      }
      throw error;
    }
    throw new Error("Unresolvable file permissions link");
  } catch {
    throw new Error(`Cannot read file permissions configuration: ${file}`);
  }
}

export function readFilePermissions(): FilePermissions | undefined {
  return readFilePermissionsSnapshot()?.policy;
}

export function permissionRoots(policy: FilePermissions, access: "read" | "write"): Set<string> {
  return new Set(policy[access].map(expandRoot));
}

function writePermissions(file: string, policy: FilePermissions): void {
  const text = JSON.stringify(policy, null, 2) + "\n";
  if (Buffer.byteLength(text, "utf8") > 1024 * 1024) {
    throw Object.assign(new Error("File permissions exceed 1 MiB"), { code: "invalid_permissions" });
  }
  writePrivateFileAtomicSync(file, text);
}

/** Only first-use migration consumes legacy discovery; configured policies are authoritative. */
export function initializeFilePermissions(read: Iterable<string>, write: Iterable<string>): FilePermissions {
  const file = getFilePermissionsPath();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  return withStateFileTransaction(file, () => {
    const current = readFilePermissions();
    if (current) return current;
    const policy: FilePermissions = {
      version: 1,
      read: [...new Set([...defaults.read, ...read])].filter((root) => validLists({ read: [root], write: [] })),
      write: [...new Set([...defaults.write, ...write])].filter((root) => validLists({ read: [], write: [root] })),
    };
    markInitialized(file);
    writePermissions(file, policy);
    return policy;
  });
}

/** Explicit operator grants merge under the shared state lock; browsing never upgrades read-only roots. */
export function grantFilePermissions(root: string, access: "read" | "read-write"): void {
  const file = getFilePermissionsPath();
  if (!validLists({ read: [root], write: [] })) throw new Error("Invalid file permission path");
  withStateFileTransaction(file, () => {
    const policy = readFilePermissions();
    if (!policy) throw new Error("File permissions must be initialized before granting access");
    const read = permissionRoots(policy, "read");
    const write = permissionRoots(policy, "write");
    const alreadyReadable = isPathWithinRoots(root, read) || isExistingPathWithinRoots(root, read);
    const alreadyWritable = isPathWithinRoots(root, write) || isExistingPathWithinRoots(root, write);
    const containsReadOnly = [...read].some((readRoot) => {
      const inside = isPathWithinRoots(readRoot, new Set([root])) || isExistingPathWithinRoots(readRoot, new Set([root]));
      return inside && !isPathWithinRoots(readRoot, write) && !isExistingPathWithinRoots(readRoot, write);
    });
    const previous = { read: [...policy.read], write: [...policy.write] };
    let changed = false;
    if (!isPathWithinRoots(root, read)) { policy.read.push(root); changed = true; }
    if (access === "read-write" && (!alreadyReadable || alreadyWritable) && !containsReadOnly && !isPathWithinRoots(root, write)) {
      policy.write.push(root); changed = true;
    }
    if (changed) {
      policy.previous = previous;
      writePermissions(file, policy);
    }
  });
}

/** The same lock serializes UI edits and explicit directory grants across Reader processes. */
export function updateFilePermissions(expectedRevision: string, next: FilePermissionLists | "restore"): FilePermissionsSnapshot {
  const file = getFilePermissionsPath();
  return withStateFileTransaction(file, () => {
    const current = readFilePermissionsSnapshot();
    if (!current || current.revision !== expectedRevision) {
      throw Object.assign(new Error("File permissions changed; reload before saving"), { code: "revision_conflict" });
    }
    const requested = next === "restore" ? current.policy.previous : next;
    if (!validLists(requested)) throw Object.assign(new Error("Invalid file permissions"), { code: "invalid_permissions" });
    if (JSON.stringify({ read: current.policy.read, write: current.policy.write }) === JSON.stringify(requested)) return current;
    const updated: FilePermissions = {
      version: 1,
      read: [...new Set(requested.read)],
      write: [...new Set(requested.write)],
      previous: { read: current.policy.read, write: current.policy.write },
    };
    writePermissions(file, updated);
    return readFilePermissionsSnapshot()!;
  });
}

/** Protect the policy and its on-disk aliases from generic file mutation routes. */
export function isFilePermissionsTarget(target: string, includeAncestors = false): boolean {
  const file = getFilePermissionsPath();
  const physical = (value: string): string => {
    try { return realpathSync(value); }
    catch {
      const parent = path.dirname(value);
      return parent === value ? value : path.join(physical(parent), path.basename(value));
    }
  };
  const marker = `${file}.initialized`;
  return [target, physical(target)].some((candidate) => [file, physical(file), marker, physical(marker)].some((policy) =>
    samePath(candidate, policy) || (includeAncestors && isPathWithinRoots(policy, new Set([candidate]))),
  ));
}
