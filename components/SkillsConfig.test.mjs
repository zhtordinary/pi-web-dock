import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { readFile } = await import("node:fs/promises");
const {
  getPluginSkillGroupStatus,
  getSkillRuntimeDiagnosis,
  getSkillCurrentStateLabel,
  getSkillPolicyLabel,
  getSkillInvocationAdviceLabel,
  getSkillStateDotTone,
  getSkillAdviceConflict,
  getSkillListBadge,
  getSkillChecklistItems,
  isSkillsPanelRequestCurrent,
  skillEffectiveUseState,
  isSkillVisible,
} = await jiti.import("./SkillsConfig.tsx");

test("skill scope badges localize global and use the shared neutral background", async () => {
  const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /t\("skills\.scope\.global"\)/);
  assert.match(source, /<ConfigScopeTag scope=\{label\}>\{displayLabel\}<\/ConfigScopeTag>/);
});

test("maps plugin skill group status for the visual indicator", () => {
  const enabled = { source: "npm:tool", scope: "global", disabled: false };
  const disabled = { source: "npm:tool", scope: "global", disabled: true };

  assert.equal(getPluginSkillGroupStatus(undefined, {}), "unknown");
  assert.equal(getPluginSkillGroupStatus("npm:missing", {}), "unknown");
  assert.equal(getPluginSkillGroupStatus("npm:tool", { "npm:tool": enabled }), "enabled");
  assert.equal(getPluginSkillGroupStatus("npm:tool", { "npm:tool": disabled }), "disabled");
});

test("labels the current effective invocation state from the runtime diagnosis", () => {
  const t = (key) => key;
  assert.equal(getSkillCurrentStateLabel({ code: "fully-enabled" }, t), "i18n.skillCurrentStateAutomatic");
  assert.equal(getSkillCurrentStateLabel({ code: "explicit-only" }, t), "i18n.skillCurrentStateManual");
  assert.equal(getSkillCurrentStateLabel({ code: "plugin-disabled" }, t), "i18n.skillCurrentStateUnavailable");
  assert.equal(getSkillCurrentStateLabel({ code: "collision" }, t), "i18n.skillCurrentStateUnavailable");
});

test("labels SKILL.md declaration separately from the current effective state", () => {
  const t = (key) => key;
  assert.equal(
    getSkillPolicyLabel({ disableModelInvocation: false, declaresManualInvocation: false }, t),
    "i18n.skillConfigNoManualDeclaration",
  );
  assert.equal(
    getSkillPolicyLabel({ disableModelInvocation: true, declaresManualInvocation: true }, t),
    "i18n.skillConfigDeclaredManual",
  );
  // Runtime flag cleared by an explicit override: the declaration must still be reported.
  assert.equal(
    getSkillPolicyLabel({ disableModelInvocation: false, declaresManualInvocation: true }, t),
    "i18n.skillConfigManualOverridden",
  );
});

test("reports AI invocation advice without overriding configuration", () => {
  const t = (key) => key;
  assert.equal(
    getSkillInvocationAdviceLabel({ triggerMode: "automatic", triggerModeSource: "ai" }, { code: "fully-enabled" }, t),
    "i18n.skillAdviceAiAutomatic",
  );
  assert.equal(
    getSkillInvocationAdviceLabel({ triggerMode: "manual", triggerModeSource: "ai" }, { code: "explicit-only" }, t),
    "i18n.skillAdviceAiManual",
  );
  assert.equal(
    getSkillInvocationAdviceLabel({ triggerMode: "automatic", triggerModeSource: "fallback" }, { code: "fully-enabled" }, t),
    "i18n.skillAdviceFallback",
  );
  assert.equal(
    getSkillInvocationAdviceLabel({ triggerMode: undefined, triggerModeSource: undefined }, { code: "fully-enabled" }, t),
    "i18n.skillAdviceNotAnalyzed",
  );
  // A manual declaration is decided by configuration, so no AI advice applies.
  assert.equal(
    getSkillInvocationAdviceLabel(
      { triggerMode: "manual", triggerModeSource: "frontmatter", declaresManualInvocation: true },
      { code: "explicit-only" },
      t,
    ),
    "i18n.skillAdviceConfiguredManual",
  );
  // A content-current recommendation remains useful while a resource is disabled.
  assert.equal(
    getSkillInvocationAdviceLabel(
      { triggerMode: "manual", triggerModeSource: "ai" },
      { code: "plugin-disabled" },
      t,
    ),
    "i18n.skillAdviceAiManual",
  );
});

