import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./MessageView.tsx", import.meta.url), "utf8");

test("expanded tool results render image blocks lazily", () => {
  assert.match(source, /const resultImages = resultContent\.filter/);
  assert.match(source, /images=\{resultImages\}/);
  assert.match(source, /loading="eager"/);
  assert.match(source, /apiPathForPeer\(remotePeer, url\.slice\("\/api\/"\.length\)\)/);
  assert.match(source, /fileApiPath\(localPath, "read", sessionId, remotePeer\)/);
  assert.match(source, /images=\{resultImages\}[\s\S]*sessionId=\{sessionId\}/);
});
