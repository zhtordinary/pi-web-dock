import { realpathSync } from "node:fs";

/** libuv may abort when Windows watches an 8.3 short path. */
export function watchDirectory(directory: string, platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? realpathSync.native(directory) : directory;
}