test("keeps the state dot tied to the effective runtime policy", () => {
  assert.equal(getSkillStateDotTone({ code: "fully-enabled" }), "automatic");
  assert.equal(getSkillStateDotTone({ code: "explicit-only" }), "manual");
  assert.equal(getSkillStateDotTone({ code: "plugin-disabled" }), "unavailable");
  assert.equal(getSkillStateDotTone({ code: "collision" }), "unavailable");
});

test("shows a distinct AI advice badge only when advice differs from the current setting", () => {
  const t = (key) => key;
  const automatic = { code: "fully-enabled" };
  const manual = { code: "explicit-only" };
  const manualAdvice = { triggerMode: "manual", triggerModeSource: "ai" };
  const automaticAdvice = { triggerMode: "automatic", triggerModeSource: "ai" };
  assert.deepEqual(getSkillListBadge(manualAdvice, automatic, t), {
    label: "i18n.skillListAdviceManual", tone: "advice",
  });
  assert.deepEqual(getSkillListBadge(automaticAdvice, manual, t), {
    label: "i18n.skillListAdviceAutomatic", tone: "advice",
  });
  assert.deepEqual(getSkillListBadge(automaticAdvice, automatic, t), {
    label: "i18n.skillCurrentStateAutomatic", tone: "automatic",
  });
  assert.deepEqual(getSkillListBadge(manualAdvice, manual, t), {
    label: "i18n.skillCurrentStateManual", tone: "manual",
  });

  for (const skill of [
    {},
    { ...manualAdvice, triggerModeSource: "fallback" },
    { ...manualAdvice, triggerModeSource: "frontmatter" },
    { ...manualAdvice, triggerMode: undefined },
    { ...manualAdvice, declaresManualInvocation: true },
  ]) {
    assert.deepEqual(getSkillListBadge(skill, automatic, t), {
      label: "i18n.skillCurrentStateAutomatic", tone: "automatic",
    });
  }
  for (const code of ["plugin-disabled", "project-excluded", "global-excluded", "collision", "error"]) {
    assert.deepEqual(getSkillListBadge(manualAdvice, { code }, t), {
      label: "i18n.skillCurrentStateUnavailable", tone: "unavailable",
    });
  }
});

test("localizes concise list advice without changing detail advice", async () => {
  for (const [locale, exportName, manual, automatic] of [
    ["zh-CN", "zhCNLocale", "AI 建议：手动触发", "AI 建议：自动调用"],
    ["zh-TW", "zhTWLocale", "AI 建議：手動觸發", "AI 建議：自動呼叫"],
    ["en", "enLocale", "AI advice: manual trigger", "AI advice: auto-invoke"],
  ]) {
    const { messages } = (await jiti.import(`../lib/i18n/messages/${locale}.ts`))[exportName];
    assert.equal(messages["i18n.skillListAdviceManual"], manual);
    assert.equal(messages["i18n.skillListAdviceAutomatic"], automatic);
    assert.notEqual(messages["i18n.skillAdviceAiManual"], manual);
  }
});

test("keeps the policy row honest about an overridden declaration", () => {
  const t = (key) => key;
  // Declaration still on the file, but the runtime flag was cleared by an override.
  const overridden = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: false,
    declaresManualInvocation: true,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diag = getSkillRuntimeDiagnosis(overridden, { viewScope: "global" });
  assert.equal(diag.code, "fully-enabled");
  assert.equal(diag.promptIncluded, true);
  assert.equal(getSkillPolicyLabel(overridden, t), "i18n.skillConfigManualOverridden");
  assert.match(diag.reasonDetail, /skillDiagReasonFrontmatterOverride/);
  assert.match(diag.diagnosticRule, /effective setting: enabled/);
});

