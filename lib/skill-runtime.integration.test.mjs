import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Each test process owns its activity file: a parallel test file holding the
// shared activity lock when a run starts would fail that run before the model answers.
const activityRoot = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-activity-"));
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(activityRoot, "session-activity.json");
test.after(() => rm(activityRoot, { recursive: true, force: true }));

// This harness is intentionally an SDK-layer test. It is written on the Mac
// source boundary and is executed only after Debian installs the locked SDK
// closure. The fixture is local and contains no credentials or external state.
const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const { filterRuntimeSkills, getSkillPolicyKey, routeSkillCommand } = await jiti.import("./skill-runtime-policy.ts");

function packageVersion(packageName) {
  const entryUrl = import.meta.resolve(packageName);
  let directory = dirname(fileURLToPath(entryUrl));
  while (directory !== dirname(directory)) {
    const packagePath = join(directory, "package.json");
    try {
      const packageJson = JSON.parse(readFileSync(packagePath, "utf8"));
      if (packageJson.name === packageName) return packageJson.version;
    } catch {
      // Keep walking until the package root is reached.
    }
    directory = dirname(directory);
  }
  return undefined;
}

const SDK_VERSION = packageVersion("@earendil-works/pi-coding-agent");
assert.equal(SDK_VERSION, "1.4.0", "this harness must import the locked Pi SDK 1.4.0 closure");

// These are exact public-source excerpts, kept as test fixtures so the Mac
// harness does not depend on a private HOME checkout or install another
// package. `sourceSha256` pins the complete public source snapshot from which
// each excerpt was taken; the generated fixture keeps exact public frontmatter
// metadata plus a local marker and is never treated as an installed package.
// The extension below reproduces the one public Scheduler.fire call exactly;
// it does not claim to execute the pstack package.
const PUBLIC_SOURCE_FIXTURES = {
  pstackSchedule: {
    source: "github.com/michael-denyer/pstack-claude",
    path: "plugins/pstack/pi/schedule.ts",
    sourceSha256: "d717bb8916a9ac30b56b60f9b3f7bdd09fe33156d296ad0dc5487e0ae4185f39",
    excerpt: `  fire(prompt: string): void {
    this.pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true });
  }`,
  },
  pstackSkills: [
    {
      name: "poteto-mode",
      description: "poteto's agent style for concise, detailed responses, deliberate subagents, unslopped prose, simple code, and verified work. Use for poteto, /poteto-mode, or requests to work in this style.",
      heading: "# Poteto mode",
      path: "plugins/pstack/skills/poteto-mode/SKILL.md",
      sourceSha256: "9bcd30d1b65e28191904a8bed7e72813fa13d7cd7ed52d658293857caf16d35a",
    },
    {
      name: "architect",
      description: "Sketch types, signatures, and module structure before code, then stay in the loop while implementation fills in. Use for /architect, 'architect this', 'design this', or non-trivial work where jumping to code would lock in the wrong shape.",
      heading: "# Architect",
      path: "plugins/pstack/skills/architect/SKILL.md",
      sourceSha256: "93527e69688c5f31c23ce8913b5597a9c7fc1060fba84bf4e57bb1c3facb69b7",
    },
    {
      name: "how",
      description: `Use for "how does X work", code walkthroughs before changing something, and placement / ownership / layering questions ("where should this live", "which package owns this"). Explains subsystem architecture, runtime flow, onboarding mental models. Use why for motivation.`,
      heading: "# How",
      path: "plugins/pstack/skills/how/SKILL.md",
      sourceSha256: "bdb127ef241dfab58e7e029d0ea1a3164600cc4cf1fd30de4c3022437f9cb424",
    },
    {
      name: "interrogate",
      description: `Use for "interrogate", "adversarial review", "multi-model review", "challenge this", "stress test this code", "find blind spots", or "tear this apart". Multiple LLM reviewers challenge changes from independent angles.`,
      heading: "# Interrogate",
      path: "plugins/pstack/skills/interrogate/SKILL.md",
      sourceSha256: "f05deea40b6980b9e9279ba911f94bd75542abd280671132ddff3b8179560977",
    },
  ],
  dbskillSkills: [
    {
      name: "dbs",
      description: "dontbesilent 商业工具箱主入口，提供新手教程、单任务编排、联网编号执行与隐藏款目录查询。用户第一次使用 dbskill、不知道该用哪个正式 Skill、输入方法视频的三位编号、查询所有隐藏款，或在任务完成后询问下一步时使用。",
      heading: "# dbs：商业工具箱",
      path: "skills/dbs/SKILL.md",
      sourceSha256: "99e5e0c0855998fb7beb3c9dbed6bcad81df3585ffc44996738096d72a4c2137",
    },
    {
      name: "dbs-goal",
      description: "提取已有约束，只追问影响执行或验收的信息，把模糊愿望整理成可行动、可检查的交付目标。用户要明确做成什么、边界和验收标准时使用；不替代概念拆解、研究问题改写或顾客购买动机分析。",
      heading: "# dbs-goal：目标清晰化",
      path: "skills/dbs-goal/SKILL.md",
      sourceSha256: "f2c00600a2db28f9627e69760280a6fa5ba30a2d0782612193f54a372f0d2dd8",
    },
    {
      name: "dbs-good-question",
      description: "把模糊提问改写成 Agent 可推理、可批评、可验证的问题说明书，并判断自动化可解程度。用户要改进问题表述、研究问题或评估 Agent 可解性时使用；任务交付目标已明确时不重复澄清目标。",
      heading: "# dbs-good-question：好问题生成器",
      path: "skills/dbs-good-question/SKILL.md",
      sourceSha256: "96452fa967fabfdce8191fead6c24d385b76ac238556a3938b16a43b634f1d4a",
    },
  ],
};

