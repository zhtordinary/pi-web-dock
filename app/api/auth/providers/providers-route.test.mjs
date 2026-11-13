import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const source = await readFile(new URL("./route.ts", import.meta.url), "utf8");

test("auth providers route returns both lists from one runtime snapshot", () => {
  assert.match(source, /buildApiKeyProviderList, buildOAuthProviderList/);
  assert.match(source, /getModelRuntimeWithExtensions/);
  assert.match(source, /const inputs = await collectProviderListingInputs\(modelRuntime\);/);
  assert.match(source, /const oauthProviders = buildOAuthProviderList\(inputs\);/);
  assert.match(source, /const apiKeyProviders = buildApiKeyProviderList\(inputs\);/);
  assert.match(source, /providers: oauthProviders, oauthProviders, apiKeyProviders/);
});
