import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");

test("new-session startup sends only explicit browser overrides", () => {
  const requestSource = source.slice(
    source.indexOf("const requestNewSession"),
    source.indexOf("const ensureNewSession"),
  );

  assert.match(requestSource, /const selectedModel = newSessionModelOverrideRef\.current;/);
  assert.doesNotMatch(requestSource, /newSessionModel \?\? newSessionDefaultModel/);
  assert.match(requestSource, /const selectedThinkingLevel = thinkingLevelOverrideRef\.current;/);
  assert.doesNotMatch(requestSource, /thinkingLevel !== "auto"/);
});

test("new-session startup adopts server state only while explicit overrides are unchanged", () => {
  const responseSource = source.slice(
    source.indexOf("const applyNewSessionResponse"),
    source.indexOf("const requestNewSession"),
  );

  assert.match(
    responseSource,
    /result\.model && newSessionModelOverrideRef\.current === selectedModel/,
  );
  assert.match(responseSource, /setPendingModel\(result\.model\)/);
  assert.match(responseSource, /setNewSessionDefaultModel\(result\.model\)/);
  assert.match(
    responseSource,
    /thinkingLevelOverrideRef\.current === selectedThinkingLevel/,
  );
  assert.match(responseSource, /setLiveThinkingLevel\(asConcreteThinkingLevel\(result\.thinkingLevel\)\)/);
  assert.match(responseSource, /setNewSessionDefaultThinkingLevel\(asConcreteThinkingLevel\(result\.thinkingLevel\)\)/);
});

test("model-list refresh does not overwrite a live session or explicit thinking override", () => {
  const loadModelsSource = source.slice(
    source.indexOf("const loadModels = useCallback"),
    source.indexOf("const handleBuiltinSlashCommand"),
  );

  assert.match(loadModelsSource, /if \(isNew && !sessionIdRef\.current\)/);
  assert.match(
    loadModelsSource,
    /thinkingLevelOverrideRef\.current === null/,
  );
  assert.match(loadModelsSource, /setThinkingLevel\(\s*modelDefault[\s\S]*\?\? "auto"/);
});
