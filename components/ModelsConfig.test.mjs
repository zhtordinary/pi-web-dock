import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const readerSource = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const appShellSource = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const imageGenSource = await readFile(new URL("./ImageGenConfig.tsx", import.meta.url), "utf8");
const apiKeyDetail = readerSource.slice(
  readerSource.indexOf("function ApiKeyDetail"),
  readerSource.indexOf("// ── Add provider picker"),
);

test("provider search includes OAuth IDs and model rows display names without changing identity", () => {
  assert.match(readerSource, /!p\.loggedIn && \(!q \|\| p\.name\.toLowerCase\(\)\.includes\(q\) \|\| p\.id\.toLowerCase\(\)\.includes\(q\)\)/);
  assert.match(readerSource, /m\.name\?\.trim\(\) \|\| m\.id \|\| t\("i18n\.newModel"\)/);
  assert.match(readerSource, /toggleModelHidden\(pName, m\.id\)/);
  assert.match(readerSource, /type: "model", providerName: pName, index: i/);
});

test("provider detail keeps the enable switch after the delete action", () => {
  const detail = readerSource.slice(
    readerSource.indexOf("function ProviderDetail"),
    readerSource.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.ok(detail.indexOf('<ConfigButton variant="danger"') < detail.indexOf("<EnabledModelsProviderSwitch"));
});

test("provider-endpoint model import remains an explicit action", () => {
  assert.match(apiKeyDetail, /const refreshManagedModels = useCallback/);
  assert.match(apiKeyDetail, /onImportModels=\{refreshManagedModels\}/);
  assert.doesNotMatch(apiKeyDetail, /loadManagedScope|saveManagedScope|models-scope/);
  assert.doesNotMatch(apiKeyDetail, /refreshManagedModels\(\{ background:/);
});

import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  readApiJson,
  resolveSystemPromptRole,
  renameProviderEntry,
  serializeHeaderRows,
  setCompatBool,
  setCompatOverride,
  setSystemPromptRole,
  updateHeaderRow,
} = await jiti.import("./models-config-helpers.ts");
const { modelDiscoveryKey } = await jiti.import("../lib/model-discovery.ts");

const source = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const helperSource = await readFile(new URL("./models-config-helpers.ts", import.meta.url), "utf8");

test("model config response parsing reports HTTP failures instead of raw JSON syntax errors", async () => {
  await assert.rejects(
    () => readApiJson(new Response(null, { status: 504, statusText: "Gateway Timeout" })),
    /HTTP 504 Gateway Timeout: empty response/,
  );
  await assert.rejects(
    () => readApiJson(new Response("Bad Gateway", { status: 502, statusText: "Bad Gateway" })),
    /HTTP 502 Bad Gateway: invalid JSON response/,
  );
  assert.deepEqual(
    await readApiJson(new Response(JSON.stringify({ success: true }), { headers: { "content-type": "application/json" } })),
    { success: true },
  );
});

test("model save requires an explicit success response and reports refresh issues", () => {
  const mainSaveStart = source.indexOf("const handleSave = useCallback(async (): Promise<boolean>");
  const mainSave = source.slice(mainSaveStart, source.indexOf("const isMainDirty", mainSaveStart));
  assert.match(mainSave, /d\.success !== true/);
  assert.match(mainSave, /timedOutSessionIds/);
  assert.match(mainSave, /models\.savedWithRefreshWarning/);
});


test("keeps Recap and auxiliary vision settings out of the model settings UI", () => {
  assert.doesNotMatch(source, /models\.tabRecap/);
  assert.doesNotMatch(source, /recap-config/);
  assert.doesNotMatch(source, /RecapModelConfigPanel/);
  assert.doesNotMatch(source, /models\.tabVision/);
  assert.doesNotMatch(source, /mode=\{modelTab === "vision"/);
});

test("keeps the default thinking level label and select on one responsive row", () => {
  const modelDetailStart = source.indexOf("function ModelDetail");
  const detail = source.slice(modelDetailStart, source.indexOf("function OAuthDetail", modelDetailStart));
  assert.match(detail, /<div style=\{\{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" \}\}>[\s\S]*?\{defaultThinkingLabel\}[\s\S]*?<Select/);
  assert.match(detail, /flex: "1 1 260px", minWidth: 0/);
  assert.doesNotMatch(detail, /<Field label=\{defaultThinkingLabel\}>/);
});

test("keeps visited model-setting tabs mounted without saving on tab switch", () => {
  for (const tab of ["main", "gen", "routing", "plugins"]) {
    assert.ok(source.includes(`visitedModelTabs.has("${tab}")`), `${tab} panel mounts once visited`);
    assert.ok(source.includes(`display: modelTab === "${tab}" ? "flex" : "none"`), `${tab} panel hides without unmounting`);
  }
  assert.match(source, /visitedModelTabs\.has\("gen"\)/);
  assert.match(source, /display: modelTab === "gen" \? "flex" : "none"/);
  assert.doesNotMatch(source, /mode=\{modelTab/);

  const tabsStart = source.indexOf("{/* Model tabs:");
  const clickStart = source.indexOf("onClick=", tabsStart);
  const clickEnd = source.indexOf("</button>", clickStart);
  const tabClick = source.slice(clickStart, clickEnd);
  assert.match(tabClick, /setModelTab\(tab\.key\)/);
  assert.match(tabClick, /setVisitedModelTabs/);
  assert.doesNotMatch(tabClick, /fetch|handleSave|saveAll|discardAll/);
});

test("loads combined auth provider lists and falls back for older peers", () => {
  assert.match(source, /fetch\(apiFor\(remotePeer, "auth\/providers"\)\)/);
  assert.match(source, /Array\.isArray\(data\.oauthProviders\)/);
  assert.match(source, /Array\.isArray\(data\.apiKeyProviders\)/);
  assert.match(source, /if \(hasCombinedApiKeyList\) return;/);
  assert.match(source, /fetch\(apiFor\(remotePeer, "auth\/all-providers"\)\)/);
  assert.match(source, /response\.ok && Array\.isArray\(data\.providers\)/);
});

test("custom model config exposes provider-level request headers", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.match(providerDetail, /<HeaderListEditor/);
  assert.match(providerDetail, /headers=\{provider\.headers\}/);
  assert.match(providerDetail, /set\("headers", headers\)/);
});

test("custom model config separates API-fixed and configurable system prompt roles", () => {
  assert.match(source, /headers=\{model\.headers\}/);
  assert.match(source, /set\("headers", headers\)/);
  assert.match(source, /resolveSystemPromptRole,/);
  assert.match(helperSource, /api === "openai-responses" \|\| api === "openai-completions"/);
  assert.match(source, /promptRole\.editable \?/);
  assert.match(source, /models\.roleApiFixed/);
  assert.match(source, /models\.roleEffective/);
  assert.doesNotMatch(source, /effectiveCompat\(provider, model\)\["supportsDeveloperRole"\] !== false/);
});

test("compatibility summary names explicit overrides instead of an unexplained score", () => {
  assert.match(source, /models\.compatSummary/);
  assert.match(source, /if \(promptRole\.editable\) compatibilityOverrideCount \+= 1/);
});

test("effective API provenance distinguishes adapter fallback from provider settings", () => {
  assert.match(source, /const effectiveApiSource = model\.api[\s\S]*?provider\.api[\s\S]*?models\.sourceAdapter/);
  assert.match(source, /source: effectiveApiSource/);
});

test("Anthropic system prompts are API-fixed and ignore developer-role overrides", () => {
  assert.deepEqual(
    resolveSystemPromptRole(
      { api: "anthropic-messages" },
      { reasoning: true, compat: { supportsDeveloperRole: true } },
    ),
    {
      api: "anthropic-messages",
      editable: false,
      selection: "",
      effective: "system",
      source: "api",
      ignoredOverride: true,
    },
  );
});

test("OpenAI Responses shows adapter defaults separately from explicit overrides", () => {
  assert.deepEqual(resolveSystemPromptRole(
    { api: "openai-responses" },
    { reasoning: true },
  ), {
    api: "openai-responses",
    editable: true,
    selection: "",
    effective: "developer",
    source: "adapter",
    ignoredOverride: false,
  });
  assert.equal(resolveSystemPromptRole(
    { api: "openai-responses" },
    { reasoning: true, compat: { supportsDeveloperRole: false } },
  ).effective, "system");
});

test("returning prompt role to default removes only its model override", () => {
  assert.deepEqual(
    setSystemPromptRole({ compat: { supportsStore: true, supportsDeveloperRole: false } }, ""),
    { compat: { supportsStore: true } },
  );
});

test("OpenAI Completions resolves provider fallback and both explicit override states", () => {
  assert.deepEqual(resolveSystemPromptRole(
    { api: "openai-completions", compat: { supportsDeveloperRole: false } },
    { reasoning: true },
  ), {
    api: "openai-completions",
    editable: true,
    selection: "",
    effective: "system",
    source: "provider",
    ignoredOverride: false,
  });
  assert.deepEqual(resolveSystemPromptRole(
    { api: "openai-completions" },
    { reasoning: true, compat: { supportsDeveloperRole: true } },
  ), {
    api: "openai-completions",
    editable: true,
    selection: "developer",
    effective: "developer",
    source: "model",
    ignoredOverride: false,
  });
  assert.deepEqual(resolveSystemPromptRole(
    { api: "openai-completions" },
    { reasoning: true, compat: { supportsDeveloperRole: false } },
  ), {
    api: "openai-completions",
    editable: true,
    selection: "system",
    effective: "system",
    source: "model",
    ignoredOverride: false,
  });
});

test("prompt role selections write explicit model overrides without losing other compat", () => {
  const entry = { compat: { supportsStore: true } };
  assert.deepEqual(setSystemPromptRole(entry, "developer"), {
    compat: { supportsStore: true, supportsDeveloperRole: true },
  });
  assert.deepEqual(setSystemPromptRole(entry, "system"), {
    compat: { supportsStore: true, supportsDeveloperRole: false },
  });
});

test("model settings expose a per-model default thinking level", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );
  assert.match(source, /THINKING_LEVEL_ORDER/);
  assert.match(modelDetail, /availableThinkingLevels/);
  assert.match(modelDetail, /model\.thinkingLevelMap\?\.\[level\]/);
  assert.match(modelDetail, /mappedThinkingLevels\.length > 0\s*\?\s*mappedThinkingLevels\s*:\s*availableThinkingLevels/);
  assert.match(modelDetail, /const showThinkingLevel = model\.reasoning === true;/);
  assert.match(modelDetail, /showThinkingLevel &&/);
  assert.match(modelDetail, /disabled=\{thinkingLevelOptions\.length === 0\}/);
  assert.match(modelDetail, /model\.defaultThinkingLevel/);
  assert.match(modelDetail, /set\("defaultThinkingLevel", level \|\| undefined\)/);
  assert.match(source, /defaultThinkingLevel\?: string/);
  assert.match(source, /apiFor\(remotePeer, "models-config"\)/);
});

test("model endpoint and adaptive thinking preserve inheritance and explicit overrides", () => {
  const model = { compat: { supportsStore: true } };
  assert.deepEqual(setCompatOverride(model, "forceAdaptiveThinking", true), { compat: { supportsStore: true, forceAdaptiveThinking: true } });
  assert.deepEqual(setCompatOverride(model, "forceAdaptiveThinking", false), { compat: { supportsStore: true, forceAdaptiveThinking: false } });
  assert.deepEqual(setCompatOverride({ compat: { supportsStore: true, forceAdaptiveThinking: false } }, "forceAdaptiveThinking", undefined), model);
  assert.deepEqual(setCompatOverride({ compat: { forceAdaptiveThinking: true } }, "forceAdaptiveThinking", undefined), { compat: undefined });
  assert.match(source, /baseUrl\?: string/);
  assert.match(source, /model\.baseUrl \?\? provider\.baseUrl/);
  assert.match(source, /set\("baseUrl", value \|\| undefined\)/);
  assert.match(source, /\(model\.api \?\? provider\.api\) === "anthropic-messages"/);
  assert.match(source, /setCompatOverride\(model, "forceAdaptiveThinking"/);
  assert.match(source, /requestId !== testRequestIdRef\.current \|\| draftIdentity !== draftIdentityRef\.current/);
  assert.match(source, /requestId !== catalogRequestIdRef\.current \|\| draftIdentity !== draftIdentityRef\.current/);
});

test("model settings expose Fast mode without discarding other sampling parameters", () => {
  assert.match(source, /samplingParams\?: Record<string, unknown>/);
  assert.match(source, /isFastModeSupported/);
  assert.match(source, /const fastModeModel = \{ \.\.\.model, api: model\.api \?\? provider\.api \}/);
  assert.match(source, /setFastModeDefault\(model, enabled\)/);
  assert.match(source, /models\.fastModeHelp/);
});test("disabling the developer role writes an explicit false override", () => {
  assert.deepEqual(
    setCompatBool({ compat: { supportsStore: true } }, "supportsDeveloperRole", false),
    { compat: { supportsStore: true, supportsDeveloperRole: false } },
  );
});

test("editing a header preserves row order and stable identities", () => {
  const rows = [
    { id: 10, name: "X-First", value: "one" },
    { id: 11, name: "X-Second", value: "two" },
  ];
  const updated = updateHeaderRow(rows, 10, { name: "X-First-Edited" });

  assert.deepEqual(updated.map(({ id, name }) => ({ id, name })), [
    { id: 10, name: "X-First-Edited" },
    { id: 11, name: "X-Second" },
  ]);
  assert.deepEqual(serializeHeaderRows(updated), {
    "X-First-Edited": "one",
    "X-Second": "two",
  });
});

test("blank header drafts are omitted until they have a name", () => {
  const rows = [
    { id: 1, name: "X-Existing", value: "kept" },
    { id: 2, name: "", value: "draft value" },
  ];

  assert.deepEqual(serializeHeaderRows(rows), { "X-Existing": "kept" });
  assert.deepEqual(
    serializeHeaderRows(updateHeaderRow(rows, 2, { name: "X-Draft" })),
    { "X-Existing": "kept", "X-Draft": "draft value" },
  );
});


test("model specs do not expose independent prices", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );
  const specsIndex = modelDetail.indexOf('t("models.modelSpecs")');
  const advancedIndex = modelDetail.indexOf('t("models.advancedSettings")');

  assert.ok(specsIndex >= 0);
  assert.ok(advancedIndex > specsIndex);
  assert.doesNotMatch(modelDetail, /models\.costPerMillion|models\.editCosts|parseCompleteModelCost|model\.cost/);
});

test("per-model settings use one primary divider before advanced settings", () => {
  const modelDetail = source.slice(
    source.indexOf("function ModelDetail"),
    source.indexOf("// ── OAuth detail"),
  );

  assert.equal(
    (modelDetail.match(/borderTop: "1px solid var\(--border\)"/g) ?? []).length,
    1,
  );
  assert.doesNotMatch(modelDetail, /borderBottom: "1px solid var\(--border\)"/);
});

test("thinking level overrides keep explicit default, disabled, and custom controls", () => {
  const editor = source.slice(
    source.indexOf("function ThinkingLevelMapEditor"),
    source.indexOf("// ── Model detail"),
  );

  assert.match(editor, /THINKING_LEVELS\.map/);
  assert.match(editor, />\s*Default\s*</);
  assert.match(editor, />\s*Disabled\s*</);
  assert.match(editor, />\s*Custom\s*</);
  assert.match(editor, /state === "omit"/);
  assert.match(editor, /state === "null"/);
  assert.match(editor, /state === "string"/);
});

test("enabled-model controls stay explicit while model-config saves only refresh their view", () => {
  assert.match(source, /useEnabledModels\(cwd \?\? null, remotePeer\)/);
  assert.match(source, /refreshEnabledModels\(\)/);
  assert.doesNotMatch(source, /resyncEnabledModels|collectModelRenames|savedModelIdsRef|renamesRef/);
  assert.match(source, /<EnabledModelsSection[\s\S]{0,220}peer=\{peer\}/);
  assert.match(source, /fetch\(apiFor\(peer, "models-config\/discover-managed"\)/);
  assert.ok(source.includes('fetch(apiFor(remotePeer, "models-config"'));
  assert.match(source, /<ProviderDetail[\s\S]{0,260}peer=\{remotePeer\}/);
});

test("provider fold state is shared between aggregate and embedded monitor panels", () => {
  assert.ok(source.includes("COLLAPSED_PROVIDERS_REQUEST_EVENT"));
  assert.ok(source.includes("window.parent.postMessage({ type: COLLAPSED_PROVIDERS_REQUEST_EVENT }"));
  assert.ok(source.includes("window.parent.postMessage({ type: COLLAPSED_PROVIDERS_SYNC_EVENT"));
  assert.ok(appShellSource.includes("COLLAPSED_PROVIDERS_REQUEST_EVENT"));
  assert.ok(appShellSource.includes("readCollapsedProviderNames()"));
  assert.ok(appShellSource.includes("writeCollapsedProviderNames(names)"));
  assert.ok(appShellSource.includes("COLLAPSED_PROVIDERS_CHANGED_EVENT"));
});

test("fold state persists to three-way-synced models.json instead of localStorage", () => {
  // AppShell 顶层启动时预取服务端折叠清单。
  assert.ok(appShellSource.includes("loadCollapsedProviderNames"));
  // 面板写回前确认服务端已加载，避免用空缓存覆盖 models.json 已有折叠。
  assert.ok(source.includes("isCollapsedProvidersLoaded"));
  assert.match(source, /if \(!isCollapsedProvidersLoaded\(\)\) return;/);
  // 面板监听模块缓存变化事件，预取完成/其他窗口写入后刷新折叠态。
  assert.ok(source.includes("window.addEventListener(COLLAPSED_PROVIDERS_CHANGED_EVENT, refresh)"));
});

test("visibility controls show current state and keep labels as actions", () => {
  const secret = source.slice(source.indexOf("function SecretTextInput"), source.indexOf("function NumInput"));
  assert.match(secret, /aria-label=\{visible \? t\("i18n\.hideDetails"\) : t\("i18n\.showDetails"\)\}/);
  assert.match(secret, /aria-pressed=\{visible\}/);
  assert.match(secret, /color: visible \? "var\(--accent\)" : "var\(--text-dim\)"/);
  assert.ok(secret.indexOf("M1 12") < secret.indexOf("M17.94"), "visible secret must use Eye before hidden secret uses EyeOff");
  assert.match(source, /isProviderCollapsed \? <EyeOff size=\{14\} strokeWidth=\{1\.8\} \/> : <Eye size=\{14\} strokeWidth=\{1\.8\} \/>/);
  assert.match(source, /color: isProviderCollapsed \? "var\(--text-dim\)" : "var\(--accent\)"/);
  assert.match(source, /hidden \? <EyeOff size=\{13\} strokeWidth=\{1\.8\} \/> : <Eye size=\{13\} strokeWidth=\{1\.8\} \/>/);
  assert.match(source, /color: hidden \? "var\(--text-dim\)" : "var\(--accent\)"/);
});

test("keeps per-model hidden state in the full config save", () => {
  assert.match(source, /interface ModelsJson[\s\S]*hiddenModels\?: string\[\]/);
  assert.match(source, /setConfig\(\(prev\) => \(\{ \.\.\.prev, hiddenModels: next \}\)\)/);
  assert.match(source, /body: JSON\.stringify\(\{ hiddenModels: next \}\)/);
  assert.match(source, /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/);
});

test("hidden model rows are opt-in without filtering providers", () => {
  assert.match(source, /const \[showHiddenModels, setShowHiddenModels\] = useState\(false\)/);
  assert.match(source, /const hiddenModelCount = customProviders\.reduce/);
  assert.ok(source.includes("const visibleModels = models"));
  assert.ok(source.includes("showHiddenModels || !model.id || !hiddenModels.includes(`${pName}/${model.id}`)"));
  assert.match(source, /aria-pressed=\{showHiddenModels\}/);
  assert.match(source, /disabled=\{hiddenModelCount === 0\}/);
  assert.match(source, /models\.showHiddenModels/);
  assert.match(source, /models\.hideHiddenModels/);
  assert.ok(source.includes("<span>{hiddenModelAction}</span>"));
  assert.ok(source.includes("visibleCustomProviders.map(([pName, pData])"));
});

test("hidden provider rows are opt-in without changing provider fold state", () => {
  assert.match(source, /const \[showHiddenProviders, setShowHiddenProviders\] = useState\(false\)/);
  assert.match(source, /const hiddenProviderCount = \[\.\.\.managedProviderIds\]\.filter/);
  assert.ok(source.includes("const visibleActiveOAuth = showHiddenProviders"));
  assert.ok(source.includes("activeOAuth.filter((provider) => !collapsedProviders.has(provider.id))"));
  assert.ok(source.includes("const visibleActiveApiKey = showHiddenProviders"));
  assert.ok(source.includes("activeApiKey.filter((provider) => !collapsedProviders.has(provider.id))"));
  assert.ok(source.includes("visibleActiveOAuth.map((p)"));
  assert.ok(source.includes("visibleActiveApiKey.map((p)"));
  assert.ok(source.includes("const visibleCustomProviders = showHiddenProviders"));
  assert.ok(source.includes("customProviders.filter(([name]) => !collapsedProviders.has(name))"));
  assert.match(source, /aria-pressed=\{showHiddenProviders\}/);
  assert.match(source, /disabled=\{hiddenProviderCount === 0\}/);
  assert.match(source, /models\.showHiddenProviders/);
  assert.match(source, /models\.hideHiddenProviders/);
  assert.ok(source.includes("<span>{hiddenProviderAction}</span>"));
});

test("managed provider rows use the same compact icon size as custom provider rows", () => {
  const treeStart = source.indexOf("{/* Left: tree */");
  const treeEnd = source.indexOf("{/* Add provider */", treeStart);
  const tree = source.slice(treeStart, treeEnd);
  assert.deepEqual(
    [...tree.matchAll(/<ProviderIcon id=\{p\.id\} size=\{(\d+)\} \/>/g)].map((match) => match[1]),
    ["11", "11"],
  );
  assert.match(tree, /<svg width="11" height="11"/);
});

test("reloads model and auth state when active device changes", () => {
  const authStart = source.indexOf("const loadAuthProviders = useCallback");
  const authEnd = source.indexOf("const refreshAuthProviders", authStart);
  const authSource = source.slice(authStart, authEnd);
  assert.match(authSource, /apiFor\(remotePeer, "auth\/providers"\)/);
  assert.match(authSource, /\}, \[remotePeer\]\);/);

  const configStart = source.indexOf("fetch(apiFor(remotePeer, \"models-config\"))");
  const configEnd = source.indexOf("const addCustomProvider", configStart);
  const configSource = source.slice(source.lastIndexOf("useEffect(() => {", configStart), configEnd);
  assert.ok(configStart >= 0, "model config fetch follows current peer");
  assert.match(configSource, /let cancelled = false/);
  assert.match(configSource, /\[refreshAuthProviders, remotePeer\]\);/);
});

test("image providers stay independent while vision candidates follow main-tree fold state", () => {
  assert.ok(source.includes('remotePeer={remotePeer} onChanged={() => { changedRef.current = true; }}'));
  assert.ok(!source.includes("hiddenProviders={collapsedProviders}"));
  // The auxiliary vision-model surface was removed; image generation now owns
  // only image providers and no longer mirrors the main model tree.
  assert.doesNotMatch(imageGenSource, /visionProvider|visionModelId|hiddenProviders|setVisionModel/);
});

test("renaming a provider keeps its place", () => {
  const config = {
    providers: {
      first: { models: [{ id: "a" }] },
      stepfun: { baseUrl: "https://x", models: [{ id: "aaa" }, { id: "ddd" }] },
      last: {},
    },
  };
  const renamed = renameProviderEntry(config, "stepfun", "house");

  assert.deepEqual(Object.keys(renamed.providers), ["first", "house", "last"]);
  assert.equal(renamed.providers.house, config.providers.stepfun);
  assert.deepEqual(Object.keys(renameProviderEntry(renamed, "house", "stepfun").providers), ["first", "stepfun", "last"]);
});

test("renaming a provider onto another provider's id changes nothing", () => {
  const config = { providers: { one: { models: [{ id: "a" }] }, two: { models: [{ id: "b" }] } } };
  assert.equal(renameProviderEntry(config, "one", "two"), null);
  assert.equal(renameProviderEntry(config, "gone", "three"), null);
});

test("a provider added since the last save is renamed without a settings rewrite", () => {
  const config = { providers: { "new-provider": {} } };
  const renamed = renameProviderEntry(config, "new-provider", "house");
  assert.deepEqual(Object.keys(renamed.providers), ["house"]);
});

test("Save applies a provider name typed without pressing Rename", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  // The field edits the panel's draft, not state the Save button cannot see.
  assert.doesNotMatch(providerDetail, /useState\(name\)/);
  assert.match(providerDetail, /onChange=\{onEditingNameChange\}/);

  const save = source.slice(
    source.indexOf("const handleSave = useCallback"),
    source.indexOf("const providers = Object.entries(config.providers"),
  );
  assert.match(save, /applyProviderRename\(config, providerNameDraft\.provider, pendingName\)/);
  assert.match(save, /body: JSON\.stringify\(draft\)/);
  assert.match(save, /refreshEnabledModels\(\)/);
  assert.doesNotMatch(save, /collectModelRenames|resyncEnabledModels|savedModelIdsRef|renamesRef/);
});

