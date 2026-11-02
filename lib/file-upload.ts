import { randomUUID } from "node:crypto";
import fs from "fs";
import path from "path";

export const UPLOAD_CONFLICT_STRATEGIES = ["error", "overwrite", "skip"] as const;
export type UploadConflictStrategy = typeof UPLOAD_CONFLICT_STRATEGIES[number];

const UPLOAD_CONFLICT_STRATEGY_SET = new Set<string>(UPLOAD_CONFLICT_STRATEGIES);

export interface UploadTargetInspection {
  conflicts: string[];
  nonReplaceable: string[];
}

export function parseUploadConflictStrategy(value: string | null): UploadConflictStrategy | null {
  const candidate = value ?? "error";
  return UPLOAD_CONFLICT_STRATEGY_SET.has(candidate)
    ? candidate as UploadConflictStrategy
    : null;
}

export function validateUploadFileNames(fileNames: string[]): string | null {
  if (fileNames.length === 0) return "No files selected";

  const seen = new Set<string>();
  for (const fileName of fileNames) {
    if (!fileName || fileName === "." || fileName === ".." || fileName.includes("\0")) {
      return `Invalid file name: ${fileName || "(empty)"}`;
    }
    if (fileName.includes("/") || fileName.includes("\\") || path.basename(fileName) !== fileName) {
      return `File names must not contain a path: ${fileName}`;
    }
    if (seen.has(fileName)) return `Duplicate file name in upload: ${fileName}`;
    seen.add(fileName);
  }

  return null;
}

export function inspectUploadTargets(directory: string, fileNames: string[]): UploadTargetInspection {
  const conflicts: string[] = [];
  const nonReplaceable: string[] = [];

  for (const fileName of fileNames) {
    const destination = path.join(directory, fileName);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(destination);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") continue;
      throw error;
    }

    conflicts.push(fileName);
    if (!stat.isFile() || stat.isSymbolicLink()) nonReplaceable.push(fileName);
  }

  return { conflicts, nonReplaceable };
}

export interface AtomicUploadOptions {
  replaceExisting?: boolean;
}

/**
 * Make an uploaded file visible only after all bytes have been written.
 * Existing files are replaced with one same-directory rename; new files use a
 * hard-link handoff so a concurrent creator cannot be clobbered.
 */
export function writeUploadFileAtomicSync(
  destination: string,
  bytes: Uint8Array,
  { replaceExisting = false }: AtomicUploadOptions = {},
): void {
  const directory = path.dirname(destination);
  const baseName = path.basename(destination);
  let existing: fs.Stats | null = null;
  try {
    existing = fs.lstatSync(destination);
    if (existing.isSymbolicLink() || !existing.isFile()) {
      throw new Error("Cannot replace a directory or symbolic link");
    }
    if (!replaceExisting) {
      const error = new Error("A file with that name already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const tempPath = path.join(directory, `.${baseName}-${randomUUID()}.upload.tmp`);
  const mode = existing ? existing.mode & 0o777 : 0o666;
  let fd: number | null = null;
  let tempOwned = false;
  try {
    fd = fs.openSync(tempPath, "wx", mode);
    tempOwned = true;
    let offset = 0;
    while (offset < bytes.byteLength) {
      const written = fs.writeSync(fd, bytes, offset, bytes.byteLength - offset, null);
      if (!Number.isInteger(written) || written <= 0) {
        throw new Error("Upload write made no progress");
      }
      offset += written;
    }
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    // Recheck after the complete write so a directory or link introduced by a
    // concurrent request is never replaced.
    let current: fs.Stats | null = null;
    try {
      current = fs.lstatSync(destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current && (current.isSymbolicLink() || !current.isFile())) {
      throw new Error("Cannot replace a directory or symbolic link");
    }
    if (!replaceExisting && current) {
      const error = new Error("A file with that name already exists") as NodeJS.ErrnoException;
      error.code = "EEXIST";
      throw error;
    }

    if (replaceExisting) {
      fs.renameSync(tempPath, destination);
    } else {
      // link() is atomic and refuses an existing destination, unlike rename().
      fs.linkSync(tempPath, destination);
      fs.unlinkSync(tempPath);
    }
    tempOwned = false;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original write failure.
      }
    }
    if (tempOwned) {
      try {
        fs.unlinkSync(tempPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          // Only this invocation's private temp path may be cleaned up.
        }
      }
    }
  }
}
