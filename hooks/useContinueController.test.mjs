import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useContinueController.ts", import.meta.url), "utf8");

test("manual messages cancel only the current flow and preserve unattended mode", () => {
  const start = source.indexOf("if (lastUserMessageIsManual(messages))");
  const end = source.indexOf("const last = lastAssistantClassification", start);
  assert.ok(start >= 0 && end > start);
  const manualBlock = source.slice(start, end);
  assert.match(manualBlock, /resetFlow\(\)/);
  assert.doesNotMatch(manualBlock, /setUnattended\(false\)/);
  assert.doesNotMatch(manualBlock, /localStorage\.setItem/);
  assert.match(source, /if \(unattendedRef\.current && serverStateKnownRef\.current\) return/);
  assert.match(source, /const resumeRequiredRef = useRef\(false\)/);
  assert.match(source, /lastUserMessageIsManual\(messages\)[\s\S]*?if \(agentRunning \|\| isCompacting\) return/);
  assert.match(source, /if \(resumeRequiredRef\.current\) return/);
  assert.doesNotMatch(source, /onUnattendedState/);
});

test("unattended retries are observed from the server, never invented by history", () => {
  assert.match(source, /if \(unattendedRef\.current\) return/);
  assert.match(source, /serverStateKnownRef\.current = true/);
});

test("explicit stop control still disables unattended mode", () => {
  const start = source.indexOf("const stopAutoRetry = useCallback");
  const end = source.indexOf("// Manual recovery", start);
  assert.match(source.slice(start, end), /setUnattended\(false\)/);
});
