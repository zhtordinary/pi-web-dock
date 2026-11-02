import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
  moduleCache: false,
});
const { AgentSessionWrapper, resolveActiveToolNames, setRpcSessionTools, listReaderRuntimeSafetySnapshot } = await jiti.import("./rpc-manager.ts");
const { TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");
const { SUBAGENT_META_TYPE } = await jiti.import("./subagents.ts");
const liveEvents = await jiti.import("./live-agent-events.ts");

const READ_ONLY = ["read", "grep", "find", "ls"];

// `defaultActive` lives on the definition only; getAllTools() leaves it out, as pi's does.
const DEFINITIONS = [
  { name: "read", description: "read" },
  { name: "bash", description: "bash" },
  { name: "edit", description: "edit" },
  { name: "write", description: "write" },
  { name: "grep", description: "grep" },
  { name: "find", description: "find" },
  { name: "ls", description: "ls" },
  { name: "lookup", description: "no exposure field" },
  { name: "ask", description: "model-only", exposure: "model-only" },
  { name: "codemode", description: "registered inactive", exposure: "model-only", defaultActive: false },
  { name: "tool_search", description: "registered inactive", exposure: "model-only", defaultActive: false },
  { name: "scripted", description: "codemode", exposure: "codemode" },
  { name: "searchable", description: "deferred", exposure: "deferred" },
  { name: "withdrawn", description: "hidden", exposure: "hidden" },
];

function toolInfo(definition) {
  const info = { ...definition };
  delete info.defaultActive;
  return info;
}

function pin(tools) {
  return { type: "custom", customType: TOOL_SELECTION_TYPE, data: { version: 1, tools } };
}

function makeInner({ active = ["read", "lookup", "ask"], definitions = DEFINITIONS, entries = [], ...overrides } = {}) {
  const state = { active: [...active], activations: [] };
  const byName = new Map(definitions.map((definition) => [definition.name, definition]));
  const inner = {
    sessionId: "tool-exposure-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    sessionManager: {
      getCwd: () => "",
      getEntries: () => entries,
      getLeafId: () => "leaf",
      resetLeaf: () => {},
      buildSessionContext: () => ({ messages: [] }),
      appendCustomEntry: () => {},
    },
    settingsManager: {
      getDefaultTools: () => undefined,
      setProjectTrusted: () => {},
      isProjectTrusted: () => false,
      getGlobalSettings: () => ({}),
      getProjectSettings: () => ({}),
      reload: async () => {},
    },
    agent: { state: {} },
    extensionRunner: { emit: async () => {}, setUIContext: () => {} },
    subscribe: () => () => {},
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    getActiveToolNames: () => [...state.active],
    getAllTools: () => definitions.map(toolInfo),
    // Like pi: unknown and withdrawn tools are ignored.
    setActiveToolsByName: (names) => {
      state.activations.push(names);
      state.active = names.filter((name) => byName.has(name) && byName.get(name).exposure !== "hidden");
    },
    reload: async () => {},
    navigateTree: async () => ({ cancelled: false }),
    dispose: () => {},
    ...overrides,
  };
  return { inner, state };
}

function makeWrapper(options = {}, wrapperOptions = {}) {
  const { inner, state } = makeInner(options);
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, {
    ...(wrapperOptions.mcpHost ? { mcpHost: wrapperOptions.mcpHost } : {}),
  });
  if (wrapperOptions.chatOnly) wrapper.setForceEmptySystemPrompt(true);
  return { wrapper, inner, state };
}

test("a tool selection replaces only the coding tools and keeps the active extension tools", async (t) => {
  const { wrapper, state } = makeWrapper({
    active: ["read", "bash", "edit", "write", "lookup", "ask", "searchable", "codemode"],
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "set_tools", toolNames: READ_ONLY });

  assert.deepEqual(state.activations, [
    ["read", "grep", "find", "ls", "lookup", "ask", "searchable", "codemode"],
  ]);
});

test("a strict tool selection never carries extension tools", (t) => {
  const { inner, state } = makeInner({
    active: ["read", "bash", "lookup", "codemode"],
  });
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, {
    strictToolAllowlist: true,
  });
  t.after(() => wrapper.destroy());

  wrapper.setActiveToolSelection(READ_ONLY);

  assert.deepEqual(state.activations, [["read", "grep", "find", "ls"]]);
  assert.equal(wrapper.isStrictToolAllowlist(), true);
});

