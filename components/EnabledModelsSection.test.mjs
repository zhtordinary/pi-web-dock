import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const {
  enabledModelsBulkActions,
  enabledModelsProviderToggle,
  filterEnabledModels,
  isLastEnabledModel,
  providerBadgeLabel,
} = await jiti.import("./enabled-models-helpers.ts");

const source = await readFile(new URL("./EnabledModelsSection.tsx", import.meta.url), "utf8");
const modelsConfigSource = await readFile(new URL("./ModelsConfig.tsx", import.meta.url), "utf8");
const cssSource = await readFile(new URL("../app/settings.css", import.meta.url), "utf8");

const entry = (id, enabled, extra = {}) => ({
  id,
  name: id.toUpperCase(),
  ref: `anthropic/${id}`,
  enabled,
  ...extra,
});

function view(models, overrides = {}) {
  return {
    allEnabled: false,
    patterns: ["anthropic/*"],
    stalePatterns: [],
    enabledTotal: models.filter((model) => model.enabled).length,
    availableTotal: models.length,
    providers: [{
      id: "anthropic",
      name: "Anthropic",
      kind: "builtin",
      enabledCount: models.filter((model) => model.enabled).length,
      models,
    }],
    scope: "global",
    editable: true,
    ...overrides,
  };
}

test("the filter matches model ids and display names", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  assert.deepEqual(filterEnabledModels(models, "opu").map((model) => model.id), ["opus"]);
  assert.deepEqual(filterEnabledModels(models, "SONNET").map((model) => model.id), ["sonnet"]);
  assert.equal(filterEnabledModels(models, "   ").length, 2);
});

test("bulk actions only offer the direction that changes something", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  // Other providers keep models on, so both directions are live here.
  const actions = enabledModelsBulkActions(view(models, { enabledTotal: 4 }), models);
  assert.deepEqual(actions.enableRefs, ["anthropic/opus"]);
  assert.deepEqual(actions.disableRefs, ["anthropic/sonnet"]);
  assert.equal(actions.canEnable, true);
  assert.equal(actions.canDisable, true);

  const allOn = [entry("sonnet", true), entry("opus", true)];
  assert.equal(enabledModelsBulkActions(view(allOn), allOn).canEnable, false);
});

test("a bulk disable that would empty the scope is withheld", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const actions = enabledModelsBulkActions(view(models), models);
  assert.equal(actions.canDisable, false);
  assert.deepEqual(actions.disableRefs, ["anthropic/sonnet"]);
});

test("a bulk disable stays available while other providers keep models on", () => {
  const models = [entry("sonnet", true)];
  const scoped = view(models, { enabledTotal: 3, availableTotal: 5 });
  assert.equal(enabledModelsBulkActions(scoped, models).canDisable, true);
});

test("an unrestricted scope can narrow with a bulk disable", () => {
  const models = [entry("sonnet", true), entry("opus", true)];
  const unrestricted = view(models, { allEnabled: true, patterns: null, enabledTotal: 3 });
  const actions = enabledModelsBulkActions(unrestricted, models);
  assert.equal(actions.canDisable, true);
  assert.equal(actions.canEnable, false);
});

test("an unrestricted scope with one model still protects the last model", () => {
  const models = [entry("sonnet", true)];
  const unrestricted = view(models, { allEnabled: true, patterns: null, enabledTotal: 1 });
  assert.equal(enabledModelsBulkActions(unrestricted, models).canDisable, false);
});

test("read-only project scope disables both bulk actions", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const readOnly = view(models, { scope: "project", editable: false, enabledTotal: 4 });
  const actions = enabledModelsBulkActions(readOnly, models);
  assert.equal(actions.canEnable, false);
  assert.equal(actions.canDisable, false);
});

test("the last enabled model is locked on", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  const single = view(models);
  assert.equal(isLastEnabledModel(single, models[0]), true);
  assert.equal(isLastEnabledModel(single, models[1]), false);
  assert.equal(isLastEnabledModel(view(models, { enabledTotal: 2 }), models[0]), false);
});

test("the sidebar badge only appears while the selector is narrowed", () => {
  const models = [entry("sonnet", true), entry("opus", false)];
  assert.equal(providerBadgeLabel(view(models), "anthropic"), "1/2");
  assert.equal(providerBadgeLabel(view(models, { allEnabled: true }), "anthropic"), null);
  assert.equal(providerBadgeLabel(view(models), "openai"), null);
  assert.equal(providerBadgeLabel(null, "anthropic"), null);
});

