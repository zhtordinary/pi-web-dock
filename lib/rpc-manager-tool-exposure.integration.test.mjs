import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fauxAssistantMessage, fauxProvider, fauxText, getCurrentTools } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

// Each test process owns its real activity persistence; parallel fixtures are not peer writers.
const originalActivityFile = process.env.PI_WEB_SESSION_ACTIVITY_FILE;
const activityRoot = await mkdtemp(join(tmpdir(), "reader-tool-exposure-activity-"));
process.env.PI_WEB_SESSION_ACTIVITY_FILE = join(activityRoot, "session-activity.json");
test.after(async () => {
  if (originalActivityFile === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_FILE;
  else process.env.PI_WEB_SESSION_ACTIVITY_FILE = originalActivityFile;
  await rm(activityRoot, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { appendSessionToolSelection } = await jiti.import("./session-tool-selection.ts");

const READ_ONLY = ["read", "grep", "find", "ls"];

const lookupExtension = {
  name: "lookup",
  factory: (pi) => {
    pi.registerTool({
      name: "lookup",
      label: "lookup",
      description: "an extension tool pi activates on registration",
      parameters: { type: "object", properties: {} },
      async execute() {
        return { content: [{ type: "text", text: "found" }], details: undefined };
      },
    });
  },
};

// On reload it swaps the discovery tools, as the MCP extension does when exposures change.
const reloadSwitchExtension = {
  name: "reload-switch",
  factory: (pi) => {
    pi.on("session_start", (event) => {
      if (event.reason !== "reload") return;
      pi.setActiveTools([...pi.getActiveTools().filter((name) => name !== "tool_search"), "codemode"]);
    });
  },
};

// pi's own codemode and tool_search, which register with `defaultActive: false`.
async function createSession(dir, settings = {}, extensionFactories = []) {
  const faux = fauxProvider({ models: [{ id: "faux-tools" }] });
  const modelRuntime = await ModelRuntime.create({
    authPath: join(dir, "auth.json"),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  const settingsManager = SettingsManager.inMemory(settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir,
    agentDir: dir,
    settingsManager,
    extensionFactories: [createCodemodeExtension(), createToolSearchExtension(), lookupExtension, ...extensionFactories],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  const { session } = await createAgentSession({
    cwd: dir,
    agentDir: dir,
    modelRuntime,
    model: faux.getModel("faux-tools"),
    sessionManager: SessionManager.inMemory(dir),
    settingsManager,
    resourceLoader,
  });
  return { session, faux };
}

function sorted(names) {
  return [...names].sort();
}

for (const type of ["prompt", "steer", "follow_up"]) {
  test(`a first managed ${type} initializes unattended only after CAS admission`, async (t) => {
    const dir = await mkdtemp(join(tmpdir(), "pi-web-managed-unattended-cas-"));
    t.after(() => rm(dir, { recursive: true, force: true }));
    const { session, faux } = await createSession(dir, { compaction: { enabled: false } });
    faux.setResponses([fauxAssistantMessage([fauxText("isolated fixture output")])]);
    const wrapper = new AgentSessionWrapper(session);
    t.after(() => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); });
    const expected = wrapper.getLiveRuntimeIdentity();
    const receiptId = `fixture-unattended-${type}`;
    wrapper.bindControlReceipt(receiptId, type, expected);
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    wrapper.onEvent(event => { if (event.type === "prompt_done") finish(); });
    assert.equal(wrapper.getUnattendedConfigured(), false);
    await wrapper.send({ type, message: "isolated fixture input", readerControlReceiptId: receiptId, readerControlExpectedBootId: expected.bootId, readerControlExpectedRevision: expected.revision });
    if (type === "prompt") await completed;
    assert.equal(wrapper.controlReceiptBindings.get(receiptId).identityConsumed, true);
    assert.equal(wrapper.getUnattendedEnabled(), true);
    assert.equal(wrapper.getUnattendedConfigured(), true);
  });
}

test("a managed prompt admitted to the compaction queue consumes CAS before its own revision changes", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-managed-deferred-cas-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session, faux } = await createSession(dir, { compaction: { enabled: false } });
  let compacting = true, generated = 0;
  Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); });
  const errors = []; wrapper.onEvent(event => { if (event.type === "prompt_error") errors.push(event.errorMessage); });
  const expected = wrapper.getLiveRuntimeIdentity();
  wrapper.bindControlReceipt("fixture-deferred-cas", "prompt", expected);
  await wrapper.send({ type: "prompt", message: "isolated fixture input", streamingBehavior: "followUp", readerControlReceiptId: "fixture-deferred-cas", readerControlExpectedBootId: expected.bootId, readerControlExpectedRevision: expected.revision });
  assert.equal(wrapper.deferredCompactionPrompts.length, 1);
  assert.equal(wrapper.controlReceiptBindings.get("fixture-deferred-cas").identityConsumed, true);
  assert.notEqual(wrapper.getLiveRuntimeIdentity().revision, expected.revision);
  faux.setResponses([() => { generated++; return fauxAssistantMessage([fauxText("isolated fixture output")]); }]);
  compacting = false;
  await wrapper.flushDeferredCompactionPrompts();
  for (let i = 0; i < 200 && generated === 0 && errors.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(generated, 1); assert.deepEqual(errors, []);
});

test("a pinned preset neither activates codemode nor drops the one defaultTools adds", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-activation-"));
  try {
    const plain = await createSession(dir);
    const initial = plain.session.getActiveToolNames();
    assert.deepEqual(sorted(initial), ["bash", "edit", "lookup", "read", "write"]);
    assert.deepEqual(
      sorted(resolveActiveToolNames(plain.session, READ_ONLY, initial)),
      ["find", "grep", "lookup", "ls", "read"],
    );
    plain.session.dispose();

    const withCodemode = await createSession(dir, { defaultTools: ["+codemode"] });
    const initialWithCodemode = withCodemode.session.getActiveToolNames();
    assert.ok(initialWithCodemode.includes("codemode"));
    assert.deepEqual(
      sorted(resolveActiveToolNames(withCodemode.session, READ_ONLY, initialWithCodemode)),
      ["codemode", "find", "grep", "lookup", "ls", "read"],
    );
    withCodemode.session.dispose();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// Like an MCP server's tool when only scripts reach it.
const scriptedMcpExtension = {
  name: "scripted-mcp",
  factory: (pi) => {
    pi.registerTool({
      name: "mcp__docs__search",
      label: "search",
      description: "search the docs",
      parameters: { type: "object", properties: { query: { type: "string" } } },
      exposure: "codemode",
      namespace: { name: "mcp__docs", description: "the docs server" },
      async execute() {
        return { content: [{ type: "text", text: "found" }], details: undefined };
      },
    });
  },
};

test("get_tools reports codemode's declared description and dynamic lookup guidance", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-descriptions-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session } = await createSession(dir, { defaultTools: ["+codemode"] }, [scriptedMcpExtension]);
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());

  const tools = await wrapper.send({ type: "get_tools" });
  const codemode = tools.find((tool) => tool.name === "codemode");

  assert.equal(codemode.active, true);
  assert.equal(codemode.description, session.getToolDefinition("codemode").description);
  // The current SDK keeps MCP declarations discoverable through the script helpers
  // instead of appending a static namespace listing to the codemode description.
  assert.match(codemode.description, /searchTools\(query/);
  assert.doesNotMatch(codemode.description, /## mcp__docs/);
});

test("get_tools exposes active state without declaration-only metadata", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-hidden-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const hiddenNames = async (settings) => {
    const { session } = await createSession(dir, settings);
    const wrapper = new AgentSessionWrapper(session);
    t.after(() => wrapper.destroy());
    const tools = await wrapper.send({ type: "get_tools" });
    assert.ok(tools.find((tool) => tool.name === "codemode").active);
    assert.ok(tools.every((tool) => !Object.hasOwn(tool, "declarationHidden")));
    return sorted(tools.filter((tool) => tool.declarationHidden).map((tool) => tool.name));
  };

  // Still active, so presets and scripts see them; only their declarations are withheld.
  assert.deepEqual(
    await hiddenNames({ defaultTools: ["+codemode"], codemode: { mode: "only" } }),
    [],
  );
  assert.deepEqual(await hiddenNames({ defaultTools: ["+codemode"] }), []);
});

test("navigating to an older branch keeps the Read-only pin and branch tools", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-navigation-"));
  const { session, faux } = await createSession(dir);
  const wrapper = new AgentSessionWrapper(session);
  try {
    faux.setResponses([
      () => fauxAssistantMessage([fauxText("first")]),
      () => fauxAssistantMessage([fauxText("second")]),
    ]);
    await session.prompt("first");
    const firstLeafId = session.sessionManager.getLeafId();

    appendSessionToolSelection(session.sessionManager, READ_ONLY);
    wrapper.setActiveToolSelection(READ_ONLY);
    // Activated at runtime, as the MCP extension does when a server connects.
    session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    await session.prompt("second");
    const secondLeafId = session.sessionManager.getLeafId();
    const pinnedTools = ["codemode", "find", "grep", "lookup", "ls", "read"];
    assert.deepEqual(sorted(session.getActiveToolNames()), pinnedTools);

    // On its own, pi restores the older branch's loadout: write is back and codemode is gone.
    await session.navigateTree(firstLeafId, {});
    assert.deepEqual(sorted(session.getActiveToolNames()), ["bash", "edit", "lookup", "read", "write"]);
    await session.navigateTree(secondLeafId, {});
    assert.deepEqual(sorted(session.getActiveToolNames()), pinnedTools);

    assert.deepEqual(await wrapper.send({ type: "navigate_tree", targetId: firstLeafId }), {
      cancelled: false,
      leafId: firstLeafId,
      editorText: undefined,
    });
    assert.equal(session.sessionManager.getLeafId(), firstLeafId);
    assert.deepEqual(sorted(session.getActiveToolNames()), ["find", "grep", "lookup", "ls", "read"]);
  } finally {
    wrapper.destroy();
    await rm(dir, { recursive: true, force: true });
  }
});