test("preferred order never restores tools excluded by the final strict selection", (t) => {
  const { inner, state } = makeInner({ active: ["lookup", "ls", "read"] });
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { strictToolAllowlist: true });
  t.after(() => wrapper.destroy());
  wrapper.setActiveToolSelection(["read", "ls"], ["lookup"], ["lookup", "ls", "read"]);
  assert.deepEqual(state.active, ["read", "ls"]);
  wrapper.setActiveToolSelection(["read", "ls"], [], ["ls", "read"]);
  assert.deepEqual(state.active, ["ls", "read"]);
});

test("live snapshot maxBytes bounds active tools and streaming projection", (t) => {
  const { inner } = makeInner();
  inner.agent.state.streamingMessage = {
    type: "assistant",
    text: "streaming-".repeat(2_000),
  };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.activeToolEvents.set("tool-call", {
    type: "tool_execution_update",
    toolCallId: "tool-call",
    toolName: "bash",
    partialResult: "active-".repeat(8_000),
  });
  t.after(() => wrapper.destroy());

  const requestedMaxBytes = 8 * 1024;
  const snapshot = wrapper.readLiveEvents({ cursor: 0, limit: 100, maxBytes: requestedMaxBytes });
  const snapshotBytes = Buffer.byteLength(JSON.stringify(snapshot), "utf8");
  assert.ok(snapshotBytes <= requestedMaxBytes - liveEvents.LIVE_EVENT_ROUTE_ENVELOPE_BYTES);
  assert.ok(Array.isArray(snapshot.events));
  assert.equal(typeof snapshot.cursor, "number");
  assert.equal(typeof snapshot.nextCursor, "number");
});

test("a tool selection does not activate tools registered with defaultActive: false", (t) => {
  const { wrapper, state } = makeWrapper();
  t.after(() => wrapper.destroy());

  wrapper.setActiveToolSelection(["read"]);

  assert.deepEqual(state.activations, [["read", "lookup", "ask"]]);
});

test("withdrawn and unregistered tools are never carried", (t) => {
  const { wrapper, state } = makeWrapper({ active: ["read", "withdrawn", "gone", "codemode"] });
  t.after(() => wrapper.destroy());

  wrapper.setActiveToolSelection(["read", "withdrawn"]);

  assert.deepEqual(state.activations, [["read", "codemode"]]);
});

test("an empty selection is Chat only", (t) => {
  const { inner } = makeInner({ active: ["read", "lookup", "codemode"] });
  assert.deepEqual(resolveActiveToolNames(inner, [], inner.getActiveToolNames()), []);

  const { wrapper, state } = makeWrapper({ active: ["read", "lookup", "codemode"] });
  t.after(() => wrapper.destroy());
  wrapper.setActiveToolSelection([]);
  assert.deepEqual(state.activations, [[]]);
});

test("startup keeps what defaultTools activates and never what pi leaves inactive", async () => {
  // The SDK's initial loadout: defaultTools plus the tools activated on registration.
  const { inner } = makeInner();
  const withCodemode = ["read", "bash", "edit", "write", "codemode", "lookup", "ask"];
  const withoutCodemode = ["read", "bash", "edit", "write", "lookup", "ask"];

  assert.deepEqual(
    resolveActiveToolNames(inner, READ_ONLY, withCodemode),
    ["read", "grep", "find", "ls", "codemode", "lookup", "ask"],
  );
  assert.deepEqual(
    resolveActiveToolNames(inner, withoutCodemode, withoutCodemode),
    ["read", "bash", "edit", "write", "lookup", "ask"],
  );

  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  assert.match(startupSource, /const initialToolNames = inner\.getActiveToolNames\(\);/);
  assert.match(
    startupSource,
    /resolveActiveToolNames\(\s*inner,\s*effectiveToolNames \?\? initialToolNames,\s*strictToolAllowlistEnabled \? \[\] : initialToolNames,\s*\)/,
  );
});

test("reload keeps the tools that were active and those an extension activated while it restarted", async (t) => {
  const { wrapper, state } = makeWrapper({
    active: ["read", "bash", "codemode", "lookup"],
    reload: async () => {
      // An extension's session_start activates tool_search; nothing activates the others.
      state.active = [...state.active, "ask", "tool_search"];
    },
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "reload" });

  assert.deepEqual(state.activations.at(-1), ["read", "bash", "codemode", "lookup", "ask", "tool_search"]);
});

