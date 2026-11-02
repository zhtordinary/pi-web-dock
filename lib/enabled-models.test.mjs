import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const {
  clearEnabledModels,
  computeEnabledModelsState,
  modelRefProvider,
  pruneStaleEnabledModels,
  validateProviderEntries,
  renameModelPatterns,
  renameProviderPatterns,
  setModelsEnabled,
} = await jiti.import("./enabled-models.ts");

const AVAILABLE = [
  "anthropic/claude-sonnet-4-6",
  "anthropic/claude-opus-4-1",
  "anthropic/claude-haiku-4-5",
  "openai/gpt-5.5",
  "zen/x:exacto",
];

/** Stand-in for the SDK resolver: exact refs, `provider/*` globs and `*`. */
function resolve(pattern, availableRefs) {
  const colon = pattern.lastIndexOf(":");
  const levels = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
  const suffix = colon >= 0 ? pattern.slice(colon + 1) : "";
  const pin = levels.has(suffix) ? suffix : undefined;
  const body = pin ? pattern.slice(0, colon) : pattern;
  // Like minimatch: `*` stops at a slash, `**` crosses it.
  const matched = body === "*"
    ? availableRefs.filter((ref) => !ref.slice(ref.indexOf("/") + 1).includes("/"))
    : body === "**"
      ? [...availableRefs]
      : body.endsWith("/**")
        ? availableRefs.filter((ref) => modelRefProvider(ref) === body.slice(0, -3))
        : body.endsWith("/*")
          ? availableRefs.filter((ref) => (
            modelRefProvider(ref) === body.slice(0, -2)
              && !ref.slice(ref.indexOf("/") + 1).includes("/")
          ))
          : availableRefs.filter((ref) => ref === body);
  return { pattern, matched, ...(pin ? { pin } : {}) };
}

function input(patterns, availableRefs = AVAILABLE) {
  return {
    patterns,
    availableRefs,
    resolutions: (patterns ?? []).map((pattern) => resolve(pattern, availableRefs)),
  };
}

test("state reports everything enabled when no pattern narrows the list", () => {
  assert.deepEqual(computeEnabledModelsState(input(undefined)), {
    allEnabled: true,
    enabled: AVAILABLE,
    pins: {},
    stalePatterns: [],
  });
});

test("state treats a fully stale list as unscoped and keeps the stale patterns", () => {
  const state = computeEnabledModelsState(input(["gone/*", "missing/model"]));
  assert.equal(state.allEnabled, true);
  assert.deepEqual(state.enabled, AVAILABLE);
  assert.deepEqual(state.stalePatterns, ["gone/*", "missing/model"]);
});

test("state resolves globs, pins and stale entries together", () => {
  const state = computeEnabledModelsState(input(["anthropic/*:high", "openai/gpt-5.5", "gone/*"]));
  assert.equal(state.allEnabled, false);
  assert.deepEqual(state.enabled, [
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-1",
    "anthropic/claude-haiku-4-5",
    "openai/gpt-5.5",
  ]);
  assert.equal(state.pins["anthropic/claude-opus-4-1"], "high");
  assert.deepEqual(state.stalePatterns, ["gone/*"]);
});

test("the first matching rule wins even when it has no thinking pin", () => {
  const state = computeEnabledModelsState(input([
    "anthropic/claude-sonnet-4-6",
    "anthropic/*:high",
    "anthropic/claude-opus-4-1:low",
  ]));
  assert.equal(state.pins["anthropic/claude-sonnet-4-6"], undefined);
  assert.equal(state.pins["anthropic/claude-opus-4-1"], "high");
});

test("an unrestricted scope cannot be rebuilt from an incomplete catalog", () => {
  assert.deepEqual(setModelsEnabled(input(undefined), ["anthropic/claude-opus-4-1"], false), {
    ok: false, reason: "unsafe-scope",
  });
});