test("navigation preserves declaration order when the final permitted tool set is unchanged", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-navigation-order-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session, faux } = await createSession(dir);
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => wrapper.destroy());
  const declarations = [];
  faux.setResponses(Array.from({ length: 3 }, () => context => {
    declarations.push(getCurrentTools(context.messages).map((tool) => tool.name));
    return fauxAssistantMessage([fauxText("fixture")]);
  }));
  appendSessionToolSelection(session.sessionManager, READ_ONLY);
  wrapper.setActiveToolSelection(READ_ONLY);
  const desired = ["lookup", "ls", "find", "grep", "read"];
  // Pi 1.5 retains active tools' order; deactivate them to construct this loadout.
  session.setActiveToolsByName([]);
  session.setActiveToolsByName(desired);
  await session.prompt("first");
  const firstLeafId = session.sessionManager.getLeafId();
  await session.prompt("second");
  assert.deepEqual(session.getActiveToolNames(), desired);
  assert.deepEqual(declarations[1], desired);

  assert.equal((await wrapper.send({ type: "navigate_tree", targetId: firstLeafId })).cancelled, false);
  assert.deepEqual(session.getActiveToolNames(), desired, "same allowed set must retain the previous declaration order");
  assert.equal((await wrapper.send({ type: "navigate_tree", targetId: null })).cancelled, false);
  assert.deepEqual(session.getActiveToolNames(), desired, "root navigation follows the same rule");
  await session.prompt("third");
  assert.deepEqual(declarations[2], desired, "the order reaching the provider stays stable");
});

