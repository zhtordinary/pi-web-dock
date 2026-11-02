import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("receipt query is read-only, exact-device scoped, and exposes terminal state", () => {
  assert.match(source, /readControlReceipt/);
  assert.match(source, /localDeviceIdentity/);
  assert.match(source, /receipt_not_found/);
  assert.match(source, /runtimeStartAttempted: false/);
  assert.match(source, /writeSideEffects: false/);
  assert.match(source, /Cache-Control.*no-store/);
});