test("disabling one model must not silently remove unseen models covered by a glob", () => {
  const visible = ["anthropic/one", "anthropic/two", "openai/three"];
  const later = [...visible, "anthropic/temporarily-unavailable"];
  const before = input(["anthropic/*", "openai/three"], visible);
  const edit = setModelsEnabled(before, ["anthropic/one"], false);
  if (!edit.ok) {
    assert.equal(edit.reason, "unsafe-scope");
    return;
  }
  const after = computeEnabledModelsState(input(edit.patterns, later));
  assert.ok(after.enabled.includes("anthropic/temporarily-unavailable"), "the previous glob enabled this model");
  assert.ok(!after.enabled.includes("anthropic/one"), "the chosen model remains disabled");
});

test("disabling one model from an unrestricted scope must not silently remove unseen providers", () => {
  const visible = ["anthropic/one", "openai/two"];
  const later = [...visible, "unseen-provider/three"];
  const edit = setModelsEnabled(input(undefined, visible), ["anthropic/one"], false);
  if (!edit.ok) {
    assert.equal(edit.reason, "unsafe-scope");
    return;
  }
  const after = computeEnabledModelsState(input(edit.patterns, later));
  assert.ok(after.enabled.includes("unseen-provider/three"), "the unrestricted scope included this provider");
  assert.ok(!after.enabled.includes("anthropic/one"), "the chosen model remains disabled");
});

test("a pinned glob cannot be expanded using only currently available models", () => {
  const before = input(["anthropic/*:high", "openai/gpt-5.5"]);
  assert.deepEqual(setModelsEnabled(before, ["anthropic/claude-opus-4-1"], false), {
    ok: false, reason: "unsafe-scope",
  });
  assert.deepEqual(before.patterns, ["anthropic/*:high", "openai/gpt-5.5"]);
});

test("disable drops a pattern that matched only the removed model", () => {
  const result = setModelsEnabled(
    input(["anthropic/claude-opus-4-1", "openai/gpt-5.5"]),
    ["anthropic/claude-opus-4-1"],
    false,
  );
  assert.deepEqual(result.patterns, ["openai/gpt-5.5"]);
});

test("a precise disable preserves untouched globs, unknown entries, order and pins", () => {
  const before = input(["gone/*", "anthropic/claude-opus-4-1:high", "openai/gpt-5.5:low", "future/model"]);
  assert.deepEqual(setModelsEnabled(before, ["anthropic/claude-opus-4-1"], false), {
    ok: true, patterns: ["gone/*", "openai/gpt-5.5:low", "future/model"], changed: true,
  });
});

test("a disable that changes no available model does not rewrite anything", () => {
  const before = input(["anthropic/*", "gone/*"]);
  assert.deepEqual(setModelsEnabled(before, ["openai/gpt-5.5"], false), {
    ok: true, patterns: before.patterns, changed: false,
  });
});

test("an unresolved matcher error prevents a scope write without changing its patterns", () => {
  const before = input(["anthropic/claude-opus-4-1", "openai/gpt-5.5", "broken/*"]);
  before.resolutions[2].unverified = true;
  assert.deepEqual(setModelsEnabled(before, ["anthropic/claude-opus-4-1"], false), {
    ok: false, reason: "unsafe-scope",
  });
  assert.deepEqual(before.patterns, ["anthropic/claude-opus-4-1", "openai/gpt-5.5", "broken/*"]);
});

test("a bare model id cannot be rewritten as if it were a provider-qualified reference", () => {
  const before = {
    patterns: ["same-id", "openai/gpt-5.5"],
    availableRefs: ["anthropic/same-id", "openai/gpt-5.5"],
    resolutions: [{ pattern: "same-id", matched: ["anthropic/same-id"] }, { pattern: "openai/gpt-5.5", matched: ["openai/gpt-5.5"] }],
  };
  assert.deepEqual(setModelsEnabled(before, ["anthropic/same-id"], false), { ok: false, reason: "unsafe-scope" });
});

test("a precise entry cannot mask an overlapping unsafe pattern", () => {
  const before = input(["anthropic/*", "anthropic/claude-opus-4-1"]);
  assert.deepEqual(setModelsEnabled(before, ["anthropic/claude-opus-4-1"], false), {
    ok: false, reason: "unsafe-scope",
  });
});

