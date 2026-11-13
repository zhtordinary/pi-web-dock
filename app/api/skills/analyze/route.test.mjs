import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
test("analyze route keeps single-skill compatibility and exposes the background job", async () => {
  const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");
  assert.match(source, /isApiRequestAllowed\(req\)/);
  assert.match(source, /hasJsonContentType\(req\)/);
  assert.match(source, /getSkillAnalysisJob/);
  assert.match(source, /startSkillAnalysisJob/);
  assert.match(source, /analyzeRequestedSkill/);
  assert.match(source, /Array\.isArray\(body\.filePaths\)/);
  assert.match(source, /status: job\.status === "running" \? 202 : 200/);
});

test("install and update paths request complete trigger reanalysis", async () => {
  const routes = [
    new URL("../install/route.ts", import.meta.url),
    new URL("../update/route.ts", import.meta.url),
    new URL("../../plugins/route.ts", import.meta.url),
  ];
  for (const route of routes) {
    const source = await readFile(route, "utf8");
    assert.match(source, /refreshUpdatedSkillTriggerMetadata/);
  }
});
