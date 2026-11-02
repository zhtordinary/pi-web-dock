import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { basename, dirname, join } from "node:path";

export * from "./file-edit-constants.ts";

type FileVersionStats = Pick<Stats, "dev" | "ino" | "mtimeMs" | "ctimeMs" | "size">;

/** Opaque optimistic-concurrency token for one on-disk file snapshot. */
export function fileVersion(stat: FileVersionStats): string {
  return JSON.stringify([stat.dev, stat.ino, stat.mtimeMs, stat.ctimeMs, stat.size]);
}

/** Replace existing text file atomically while preserving its symlink and mode. */
export function writeTextFileAtomicSync(filePath: string, contents: string): void {
  let targetPath = filePath;
  if (lstatSync(filePath).isSymbolicLink()) targetPath = realpathSync(filePath);

  const current = statSync(targetPath);
  if (!current.isFile()) throw new Error("Not a file");

  const tempPath = join(dirname(targetPath), `.${basename(targetPath)}-${randomUUID()}.tmp`);
  let operationFailed = false;
  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: current.mode & 0o777,
      flush: true,
    });
    renameSync(tempPath, targetPath);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) throw error;
    }
  }
}
