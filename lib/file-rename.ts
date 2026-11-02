import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";
import lockfile from "proper-lockfile";

const RENAME_LOCK_NAME = ".pi-web-rename.lock";
const COLLISION_CODES = new Set(["EEXIST", "ENOTEMPTY", "EISDIR", "ENOTDIR"]);
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));

export interface RenamePathOptions {
  /** Test-only seam for placing an independent writer before reservation. */
  beforeReservation?: () => void;
  /** Test-only seam for replacing a file target between link and unlink. */
  afterFileLink?: () => void;
  /** Test-only seam for replacing a directory reservation before staging. */
  afterReservation?: () => void;
  /** Test-only seam invoked before each staged child is copied. */
  beforeChildMove?: (relativePath: string) => void;
  /** Test-only seam invoked after each staged child is copied. */
  afterChildMove?: (relativePath: string) => void;
  /** Test-only seam for exercising the non-Linux directory implementation. */
  forceFallback?: boolean;
}

export class FileRenameCollisionError extends Error {
  readonly code = "EEXIST";

  constructor() {
    super("A file or folder with that name already exists");
    this.name = "FileRenameCollisionError";
  }
}

type CopiedChild = {
  targetPath: string;
  stat: fs.Stats;
  isDirectory: boolean;
};

function isCollisionError(error: unknown): boolean {
  return COLLISION_CODES.has((error as NodeJS.ErrnoException).code ?? "");
}

function sameDirectoryEntry(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwnedEntry(current: fs.Stats, expected: CopiedChild): boolean {
  // Directory ctime changes when children are created or removed, so only
  // its inode can be used for rollback. Files and symlinks retain their ctime
  // after creation unless another writer changes or replaces them.
  return sameDirectoryEntry(current, expected.stat)
    && (expected.isDirectory || current.ctimeMs === expected.stat.ctimeMs);
}

function acquireParentLock(parentPath: string): () => void {
  const options = {
    lockfilePath: path.join(parentPath, RENAME_LOCK_NAME),
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: 0,
  } as const;
  const deadline = Date.now() + 30_000;
  while (true) {
    try {
      return lockfile.lockSync(parentPath, options);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
      Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, 10);
    }
  }
}

function assertDirectoryReservation(
  targetPath: string,
  reservation: fs.Stats,
  markerName: string,
  marker: fs.Stats,
): void {
  try {
    const current = fs.lstatSync(targetPath);
    if (!current.isDirectory() || !sameDirectoryEntry(current, reservation)) throw new FileRenameCollisionError();
    const currentMarker = fs.lstatSync(path.join(targetPath, markerName));
    if (!currentMarker.isFile() || !sameDirectoryEntry(currentMarker, marker)) throw new FileRenameCollisionError();
  } catch (error) {
    if (error instanceof FileRenameCollisionError || isCollisionError(error) || (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileRenameCollisionError();
    }
    throw error;
  }
}

function copyDirectoryContentsNoClobberSync(
  sourcePath: string,
  targetPath: string,
  copiedChildren: CopiedChild[],
  assertReservation: () => void,
  beforeChildMove: ((relativePath: string) => void) | undefined,
  afterChildMove: ((relativePath: string) => void) | undefined,
  relativeParts: string[] = [],
): void {
  const names = fs.readdirSync(sourcePath).sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const sourceChild = path.join(sourcePath, name);
    const targetChild = path.join(targetPath, name);
    const relativePath = [...relativeParts, name].join("/");

    beforeChildMove?.(relativePath);
    assertReservation();
    const sourceStat = fs.lstatSync(sourceChild);

    if (sourceStat.isDirectory()) {
      try {
        // Build with owner write/execute permission, then restore the source
        // mode after children are copied. Read-only source directories must not
        // make their fresh destination unwritable mid-transaction.
        fs.mkdirSync(targetChild, (sourceStat.mode & 0o7777) | 0o700);
      } catch (error) {
        if (isCollisionError(error)) throw new FileRenameCollisionError();
        throw error;
      }
      const copiedDirectory: CopiedChild = {
        targetPath: targetChild,
        stat: fs.lstatSync(targetChild),
        isDirectory: true,
      };
      copiedChildren.push(copiedDirectory);
      copyDirectoryContentsNoClobberSync(
        sourceChild,
        targetChild,
        copiedChildren,
        assertReservation,
        beforeChildMove,
        afterChildMove,
        [...relativeParts, name],
      );
      const currentDirectory = fs.lstatSync(targetChild);
      if (!sameDirectoryEntry(currentDirectory, copiedDirectory.stat)) throw new FileRenameCollisionError();
      fs.chmodSync(targetChild, sourceStat.mode & 0o7777);
      const finalDirectory = fs.lstatSync(targetChild);
      if (!sameDirectoryEntry(finalDirectory, copiedDirectory.stat)) throw new FileRenameCollisionError();
      copiedDirectory.stat = finalDirectory;
    } else if (sourceStat.isFile()) {
      try {
        // link(2) creates the destination atomically without replacing it;
        // the staged source is deliberately kept until the transaction commits.
        fs.linkSync(sourceChild, targetChild);
      } catch (error) {
        if (isCollisionError(error)) throw new FileRenameCollisionError();
        throw error;
      }
      copiedChildren.push({
        targetPath: targetChild,
        stat: fs.lstatSync(targetChild),
        isDirectory: false,
      });
    } else if (sourceStat.isSymbolicLink()) {
      try {
        fs.symlinkSync(fs.readlinkSync(sourceChild), targetChild);
      } catch (error) {
        if (isCollisionError(error)) throw new FileRenameCollisionError();
        throw error;
      }
      copiedChildren.push({
        targetPath: targetChild,
        stat: fs.lstatSync(targetChild),
        isDirectory: false,
      });
    } else {
      throw new Error("Only regular files, folders, and symlinks can be renamed");
    }

    afterChildMove?.(relativePath);
    assertReservation();
  }
}


