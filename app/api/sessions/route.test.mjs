import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const route = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("session list keeps the unscoped contract and supports project-scoped listings", () => {
  assert.match(route, /const projectRoot = searchParams\.get\("projectRoot"\)/);
  assert.match(route, /listProjectSessions\(root, getRpcSessionInfos\(\)\)/);
  assert.match(route, /isAbsolute\(root\)/);
  assert.match(route, /listAllSessions\(\{ force \}\)/);
  assert.match(route, /if \(archivedOnly\)/);
  assert.ok(route.indexOf("if (archivedOnly)") < route.indexOf("if (projectRoot !== null)"));
});