test("keeps the declared manual state authoritative when no override is present", () => {
  const t = (key) => key;
  const declared = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: true,
    declaresManualInvocation: true,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diag = getSkillRuntimeDiagnosis(declared, { viewScope: "global" });
  assert.equal(diag.code, "explicit-only");
  assert.equal(diag.promptIncluded, false);
  assert.equal(diag.commandUsable, true);
  assert.equal(getSkillCurrentStateLabel(diag, t), "i18n.skillCurrentStateManual");
  assert.equal(getSkillPolicyLabel(declared, t), "i18n.skillConfigDeclaredManual");
  assert.match(diag.diagnosticRule, /disable-model-invocation: true/);
});

test("attributes an explicit global automatic-invocation disable to Reader settings, not SKILL.md", () => {
  const skill = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: true,
    declaresManualInvocation: false,
    globalInvocationOverride: "disabled",
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diagnosis = getSkillRuntimeDiagnosis(skill, { viewScope: "global" });
  assert.equal(diagnosis.code, "explicit-only");
  assert.equal(diagnosis.runtimeLoaded, true);
  assert.equal(diagnosis.commandUsable, true);
  assert.match(diagnosis.diagnosticRule, /global setting: piWebGlobalSkillInvocationOverrides = disabled/);
  assert.doesNotMatch(diagnosis.diagnosticRule, /frontmatter/);
  assert.equal(getSkillPolicyLabel(skill, (key) => key), "i18n.skillConfigNoManualDeclaration");
});

test("builds execution checklist items for runtime, prompt, and manual command", () => {
  const t = (key, params) => (params?.name ? `${key}:${params.name}` : key);
  const skill = { name: "demo-skill" };

  // Fully enabled: all 3 good
  const fullItems = getSkillChecklistItems({
    runtimeLoaded: true,
    promptIncluded: true,
    commandUsable: true,
  }, skill, t);
  assert.equal(fullItems.length, 3);
  assert.equal(fullItems[0].key, "runtime");
  assert.equal(fullItems[0].icon, "✓");
  assert.equal(fullItems[0].state, "good");
  assert.equal(fullItems[0].title, "i18n.skillChecklistRuntimeTitle");
  assert.equal(fullItems[0].detail, "i18n.skillChecklistRuntimeLoaded");
  assert.equal(fullItems[1].key, "prompt");
  assert.equal(fullItems[1].icon, "✓");
  assert.equal(fullItems[1].state, "good");
  assert.equal(fullItems[1].title, "i18n.skillChecklistPromptTitle");
  assert.equal(fullItems[1].detail, "i18n.skillChecklistPromptIncluded");
  assert.equal(fullItems[2].key, "manual");
  assert.equal(fullItems[2].icon, "✓");
  assert.equal(fullItems[2].state, "good");
  assert.equal(fullItems[2].title, "i18n.skillChecklistManualTitle");
  assert.equal(fullItems[2].detail, "i18n.skillChecklistManualAvailable:demo-skill");

  // Explicit only (amber): runtime loaded, prompt warned/excluded, manual command available
  const manualItems = getSkillChecklistItems({
    runtimeLoaded: true,
    promptIncluded: false,
    commandUsable: true,
  }, skill, t);
  assert.equal(manualItems[0].icon, "✓");
  assert.equal(manualItems[0].state, "good");
  assert.equal(manualItems[1].icon, "⊘");
  assert.equal(manualItems[1].state, "warn");
  assert.equal(manualItems[1].iconColor, "#f59e0b");
  assert.equal(manualItems[1].detail, "i18n.skillChecklistPromptExcluded");
  assert.equal(manualItems[2].icon, "✓");

  // Unloaded / plugin disabled: runtime error, prompt muted, manual muted
  const unloadedItems = getSkillChecklistItems({
    runtimeLoaded: false,
    promptIncluded: false,
    commandUsable: false,
  }, skill, t);
  assert.equal(unloadedItems[0].icon, "✗");
  assert.equal(unloadedItems[0].state, "error");
  assert.equal(unloadedItems[0].detail, "i18n.skillChecklistRuntimeNotLoaded");
  assert.equal(unloadedItems[1].icon, "✗");
  assert.equal(unloadedItems[1].state, "muted");
  assert.equal(unloadedItems[2].icon, "✗");
  assert.equal(unloadedItems[2].state, "muted");
  assert.equal(unloadedItems[2].detail, "i18n.skillChecklistManualUnavailable");
});

