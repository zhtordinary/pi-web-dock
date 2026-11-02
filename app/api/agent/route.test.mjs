import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./[id]/route.ts", import.meta.url), "utf8");

test("missing transient prompt responses are machine-distinguishable and never accepted", () => {
  const missingBlock = source.slice(
    source.indexOf("const filePath = await resolveSessionPath(id);"),
    source.indexOf("const { session }", source.indexOf("const filePath = await resolveSessionPath(id);")),
  );
  assert.match(missingBlock, /code: "session_missing"/);
  assert.match(missingBlock, /reason: "session_missing"/);
  assert.match(missingBlock, /accepted: false/);
  assert.match(missingBlock, /status: 404/);
});

test("set_tools forwards the explicit strict allow-list policy", () => {
  assert.match(source, /requestedStrictToolAllowlist/);
  assert.match(source, /setRpcSessionTools\(id, filePath, toolNames, requestedStrictToolAllowlist\)/);
});

test("reopening a persisted session forwards and validates strict tool selection", () => {
  assert.match(source, /strictToolAllowlist requires an explicit toolNames allow-list/);
  assert.match(source, /validateSessionToolSelection\(toolNames\)/);
  assert.match(source, /strictToolAllowlist: requestedStrictToolAllowlist/);
});
