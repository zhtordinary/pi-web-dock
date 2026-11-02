import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("runtime bootstrap does not own history paging or full transcript expansion", () => {
  assert.doesNotMatch(source, /loadFullHistory|loadHistoryStep|loadEarlierHistory/);
  assert.doesNotMatch(source, /fullHistoryAbortControllerRef|fullHistoryExpandedRef|historyCursorRef/);
  assert.doesNotMatch(source, /getSessionViewSnapshot|setSessionViewSnapshot|deleteSessionViewSnapshot/);
});

test("session open and branch recovery use metadata-only bootstrap", () => {
  assert.match(source, /new URLSearchParams\(\{ metadataOnly: "1" \}\)/);
  assert.match(source, /new URLSearchParams\(\{ metadataOnly: "1", leafId: leafId \?\? "" \}\)/);
  assert.doesNotMatch(source, /sessions\/.*context\?/);
});
