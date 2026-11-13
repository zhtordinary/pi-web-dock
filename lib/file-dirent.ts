import fs from "fs";

type DirentType = Pick<fs.Dirent, "isDirectory" | "isFile"> & Partial<Pick<fs.Dirent, "isSymbolicLink">>;

export function resolveDirentIsDirectory(
  dirent: DirentType,
  fullPath: string,
): boolean | null {
  if (dirent.isDirectory()) return true;
  if (dirent.isFile()) return false;

  try {
    return fs.statSync(fullPath).isDirectory();
  } catch {
    return dirent.isSymbolicLink?.() ? false : null;
  }
}