test("reload rejects every SDK busy state before touching resource selections", async (t) => {
  const made = makeWrapper({ active: ["read", "lookup"] });
  t.after(() => made.wrapper.destroy());

  for (const key of ["isStreaming", "isCompacting", "isBashRunning"]) {
    made.inner[key] = true;
    await assert.rejects(made.wrapper.send({ type: "reload" }), /session is busy/);
    assert.deepEqual(made.state.activations, [], key);
    made.inner[key] = false;
  }
});

test("reload rejects while MCP preparation is pending even when SDK run flags are idle", async (t) => {
  let release;
  let markStarted;
  const started = new Promise((resolve) => {
    markStarted = resolve;
  });
  let reloads = 0;
  const made = makeWrapper({
    active: ["read"],
    reload: async () => {
      reloads += 1;
    },
  }, {
    mcpHost: {
      prepareForPrompt: async () => {
        const pending = new Promise((resolve) => {
          release = resolve;
        });
        markStarted();
        await pending;
      },
      dispose: () => {},
    },
  });
  t.after(() => {
    release?.();
    made.wrapper.destroy();
  });

  const preparation = made.wrapper.prepareMcpForRun(new AbortController().signal);
  // The host marks the wait only after its own promise is pending, so the
  // wrapper's running state is exercised rather than inferred from SDK flags.
  await started;
  assert.equal(made.inner.isStreaming, false);
  assert.equal(made.inner.isCompacting, false);
  assert.equal(made.inner.isBashRunning, false);
  assert.equal(made.wrapper.isRunning(), true);
  await assert.rejects(made.wrapper.send({ type: "reload" }), /session is busy/);
  assert.equal(reloads, 0);

  release();
  assert.equal(await preparation, true);
  assert.equal(made.wrapper.isRunning(), false);
  await made.wrapper.send({ type: "reload" });
  assert.equal(reloads, 1);
});

test("reload keeps the coding selection but not a tool an extension switched off while it restarted", async (t) => {
  const { wrapper, state } = makeWrapper({
    active: ["read", "grep", "find", "ls", "codemode", "searchable", "lookup"],
    reload: async () => {
      // pi rebuilds from the tools active before; then an extension's session_start withdraws
      // the deferred tool from the declared set, and something turns write on.
      state.active = ["read", "grep", "find", "ls", "write", "codemode", "lookup", "ask"];
    },
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "reload" });

  assert.deepEqual(state.activations.at(-1), ["read", "grep", "find", "ls", "codemode", "lookup", "ask"]);
});

test("reload does not activate tools registered with defaultActive: false", async (t) => {
  const { wrapper, state } = makeWrapper({ active: ["read", "bash", "lookup", "ask"] });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "reload" });

  assert.deepEqual(state.activations.at(-1), ["read", "bash", "lookup", "ask"]);
});

test("a direct or model-only tool an extension switched off stays off after reload and set_tools", async (t) => {
  const { wrapper, state } = makeWrapper({
    active: ["read", "bash", "lookup", "ask"],
    reload: async () => {
      // An extension's session_start(reload) keeps both extension tools out of the loadout.
      state.active = ["read", "bash"];
    },
  });
  t.after(() => wrapper.destroy());

  await wrapper.send({ type: "reload" });
  assert.deepEqual(state.activations.at(-1), ["read", "bash"]);

  await wrapper.send({ type: "set_tools", toolNames: READ_ONLY });
  assert.deepEqual(state.activations.at(-1), ["read", "grep", "find", "ls"]);
});

test("navigating the tree re-applies the pinned selection over the branch's restored tools", async (t) => {
  const made = makeWrapper({
    active: ["read", "grep", "find", "ls", "lookup", "codemode", "searchable"],
    entries: [pin(["read", "bash", "edit", "write"]), pin(READ_ONLY)],
    navigateTree: async () => {
      // pi restores the older branch's loadout from its transcript.
      made.state.active = ["read", "bash", "edit", "write", "lookup"];
      return { cancelled: false };
    },
  });
  t.after(() => made.wrapper.destroy());

  assert.deepEqual(await made.wrapper.send({ type: "navigate_tree", targetId: "older" }), {
    cancelled: false,
    leafId: "leaf",
    editorText: undefined,
  });

  // Read-only stays read-only; an inactive extension tool restored by the branch is not carried.
  assert.deepEqual(made.state.active, ["read", "grep", "find", "ls", "lookup"]);
});