test("model discovery is not gated on a configured base URL", () => {
  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  // pi resolves the endpoint for a provider that only lists models, so an empty
  // Base URL must still let the user fetch the upstream list.
  assert.match(providerDetail, /if \(discoveryState\.phase === "loading"\) return;/);
  assert.match(providerDetail, /disabled=\{discoveryState\.phase === "loading"\}/);
  assert.doesNotMatch(providerDetail, /!provider\.baseUrl\?\.trim\(\)/);
  assert.doesNotMatch(providerDetail, /Leave empty for a built-in provider to use the endpoint pi ships/);
  assert.doesNotMatch(providerDetail, /Added to every request from this provider/);
  assert.doesNotMatch(providerDetail, /Prefix with.*shell-command/);
  assert.match(providerDetail, /placeholder=\{t\("models\.apiKeyPlaceholder"\)\}/);
});

test("discovered model imports keep endpoint and capability metadata", () => {
  const addModels = source.slice(
    source.indexOf("const addDiscoveredModels"),
    source.indexOf("const updateModel", source.indexOf("const addDiscoveredModels")),
  );
  assert.match(addModels, /discoveredModelToConfig/);
  assert.match(addModels, /discoveredModel\.api === undefined/);
  assert.match(addModels, /provider\.api/);
  assert.match(addModels, /discoveredModel\.baseUrl === undefined/);
  assert.match(addModels, /provider\.baseUrl/);
  assert.match(source, /cost\?: ModelCost/);
});

