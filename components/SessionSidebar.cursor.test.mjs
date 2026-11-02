import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./SessionSidebar.tsx", import.meta.url), "utf8");

test("keeps the normal sidebar surface on the pointer cursor", () => {
  assert.match(source, /height: "100%", overflow: "hidden", cursor: "pointer"/);
  assert.match(source, /background: "none", border: "none", padding: 0, cursor: "pointer"/);
});