test("navigating an unpinned session keeps the branch's restored tools", async (t) => {
  const made = makeWrapper({
    active: ["read", "bash", "edit", "write", "lookup", "tool_search", "searchable"],
    navigateTree: async () => {
      made.state.active = ["read", "bash", "lookup", "scripted"];
      return { cancelled: false };
    },
  });
  t.after(() => made.wrapper.destroy());

  assert.deepEqual(await made.wrapper.send({ type: "navigate_tree", targetId: "older" }), {
    cancelled: false,
    leafId: "leaf",
    editorText: undefined,
  });

  assert.deepEqual(made.state.active, ["read", "bash", "lookup", "scripted"]);
});

test("navigation keeps an extension tool off when the branch's loadout leaves it out", async (t) => {
  const made = makeWrapper({
    active: ["read", "grep", "find", "ls", "lookup", "ask"],
    entries: [pin(READ_ONLY)],
    navigateTree: async () => {
      // The branch was recorded while an extension kept both of its tools switched off.
      made.state.active = ["read", "bash", "edit", "write"];
      return { cancelled: false };
    },
  });
  t.after(() => made.wrapper.destroy());

  assert.deepEqual(await made.wrapper.send({ type: "navigate_tree", targetId: "older" }), {
    cancelled: false,
    leafId: "leaf",
    editorText: undefined,
  });

  assert.deepEqual(made.state.active, ["read", "grep", "find", "ls"]);
});

test("navigation keeps pi-web's subagent tools, which the session switched on after the branch was recorded", async (t) => {
  const agentTools = ["Agent", "get_subagent_result", "steer_subagent"].map((name) => ({ name, description: name, exposure: "model-only" }));
  const made = makeWrapper({
    definitions: [...DEFINITIONS, ...agentTools],
    active: ["read", "grep", "find", "ls", "lookup", "Agent", "get_subagent_result", "steer_subagent"],
    entries: [pin(READ_ONLY)],
    navigateTree: async () => {
      // The branch predates enabling built-in subagents and the reload that registered them.
      made.state.active = ["read", "bash", "edit", "write", "lookup"];
      return { cancelled: false };
    },
  });
  t.after(() => made.wrapper.destroy());

  assert.deepEqual(await made.wrapper.send({ type: "navigate_tree", targetId: "older" }), {
    cancelled: false,
    leafId: "leaf",
    editorText: undefined,
  });

  assert.deepEqual(made.state.active, ["read", "grep", "find", "ls", "lookup", "Agent", "get_subagent_result", "steer_subagent"]);
});

test("navigation from an extension command re-applies the selection too", async (t) => {
  const made = makeWrapper({
    active: ["read", "grep", "find", "ls", "lookup"],
    entries: [pin(READ_ONLY)],
    navigateTree: async (_targetId, options) => {
      assert.deepEqual(options, { summarize: true });
      made.state.active = ["read", "bash", "edit", "write", "lookup"];
      return { cancelled: false };
    },
  });
  t.after(() => made.wrapper.destroy());

  const actions = made.wrapper.createExtensionCommandContextActions();
  assert.deepEqual(await actions.navigateTree("older", { summarize: true }), {
    cancelled: false,
    editorText: undefined,
  });

  assert.deepEqual(made.state.active, ["read", "grep", "find", "ls", "lookup"]);
});

test("cancelled navigation, Chat only, and subagents keep the tools pi restored", async (t) => {
  const restored = ["read", "bash", "edit", "write"];
  const cases = [
    {
      name: "cancelled",
      options: { entries: [pin(READ_ONLY)], navigateTree: async () => ({ cancelled: true }) },
      wrapperOptions: {},
      expected: { cancelled: true, leafId: "leaf", editorText: undefined },
    },
    {
      name: "Chat only",
      options: { active: [], entries: [pin([])] },
      wrapperOptions: { chatOnly: true },
      expected: { cancelled: false, leafId: "leaf", editorText: undefined },
    },
    {
      name: "subagent",
      options: {
        entries: [{
          type: "custom",
          customType: SUBAGENT_META_TYPE,
          data: {
            version: 1,
            parentSessionId: "parent",
            parentSessionPath: "/tmp/parent.jsonl",
            resourceSnapshot: { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false },
          },
        }],
      },
      wrapperOptions: {},
      expected: { cancelled: false, leafId: "leaf", editorText: undefined },
    },
  ];

  for (const { name, options, wrapperOptions, expected } of cases) {
    const made = makeWrapper({
      navigateTree: async () => {
        made.state.active = [...restored];
        return { cancelled: false };
      },
      ...options,
    }, wrapperOptions);
    t.after(() => made.wrapper.destroy());

    assert.deepEqual(await made.wrapper.send({ type: "navigate_tree", targetId: "older" }), expected, name);
    assert.deepEqual(made.state.activations, [], name);
  }
});