function assertCopiedChildrenIntact(copiedChildren: CopiedChild[]): void {
  for (const copiedChild of copiedChildren) {
    try {
      const current = fs.lstatSync(copiedChild.targetPath);
      if (!sameOwnedEntry(current, copiedChild)) throw new FileRenameCollisionError();
    } catch (error) {
      if (error instanceof FileRenameCollisionError || isCollisionError(error) || (error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FileRenameCollisionError();
      }
      throw error;
    }
  }
}

function rollbackCopiedChildren(copiedChildren: CopiedChild[]): void {
  for (let index = copiedChildren.length - 1; index >= 0; index -= 1) {
    const copiedChild = copiedChildren[index];
    try {
      const current = fs.lstatSync(copiedChild.targetPath);
      if (!sameOwnedEntry(current, copiedChild)) continue;
      if (copiedChild.isDirectory) {
        if (fs.readdirSync(copiedChild.targetPath).length === 0) fs.rmdirSync(copiedChild.targetPath);
      } else {
        fs.unlinkSync(copiedChild.targetPath);
      }
    } catch {
      // Preserve any entry whose identity or parent path is no longer ours.
    }
  }
}

function makeTreeWritableForRemoval(rootPath: string): void {
  const stat = fs.lstatSync(rootPath);
  if (!stat.isDirectory()) return;
  fs.chmodSync(rootPath, (stat.mode & 0o7777) | 0o700);
  for (const name of fs.readdirSync(rootPath)) {
    makeTreeWritableForRemoval(path.join(rootPath, name));
  }
}

function restoreStagedSource(sourcePath: string, payloadPath: string): void {
  try {
    fs.lstatSync(sourcePath);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return;
  }
  try {
    fs.renameSync(payloadPath, sourcePath);
  } catch {
    // Preserve the staged source rather than replacing an independent writer.
  }
}

function removeDirectoryReservation(
  targetPath: string,
  reservation: fs.Stats,
  markerName: string,
  marker: fs.Stats,
): void {
  try {
    const current = fs.lstatSync(targetPath);
    if (!current.isDirectory() || !sameDirectoryEntry(current, reservation)) return;
    const currentMarker = fs.lstatSync(path.join(targetPath, markerName));
    if (!currentMarker.isFile() || !sameDirectoryEntry(currentMarker, marker)) return;
    fs.unlinkSync(path.join(targetPath, markerName));
    if (fs.readdirSync(targetPath).length === 0) fs.rmdirSync(targetPath);
  } catch {
    // Preserve a target that another process created or populated.
  }
}

function removeEmptyDirectoryReservation(targetPath: string, reservation: fs.Stats): void {
  try {
    const current = fs.lstatSync(targetPath);
    if (current.isDirectory() && sameDirectoryEntry(current, reservation) && fs.readdirSync(targetPath).length === 0) {
      fs.rmdirSync(targetPath);
    }
  } catch {
    // Preserve a target that another process created or populated.
  }
}

function removeReservationMarker(
  targetPath: string,
  reservation: fs.Stats,
  markerName: string,
  marker: fs.Stats,
): void {
  assertDirectoryReservation(targetPath, reservation, markerName, marker);
  try {
    fs.unlinkSync(path.join(targetPath, markerName));
  } catch (error) {
    if (isCollisionError(error) || (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new FileRenameCollisionError();
    }
    throw error;
  }
}

/**
 * Rename within one parent without replacing an existing destination.
 *
 * Regular files use link(2), whose destination creation is atomic and
 * no-replace on Linux and macOS, followed by unlinking the old name.
 * Directories use the platform no-replace primitive on Linux. The portable
 * fallback reserves a non-empty destination, stages the source in a private
 * sibling directory, and copies children with no-clobber creation while
 * retaining a manifest for transactional rollback. The staged source is
 * deleted only after the reservation remains ours and every child is copied.
 */
export function renamePathNoClobberSync(
  sourcePath: string,
  targetPath: string,
  options: RenamePathOptions = {},
): void {
  const sourceParent = path.resolve(path.dirname(sourcePath));
  const targetParent = path.resolve(path.dirname(targetPath));
  if (sourceParent !== targetParent) {
    throw new Error("No-clobber rename requires one parent directory");
  }

  const release = acquireParentLock(sourceParent);

  try {
    const sourceStat = fs.lstatSync(sourcePath);
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) {
      throw new Error("Only files and folders can be renamed");
    }

    options.beforeReservation?.();

    if (sourceStat.isFile()) {
      try {
        fs.linkSync(sourcePath, targetPath);
      } catch (error) {
        if (isCollisionError(error)) throw new FileRenameCollisionError();
        throw error;
      }

      options.afterFileLink?.();
      try {
        const linkedTarget = fs.lstatSync(targetPath);
        const currentSource = fs.lstatSync(sourcePath);
        if (!sameDirectoryEntry(linkedTarget, sourceStat) || !sameDirectoryEntry(currentSource, sourceStat)) {
          throw new FileRenameCollisionError();
        }
        fs.unlinkSync(sourcePath);
      } catch (error) {
        // Do not leave a duplicate when the source unlink fails, but never
        // remove a destination that stopped referring to this source inode.
        try {
          const currentSource = fs.lstatSync(sourcePath);
          const currentTarget = fs.lstatSync(targetPath);
          if (sameDirectoryEntry(currentSource, currentTarget)) fs.unlinkSync(targetPath);
        } catch {
          // Keep the destination if its identity can no longer be proven.
        }
        throw error;
      }
      return;
    }

    if (process.platform === "linux" && !options.forceFallback) {
      try {
        fs.lstatSync(targetPath);
        throw new FileRenameCollisionError();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      options.afterReservation?.();
      try {
        execFileSync("mv", ["-n", "-T", sourcePath, targetPath], { stdio: "ignore" });
      } catch (error) {
        if (isCollisionError(error) || fs.existsSync(targetPath)) throw new FileRenameCollisionError();
        throw error;
      }
      try {
        fs.lstatSync(sourcePath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      throw new FileRenameCollisionError();
    }

    // macOS/Windows fallback: reserve a non-empty destination and stage the
    // source in a sibling directory so another writer cannot delete the only
    // copy of the source by replacing/removing the destination mid-copy.
    const markerName = `.pi-web-rename-reservation-${randomUUID()}`;
    const payloadName = `.pi-web-rename-payload-${randomUUID()}`;
    const payloadPath = path.join(sourceParent, payloadName);
    let reservation: fs.Stats;
    let marker: fs.Stats;
    try {
      fs.mkdirSync(targetPath, 0o700);
      fs.writeFileSync(path.join(targetPath, markerName), "", { flag: "wx" });
      reservation = fs.lstatSync(targetPath);
      marker = fs.lstatSync(path.join(targetPath, markerName));
    } catch (error) {
      if (isCollisionError(error)) throw new FileRenameCollisionError();
      throw error;
    }

    const copiedChildren: CopiedChild[] = [];
    let staged = false;
    let committed = false;
    let markerRemoved = false;
    const assertReservation = () => assertDirectoryReservation(targetPath, reservation, markerName, marker);

    try {
      options.afterReservation?.();
      assertReservation();
      fs.renameSync(sourcePath, payloadPath);
      staged = true;
      assertReservation();
      copyDirectoryContentsNoClobberSync(
        payloadPath,
        targetPath,
        copiedChildren,
        assertReservation,
        options.beforeChildMove,
        options.afterChildMove,
      );
      assertReservation();
      assertCopiedChildrenIntact(copiedChildren);
      // Marker removal is the commit point. Keep the reservation directory
      // writable until the marker is gone, then finalize its source mode.
      removeReservationMarker(targetPath, reservation, markerName, marker);
      markerRemoved = true;
      committed = true;
      try {
        makeTreeWritableForRemoval(payloadPath);
        fs.rmSync(payloadPath, { recursive: true, force: true });
      } catch {
        // The committed target is authoritative; preserve an orphaned staged
        // payload rather than risking deletion of an unrelated path.
      }
      fs.chmodSync(targetPath, sourceStat.mode & 0o7777);
    } catch (error) {
      if (staged) {
        rollbackCopiedChildren(copiedChildren);
        restoreStagedSource(sourcePath, payloadPath);
      }
      if (isCollisionError(error)) throw new FileRenameCollisionError();
      throw error;
    } finally {
      if (committed) {
        // The target is now the caller's committed destination; never remove it.
      } else if (markerRemoved) {
        removeEmptyDirectoryReservation(targetPath, reservation);
      } else {
        removeDirectoryReservation(targetPath, reservation, markerName, marker);
      }
    }
  } finally {
    release();
  }
}
