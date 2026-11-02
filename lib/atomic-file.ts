import { randomUUID } from "crypto";
import { lstatSync, realpathSync, renameSync, unlinkSync, writeFileSync, openSync, closeSync, fsyncSync } from "fs";
import { basename, dirname, join } from "path";

/**
 * A configured path that exists as a link but cannot be resolved: the link
 * target is missing, or the links form a loop. Replacing the link would turn a
 * user's symlinked config into a separate regular file and silently detach it
 * from wherever it points, so the write fails instead.
 */
export class UnresolvableLinkError extends Error {
  constructor(path: string, cause: unknown) {
    super(`Refusing to replace unresolvable link ${path}: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "UnresolvableLinkError";
  }
}

/**
 * Replace a file atomically without exposing credentials through default
 * process permissions. The caller must create the parent directory first.
 *
 * An existing link is written through to its target so the link survives; a
 * link that cannot be resolved throws UnresolvableLinkError and leaves both
 * the link and the filesystem untouched.
 */
export function writePrivateFileAtomicSync(path: string, contents: string): void {
  // Preserve managed symlinks while still replacing the real file atomically.
  let targetPath = path;
  let link = false;
  try {
    link = lstatSync(path).isSymbolicLink();
  } catch (error) {
    // Nothing at this path yet: a plain create is the intended behaviour.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (link) {
    try {
      targetPath = realpathSync(path);
    } catch (error) {
      throw new UnresolvableLinkError(path, error);
    }
  }
  const dir = dirname(targetPath);
  const tempPath = join(dir, `.${basename(targetPath)}-${randomUUID()}.tmp`);
  let operationFailed = false;

  try {
    writeFileSync(tempPath, contents, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
      flush: true,
    });
    renameSync(tempPath, targetPath);
    const directoryFd = openSync(dir, "r");
    try { fsyncSync(directoryFd); }
    catch (error) { if (!["EINVAL", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error; }
    finally { closeSync(directoryFd); }
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      unlinkSync(tempPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" && !operationFailed) {
        throw error;
      }
    }
  }
}