test("flags a conflict only when the current state contradicts the AI advice", () => {
  const automaticAdvice = { triggerMode: "automatic", triggerModeSource: "ai" };
  const manualAdvice = { triggerMode: "manual", triggerModeSource: "ai" };
  assert.equal(getSkillAdviceConflict(automaticAdvice, { code: "fully-enabled" }), false);
  assert.equal(getSkillAdviceConflict(automaticAdvice, { code: "explicit-only" }), true);
  assert.equal(getSkillAdviceConflict(manualAdvice, { code: "explicit-only" }), false);
  assert.equal(getSkillAdviceConflict(manualAdvice, { code: "fully-enabled" }), true);
  // No advice or an unavailable runtime cannot conflict.
  assert.equal(getSkillAdviceConflict({}, { code: "fully-enabled" }), false);
  assert.equal(getSkillAdviceConflict(manualAdvice, { code: "plugin-disabled" }), false);
  assert.equal(
    getSkillAdviceConflict({ ...manualAdvice, declaresManualInvocation: true }, { code: "fully-enabled" }),
    false,
  );
});

test("diagnoses fully-enabled skill with prompt inclusion and runtime loaded", () => {
  const skill = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: false,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diag = getSkillRuntimeDiagnosis(skill, { viewScope: "global" });
  assert.equal(diag.code, "fully-enabled");
  assert.equal(diag.runtimeLoaded, true);
  assert.equal(diag.promptIncluded, true);
  assert.equal(diag.commandUsable, true);
  assert.equal(diag.badgeTone, "good");
  assert.equal(diag.executionSummary, "skills.summaryAutomatic");
});

test("diagnoses explicit-only skill when disable-model-invocation is true", () => {
  const skill = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: true,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diag = getSkillRuntimeDiagnosis(skill, { viewScope: "global" });
  assert.equal(diag.code, "explicit-only");
  assert.equal(diag.runtimeLoaded, true);
  assert.equal(diag.promptIncluded, false);
  assert.equal(diag.commandUsable, true);
  assert.equal(diag.badgeTone, "warn");
  assert.match(diag.diagnosticRule, /disable-model-invocation: true/);
});

test("diagnoses project effective manual override separately from file declaration", () => {
  const skill = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: false,
    effectiveSkillEnabled: false,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const diag = getSkillRuntimeDiagnosis(skill, { viewScope: "project" });
  assert.equal(diag.code, "explicit-only");
  assert.equal(diag.runtimeLoaded, true);
  assert.equal(diag.promptIncluded, false);
  assert.equal(diag.commandUsable, true);
  assert.match(diag.diagnosticRule, /effectiveSkillEnabled = false/);
});

test("diagnoses plugin-disabled skill when parent plugin package is disabled", () => {
  const skill = {
    name: "demo",
    filePath: "/packages/tool/skills/demo/SKILL.md",
    resourceEnabled: true,
    disableModelInvocation: false,
    sourceInfo: { scope: "project", origin: "package", source: "npm:tool" },
  };
  const diag = getSkillRuntimeDiagnosis(skill, {
    viewScope: "project",
    pluginPackages: {
      "npm:tool": { source: "npm:tool", scope: "project", disabled: true },
    },
  });
  assert.equal(diag.code, "plugin-disabled");
  assert.equal(diag.runtimeLoaded, false);
  assert.equal(diag.promptIncluded, false);
  assert.equal(diag.commandUsable, false);
  assert.equal(diag.badgeTone, "muted");
  assert.match(diag.diagnosticRule, /packages\["npm:tool"\]\.disabled = true/);
});