test("discovered selection keeps identical IDs separate across endpoints", () => {
  const provider = { api: "openai-completions", baseUrl: "https://gateway.example/v1" };
  const fixture = [
    { id: "shared", name: "Shared / east", api: "openai-completions", baseUrl: "https://east.example/v1" },
    { id: "shared", name: "Shared / west", api: "openai-completions", baseUrl: "https://west.example/v1" },
  ];
  const identity = (model) => modelDiscoveryKey({
    id: model.id,
    api: model.api ?? provider.api,
    baseUrl: model.baseUrl ?? provider.baseUrl,
  });
  const keys = fixture.map(identity);
  assert.equal(new Set(keys).size, fixture.length);

  // This mirrors ProviderDetail's selection/addition boundary: an existing
  // east endpoint does not collapse the west endpoint with the same id; the
  // SDK-level conflict is surfaced and the addition is rejected.
  const existingKeys = new Set([keys[0]]);
  const selectedKeys = new Set(keys);
  const selectedById = new Map();
  const conflicts = new Set();
  for (const model of fixture) {
    const key = identity(model);
    if (!selectedKeys.has(key)) continue;
    const previous = selectedById.get(model.id);
    if ((existingKeys.has(keys[0]) && key !== keys[0]) || (previous && previous !== key)) conflicts.add(model.id);
    selectedById.set(model.id, key);
  }
  assert.deepEqual([...conflicts], ["shared"]);
  const additions = conflicts.size === 0
    ? fixture.filter((model) => selectedKeys.has(identity(model)) && !existingKeys.has(identity(model)))
    : [];
  assert.deepEqual(additions, []);

  const providerDetail = source.slice(
    source.indexOf("function ProviderDetail"),
    source.indexOf("// ── ThinkingLevelMap editor"),
  );
  assert.match(providerDetail, /const existingModelKeys = new Set/);
  assert.match(providerDetail, /discoveredModelIdentity\(provider, model\)/);
  assert.match(providerDetail, /selectedModelKeys/);
  assert.match(providerDetail, /selectedConflictIds/);
  assert.match(providerDetail, /same provider\/model ID cannot use multiple endpoints/);
  assert.match(providerDetail, /key=\{key\}/);
  assert.match(providerDetail, /endpointLabel/);
  assert.match(providerDetail, /endpointConflict/);

  const addModels = source.slice(
    source.indexOf("const addDiscoveredModels"),
    source.indexOf("const updateModel", source.indexOf("const addDiscoveredModels")),
  );
  assert.match(addModels, /const existingKeys = new Set/);
  assert.match(addModels, /const discoveredWithProviderDefaults =/);
  assert.match(addModels, /discoveredModelIdentity\(currentProvider, modelWithProviderDefaults\)/);
  assert.match(addModels, /if \(existingKeys\.has\(key\)\) continue/);
  assert.match(addModels, /findModelEndpointConflicts/);

  const saveStart = source.indexOf("const handleSave = useCallback");
  const save = source.slice(saveStart, source.indexOf("const isMainDirty", saveStart));
  assert.match(save, /findModelEndpointConflicts\(draft\)/);
  assert.match(save, /setSaveError\(`\$\{t\("files\.conflict"\)\}/);
});