function fixtureSource(fixture) {
  const frontmatter = `---\nname: ${fixture.name}\ndescription: ${fixture.description}\n---\n`;
  return `${frontmatter}\n${fixture.heading}\n\nPublic source fixture excerpt.`;
}

function publicSourceSkill(fixture, filePath) {
  const source = fixtureSource(fixture);
  const sourceRepository = fixture.path.startsWith("plugins/pstack/")
    ? "github.com/michael-denyer/pstack-claude"
    : "github.com/dontbesilent2025/dbskill";
  return {
    name: fixture.name,
    description: fixture.description,
    filePath,
    baseDir: dirname(filePath),
    disableModelInvocation: false,
    sourceInfo: {
      origin: "package",
      source: sourceRepository,
      scope: "user",
      baseDir: dirname(filePath),
      path: filePath,
    },
    pluginResourceKey: `skills/${fixture.name}/SKILL.md`,
    source,
  };
}

function sourceFixtureSha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

function publicPstackScheduleFixture() {
  const fixture = PUBLIC_SOURCE_FIXTURES.pstackSchedule;
  const { excerpt } = fixture;
  return {
    name: "pstack-public-schedule-source-fixture",
    factory(pi) {
      // This is the exact public Scheduler.fire excerpt above, isolated as a
      // test seam rather than imported from a private external checkout.
      const scheduler = { fire: (prompt) => pi.sendUserMessage(prompt, { deliverAs: "followUp", expandPromptTemplates: true }) };
      pi.registerCommand("pstack-schedule-fixture", {
        description: `Public source fixture (${fixture.source}/${fixture.path}; ${sourceFixtureSha256(excerpt)})`,
        handler: async () => scheduler.fire("/skill:native-sample from-pstack"),
      });
    },
  };
}

async function writePublicSkillFixtures(root) {
  const skills = [];
  for (const fixture of [...PUBLIC_SOURCE_FIXTURES.pstackSkills, ...PUBLIC_SOURCE_FIXTURES.dbskillSkills]) {
    const filePath = join(root, fixture.path);
    const source = fixtureSource(fixture);
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(filePath, source, "utf8");
    skills.push({ fixture, skill: publicSourceSkill(fixture, filePath) });
  }
  return skills;
}