test("disabling a provider cannot discard unknown matches of its glob", () => {
  const before = input(["anthropic/*", "openai/gpt-5.5", "gone/*"]);
  assert.deepEqual(setModelsEnabled(before, [
    "anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-1", "anthropic/claude-haiku-4-5",
  ], false), { ok: false, reason: "unsafe-scope" });
});

test("disabling the last enabled model is refused", () => {
  const result = setModelsEnabled(input(["openai/gpt-5.5"]), ["openai/gpt-5.5"], false);
  assert.deepEqual(result, { ok: false, reason: "last-model" });
});

test("stale patterns alone do not count as an enabled model", () => {
  const result = setModelsEnabled(input(["openai/gpt-5.5", "gone/*"]), ["openai/gpt-5.5"], false);
  assert.deepEqual(result, { ok: false, reason: "last-model" });
});

test("enable appends the model and preserves entry order", () => {
  const result = setModelsEnabled(
    input(["openai/gpt-5.5", "anthropic/claude-opus-4-1"]),
    ["anthropic/claude-sonnet-4-6"],
    true,
  );
  assert.deepEqual(result.patterns, [
    "openai/gpt-5.5",
    "anthropic/claude-opus-4-1",
    "anthropic/claude-sonnet-4-6",
  ]);
});

test("enabling one model preserves the exact entries and their order", () => {
  const result = setModelsEnabled(
    input(["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "anthropic/claude-opus-4-1"]),
    ["anthropic/claude-haiku-4-5"],
    true,
  );
  assert.deepEqual(result.patterns, ["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "anthropic/claude-opus-4-1", "anthropic/claude-haiku-4-5"]);
});

test("enable keeps explicit entries when the provider carries a thinking pin", () => {
  const result = setModelsEnabled(
    input(["anthropic/claude-sonnet-4-6:high", "anthropic/claude-opus-4-1"]),
    ["anthropic/claude-haiku-4-5"],
    true,
  );
  assert.deepEqual(result.patterns, [
    "anthropic/claude-sonnet-4-6:high",
    "anthropic/claude-opus-4-1",
    "anthropic/claude-haiku-4-5",
  ]);
});

test("enable is a no-op when the model is already covered", () => {
  const before = input(["anthropic/*", "openai/gpt-5.5"]);
  const result = setModelsEnabled(before, ["anthropic/claude-opus-4-1"], true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.patterns, before.patterns);
});

test("enabling a model while the scope is unrestricted or entirely unmatched changes nothing", () => {
  for (const before of [input(undefined), input([]), input(["unknown-provider/*"])]) {
    assert.deepEqual(setModelsEnabled(before, ["openai/gpt-5.5"], true), {
      ok: true, patterns: before.patterns, changed: false,
    });
  }
});

test("enabling the last currently available model keeps the original scope", () => {
  const result = setModelsEnabled(input(["anthropic/*", "openai/*"]), ["zen/x:exacto"], true);
  assert.deepEqual(result.patterns, ["anthropic/*", "openai/*", "zen/x:exacto"]);
  assert.equal(result.changed, true);
});

test("a stale pattern keeps the setting alive even when everything is enabled", () => {
  const result = setModelsEnabled(
    input(["anthropic/*", "openai/*", "gone/*"]),
    ["zen/x:exacto"],
    true,
  );
  assert.deepEqual(result.patterns, ["anthropic/*", "openai/*", "gone/*", "zen/x:exacto"]);
});

test("a thinking pin keeps the setting alive even when everything is enabled", () => {
  const result = setModelsEnabled(
    input(["anthropic/*:high", "openai/*"]),
    ["zen/x:exacto"],
    true,
  );
  assert.deepEqual(result.patterns, ["anthropic/*:high", "openai/*", "zen/x:exacto"]);
});

test("a precise model id containing a colon can be disabled without changing other pins", () => {
  const before = input(["zen/x:exacto:low", "openai/gpt-5.5:high"]);
  assert.deepEqual(setModelsEnabled(before, ["zen/x:exacto"], false), {
    ok: true, patterns: ["openai/gpt-5.5:high"], changed: true,
  });
});

test("unknown references are ignored instead of being written out", () => {
  const before = input(["anthropic/*"]);
  const result = setModelsEnabled(before, ["ghost/model"], true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.patterns, before.patterns);
});

test("clearing the scope drops every pattern, stale ones included", () => {
  assert.deepEqual(clearEnabledModels(input(["anthropic/*", "gone/*"])), {
    ok: true,
    patterns: undefined,
    changed: true,
  });
  assert.equal(clearEnabledModels(input(undefined)).changed, false);
});

// ── Model ids containing slashes (extension providers, OpenRouter, …) ─────────

const NESTED = [
  "commandcode/gpt-5.5",
  "commandcode/sakana/fugu-ultra",
  "commandcode/moonshotai/kimi-k2.6",
  "openai/gpt-5.5",
  "openai/gpt-5.4",
];

test("enabling nested model ids retains exact references and order", () => {
  const result = setModelsEnabled(
    input(["commandcode/gpt-5.5", "openai/gpt-5.5"], NESTED),
    ["commandcode/sakana/fugu-ultra", "commandcode/moonshotai/kimi-k2.6"],
    true,
  );
  assert.deepEqual(result.patterns, ["commandcode/gpt-5.5", "openai/gpt-5.5", "commandcode/sakana/fugu-ultra", "commandcode/moonshotai/kimi-k2.6"]);
});

test("enabling missing nested models preserves an existing provider glob", () => {
  const result = setModelsEnabled(
    input(["commandcode/*", "openai/gpt-5.5"], NESTED),
    NESTED.filter((ref) => ref.startsWith("commandcode/")),
    true,
  );
  assert.deepEqual(result.patterns, ["commandcode/*", "openai/gpt-5.5", "commandcode/sakana/fugu-ultra", "commandcode/moonshotai/kimi-k2.6"]);
});

test("unrestricted nested models are not materialized from the current catalog", () => {
  assert.deepEqual(setModelsEnabled(input(undefined, NESTED), ["openai/gpt-5.5"], false), {
    ok: false, reason: "unsafe-scope",
  });
});

test("enabling a nested model keeps the provider's explicit entries", () => {
  const stored = ["commandcode/gpt-5.5", "commandcode/sakana/fugu-ultra"];
  const result = setModelsEnabled(input(stored, NESTED), ["commandcode/moonshotai/kimi-k2.6"], true);
  assert.deepEqual(result.patterns, [...stored, "commandcode/moonshotai/kimi-k2.6"]);
});

// ── Preserving unrelated scope entries ───────────────────────────────────────

test("editing one provider never broadens another provider's explicit scope", () => {
  const result = setModelsEnabled(
    input(["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-1", "anthropic/claude-haiku-4-5"]),
    ["openai/gpt-5.5"],
    true,
  );
  assert.deepEqual(result.patterns, ["anthropic/claude-sonnet-4-6", "anthropic/claude-opus-4-1", "anthropic/claude-haiku-4-5", "openai/gpt-5.5"]);
});

test("a single exact reference is left alone, even when it covers its provider", () => {
  const result = setModelsEnabled(
    input(["openai/gpt-5.5", "anthropic/claude-sonnet-4-6"]),
    ["anthropic/claude-opus-4-1"],
    true,
  );
  assert.deepEqual(result.patterns, [
    "openai/gpt-5.5",
    "anthropic/claude-sonnet-4-6",
    "anthropic/claude-opus-4-1",
  ]);
});

test("an entry beside a glob is retained when another model is enabled", () => {
  const result = setModelsEnabled(
    input(["anthropic/*", "anthropic/claude-opus-4-1"]),
    ["openai/gpt-5.5"],
    true,
  );
  assert.deepEqual(result.patterns, ["anthropic/*", "anthropic/claude-opus-4-1", "openai/gpt-5.5"]);
});

test("an enable leaves partly enabled providers and unmatched entries alone", () => {
  const result = setModelsEnabled(
    input(["anthropic/claude-sonnet-4-6", "openai/gpt-5.5", "gone/*"]),
    ["anthropic/claude-opus-4-1"],
    true,
  );
  assert.deepEqual(result.patterns, [
    "anthropic/claude-sonnet-4-6",
    "openai/gpt-5.5",
    "gone/*",
    "anthropic/claude-opus-4-1",
  ]);
});

test("an enable keeps a provider whose entries pin a thinking level", () => {
  const result = setModelsEnabled(
    input([
      "anthropic/claude-sonnet-4-6:high",
      "anthropic/claude-opus-4-1:high",
      "anthropic/claude-haiku-4-5:high",
    ]),
    ["openai/gpt-5.5"],
    true,
  );
  assert.deepEqual(result.patterns, [
    "anthropic/claude-sonnet-4-6:high",
    "anthropic/claude-opus-4-1:high",
    "anthropic/claude-haiku-4-5:high",
    "openai/gpt-5.5",
  ]);
});


// ── Pruning entries that match nothing ───────────────────────────────────────

test("pruning refuses to treat a signed-out provider as deleted", () => {
  const before = input(["deepseek/v4-flash:high", "anthropic/*", "gone/*", "openai/gpt-5.5"]);
  assert.deepEqual(pruneStaleEnabledModels(before), { ok: false, reason: "unverified-models" });
  assert.deepEqual(before.patterns, ["deepseek/v4-flash:high", "anthropic/*", "gone/*", "openai/gpt-5.5"]);
});

test("pruning is a no-op when every entry matches", () => {
  const before = input(["anthropic/*", "openai/gpt-5.5"]);
  assert.deepEqual(pruneStaleEnabledModels(before), { ok: true, patterns: before.patterns, changed: false });
});

test("pruning an entirely unavailable list never clears the setting", () => {
  const before = input(["gone/*", "missing/model"]);
  assert.deepEqual(pruneStaleEnabledModels(before), { ok: false, reason: "unverified-models" });
  assert.deepEqual(before.patterns, ["gone/*", "missing/model"]);
});

test("pruning with an empty catalog never discards configured patterns", () => {
  const before = input(["anthropic/*:high", "other/model"], []);
  assert.deepEqual(pruneStaleEnabledModels(before), { ok: false, reason: "unverified-models" });
  assert.deepEqual(before.patterns, ["anthropic/*:high", "other/model"]);
});

test("a wider pattern already covering a provider is not rewritten", () => {
  // `*` covers both openai models here (it stops at the nested commandcode ids),
  // so openai's own entries are redundant and stay exactly as written.
  const before = input(["*", "openai/gpt-5.5", "openai/gpt-5.4"], NESTED);
  const result = setModelsEnabled(before, ["openai/gpt-5.5"], true);
  assert.equal(result.changed, false);
  assert.deepEqual(result.patterns, before.patterns);
});

// ── Following a custom provider that was renamed in models.json ─────────────

test("renaming rewrites the entries of that provider and keeps the rest", () => {
  assert.deepEqual(
    renameProviderPatterns(
      ["my-gateway/alpha:high", "my-gateway/*", "anthropic/*", "my-gateway-old/x"],
      [{ from: "my-gateway", to: "house" }],
    ),
    ["house/alpha:high", "house/*", "anthropic/*", "my-gateway-old/x"],
  );
});

test("renaming several providers at once is one rewrite", () => {
  assert.deepEqual(
    renameProviderPatterns(["a/one", "b/two", "c/three"], [{ from: "a", to: "x" }, { from: "b", to: "y" }]),
    ["x/one", "y/two", "c/three"],
  );
});

test("renaming is a no-op without patterns or without a real rename", () => {
  assert.equal(renameProviderPatterns(undefined, [{ from: "a", to: "b" }]), undefined);
  const before = ["anthropic/*"];
  assert.equal(renameProviderPatterns(before, []), before);
  assert.equal(renameProviderPatterns(before, [{ from: "a", to: "a" }]), before);
  assert.deepEqual(renameProviderPatterns(before, [{ from: "x", to: "y" }]), before);
});

// ── Entries whose provider prefix stopped scoping them ──────────────────────

const OVERMATCH = [
  "stepfun/aaa",
  "stepfun/ddd",
  "commandcode/stepfun/Step-5-Preview",
  "commandcode/gpt-5.5",
];

/** Hand-built resolution: pi matches a pattern against the bare model id too. */
function overmatchInput(patterns, resolutions) {
  return { patterns, availableRefs: OVERMATCH, resolutions };
}

test("a glob reaching into another provider cannot be narrowed from a partial catalog", () => {
  const result = validateProviderEntries(overmatchInput(
    ["commandcode/gpt-5.5", "stepfun/*"],
    [
      { pattern: "commandcode/gpt-5.5", matched: ["commandcode/gpt-5.5"] },
      {
        pattern: "stepfun/*",
        matched: ["stepfun/aaa", "stepfun/ddd", "commandcode/stepfun/Step-5-Preview"],
      },
    ],
  ));
  assert.deepEqual(result, { ok: false, reason: "unsafe-scope" });
});

test("a cross-provider glob with a thinking pin cannot be narrowed", () => {
  const result = validateProviderEntries(overmatchInput(
    ["stepfun/*:high"],
    [{
      pattern: "stepfun/*:high",
      matched: ["stepfun/aaa", "commandcode/stepfun/Step-5-Preview"],
      pin: "high",
    }],
  ));
  assert.deepEqual(result, { ok: false, reason: "unsafe-scope" });
});

test("an entry that stays inside its provider is left alone", () => {
  const before = overmatchInput(
    ["stepfun/aaa", "commandcode/**"],
    [
      { pattern: "stepfun/aaa", matched: ["stepfun/aaa"] },
      { pattern: "commandcode/**", matched: ["commandcode/stepfun/Step-5-Preview", "commandcode/gpt-5.5"] },
    ],
  );
  const result = validateProviderEntries(before);
  assert.equal(result.changed, false);
  assert.deepEqual(result.patterns, before.patterns);
});

test("a bare model id that only looks like a prefix is left alone", () => {
  // `stepfun/Step-5-Preview` is commandcode's model id, not a stepfun scope.
  const before = overmatchInput(
    ["stepfun/Step-5-Preview"],
    [{ pattern: "stepfun/Step-5-Preview", matched: ["commandcode/stepfun/Step-5-Preview"] }],
  );
  const result = validateProviderEntries(before);
  assert.equal(result.changed, false);
  assert.deepEqual(result.patterns, before.patterns);
});

test("a catch-all pattern names no provider and is never cut back", () => {
  const before = overmatchInput(
    ["**"],
    [{ pattern: "**", matched: [...OVERMATCH] }],
  );
  assert.equal(validateProviderEntries(before).changed, false);
});

// ── Following a model that was renamed in models.json ───────────────────────

test("renaming a model rewrites its entry and keeps the pin", () => {
  assert.deepEqual(
    renameModelPatterns(
      ["stepfun/aaa", "stepfun/ddd", "stepfun/ddd:high", "stepfun/*"],
      [{ from: "stepfun/ddd", to: "stepfun/ddd1" }],
    ),
    ["stepfun/aaa", "stepfun/ddd1", "stepfun/ddd1:high", "stepfun/*"],
  );
});

test("a colon inside a model id is not mistaken for a thinking pin", () => {
  assert.deepEqual(
    renameModelPatterns(["zen/x:exacto"], [{ from: "zen/x", to: "zen/y" }]),
    ["zen/x:exacto"],
  );
  assert.deepEqual(
    renameModelPatterns(["zen/x:exacto:high"], [{ from: "zen/x:exacto", to: "zen/y" }]),
    ["zen/y:high"],
  );
});

test("renaming a model is a no-op without patterns or without a real rename", () => {
  assert.equal(renameModelPatterns(undefined, [{ from: "a/b", to: "a/c" }]), undefined);
  const before = ["stepfun/aaa"];
  assert.equal(renameModelPatterns(before, []), before);
  assert.deepEqual(renameModelPatterns(before, [{ from: "stepfun/zzz", to: "stepfun/yyy" }]), before);
});

test("a model rename spells the provider id the settings file still uses", () => {
  // Applied before the provider rewrite, so both moves land in one pass.
  const afterModels = renameModelPatterns(
    ["old/ddd", "old/*"],
    [{ from: "old/ddd", to: "new/ddd1" }],
  );
  assert.deepEqual(renameProviderPatterns(afterModels, [{ from: "old", to: "new" }]), [
    "new/ddd1",
    "new/*",
  ]);
});
