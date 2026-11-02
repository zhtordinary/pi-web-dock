import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("Reader keeps a response type, not a second capability table", async () => {
  const source = await readFile(new URL("./gen-capabilities.ts", import.meta.url), "utf8");
  assert.match(source, /export interface GenCapability/);
  assert.doesNotMatch(source, /GEN_CAPABILITIES|gpt-image-2|gemini-3/);
});
