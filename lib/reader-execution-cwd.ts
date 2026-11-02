import { execFile } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export function assertReaderExecutionCwd(cwd: string): string {
  if (!isAbsolute(cwd)) throw new Error('Reader execution cwd must be absolute');
  const stat = lstatSync(cwd);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Reader execution cwd is missing or unsafe');
  return realpathSync(cwd);
}

/** The repository root shared by every worktree of `cwd`, or `cwd` itself outside Git. */
export async function readerRuntimeProjectRoot(cwd: string): Promise<string> {
  const actual = assertReaderExecutionCwd(cwd);
  try {
    const { stdout } = await execFileAsync('git', ['-C', actual, 'rev-parse', '--path-format=absolute', '--git-common-dir'], { timeout: 3000, maxBuffer: 32768 });
    const common = stdout.trim();
    if (isAbsolute(common) && common.endsWith('/.git')) return assertReaderExecutionCwd(resolve(common, '..'));
  } catch { /* A directory outside Git is its own project root. */ }
  return actual;
}