test("diagnoses project-excluded skill when projectOverride is disabled", () => {
  const skill = {
    name: "demo",
    filePath: "/packages/tool/skills/demo/SKILL.md",
    resourceEnabled: false,
    projectOverride: "disabled",
    pluginResourceKey: "skills/demo/SKILL.md",
    sourceInfo: { scope: "user", origin: "package", source: "npm:tool" },
  };
  const diag = getSkillRuntimeDiagnosis(skill, {
    viewScope: "project",
    pluginPackages: {
      "npm:tool": { source: "npm:tool", scope: "global", disabled: false },
    },
  });
  assert.equal(diag.code, "project-excluded");
  assert.equal(diag.runtimeLoaded, false);
  assert.match(diag.diagnosticRule, /rule: -skills\/demo\/SKILL\.md/);
});

test("diagnoses collision and error diagnostics", () => {
  const skill = {
    name: "demo",
    filePath: "/skills/demo/SKILL.md",
    resourceEnabled: false,
    sourceInfo: { scope: "user", origin: "top-level" },
  };
  const collisionDiag = getSkillRuntimeDiagnosis(skill, {
    viewScope: "global",
    diagnostics: [
      {
        type: "collision",
        message: 'name "demo" collision',
        collision: {
          name: "demo",
          winnerPath: "/higher/demo/SKILL.md",
          loserPath: "/skills/demo/SKILL.md",
        },
      },
    ],
  });
  assert.equal(collisionDiag.code, "collision");
  assert.equal(collisionDiag.runtimeLoaded, false);
  assert.match(collisionDiag.diagnosticRule, /winnerPath: \/higher\/demo\/SKILL\.md/);

  const errorDiag = getSkillRuntimeDiagnosis(skill, {
    viewScope: "global",
    diagnostics: [
      {
        type: "error",
        path: "/skills/demo/SKILL.md",
        message: "failed to parse skill frontmatter",
      },
    ],
  });
  assert.equal(errorDiag.code, "error");
  assert.equal(errorDiag.badgeTone, "error");
  assert.equal(errorDiag.diagnosticRule, "failed to parse skill frontmatter");
});