test("edits are serialized within one workspace generation", () => {
  assert.match(source, /if \(pendingRef\.current\?\.generation === generation\) \{\s*\n\s*queuedRef\.current = \{ generation, key, body \};\s*\n\s*return;/);
  assert.match(source, /pendingRef\.current = request;/);
  assert.match(source, /pendingRef\.current === request/);
  assert.match(source, /if \(succeeded && isCurrent\(\)\) mutateRef\.current\?\.\(queued\.key, queued\.body\)/);
  assert.match(source, /const busy = pending !== null;/);
});

test("an unfiltered bulk action is resolved by the server, a filtered one by refs", () => {
  assert.match(
    source,
    /if \(filtered\) controller\.setModels\(bulkKey, refs, enabled\);\s*\n\s*else controller\.setProvider\(provider\.id, enabled\);/,
  );
});

test("known refusals are shown as localized text, not raw server strings", () => {
  assert.match(source, /"last-model": "models\.enabledLastModel"/);
  assert.match(source, /"project-scope": "models\.enabledProjectScope"/);
  assert.match(source, /"unverified-models": "models\.enabledStaleHint"/);
  assert.match(source, /"unrestricted-scope": "models\.enabledUnrestrictedScope"/);
  assert.match(source, /"unsafe-scope": "models\.enabledUnsafeScope"/);
  assert.match(source, /"revision-conflict": "models\.enabledRevisionConflict"/);
  assert.match(source, /role="alert" className="enabled-models-error"/);
  assert.match(source, /failure\.messageKey \? t\(failure\.messageKey\) : failure\.message/);
});

test("switches are locked while the scope is not editable or unsafe", () => {
  assert.match(source, /disabled=\{busy \|\| !view\?\.editable \|\| \(view\.allEnabled && view\.patterns !== null\) \|\| lastOne\}/);
});

test("unrestricted scope does not render an informational banner", () => {
  assert.doesNotMatch(source, /showUnrestrictedScopeNote|unrestrictedScopeNoteId/);
  assert.doesNotMatch(source, /当前未设置 enabledModels/);
});

test("a custom provider is switched from its header, by one switch and no prose", () => {
  assert.match(source, /export function EnabledModelsProviderSwitch\(\{/);
  assert.match(source, /onChange=\{\(checked\) => controller\.setProvider\(provider\.id, checked\)\}/);
  // Nothing about it is explained in body text any more.
  assert.doesNotMatch(source, /enabledCustomHint/);
  assert.doesNotMatch(source, /provider\.kind === "custom"/);
});

test("why a switch cannot move is visible text it points at, never only its tooltip", () => {
  // The provider switch keeps its name and points at the note under the detail header.
  assert.match(source, /label=\{t\("models\.enabledProviderToggle", \{ provider: provider\.name \}\)\}\s*\n\s*describedBy=\{describedBy\}/);
  assert.match(source, /return key \? <div id=\{id\} className="config-detail-heading-note">\{t\(key\)\}<\/div> : null;/);
  assert.match(
    modelsConfigSource,
    /<\/ConfigDetailHeader>\s*\n\s*<EnabledModelsProviderSwitchNote providerId=\{name\} controller=\{enabledModels\} id=\{switchNoteId\} \/>/,
  );
  // A built-in provider's rows and Disable all point at the section's notes.
  assert.doesNotMatch(source, /showUnrestrictedScopeNote|unrestrictedScopeNoteId/);
  assert.match(source, /\{showLastModelNote && <div id=\{lastModelNoteId\} className="enabled-models-note">\{t\("models\.enabledLastModel"\)\}<\/div>\}/);
  assert.match(source, /disabled=\{busy \|\| !view\?\.editable \|\| \(view\.allEnabled && view\.patterns !== null\) \|\| lastOne\}/);
  assert.doesNotMatch(source, /view\.patterns === null\n\s*\? unrestrictedScopeNoteId/);
  // No reason lives in a label or a title any more.
  assert.doesNotMatch(source, /title=\{[^}]*enabledLastModel/);
  assert.doesNotMatch(source, /label=\{[^}]*(enabledLastModel|enabledCustomEmpty|FAILURE_KEYS)/);
});

test("the provider switch is on only while every model of the provider is", () => {
  const providerOf = (models, overrides = {}) => {
    const full = view(models, overrides);
    return [full, { ...full.providers[0], kind: "custom" }];
  };

  // Other providers keep models on, so both directions are live here.
  const [allOn, allOnProvider] = providerOf([entry("sonnet", true), entry("opus", true)], { enabledTotal: 4 });
  assert.deepEqual(enabledModelsProviderToggle(allOn, allOnProvider), { checked: true, blocked: false, reason: null });

  // A partial selection reads as off, and one click completes it.
  const [partial, partialProvider] = providerOf([entry("sonnet", true), entry("opus", false)], { enabledTotal: 4 });
  assert.deepEqual(enabledModelsProviderToggle(partial, partialProvider), { checked: false, blocked: false, reason: null });

  const [none, noneProvider] = providerOf([entry("sonnet", false), entry("opus", false)], { enabledTotal: 3 });
  assert.deepEqual(enabledModelsProviderToggle(none, noneProvider), { checked: false, blocked: false, reason: null });
});

test("the provider switch is locked when it would empty the scope or the file is read-only", () => {
  const unrestricted = view([entry("sonnet", true), entry("opus", true)], { allEnabled: true, patterns: null, enabledTotal: 2 });
  assert.deepEqual(
    enabledModelsProviderToggle(unrestricted, { ...unrestricted.providers[0], kind: "custom" }),
    { checked: true, blocked: true, reason: "unrestricted-scope" },
  );

  const lockedOn = view([entry("sonnet", true), entry("opus", true)], { enabledTotal: 2 });
  assert.deepEqual(
    enabledModelsProviderToggle(lockedOn, { ...lockedOn.providers[0], kind: "custom" }),
    { checked: true, blocked: true, reason: "last-model" },
  );

  const readOnly = view([entry("sonnet", true), entry("opus", false)], {
    scope: "project",
    editable: false,
    enabledTotal: 4,
  });
  assert.deepEqual(
    enabledModelsProviderToggle(readOnly, { ...readOnly.providers[0], kind: "custom" }),
    { checked: false, blocked: true, reason: "project-scope" },
  );
});

test("the section is mounted for authenticated built-in providers", () => {
  const oauth = modelsConfigSource.slice(
    modelsConfigSource.indexOf("function OAuthDetail"),
    modelsConfigSource.indexOf("// ── API Key detail"),
  );
  const apiKey = modelsConfigSource.slice(
    modelsConfigSource.indexOf("function ApiKeyDetail"),
    modelsConfigSource.indexOf("// ── Add provider picker"),
  );
  assert.match(oauth, /provider\.loggedIn && \([\s\S]*?<EnabledModelsSection/);
  assert.match(apiKey, /provider\.configured && \([\s\S]*?<EnabledModelsSection/);
  assert.match(source, /export function EnabledModelsSection/);
});

test("model name and identifier share one line with distinct hierarchy", () => {
  assert.match(source, /<span className="enabled-models-row-name" title=\{model\.name\}>/);
  assert.match(source, /className="enabled-models-row-id" title=\{model\.id\}/);
  const rowText = cssSource.slice(
    cssSource.indexOf(".enabled-models-row-text {"),
    cssSource.indexOf(".enabled-models-pin {"),
  );
  assert.match(rowText, /display: flex;[\s\S]*align-items: baseline;/);
  assert.match(rowText, /\.enabled-models-row-name \{[\s\S]*font-size: 12px;/);
  assert.match(rowText, /\.enabled-models-row-id \{[\s\S]*font-size: 10px;/);
});

test("scope and catalog requests follow the selected remote peer", () => {
  assert.match(source, /fetch\(apiFor\(peer, `models\/enabled\$\{query\}`\)/);
  assert.match(source, /fetch\(apiFor\(peer, "models\/enabled"\)/);
  assert.match(source, /fetch\(apiFor\(peer, "models\/refresh"\)/);
});

test("the banner reports unmatched entries without offering unsafe automatic removal", () => {
  assert.match(source, /t\("models\.enabledStale", \{ count: stale \}\)/);
  assert.doesNotMatch(source, /pruneStale|enabledPrune/);
});

test("a missing custom provider is not blamed on a sign-in", () => {
  const switchSource = source.slice(
    source.indexOf("export function EnabledModelsProviderSwitch"),
    source.indexOf("export function EnabledModelsSection"),
  );
  assert.match(switchSource, /"models\.enabledCustomEmpty"/);
  assert.doesNotMatch(switchSource, /enabledUnavailable/);
});

test("the section carries the usage heading font and no rule above it", () => {
  assert.match(source, /<span className="enabled-models-title">/);
  const title = cssSource.slice(cssSource.indexOf(".enabled-models-title {"));
  assert.match(title.slice(0, title.indexOf("}")), /font-size: 13px;[\s\S]*font-weight: 600;/);
  const section = cssSource.slice(cssSource.indexOf(".enabled-models-section {"));
  assert.doesNotMatch(section.slice(0, section.indexOf("}")), /border-top/);
});

test("saving models.json refreshes the scope view without writing enabledModels", () => {
  assert.match(modelsConfigSource, /refreshEnabledModels\(\)/);
  assert.doesNotMatch(modelsConfigSource, /resyncEnabledModels|collectModelRenames|savedModelIdsRef|trackAddedModels/);
  assert.doesNotMatch(source, /resync|modelRenames|fullyEnabled/);
  assert.match(source, /EnabledModelsController/);
});

test("provider rows carry the scope badge", () => {
  assert.match(cssSource, /\.models-sidebar-badge \{/);
  assert.match(cssSource, /\.enabled-models-row \+ \.enabled-models-row \{/);
});

test("model-config edits do not keep a second enabledModels rename-tracking state", () => {
  assert.doesNotMatch(modelsConfigSource, /savedModelIdsRef|trackAddedModels|collectModelRenames|renamesRef/);
});
