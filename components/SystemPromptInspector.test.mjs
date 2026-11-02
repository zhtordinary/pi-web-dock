import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { installEnglishTestLocale } from "./test-locale.mjs";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
await installEnglishTestLocale(jiti);
const { SystemPromptInspector } = await jiti.import("./SystemPromptInspector.tsx");
const { I18nProvider } = await jiti.import("../hooks/useI18n.tsx");

function inspectionWithCost(status = "calculated") {
  const baseline = { sha256: "a".repeat(64), characters: 14, estimatedTokens: 17 };
  return {
    version: 1,
    sessionId: "fixture-session",
    cwd: "/fixture",
    capturedAt: "2026-01-01T00:00:00.000Z",
    snapshotId: "fixture-snapshot",
    evidence: {
      basis: "agent-session-runtime",
      systemPromptSource: "agent.state.systemPrompt",
      providerRequestCaptured: false,
      note: "fixture evidence",
    },
    systemPrompt: {
      ...baseline,
      lines: 1,
      estimatedInputCost: {
        provider: "fixture-provider",
        model: "fixture-model",
        amount: status === "calculated" ? 0.123456 : null,
        currency: "USD",
        status,
      },
    },
    contextSources: [],
    tools: [],
    skills: [],
    extensions: [],
    skillRuntime: {
      baseline,
      activeCount: 1,
      last: {
        status: "settled",
        skillName: "hidden-runtime-skill",
        policyKey: "fixture-policy",
        baselineBefore: baseline,
        baselineAfter: baseline,
        baselineUnchanged: true,
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    errors: [],
  };
}

function renderInspector(inspection, prompt = "fixture prompt") {
  return renderToStaticMarkup(createElement(I18nProvider, null,
    createElement(SystemPromptInspector, { prompt, inspection })));
}

test("system prompt inspector renders runtime evidence tabs and prompt metadata", async () => {
  const html = renderInspector(inspectionWithCost());
  for (const label of ["Runtime snapshot", "AgentSession snapshot", "System prompt", "Context sources", "Tool capabilities", "Skills", "Extensions", "Copy original"]) {
    assert.ok(html.includes(label), label);
  }
  assert.equal((html.match(/role="tab"/g) ?? []).length, 5);
  assert.match(html, /role="tablist"/);
  assert.match(html, /role="tabpanel"/);
  assert.match(html, /fixture prompt/);
  assert.match(html, /≈ 17 tokens/);

  const source = await readFile(new URL("./SystemPromptInspector.tsx", import.meta.url), "utf8");
  assert.match(source, /displayInspection\?\.contextSources/);
  assert.match(source, /displayInspection\?\.tools/);
  assert.match(source, /displayInspection\?\.skills/);
  assert.match(source, /displayInspection\?\.extensions/);
  assert.doesNotMatch(source, /inspection\.evidence\.note/);
  assert.doesNotMatch(source, /gridTemplateColumns/);
  assert.match(source, /height: "min\(680px, 78vh\)"/);
  assert.match(source, /flex: "0 0 auto"/);
  assert.match(source, /flex: "1 1 auto"/);
  assert.match(source, /system\.inspection\.filterInPrompt/);
  assert.match(source, /system\.inspection\.filterExplicitOnly/);
  assert.match(source, /system\.inspection\.filterNotInPrompt/);
  assert.match(source, /system\.inspection\.filterActive/);
  assert.doesNotMatch(source, /system\.inspection\.filterPromptListed/);
  assert.doesNotMatch(source, /system\.inspection\.promptNotListed/);
  assert.match(source, /system\.inspection\.filterInactive/);
  assert.match(source, /system\.inspection\.expandDesc/);
  assert.match(source, /system\.inspection\.filterLoaded/);
  assert.match(source, /system\.inspection\.filterFailed/);
  assert.match(source, /filteredSkills\.map/);
  assert.match(source, /filteredTools\.map/);
  assert.match(source, /filteredExtensions\.map/);
  assert.match(source, /filteredContextSources\.map/);
  assert.match(source, /RuntimeSourceTags/);
  assert.doesNotMatch(source, /provider cache hit|cache hit/i);
  assert.match(source, /extensionDisplayName/);
  assert.match(source, /system\.inspection\.scopeProject/);
  assert.doesNotMatch(source, /<strong[^>]*>\{item\.path\}<\/strong>/);
});

test("system prompt inspector omits cost and skill diagnostics from populated snapshots", () => {
  for (const status of ["calculated", "unavailable"]) {
    const html = renderInspector(inspectionWithCost(status));
    assert.match(html, /fixture prompt/);
    assert.doesNotMatch(html, /fixture-provider|fixture-model|estimated input cost|current model pricing unavailable|Estimated at about 4 characters/);
    assert.doesNotMatch(html, /skill-runtime-evidence|providerRequestCaptured=false|Reader local baseline|hidden-runtime-skill|Dynamic calls pending/);
  }
});

test("system prompt inspector retains loading and partial-error states", () => {
  assert.match(renderInspector(null, null), /System prompt has not loaded yet/);
  const inspection = inspectionWithCost();
  inspection.errors = ["fixture evidence unavailable"];
  const html = renderInspector(inspection);
  assert.match(html, /role="alert"/);
  assert.match(html, /fixture evidence unavailable/);
  assert.match(html, /fixture prompt/);
});

test("AppShell renders the inspector instead of reconstructing prompt evidence", async () => {
  const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  assert.match(source, /<SystemPromptInspector/);
  assert.match(source, /inspection=\{runtimeInspection\}/);
  assert.match(source, /onRuntimeInspectionChange=\{handleRuntimeInspectionChange\}/);
});


test("runtime inspector keeps complete tool evidence behind the single system entry", async () => {
  const appShell = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
  const inspector = await readFile(new URL("./SystemPromptInspector.tsx", import.meta.url), "utf8");
  assert.match(inspector, /parameters/);
  assert.match(inspector, /description/);
  assert.match(inspector, /promptGuidelines/);
  assert.match(appShell, /activeTopPanel === "system"[\s\S]*?<SystemPromptInspector/);
  assert.doesNotMatch(appShell, /handleSystemInfoToggle\("tools"/);
  assert.doesNotMatch(appShell, /ToolDefinitionsPanel/);
});

test("system prompt inspector header omits estimated cost and baseline SHA in rendered output per user request", async () => {
  const inspector = await readFile(new URL("./SystemPromptInspector.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(inspector, /estimatedInputCost && \(/);
  assert.doesNotMatch(inspector, /SkillRuntimeEvidencePanel evidence/);
});
