import { lstatSync, mkdirSync, realpathSync } from "fs";
import { homedir } from "os";
import path from "path";

// "Use default directory" opens a fresh folder per day, ~/pi-cwd/<YYYYMMDD>.
// The date keeps a first-time user from landing in a folder that already holds
// their own data, and doubles as a daily scratch cwd.
const DEFAULT_CWD_PARENT = "pi-cwd";

/** Local calendar date as YYYYMMDD, so the folder matches the user's "today". */
export function localDateStamp(now = new Date()): string {
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

export function defaultCwdPath(now = new Date(), home = homedir()): string {
  return path.join(home, DEFAULT_CWD_PARENT, localDateStamp(now));
}

/** Creates the daily scratch directory without following a link at either managed level. */
export function createDefaultCwdDirectory(now = new Date(), home = homedir()): string {
  const realHome = realpathSync(home);
  const parent = path.join(realHome, DEFAULT_CWD_PARENT);
  const dir = defaultCwdPath(now, realHome);
  for (const candidate of [parent, dir]) {
    try {
      const current = lstatSync(candidate);
      if (current.isSymbolicLink() || !current.isDirectory()) {
        throw new Error("Default directory must be a regular directory");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      mkdirSync(candidate);
    }
  }
  return dir;
}
