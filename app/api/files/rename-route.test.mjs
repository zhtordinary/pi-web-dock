import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[...path]/route.ts", import.meta.url), "utf8");

test("file rename route permits links while protecting path segments and collisions", () => {
  assert.match(source, /export async function PATCH\(/);
  assert.match(source, /parseFileRenameBody/);
  assert.match(source, /validateUploadFileNames\(\[parsed\.name\]\)/);
  assert.match(source, /hasParentDirectorySegment\(filePath\)/);
  assert.match(source, /!stat\.isSymbolicLink\(\)/);
  assert.doesNotMatch(source, /The project root cannot be renamed|Symbolic links cannot be renamed/);
  assert.match(source, /A file or folder with that name already exists/);
  assert.match(source, /renamePathNoClobberSync\(filePath, targetPath\)/);
  assert.doesNotMatch(source, /fs\.renameSync\(filePath, targetPath\)/);
  assert.doesNotMatch(source, /execFileSync\("mv", \["-n", sourcePath, targetPath\]/);
});

test("session-name route resolves transient RPC before disk lookup", async () => {
  const sessionRoute = await readFile(new URL("../sessions/[id]/route.ts", import.meta.url), "utf8");
  assert.match(sessionRoute, /const live = getRpcSession\(id\);[\s\S]*?if \(live\?\.isAlive\(\)\)/);
  assert.match(sessionRoute, /if \(live\?\.isAlive\(\)\)[\s\S]*?await live\.send\(\{ type: "set_session_name"/);
});

test("file rename route keeps remote proxy compatibility through PATCH", () => {
  assert.match(source, /const MAX_RENAME_REQUEST_BYTES = 16 \* 1024/);
  assert.match(source, /readJsonWithinLimit\(request, MAX_RENAME_REQUEST_BYTES\)/);
  assert.match(source, /Rename request is too large/);
  assert.match(source, /status: 413/);
  assert.match(source, /samePath\(filePath, targetPath\)/);
});
