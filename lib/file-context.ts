/**
 * Stable ownership for manually browsed files and Agent execution.
 *
 * A file context always carries the device that owns the path. `cwd` is the
 * directory used for the operation; `projectRoot` is the stable project
 * identity. Manual browsing deliberately uses the project root as its cwd,
 * while Agent execution keeps the selected session cwd (which may be a
 * linked worktree).
 */
export interface FileContext {
  deviceId: string | null;
  projectRoot: string;
  cwd: string;
}

export interface FileContextInput {
  deviceId?: string | null;
  projectRoot?: string | null;
  cwd?: string | null;
}

function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed || null;
}

function device(value: string | null | undefined): string | null {
  return clean(value);
}

/** Resolve the manually browsed, canonical project context without local fallback. */
export function resolveMainlineFileContext(input: FileContextInput): FileContext | null {
  const projectRoot = clean(input.projectRoot) ?? clean(input.cwd);
  if (!projectRoot) return null;
  return { deviceId: device(input.deviceId), projectRoot, cwd: projectRoot };
}

/** Resolve the selected Agent's actual execution directory. */
export function resolveAgentExecutionContext(input: FileContextInput): FileContext | null {
  const cwd = clean(input.cwd);
  if (!cwd) return null;
  return {
    deviceId: device(input.deviceId),
    projectRoot: clean(input.projectRoot) ?? cwd,
    cwd,
  };
}

/** Keep a tab's explicit owner; never replace a remote tab with local state. */
export function retainFileTabContext(input: FileContextInput): FileContext | null {
  const cwd = clean(input.cwd);
  if (!cwd) return null;
  return {
    deviceId: device(input.deviceId),
    projectRoot: clean(input.projectRoot) ?? cwd,
    cwd,
  };
}

export function sameFileContext(left: FileContext | null | undefined, right: FileContext | null | undefined): boolean {
  return Boolean(left && right)
    && left!.deviceId === right!.deviceId
    && left!.projectRoot === right!.projectRoot
    && left!.cwd === right!.cwd;
}

/** Turn a relative UI selection into an unambiguous source path for @ references. */
export function resolveFileReferencePath(filePath: string, context: FileContext | null | undefined): string {
  const path = filePath.trim();
  const windowsAbsolute = path.length >= 3
    && /^[A-Za-z]:$/.test(path.slice(0, 2))
    && (path[2] === "/" || path[2] === "\\");
  if (!path || !context || path.startsWith("/") || windowsAbsolute) return path;
  let base = context.cwd;
  while (base.endsWith("/") || base.endsWith("\\")) base = base.slice(0, -1);
  let relative = path;
  while (relative.startsWith("/") || relative.startsWith("\\")) relative = relative.slice(1);
  return `${base}/${relative}`;
}