const transformedSkillInput = {
  name: "reader-input-transform-fixture",
  factory(pi) {
    pi.on("input", (event) => event.text === "rewrite-skill"
      ? { action: "transform", text: "/skill:native-sample transformed" }
      : { action: "continue" });
  },
};

async function waitFor(condition, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await delay(20);
  }
}

function createFirstResponseBarrier(session) {
  let firstResponseStarted = false;
  let releaseFirstResponse;
  const firstResponseHold = new Promise((resolve) => {
    releaseFirstResponse = resolve;
  });
  return {
    async hold(response) {
      firstResponseStarted = true;
      await firstResponseHold;
      return response;
    },
    waitUntilStreaming() {
      // Holding the faux provider response keeps the SDK's active-run window
      // open long enough for queued calls to observe the real busy state.
      return waitFor(() => firstResponseStarted && session.isStreaming);
    },
    release() {
      releaseFirstResponse();
    },
  };
}

function textOfContent(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function lastUserText(context) {
  const message = [...context.messages].reverse().find((entry) => entry.role === "user");
  return message ? textOfContent(message.content) : "";
}

async function startSession(t, contextPatch = {}, sessionOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-runtime-sdk-"));
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  const skillDir = join(agentDir, "skills", "native-sample");
  const skillPath = join(skillDir, "SKILL.md");
  await mkdir(skillDir, { recursive: true });
  await mkdir(cwd, { recursive: true });
  await writeFile(skillPath, "---\nname: native-sample\ndescription: Native SDK fixture\n---\nNative body.\n", "utf8");

  const faux = fauxProvider({ models: [{ id: "faux-skill-runtime" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory({});
  let capturedRuntimeContext;
  let discoveredSkill;
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    ...(sessionOptions.extensionFactories ? { extensionFactories: sessionOptions.extensionFactories } : {}),
    skillsOverride: (base) => {
      const skill = base.skills.find((item) => item.name === "native-sample");
      if (!skill) return base;
      discoveredSkill = skill;
      const policyKey = getSkillPolicyKey({ filePath: skill.filePath });
      const patch = typeof contextPatch === "function"
        ? contextPatch({ skill, policyKey, cwd, agentDir })
        : contextPatch;
      capturedRuntimeContext = {
        scope: "global",
        entries: [],
        states: {},
        cwd,
        agentDir,
        ...patch,
      };
      return {
        ...base,
        skills: filterRuntimeSkills(base.skills, capturedRuntimeContext),
      };
    },
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const skill = resourceLoader.getSkills().skills.find((item) => item.name === "native-sample");
  const loadedSkill = skill ?? discoveredSkill;
  assert.ok(loadedSkill, "the SDK loader must discover the global fixture skill");
  const policyKey = getSkillPolicyKey({ filePath: loadedSkill.filePath });
  const resolvedContextPatch = typeof contextPatch === "function"
    ? contextPatch({ skill: loadedSkill, policyKey, cwd, agentDir })
    : contextPatch;
  const context = capturedRuntimeContext ?? {
    scope: "global",
    entries: [],
    states: {},
    cwd,
    agentDir,
    ...resolvedContextPatch,
  };
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    model: sessionOptions.withModel === false ? undefined : faux.getModel("faux-skill-runtime"),
    sessionManager: SessionManager.inMemory(cwd),
    settingsManager,
    resourceLoader,
  });
  const wrapper = new AgentSessionWrapper(session, undefined, undefined, {
    skillRuntimeContext: context,
  });
  t.after(async () => {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  });
  wrapper.start();
  wrapper.beginExtensionBinding();
  await wrapper.waitUntilReady();
  return {
    cwd,
    agentDir,
    skill: loadedSkill,
    skillPath,
    policyKey,
    session,
    faux,
    wrapper,
    runtimeContext: context,
  };
}

const boundaryContext = { scope: "global", entries: [], states: {} };

test("Reader fails closed when the SDK Skill expansion boundary is missing", () => {
  assert.throws(
    () => new AgentSessionWrapper({}, undefined, undefined, { skillRuntimeContext: boundaryContext }),
    /Reader Skill runtime admission unavailable: Pi SDK _expandSkillCommand boundary is missing/,
  );
});

test("Reader fails closed when the SDK Skill expansion boundary is not writable", () => {
  const inner = {
    prompt: async () => {},
    steer: async () => "handled",
    followUp: async () => "handled",
    _expandSkillCommand: (text) => text,
  };
  Object.defineProperty(inner, "_expandSkillCommand", {
    configurable: false,
    writable: false,
    value: inner._expandSkillCommand,
  });
  assert.throws(
    () => new AgentSessionWrapper(inner, undefined, undefined, { skillRuntimeContext: boundaryContext }),
    /Reader Skill runtime admission unavailable: Pi SDK Skill admission boundary is not writable/,
  );
});

test("native SDK expands an admitted user slash and leaves the baseline unchanged", async (t) => {
  const { wrapper, faux } = await startSession(t);
  const before = await wrapper.send({ type: "get_state" });
  const baselineBefore = before.runtimeInspection.skillRuntime.baseline;
  const commands = await wrapper.send({ type: "get_commands" });
  assert.ok(commands.commands.some((command) => command.name === "skill:native-sample"));
  const seen = [];
  faux.setResponses([(context) => {
    seen.push(lastUserText(context));
    return fauxAssistantMessage([fauxText("done")]);
  }]);

  await wrapper.send({ type: "prompt", message: "/skill:native-sample src/app.ts" });
  await waitFor(() => !wrapper.isRunning());

  assert.equal(seen.length, 1);
  assert.match(seen[0], /<skill name="native-sample"/);
  assert.match(seen[0], /Native body\./);
  assert.match(seen[0], /src\/app\.ts$/);
  const state = await wrapper.send({ type: "get_state" });
  const evidence = state.runtimeInspection.skillRuntime;
  assert.equal(evidence.activeCount, 0);
  assert.equal(evidence.last.status, "settled");
  assert.equal(evidence.last.baselineUnchanged, true);
  assert.deepEqual(evidence.baseline, baselineBefore);
  assert.equal(state.runtimeInspection.evidence.providerRequestCaptured, false);
});

test("SDK 1.4 input transforms are admitted after transformation", async (t) => {
  const { wrapper, faux } = await startSession(t, {}, { extensionFactories: [transformedSkillInput] });
  const seen = [];
  faux.setResponses([(context) => {
    seen.push(lastUserText(context));
    return fauxAssistantMessage([fauxText("transformed")]);
  }]);

  await wrapper.send({ type: "prompt", message: "rewrite-skill" });
  await waitFor(() => !wrapper.isRunning());
  assert.equal(seen.length, 1);
  assert.match(seen[0], /<skill name="native-sample"/);
  assert.match(seen[0], /Native body\./);
  assert.match(seen[0], /transformed$/);
  assert.equal((await wrapper.send({ type: "get_state" })).runtimeInspection.skillRuntime.activeCount, 0);
});

test("the real SDK wrapper recovers a capable Skill runtime on same-session reload", async (t) => {
  const { wrapper, faux, runtimeContext, agentDir } = await startSession(t, {
    runtimeSkillsEnabled: true,
    requireRuntimeCatalog: true,
    runtimeCatalogAvailable: true,
  });
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  t.after(() => {
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  });

  // Use the actual Reader catalog loader with a malformed package entry to
  // exercise its catch path. The SDK wrapper remains alive in this test.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ packages: [{}] }), "utf8");
  await wrapper.refreshSkillRuntimePolicyCatalog(false);
  // The failure is catalog availability only; the child capability survives.
  assert.equal(runtimeContext.runtimeSkillsEnabled, true);
  assert.equal(runtimeContext.runtimeCatalogAvailable, false);
  assert.deepEqual((await wrapper.send({ type: "get_commands" })).commands.filter((command) => command.source === "skill"), []);
  await assert.rejects(
    wrapper.send({ type: "prompt", message: "/skill:native-sample unavailable" }),
    /unavailable/,
  );
  assert.equal(faux.state.callCount, 0);

  await writeFile(join(agentDir, "settings.json"), "{}\n", "utf8");
  await wrapper.send({ type: "reload" });
  assert.equal(runtimeContext.runtimeCatalogAvailable, true);
  assert.equal(runtimeContext.runtimeSkillsEnabled, true);
  assert.ok((await wrapper.send({ type: "get_commands" })).commands.some((command) => command.name === "skill:native-sample"));
  faux.setResponses([(context) => fauxAssistantMessage([fauxText(lastUserText(context))])]);
  await wrapper.send({ type: "prompt", message: "/skill:native-sample recovered" });
  await waitFor(() => !wrapper.isRunning());
  assert.equal((await wrapper.send({ type: "get_state" })).runtimeInspection.skillRuntime.activeCount, 0);
});

test("explicit-only skills stay out of automatic catalog presentation but remain slash-usable", async (t) => {
  const { wrapper, faux, skill } = await startSession(t, ({ policyKey }) => ({
    globalInvocationModes: { [policyKey]: "explicit-only" },
  }));
  const commands = await wrapper.send({ type: "get_commands" });
  assert.ok(commands.commands.some((command) => command.name === "skill:native-sample"));
  const before = await wrapper.send({ type: "get_state" });
  const row = before.runtimeInspection.skills.find((candidate) => candidate.name === "native-sample");
  assert.equal(row.promptVisible, false);
  assert.equal(row.commandUsable, true);
  assert.equal(row.runtimeLoaded, true);
  const seen = [];
  faux.setResponses([(context) => {
    seen.push(lastUserText(context));
    return fauxAssistantMessage([fauxText("explicit")]);
  }]);
  await wrapper.send({ type: "prompt", message: "/skill:native-sample explicit" });
  await waitFor(() => !wrapper.isRunning());
  assert.match(seen[0], /Native body\./);
  assert.match(seen[0], /explicit$/);
  const after = await wrapper.send({ type: "get_state" });
  assert.deepEqual(after.runtimeInspection.skillRuntime.baseline, before.runtimeInspection.skillRuntime.baseline);
  assert.equal(after.runtimeInspection.skillRuntime.last.baselineUnchanged, true);
  assert.equal(skill.name, "native-sample");
});

test("the pstack Scheduler.fire public-source fixture is admitted by the extension runner", async (t) => {
  const pstackSchedule = publicPstackScheduleFixture();
  const { wrapper, faux } = await startSession(t, ({ skill, policyKey }) => ({
    entries: [{ path: skill.filePath, key: policyKey, resourceState: "disabled" }],
  }), { extensionFactories: [pstackSchedule] });
  const errors = [];
  wrapper.onEvent((event) => {
    if (event.type === "extension_error") errors.push(event);
  });

  // This invokes the exact public Scheduler.fire call through a local source
  // fixture. Its public sendUserMessage API is void and reports the Reader
  // rejection through the SDK extension runner; this is intentionally not an
  // LLM-selected action or an installed-package execution.
  await wrapper.send({ type: "prompt", message: "/pstack-schedule-fixture" });
  await waitFor(() => errors.some((event) => /disabled|unavailable/.test(String(event.error))));
  assert.equal(faux.state.callCount, 0);
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.runtimeInspection.skillRuntime.activeCount, 0);
  assert.equal(state.runtimeInspection.skillRuntime.last.errorCode, "disabled");
});

test("dbskill public-source fixtures are explicit router inputs, not automatic model choices", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-dbs-source-fixtures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureSkills = await writePublicSkillFixtures(root);
  for (const { fixture, skill } of fixtureSkills.filter(({ fixture: item }) => item.path.startsWith("skills/"))) {
    assert.match(fixture.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(skill.sourceInfo.source, "github.com/dontbesilent2025/dbskill");
    const { name } = fixture;
    const policyKey = getSkillPolicyKey(skill);
    const route = routeSkillCommand(`/skill:${name} question`, {
      skills: [skill],
      context: {
        scope: "global",
        globalInvocationModes: { [policyKey]: "explicit-only" },
      },
    });
    assert.equal(route.policy.invocationMode, "explicit-only");
    assert.equal(route.policy.promptVisible, false);
    assert.equal(route.policy.commandUsable, true);
    assert.match(route.expandedText, new RegExp(`<skill name="${name}"`));
    assert.match(route.expandedText, new RegExp(fixture.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(route.expandedText, /question$/);
  }
});

test("pstack skill public-source fixtures remain automatic catalog resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-skill-pstack-source-fixtures-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixtureSkills = await writePublicSkillFixtures(root);
  for (const { fixture, skill } of fixtureSkills.filter(({ fixture: item }) => item.path.startsWith("plugins/pstack/"))) {
    assert.match(fixture.sourceSha256, /^[0-9a-f]{64}$/);
    assert.equal(skill.sourceInfo.source, "github.com/michael-denyer/pstack-claude");
    const { name } = fixture;
    const policyKey = getSkillPolicyKey(skill);
    const route = routeSkillCommand(`/skill:${name} pstack`, {
      skills: [skill],
      context: {
        scope: "global",
        globalInvocationModes: { [policyKey]: "automatic" },
      },
    });
    assert.equal(route.policy.invocationMode, "automatic");
    assert.equal(route.policy.promptVisible, true);
    assert.equal(route.policy.commandUsable, true);
    assert.match(route.expandedText, new RegExp(fixture.heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(route.expandedText, /pstack$/);
  }
});

test("native SDK never sees disabled or parent-capped slash resources", async (t) => {
  const disabled = await startSession(t, ({ skill, policyKey }) => ({
    entries: [{ path: skill.filePath, key: policyKey, resourceState: "disabled" }],
  }));
  await assert.rejects(
    disabled.wrapper.send({ type: "prompt", message: "/skill:native-sample" }),
    /disabled/,
  );
  assert.equal(disabled.faux.state.callCount, 0);

  const parentCapped = await startSession(t, ({ skill, policyKey }) => ({
    scope: "project",
    entries: [{ path: skill.filePath, key: policyKey, globalResourceState: "disabled", projectResourceState: "enabled" }],
  }));
  await assert.rejects(
    parentCapped.wrapper.send({ type: "prompt", message: "/skill:native-sample" }),
    /disabled/,
  );
  assert.equal(parentCapped.faux.state.callCount, 0);

  await assert.rejects(
    parentCapped.wrapper.send({ type: "prompt", message: "/skill:renamed" }),
    /unavailable/,
  );
  assert.equal(parentCapped.faux.state.callCount, 0);
});

test("native SDK rejects a read failure and cleans an admitted prompt error", async (t) => {
  const unreadable = await startSession(t);
  await rm(unreadable.skillPath, { force: true });
  await assert.rejects(
    unreadable.wrapper.send({ type: "prompt", message: "/skill:native-sample" }),
    /could not be read|read-failed|unavailable/,
  );
  assert.equal(unreadable.faux.state.callCount, 0);
  assert.equal((await unreadable.wrapper.send({ type: "get_state" })).runtimeInspection.skillRuntime.activeCount, 0);

  const noModel = await startSession(t, {}, { withModel: false });
  await assert.rejects(
    noModel.wrapper.send({ type: "prompt", message: "/skill:native-sample prompt-error" }),
    /model|Model|provider|API key/i,
  );
  const state = await noModel.wrapper.send({ type: "get_state" });
  assert.equal(state.runtimeInspection.skillRuntime.activeCount, 0);
  assert.equal(state.runtimeInspection.skillRuntime.last.errorCode, "prompt-error");
});

test("native queued slash invocations settle together after the SDK queue loop", async (t) => {
  const { wrapper, session, skillPath, faux } = await startSession(t);
  const seen = [];
  const firstResponse = createFirstResponseBarrier(session);
  faux.setResponses([
    async (context) => {
      seen.push(lastUserText(context));
      return firstResponse.hold(fauxAssistantMessage([
        fauxToolCall("read", { path: skillPath }, { id: "read-native-skill" }),
      ], { stopReason: "toolUse" }));
    },
    (context) => {
      seen.push(lastUserText(context));
      return fauxAssistantMessage([fauxText("done")]);
    },
    (context) => {
      seen.push(lastUserText(context));
      return fauxAssistantMessage([fauxText("done-queued")]);
    },
  ]);

  const first = wrapper.send({ type: "prompt", message: "/skill:native-sample first" });
  try {
    await firstResponse.waitUntilStreaming();
    await wrapper.send({ type: "follow_up", message: "/skill:native-sample second" });
  } finally {
    firstResponse.release();
  }
  await first;
  await waitFor(() => !wrapper.isRunning());

  assert.ok(seen.some((text) => text.endsWith("first")), seen.join("\n---\n"));
  assert.ok(seen.some((text) => text.endsWith("second")), seen.join("\n---\n"));
  const state = await wrapper.send({ type: "get_state" });
  assert.equal(state.runtimeInspection.skillRuntime.activeCount, 0);
  assert.equal(state.runtimeInspection.skillRuntime.last.baselineUnchanged, true);
});

test("native steer/followUp and abort share admission cleanup", async (t) => {
  const { wrapper, session, skillPath, faux } = await startSession(t);
  const seen = [];
  const firstResponse = createFirstResponseBarrier(session);
  faux.setResponses([
    async (context) => {
      seen.push(lastUserText(context));
      return firstResponse.hold(fauxAssistantMessage([
        fauxToolCall("read", { path: skillPath }, { id: "read-before-abort" }),
      ], { stopReason: "toolUse" }));
    },
    (context) => {
      seen.push(lastUserText(context));
      return fauxAssistantMessage([fauxText("done-direct-queue")]);
    },
    (context) => {
      seen.push(lastUserText(context));
      return fauxAssistantMessage([fauxText("done-direct-follow")]);
    },
  ]);

  const first = wrapper.send({ type: "prompt", message: "/skill:native-sample direct-first" });
  try {
    await firstResponse.waitUntilStreaming();
    const steer = session.steer("/skill:native-sample direct-steer", undefined, { source: "rpc" });
    const followUp = session.followUp("/skill:native-sample direct-follow", undefined, { source: "extension" });
    await Promise.all([steer, followUp]);
  } finally {
    firstResponse.release();
  }
  await first;
  await waitFor(() => !wrapper.isRunning());
  assert.ok(seen.some((text) => text.endsWith("direct-first")), seen.join("\n---\n"));
  assert.ok(seen.some((text) => text.endsWith("direct-steer")), seen.join("\n---\n"));
  assert.ok(seen.some((text) => text.endsWith("direct-follow")), seen.join("\n---\n"));
  assert.equal((await wrapper.send({ type: "get_state" })).runtimeInspection.skillRuntime.activeCount, 0);

  const abortResponse = createFirstResponseBarrier(session);
  faux.setResponses([async (context) => abortResponse.hold(fauxAssistantMessage([fauxText("abort")]))]);
  const aborted = wrapper.send({ type: "prompt", message: "/skill:native-sample abort" });
  let abortPromise;
  try {
    await abortResponse.waitUntilStreaming();
    abortPromise = session.abort();
  } finally {
    abortResponse.release();
  }
  await Promise.all([aborted, abortPromise]);
  await waitFor(() => !wrapper.isRunning());
  const afterAbort = await wrapper.send({ type: "get_state" });
  assert.equal(afterAbort.runtimeInspection.skillRuntime.activeCount, 0);
  assert.equal(afterAbort.runtimeInspection.skillRuntime.last.baselineUnchanged, true);
});