test("get_tools reports the descriptions declared to the model", async (t) => {
  const { wrapper } = makeWrapper({
    active: ["read", "codemode"],
    // get_tools reports the SDK's registered definitions and current active set.
    agent: {
      state: {
        tools: [
          { name: "read", description: "read\n\ncodemode tool declaration: …" },
          { name: "codemode", description: "Run JavaScript … ## mcp (2 tools)" },
        ],
      },
    },
  });
  t.after(() => wrapper.destroy());

  const tools = await wrapper.send({ type: "get_tools" });
  const description = (name) => tools.find((tool) => tool.name === name).description;

  assert.equal(description("codemode"), "registered inactive");
  assert.equal(description("read"), "read");
  assert.equal(description("bash"), "bash");
  assert.equal(description("scripted"), "codemode");
});

test("get_tools preserves package source metadata for plugin attribution", async (t) => {
  const sourceInfo = {
    path: "/plugin/pi-plan-mode/index.ts",
    source: "npm:@narumitw/pi-plan-mode@0.59.2",
    scope: "user",
    origin: "package",
  };
  const { wrapper } = makeWrapper({
    active: ["plugin_tool"],
    definitions: [{ name: "plugin_tool", description: "plugin tool", sourceInfo }],
  });
  t.after(() => wrapper.destroy());

  const pluginTool = (await wrapper.send({ type: "get_tools" })).find((tool) => tool.name === "plugin_tool");
  assert.deepEqual(pluginTool.sourceInfo, sourceInfo);
});

test("get_tools leaves out withdrawn tools and reports active state", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());

  const tools = await wrapper.send({ type: "get_tools" });

  assert.deepEqual(
    tools.map(({ name, active }) => ({ name, active })),
    [
      { name: "read", active: true },
      { name: "bash", active: false },
      { name: "edit", active: false },
      { name: "write", active: false },
      { name: "grep", active: false },
      { name: "find", active: false },
      { name: "ls", active: false },
      { name: "lookup", active: true },
      { name: "ask", active: true },
      { name: "codemode", active: false },
      { name: "tool_search", active: false },
      { name: "scripted", active: false },
      { name: "searchable", active: false },
    ],
  );
});


test("managed live tools change the real active set, report strict semantics and advance CAS without event traffic", async (t) => {
  const { inner, state } = makeInner({ active: ["ls"], definitions: [{ name: "ls", description: "fixture" }] });
  const wrapper = new AgentSessionWrapper(inner, undefined, undefined, { strictToolAllowlist: true });
  t.after(() => wrapper.destroy());
  const before = wrapper.getManagedSettingsSnapshot();
  assert.deepEqual(before.tools, [{ name: "ls", active: true }]);
  const result = await wrapper.sendManagedSetting({ type: "set_tools", toolNames: [] }, { bootId: before.bootId, revision: before.revision });
  assert.deepEqual(state.active, []);
  assert.equal(result.strictToolAllowlist, true);
  assert.equal(result.selectionSemantics, "exact-registered-built-in-subset");
  assert.notEqual(result.revision, before.revision);
  assert.equal(result.cursor, before.cursor);
  await assert.rejects(wrapper.sendManagedSetting({ type: "set_tools", toolNames: ["ls"] }, before), error => error.code === "revision_conflict");
  assert.deepEqual(state.active, []);
  assert.throws(() => wrapper.validateManagedSetting({ type: "set_tools", toolNames: ["bash"] }), error => error.code === "tool_unavailable");
  assert.throws(() => wrapper.validateManagedSetting({ type: "set_tools", toolNames: ["ls", "ls"] }), error => error.code === "invalid_setting");
  assert.throws(() => wrapper.validateManagedSetting({ type: "set_tools", toolNames: [], strictToolAllowlist: false }), error => error.code === "strict_policy_mismatch");
  inner.isStreaming = true;
  await assert.rejects(wrapper.sendManagedSetting({ type: "set_tools", toolNames: ["ls"] }, result), error => error.code === "runtime_busy");
});