test("reload keeps the pinned coding tools and what extensions chose while they restarted", async () => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-tool-reload-"));
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  // The wrapper's reload reads project trust from the agent directory.
  process.env.PI_CODING_AGENT_DIR = dir;
  const { session } = await createSession(dir, {}, [reloadSwitchExtension]);
  const wrapper = new AgentSessionWrapper(session);
  try {
    wrapper.beginExtensionBinding();
    await wrapper.waitUntilReady();
    wrapper.setActiveToolSelection(READ_ONLY);
    session.setActiveToolsByName([...session.getActiveToolNames(), "tool_search"]);
    assert.deepEqual(sorted(session.getActiveToolNames()), ["find", "grep", "lookup", "ls", "read", "tool_search"]);

    assert.deepEqual(await wrapper.send({ type: "reload" }), { success: true });

    // The extension switched tool_search off and codemode on; the pin still holds.
    assert.deepEqual(sorted(session.getActiveToolNames()), ["codemode", "find", "grep", "lookup", "ls", "read"]);
  } finally {
    wrapper.destroy();
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    await rm(dir, { recursive: true, force: true });
  }
});

test("a Recall while a deferred prompt waits for admission prevents delivery", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-recall-during-admission-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { session, faux } = await createSession(dir, { compaction: { enabled: false } });
  let compacting = true, generated = 0;
  Object.defineProperty(session, "isCompacting", { configurable: true, get: () => compacting });
  const wrapper = new AgentSessionWrapper(session);
  t.after(() => { for (const id of wrapper.controlReceiptBindings.keys()) wrapper.releaseControlReceiptBinding(id); wrapper.destroy(); });
  const errors = []; wrapper.onEvent(event => { if (event.type === "prompt_error") errors.push(event.errorMessage); });
  // Hold the admission lock so the flush parks after reading its queue head.
  const releaseFirst = await wrapper.acquirePromptAdmission();
  await wrapper.send({ type: "prompt", message: "withdrawn during admission", streamingBehavior: "followUp", deferCompactionQueue: false }).catch(() => {});
  faux.setResponses([() => { generated++; return fauxAssistantMessage([fauxText("should never run")]) }]);
  compacting = false;
  const flush = wrapper.flushDeferredCompactionPrompts();
  await new Promise(resolve => setImmediate(resolve));
  // The user withdraws the queued item while its admission is still pending.
  wrapper.deferredCompactionPrompts.splice(0);
  releaseFirst();
  await flush;
  for (let i = 0; i < 200 && generated === 0 && errors.length === 0; i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(generated, 0, "a withdrawn prompt must never reach the SDK");
  assert.deepEqual(errors, []);
});