test("preserves onUseSkill action and hover metadata on list badge and detail panel", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /onUseSkill\?:\s*\(skillName:\s*string\)\s*=>\s*void/);
  assert.match(source, /onClick=\{\(event\)\s*=>\s*\{\s*event\.stopPropagation\(\);\s*onUseSkill\(skill\.name\);\s*\}\}/);
  const detail = source.slice(source.indexOf("function SkillDetail("), source.indexOf("function AddSkillPanel("));
  assert.match(detail, /title=\{useSkillLabel\}[\s\S]*aria-disabled=\{!diagnosis\.commandUsable\}[\s\S]*onClick=\{\(\) => onUseSkill\(skill\.name\)\}/);
  assert.match(source, /<SkillDetail[\s\S]*onUseSkill=\{onUseSkill\}/);
  assert.match(source, /const listBadge = getSkillListBadge\(skill, diagnosis, t\)/);
  assert.match(source, /\{listBadge\.label\}/);
  assert.match(source, /background: listBadge\.tone === "advice"\s*\? "rgba\(239,68,68,0\.12\)"/);
  assert.match(source, /color: listBadge\.tone === "advice"\s*\? "var\(--danger, light-dark\(#dc2626, #f87171\)\)"/);
  assert.match(source, /const stateDotTone = getSkillStateDotTone\(diagnosis\)/);
  assert.match(source, /const rowTitle = `\$\{currentStateLabel\}/);
  assert.match(source, /const invocationAdviceReason = skill\.triggerModeSource === "ai"/);
});

test("starts pending-skill analysis as a resumable background job", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(source, /window\.confirm\(t\("i18n\.skillAnalysisConfirm"/);
  assert.match(source, /filePaths: targets\.map\(\(skill\) => skill\.filePath\)/);
  assert.match(source, /fetchAnalysisJob/);
  assert.match(source, /window\.setInterval/);
  assert.match(source, /pendingAnalysisSkills/);
  assert.match(source, /<Sparkles /);
});


test("unified use controls replace the resource and invocation switches without editing source", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("./SkillsConfig.tsx", import.meta.url), "utf8");
  assert.match(source, /<SkillUseStateControl/);
  assert.match(source, /action: "set_skill_group"/);
  assert.match(source, /data-testid="skill-advice-summary"/);
  assert.doesNotMatch(source, /function Toggle\(|skillSettingsEdit|skillResourceSettingsEdit|skillInvocationModeEdit/);
  const mutation = source.slice(source.indexOf("  const changeSkillState"), source.indexOf("  const reloadAllSessions"));
  assert.match(mutation, /applySkillsResponse\(result\)/);
  assert.doesNotMatch(mutation, /disableModelInvocation|writeFile|setSkills\(\(prev/);
  assert.match(mutation, /if \(!isCurrentPanelRequest\(request\)\) return/);
});


function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("drops deferred global skills and job responses after switching to project scope", async () => {
  const globalIdentity = {
    cwd: "/workspace/reader",
    viewScope: "global",
    remotePeer: null,
    revision: 7,
  };
  const projectIdentity = { ...globalIdentity, viewScope: "project" };
  const globalSkills = deferred();
  const globalJob = deferred();
  let currentIdentity = globalIdentity;
  let currentGeneration = 1;
  const globalRequest = { identity: globalIdentity, generation: currentGeneration };
  const state = {
    skills: ["project-skill"],
    job: { scope: "project" },
  };
  const applySkills = (request, response) => {
    if (isSkillsPanelRequestCurrent(request, currentIdentity, currentGeneration)) {
      state.skills = response.skills;
    }
  };
  const applyJob = (request, response) => {
    if (isSkillsPanelRequestCurrent(request, currentIdentity, currentGeneration)) {
      state.job = response.job;
    }
  };

  const syntheticFetchQueue = [globalSkills.promise, globalJob.promise];
  const syntheticFetch = () => syntheticFetchQueue.shift();
  const pendingGlobal = Promise.all([
    syntheticFetch("/api/skills?scope=global"),
    syntheticFetch("/api/skills/analyze?scope=global"),
  ]).then(([skills, job]) => {
    applySkills(globalRequest, skills);
    applyJob(globalRequest, job);
  });
  currentIdentity = projectIdentity;
  currentGeneration += 1;
  globalSkills.resolve({ skills: ["stale-global-skill"] });
  globalJob.resolve({ job: { scope: "global" } });
  await pendingGlobal;

  assert.deepEqual(state, {
    skills: ["project-skill"],
    job: { scope: "project" },
  });
});

test("skillEffectiveUseState classifies skills into automatic, explicit-only, and disabled", () => {
  const autoSkill = { name: "auto", resourceEnabled: true, disableModelInvocation: false };
  const dormantSkill = { name: "dormant", resourceEnabled: true, disableModelInvocation: true };
  const disabledSkill = { name: "disabled", resourceEnabled: false };

  assert.equal(skillEffectiveUseState(autoSkill), "automatic");
  assert.equal(skillEffectiveUseState(dormantSkill), "explicit-only");
  assert.equal(skillEffectiveUseState(disabledSkill), "disabled");
});

test("isSkillVisible filters across the three aligned states: automatic, explicit-only, and disabled", () => {
  const autoSkill = { name: "auto", resourceEnabled: true, disableModelInvocation: false };
  const dormantSkill = { name: "dormant", resourceEnabled: true, disableModelInvocation: true };
  const disabledSkill = { name: "disabled", resourceEnabled: false };

  // Only automatic visible
  assert.equal(isSkillVisible(autoSkill, true, false, false), true);
  assert.equal(isSkillVisible(dormantSkill, true, false, false), false);
  assert.equal(isSkillVisible(disabledSkill, true, false, false), false);

  // Only explicit-only (dormant) visible
  assert.equal(isSkillVisible(autoSkill, false, true, false), false);
  assert.equal(isSkillVisible(dormantSkill, false, true, false), true);
  assert.equal(isSkillVisible(disabledSkill, false, true, false), false);

  // Only disabled visible
  assert.equal(isSkillVisible(autoSkill, false, false, true), false);
  assert.equal(isSkillVisible(dormantSkill, false, false, true), false);
  assert.equal(isSkillVisible(disabledSkill, false, false, true), true);

  // Legacy 2-arg compatibility: (enabled, not-enabled)
  assert.equal(isSkillVisible(autoSkill, true, false), true);
  assert.equal(isSkillVisible(dormantSkill, true, false), false);
  assert.equal(isSkillVisible(disabledSkill, false, true), true);
});
