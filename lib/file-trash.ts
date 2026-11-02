import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const MACOS_TRASH_SCRIPT = `use framework "Foundation"
use scripting additions

on run argv
  if (count of argv) is 0 then error "Missing target path"

  set targetPath to item 1 of argv
  set fileManager to current application's NSFileManager's defaultManager()
  set targetURL to current application's NSURL's fileURLWithPath:targetPath
  set resultURL to reference
  set errorRef to reference
  set operationResult to fileManager's trashItemAtURL:targetURL resultingItemURL:resultURL |error|:errorRef
  set success to item 1 of operationResult
  if (success as boolean) is false then
    set failure to missing value
    set resultCount to count of operationResult
    if resultCount is greater than or equal to 3 then set failure to item 3 of operationResult
    if failure is not missing value then error (failure's localizedDescription() as text)
    error "The item could not be moved to the system trash"
  end if
end run`;

function commandError(result: { error?: Error | null; status: number | null; stderr: string | Buffer | null }, fallback: string): Error {
  if (result.error) return result.error;
  const detail = typeof result.stderr === "string" ? result.stderr.trim() : result.stderr?.toString().trim();
  return new Error(detail || fallback);
}

function runTrashCommand(command: string, args: string[], input?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args);
    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.stdin.end(input);
    child.on("error", (error) => reject(error));
    child.on("close", (status) => {
      if (status === 0) {
        resolve();
      } else {
        reject(commandError({ error: null, status, stderr }, "The item could not be moved to the system trash"));
      }
    });
  });
}

export async function moveToSystemTrash(target: string): Promise<void> {
  if (process.platform === "darwin") {
    await runTrashCommand("/usr/bin/osascript", ["-", target], MACOS_TRASH_SCRIPT);
  } else if (process.platform === "linux") {
    const gio = "/usr/bin/gio";
    if (!existsSync(gio)) {
      throw new Error("System trash is unavailable: /usr/bin/gio was not found");
    }
    await runTrashCommand(gio, ["trash", target]);
  } else {
    throw new Error(`System trash is not supported on ${process.platform}`);
  }
}