test("a pending managed setting excludes competing mutations while read-only inventory stays available", async (t) => {
  const { wrapper } = makeWrapper();
  t.after(() => wrapper.destroy());
  let finish;
  wrapper.refreshRemoteClaudeHostBinding = () => new Promise(resolve => { finish = resolve; });
  const before = wrapper.getManagedSettingsSnapshot();
  const changed = wrapper.sendManagedSetting({ type: "set_tools", toolNames: ["ls"] }, before);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(wrapper.isRunning(), true, "idle eviction and UI runtime installation must see the pending mutation");
  await assert.rejects(wrapper.send({ type: "prompt", message: "must not start" }), error => error.code === "runtime_busy");
  await assert.rejects(wrapper.sendManagedSetting({ type: "set_tools", toolNames: [] }, before), error => error.code === "runtime_busy");
  const observed = wrapper.getManagedSettingsSnapshot();
  assert.ok(observed.tools.some(tool => tool.name === "ls" && tool.active));
  finish();
  const result = await changed;
  assert.equal(result.selectionSemantics, "built-in-selection-preserves-active-extension-tools");
  assert.ok(result.tools.some(tool => tool.name === "lookup" && tool.active));
});


test("UI tool selection and managed settings share admission across remote-host awaits", async (t) => {
  const { wrapper, state } = makeWrapper({ active: ["read"] });
  const registry = globalThis.__piSessions ??= new Map();
  assert.equal(registry.has(wrapper.sessionId), false);
  registry.set(wrapper.sessionId, wrapper);
  t.after(() => { registry.delete(wrapper.sessionId); wrapper.destroy(); });
  let finish;
  let entered;
  const started = new Promise(resolve => { entered = resolve; });
  wrapper.refreshRemoteClaudeHostBinding = () => { entered(); return new Promise(resolve => { finish = resolve; }); };
  const before = wrapper.getManagedSettingsSnapshot();
  const ui = setRpcSessionTools(wrapper.sessionId, undefined, ["ls"]);
  await started;
  let inventory = listReaderRuntimeSafetySnapshot();
  assert.equal(inventory.runtimes.find(row => row.sessionId === wrapper.sessionId).settingsMutationPending, true);
  assert.equal(inventory.coverage.pendingRuntimeMutationCount, 1);
  await assert.rejects(wrapper.sendManagedSetting({ type: "set_tools", toolNames: ["read"] }, before), error => error.code === "runtime_busy");
  assert.deepEqual(state.active, ["ls"]);
  finish();
  assert.equal((await ui).recreated, false);
  assert.deepEqual(state.active, ["ls"]);

  const observed = wrapper.getManagedSettingsSnapshot();
  const managed = wrapper.sendManagedSetting({ type: "set_tools", toolNames: ["read"] }, observed);
  await new Promise(resolve => setImmediate(resolve));
  inventory = listReaderRuntimeSafetySnapshot();
  assert.equal(inventory.runtimes.find(row => row.sessionId === wrapper.sessionId).isRunning, true);
  assert.equal(inventory.runtimes.find(row => row.sessionId === wrapper.sessionId).settingsMutationPending, true);
  let uiSettled = false;
  const queuedUI = setRpcSessionTools(wrapper.sessionId, undefined, ["ls"]).finally(() => { uiSettled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(uiSettled, false, "UI must not mutate or recreate the managed wrapper during refresh");
  assert.deepEqual(state.active, ["read"]);
  wrapper.refreshRemoteClaudeHostBinding = async () => {};
  finish();
  assert.ok((await managed).tools.some(tool => tool.name === "read" && tool.active));
  await queuedUI;
  assert.deepEqual(state.active, ["ls"]);
});


test("managed tools cannot override profile-owned subagent resources", async (t) => {
  const resourceSnapshot = { version: 1, appendSystemPrompt: [], tools: ["read"], loadSkills: false, loadExtensions: false };
  const { wrapper, state } = makeWrapper({ active: ["read"], entries: [{ type: "custom", customType: SUBAGENT_META_TYPE, data: { version: 1, parentSessionId: "parent", parentSessionPath: "/tmp/fixture-parent.jsonl", resourceSnapshot } }] });
  t.after(() => wrapper.destroy());
  const before = wrapper.getManagedSettingsSnapshot();
  await assert.rejects(wrapper.sendManagedSetting({ type: "set_tools", toolNames: [] }, before), error => error.code === "subagent_settings_fixed");
  assert.deepEqual(state.active, ["read"]);
  assert.deepEqual(state.activations, []);
});
