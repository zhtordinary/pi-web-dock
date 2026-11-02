export interface RenameWorkspace {
  cwd: string;
  peer?: string;
}

export interface RenameTarget extends RenameWorkspace {
  path: string;
  isDir: boolean;
}

export function captureRenameTarget(cwd: string, peer: string | undefined, path: string, isDir: boolean): RenameTarget {
  return { cwd, peer, path, isDir };
}

export function isRenameRequestCurrent(
  target: RenameTarget,
  workspace: RenameWorkspace,
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestId === currentRequestId
    && target.cwd === workspace.cwd
    && target.peer === workspace.peer;
}

export function migrateRenamedPath(value: string, target: Pick<RenameTarget, "path" | "isDir">, nextPath: string): string {
  if (value === target.path) return nextPath;
  if (target.isDir && value.startsWith(`${target.path}/`)) {
    return `${nextPath}${value.slice(target.path.length)}`;
  }
  return value;
}
