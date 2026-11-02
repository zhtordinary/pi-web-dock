import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import lockfile from "proper-lockfile";

export class ResourceSettingsError extends Error {
  code: string;
  status: number;
  revision?: string;
  constructor(code: string, message: string, status = 400, revision?: string) {
    super(message);
    this.name = "ResourceSettingsError";
    this.code = code;
    this.status = status;
    this.revision = revision;
  }
}

export interface ResourceDocument {
  document: Record<string, unknown>;
  revision: string;
}

function revisionOf(contents: string | undefined): string {
  return createHash("sha256").update(`reader-resource-config/v1\0${contents === undefined ? "missing" : "file"}\0${contents ?? ""}`).digest("hex");
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | undefined)?.code;
}

function physicalPath(path: string): string {
  let target = path;
  try {
    if (lstatSync(path).isSymbolicLink()) target = realpathSync(path);
    if (!statSync(target).isFile()) throw new ResourceSettingsError("unsupported_path", "Configuration must be a regular file", 422);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw new ResourceSettingsError("unsupported_path", "Configuration symlink cycle detected", 422);
    if (errorCode(error) !== "ENOENT") throw error;
  }
  try {
    return resolve(realpathSync(dirname(target)), basename(target));
  } catch (error) {
    if (errorCode(error) === "ENOENT") return resolve(target);
    throw error;
  }
}

/** One atomic file read supplies both the CAS identity and the projected value. */
export function readResourceDocument(path: string): ResourceDocument {
  const target = physicalPath(path);
  let contents: string;
  let fd: number | undefined;
  try {
    fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const metadata = fstatSync(fd);
    if (!metadata.isFile()) throw new ResourceSettingsError("unsupported_path", "Configuration must be a regular file", 422);
    if (metadata.size > 1024 * 1024) throw new ResourceSettingsError("configuration_too_large", "Configuration exceeds the 1 MiB limit", 413);
    contents = readFileSync(fd, "utf8");
    if (new TextEncoder().encode(contents).length > 1024 * 1024) throw new ResourceSettingsError("configuration_too_large", "Configuration exceeds the 1 MiB limit", 413);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { document: {}, revision: revisionOf(undefined) };
    if (errorCode(error) === "ELOOP") throw new ResourceSettingsError("unsupported_path", "Configuration symlinks are not supported", 422);
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  let document: unknown;
  try {
    document = JSON.parse(contents);
  } catch {
    throw new ResourceSettingsError("invalid_configuration", "Configuration contains invalid JSON", 409);
  }
  if (!document || typeof document !== "object" || Array.isArray(document)) {
    throw new ResourceSettingsError("invalid_configuration", "Configuration must contain an object", 409);
  }
  return { document: document as Record<string, unknown>, revision: revisionOf(contents) };
}

/**
 * The synchronous UI writers and managed CAS writers share this exact lock.
 * Contention fails closed without blocking the event loop or guessing stale owners.
 * The callback must stay synchronous; compare, mutation and readback are one section.
 */
export function mutateResourceDocument<T>(
  path: string,
  expectedRevision: string | undefined,
  update: (document: Record<string, unknown>) => T,
): { revision: string; changed: boolean; result: T } {
  if (expectedRevision === undefined) mkdirSync(dirname(path), { recursive: true });
  else {
    try {
      if (!statSync(dirname(path)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ResourceSettingsError("configuration_unavailable", "Managed configuration parent directory must already exist", 409);
    }
  }
  const target = physicalPath(path);
  if (expectedRevision === undefined) mkdirSync(dirname(target), { recursive: true });
  else {
    try {
      if (!statSync(dirname(target)).isDirectory()) throw new Error("not a directory");
    } catch {
      throw new ResourceSettingsError("configuration_unavailable", "Managed configuration parent directory must already exist", 409);
    }
  }
  let release: () => void;
  try {
    release = lockfile.lockSync(target, { realpath: false, retries: 0, stale: 30_000 });
  } catch (error) {
    if (errorCode(error) === "ELOCKED") {
      throw new ResourceSettingsError("configuration_busy", "Configuration is being modified; retry after reading its revision", 409);
    }
    throw error;
  }
  try {
    const before = readResourceDocument(target);
    if (expectedRevision !== undefined && expectedRevision !== before.revision) {
      throw new ResourceSettingsError("revision_conflict", "Configuration revision changed", 409, before.revision);
    }
    const original = JSON.stringify(before.document);
    const result = update(before.document);
    const changed = original !== JSON.stringify(before.document);
    if (!changed) return { revision: before.revision, changed: false, result };
    const contents = `${JSON.stringify(before.document, null, 2)}\n`;
    if (new TextEncoder().encode(contents).length > 1024 * 1024) throw new ResourceSettingsError("configuration_too_large", "Configuration exceeds the 1 MiB limit", 413);
    // Rename over the checked destination; never follow a newly inserted symlink.
    const temp = resolve(dirname(target), `.${basename(target)}-${randomUUID()}.tmp`);
    try {
      writeFileSync(temp, contents, { encoding: "utf8", flag: "wx", mode: 0o600, flush: true });
      renameSync(temp, target);
    } finally {
      try { unlinkSync(temp); } catch (error) {
        if (errorCode(error) !== "ENOENT") throw error;
      }
    }
    return { revision: revisionOf(contents), changed: true, result };
  } finally {
    release();
  }
}
