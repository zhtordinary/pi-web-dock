import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { AgentSessionWrapper, ensureInitialUserPrompt, forkPersistedSessionFromFile, resolveActiveToolNames } = await jiti.import("./rpc-manager.ts");
const { TOOL_SELECTION_TYPE } = await jiti.import("./session-tool-selection.ts");
const { getPersistedUnattendedState } = await jiti.import("./session-activity.ts");

const READ_ONLY = ["read", "grep", "find", "ls"];
const TOOL_DEFINITIONS = [
  ...["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"].map((name) => ({ name, description: name })),
  { name: "runtime", description: "runtime extension", exposure: "direct" },
  { name: "modelOnly", description: "model-only extension", exposure: "model-only" },
  { name: "hidden", description: "hidden extension", exposure: "hidden" },
  { name: "inactive", description: "registered inactive", exposure: "direct", defaultActive: false },
  { name: "Agent", description: "Reader subagent control" },
];

function selectionEntry(tools) {
  return {
    type: "custom",
    customType: TOOL_SELECTION_TYPE,
    data: { version: 1, tools },
    id: `selection-${Math.random()}`,
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
  };
}

function makeToolFixture({
  active = ["read", "runtime", "modelOnly"],
  entries = [],
  afterReload = active,
  afterNavigate = active,
  afterRoot = afterNavigate,
} = {}) {
  const state = {
    active: [...active],
    afterReload: [...afterReload],
    afterNavigate: [...afterNavigate],
    afterRoot: [...afterRoot],
    activations: [],
    appended: [],
    leaf: "leaf",
    disposed: false,
    lastNavigateOptions: undefined,
  };
  const byName = new Map(TOOL_DEFINITIONS.map((definition) => [definition.name, definition]));
  const settingsManager = {
    getDefaultTools: () => undefined,
    setProjectTrusted: () => {},
    reload: async () => {},
    isProjectTrusted: () => false,
    getShellPath: () => "/bin/sh",
    applyOverrides: () => {},
    getDefaultThinkingLevel: () => "off",
    getCompactionSettings: () => ({ enabled: true }),
    getGlobalSettings: () => ({}),
    getProjectSettings: () => ({}),
  };
  const sessionManager = {
    getCwd: () => process.cwd(),
    getEntries: () => entries,
    getLeafId: () => state.leaf,
    resetLeaf: () => { state.leaf = null; state.active = [...state.afterRoot]; },
    buildSessionContext: () => ({ messages: [] }),
    appendCustomEntry: (...args) => state.appended.push(args),
  };
  const inner = {
    sessionId: "tool-exposure-session",
    sessionFile: undefined,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    autoCompactionEnabled: true,
    autoRetryEnabled: false,
    model: undefined,
    modelRuntime: { refresh: async () => {}, getModel: () => undefined },
    sessionManager,
    settingsManager,
    agent: { state: {} },
    extensionRunner: { emit: async () => {}, setUIContext: () => {}, getRegisteredCommands: () => [] },
    promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }) },
    subscribe: () => () => {},
    getActiveToolNames: () => [...state.active],
    getAllTools: () => TOOL_DEFINITIONS.map((definition) => {
      const info = { ...definition };
      delete info.defaultActive;
      return info;
    }),
    setActiveToolsByName: (names) => {
      state.activations.push([...names]);
      state.active = names.filter((name) => byName.has(name) && byName.get(name).exposure !== "hidden");
    },
    reload: async () => { state.active = [...state.afterReload]; },
    navigateTree: async (_targetId, options) => {
      state.lastNavigateOptions = options;
      state.active = [...state.afterNavigate];
      return { cancelled: false, editorText: "restored draft" };
    },
    dispose: () => { state.disposed = true; },
    abortBash: () => {},
    getContextUsage: () => undefined,
    getSteeringMessages: () => [],
    getFollowUpMessages: () => [],
    pendingMessageCount: 0,
  };
  return { inner, state, wrapper: new AgentSessionWrapper(inner) };
}

function unattendedFixture(t) {
  const { inner } = makeToolFixture();
  inner.sessionId = randomUUID();
  inner.agent.state.messages = [];
  inner.prompt = async (_message, options) => { options?.preflightResult?.("started"); };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  return { inner, wrapper, saved: () => getPersistedUnattendedState(inner.sessionId) };
}

test("reading and reclaiming an unconfigured runtime cannot persist a disabled preference", async (t) => {
  const { inner, wrapper, saved } = unattendedFixture(t);
  const events = [];
  wrapper.onEvent(event => events.push(event));
  assert.deepEqual(await wrapper.send({ type: "get_unattended" }), { enabled: false, configured: false, state: null });
  assert.equal(saved(), null);
  await wrapper.shutdown();
  assert.equal(saved(), null, "cleanup is not a user setting");
  assert.equal(events.filter(event => event.type === "unattended_state").at(-1)?.configured, false);
  const reopened = new AgentSessionWrapper(inner);
  t.after(() => reopened.destroy());
  reopened.restoreUnattendedState(saved());
  await reopened.send({ type: "prompt", message: "first explicit input" });
  assert.equal(reopened.getUnattendedEnabled(), true);
  assert.equal(saved()?.enabled, true);
});

test("a supplied initial question becomes one real user prompt and is not duplicated", async (t) => {
  const { inner, wrapper } = unattendedFixture(t);
  const entries = [];
  inner.sessionManager.getEntries = () => entries;
  inner.prompt = async (message, options) => {
    entries.push({ type: "message", message: { role: "user", content: message } });
    options?.preflightResult?.("started");
  };
  assert.equal(await ensureInitialUserPrompt(wrapper, "first user question"), true);
  assert.equal(await ensureInitialUserPrompt(wrapper, "first user question"), false);
  assert.deepEqual(entries, [{ type: "message", message: { role: "user", content: "first user question" } }]);
});

test("first explicit prompt, steer, and follow-up initialize the unattended default", async (t) => {
  for (const type of ["prompt", "steer", "follow_up"]) {
    const { wrapper, saved } = unattendedFixture(t);
    await wrapper.send({ type, message: "new user input" });
    assert.equal(wrapper.getUnattendedEnabled(), true, type);
    assert.equal(wrapper.getUnattendedConfigured(), true, type);
    assert.equal(saved()?.enabled, true, type);
  }
});

test("default initialization preserves saved on and off choices through input and reopening", async (t) => {
  for (const enabled of [false, true]) {
    const { inner, wrapper, saved } = unattendedFixture(t);
    wrapper.restoreUnattendedState({ enabled, schedulerState: null, updatedAt: new Date().toISOString() });
    await wrapper.send({ type: "prompt", message: "keep the saved choice" });
    assert.equal(wrapper.getUnattendedEnabled(), enabled);
    await wrapper.shutdown();
    assert.equal(saved()?.enabled, enabled);
    const reopened = new AgentSessionWrapper(inner);
    t.after(() => reopened.destroy());
    reopened.restoreUnattendedState(saved());
    await reopened.send({ type: "prompt", message: "keep it after reopening" });
    assert.equal(reopened.getUnattendedEnabled(), enabled);
  }
});

test("explicit default initialization never evaluates or retries a historical failed tail", (t) => {
  const { inner, wrapper, saved } = unattendedFixture(t);
  inner.agent.state.messages = [
    { role: "user", content: "old task", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable", timestamp: 2 },
  ];
  wrapper.initializeUnattendedDefault();
  assert.equal(wrapper.getUnattendedEnabled(), true);
  assert.equal(wrapper.getSchedulerState(), null);
  assert.equal(wrapper.schedulerTimer, null);
  assert.equal(saved()?.enabled, true);
});

test("transient tool-policy recreation carries the configured choice without resuming old errors", async (t) => {
  const { wrapper, saved } = unattendedFixture(t);
  wrapper.initializeUnattendedDefault(false);
  assert.equal(wrapper.getUnattendedConfigured(), true);
  assert.equal(wrapper.getUnattendedEnabled(), false);
  assert.equal(saved()?.enabled, false);
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const toolsSource = source.slice(source.indexOf("export async function setRpcSessionTools"), source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export async function setRpcSessionTools")));
  assert.match(toolsSource, /if \(existing\.getUnattendedConfigured\(\)\) started\.session\.initializeUnattendedDefault\(existing\.getUnattendedEnabled\(\)\)/);
});

test("explicit retry initializes an unset default without appending another user message", async (t) => {
  const { inner, wrapper, saved } = unattendedFixture(t);
  inner.agent.state.messages = [
    { role: "user", content: "继续", timestamp: 1 },
    { role: "assistant", content: [], stopReason: "error", errorMessage: "503 Service Unavailable", timestamp: 2 },
  ];
  let retried = 0;
  wrapper.retryLastFailedTurn = async () => { retried++; };
  await wrapper.send({ type: "retry_continue_only" });
  assert.equal(retried, 1);
  assert.equal(wrapper.getUnattendedConfigured(), true);
  assert.equal(saved()?.enabled, true);
  assert.equal(inner.agent.state.messages.length, 2);
});

test("invalid input and rejected branch admission leave the default unconfigured", async (t) => {
  const { wrapper, saved } = unattendedFixture(t);
  await assert.rejects(wrapper.send({ type: "prompt", message: "bad image", images: "invalid" }), /image/i);
  await assert.rejects(wrapper.send({ type: "prompt", message: "stale branch", expectedLeafId: "other-leaf" }));
  await assert.rejects(wrapper.send({ type: "retry_continue_only" }), /No continue turn/);
  assert.equal(wrapper.getUnattendedConfigured(), false);
  assert.equal(saved(), null);
});

test("client message IDs follow exact native prompt and queue objects without entering SDK messages", async (t) => {
  const entries = [], events = [], queued = [];
  const { inner } = makeToolFixture({ entries });
  let listener, failIdentityWrite = false, nextId = 0;
  inner.sessionManager.getSessionFile = () => undefined;
  inner.sessionManager.appendCustomEntry = (customType, data) => {
    if (failIdentityWrite && customType === 'pi-web:client-message') throw new Error('fixture identity write failed');
    entries.push({ type:'custom',id:`meta-${++nextId}`,parentId:entries.at(-1)?.id??null,timestamp:'2026-10-23T00:00:00Z',customType,data });
  };
  const deliver = message => {
    listener({type:'message_start',message});
    listener({type:'message_end',message});
    entries.push({type:'message',id:`message-${++nextId}`,parentId:entries.at(-1)?.id??null,timestamp:'2026-10-23T00:00:00Z',message});
  };
  inner.agent = { state:{}, prompt:async messages=>{ for(const message of messages) deliver(message); }, steer:message=>queued.push(message), followUp:message=>queued.push(message) };
  inner.subscribe = callback => {listener=callback;return ()=>{};};
  inner.prompt = async (text,options) => {
    const message={role:'user',timestamp:1,content:[{type:'text',text},{type:'image',data:'AQID',mimeType:'image/png'}]};
    options?.preflightResult?.('started');
    if(options?.streamingBehavior) inner.agent[options.streamingBehavior](message);
    else await inner.agent.prompt([message]);
  };
  const wrapper=new AgentSessionWrapper(inner);
  wrapper.onEvent(event=>events.push(event));
  wrapper.start();
  t.after(()=>wrapper.destroy());
  for(const behavior of [undefined,'steer','followUp']) {
    const clientMessageId=`client-${behavior??'prompt'}`;
    await wrapper.promptWithDisplayTracking('same',behavior?{streamingBehavior:behavior}:{},clientMessageId);
    if(behavior) deliver(queued.shift());
    await new Promise(resolve=>setImmediate(resolve));
    const completed=events.filter(event=>event.type==='message_end').at(-1);
    assert.equal(completed.clientMessageId,clientMessageId);
    assert.ok(completed.entryId);
    const ordinal=entries.findIndex(entry=>entry.id===completed.entryId);
    assert.deepEqual(completed.orderKey,[ordinal,1,ordinal]);
    assert.equal(Object.hasOwn(completed.message,'clientMessageId'),false);
    assert.equal(Object.hasOwn(completed.message,'orderKey'),false);
    const identity=entries.find(entry=>entry.type==='custom'&&entry.data?.clientMessageId===clientMessageId);
    assert.equal(identity.data.entryId,completed.entryId);
  }
  failIdentityWrite=true;
  await wrapper.promptWithDisplayTracking('write failure',{},'client-failed-write');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(events.filter(event=>event.type==='message_end').at(-1).clientMessageId,'client-failed-write');
  assert.ok(events.some(event=>event.type==='extension_error'&&event.error.includes('Do not resend')));
});

async function customMessageFixture(t) {
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const { inner } = makeToolFixture();
  const manager = SessionManager.inMemory(process.cwd());
  let listener;
  const events = [];
  inner.sessionManager = manager;
  inner.sessionId = manager.getSessionId();
  inner.agent = { state: { messages: [] } };
  inner.subscribe = (callback) => { listener = callback; return () => {}; };
  const wrapper = new AgentSessionWrapper(inner);
  wrapper.onEvent((event) => { if (event.type === "message_end") events.push(event); });
  wrapper.start();
  t.after(() => wrapper.destroy());
  return { inner, manager, events, deliver: (message) => {
    listener({ type: "message_start", message });
    listener({ type: "message_end", message });
  } };
}

test("queued identical custom messages receive their distinct SDK projection identities", async (t) => {
  const { emptyTranscript, appendPersisted, mergeTranscriptPage } = await jiti.import("./transcript-store.ts");
  const { createHistoryProjection, getHistoryWindow } = await jiti.import("./session-history.ts");
  for (const content of ["same memory", [{ type: "text", text: "same memory" }]]) {
    const h = await customMessageFixture(t);
    const details = { source: "fixture" };
    h.manager.appendCustomMessageEntry("honcho-memory-context", content, true, details);
    h.inner.agent.state.messages = h.manager.buildSessionContext().messages;
    const expected = [];
    for (let i = 0; i < 2; i += 1) {
      const message = { role: "custom", customType: "honcho-memory-context", content, display: true, details, timestamp: 1 };
      h.inner.agent.state.messages.push(message);
      h.deliver(message);
      expected.push(h.manager.appendCustomMessageEntry(message.customType, content, true, details));
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(h.events.map((event) => event.entryId), expected);
    assert.notEqual(expected[0], expected[1]);
    h.events.forEach((event) => {
      const ordinal = h.manager.getEntries().findIndex((entry) => entry.id === event.entryId);
      assert.deepEqual(event.orderKey, [ordinal, 1, ordinal]);
    });
    let transcript = emptyTranscript();
    for (const event of h.events) transcript = appendPersisted(transcript, event.message, event.entryId, { orderKey: event.orderKey });
    const history = getHistoryWindow(createHistoryProjection(h.manager.getEntries(), { sessionId: h.inner.sessionId }));
    transcript = mergeTranscriptPage(transcript, history, "append");
    assert.deepEqual(transcript.entryIds, history.items.map((item) => item.entryId));
    assert.equal(transcript.messages.length, 3, "history must join both live rows, not leave runtime-only copies");
  }
});

test("already-persisted custom events bind before a later identical idle message is appended", async (t) => {
  const h = await customMessageFixture(t);
  const content = "identical idle notice";
  const expected = [];
  for (let i = 0; i < 2; i += 1) {
    const message = { role: "custom", customType: "notice", content, display: true, timestamp: 1 };
    expected.push(h.manager.appendCustomMessageEntry(message.customType, content, true));
    h.inner.agent.state.messages = h.manager.buildSessionContext().messages;
    assert.equal(h.inner.agent.state.messages.includes(message), false);
    h.deliver(message);
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(h.events.map((event) => event.entryId), expected);
  h.events.forEach((event) => {
    const ordinal = h.manager.getEntries().findIndex((entry) => entry.id === event.entryId);
    assert.deepEqual(event.orderKey, [ordinal, 1, ordinal]);
  });
});

test("persisted custom identity remains available when optional agent state or messages are absent", async (t) => {
  for (const state of [undefined, {}]) {
    const h = await customMessageFixture(t);
    const message = { role: "custom", customType: "notice", content: "persisted notice", display: true, timestamp: 1 };
    const id = h.manager.appendCustomMessageEntry(message.customType, message.content, message.display);
    h.inner.agent.state = state;
    h.deliver(message);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.events.at(-1)?.entryId, id);
    const ordinal = h.manager.getEntries().findIndex((entry) => entry.id === id);
    assert.deepEqual(h.events.at(-1)?.orderKey, [ordinal, 1, ordinal]);
  }
});

test("RPC session startup preloads extension-registered providers before restoring models", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /createAgentSessionServices\(/);
  assert.match(startupSource, /createAgentSessionFromServices\(/);
  assert.doesNotMatch(startupSource, /await createAgentSession\(/);
});

test("tool activation uses the SDK active set instead of re-adding every registered extension", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const helperSource = source.slice(
    source.indexOf("export function resolveActiveToolNames"),
    source.indexOf("function readSessionThinkingLevel"),
  );

  assert.ok(source.includes('const CODING_TOOL_NAMES = ["read", "bash", "powershell", "edit", "write", "grep", "find", "ls"];'));
  assert.match(helperSource, /resolveShellTools\(/);
  assert.match(helperSource, /carry\.filter/);
  assert.match(helperSource, /exposure !== "hidden"/);
  assert.doesNotMatch(source, /withExtensionTools/);
});


test("RPC session startup resolves and passes the SDK-native enabled model scope", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const resolveIndex = startupSource.indexOf("resolveVisibleModels(");
  const createIndex = startupSource.indexOf("createAgentSessionFromServices(");

  assert.ok(resolveIndex >= 0);
  assert.ok(createIndex > resolveIndex);
  assert.match(startupSource, /selectInitialModelScope\(/);
  assert.match(startupSource, /scopedModels: initial\.scopedModels/);
  assert.match(startupSource, /model: initial\.model/);
  assert.match(startupSource, /thinkingLevel: initial\.thinkingLevel/);
});

test("RPC session startup treats only sessions with messages as continuing", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const hasExistingMessages = sessionManager\.getBranch\(\)\.some\(\(entry\) => entry\.type === "message"\)/,
  );
  assert.match(startupSource, /const initial = hasExistingMessages/);
  assert.doesNotMatch(startupSource, /const initial = sessionFile/);
  assert.doesNotMatch(startupSource, /sessionManager\.buildSessionContext\(\)/);
});

test("RPC session startup validates the selected manager cwd without route-level opens", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const routeSource = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const eventRouteSource = await readFile(new URL("../app/api/agent/[id]/events/route.ts", import.meta.url), "utf8");
  const autoNameRouteSource = await readFile(new URL("../app/api/sessions/[id]/auto-name/route.ts", import.meta.url), "utf8");

  assert.equal((startupSource.match(/SessionManager\.open\(/g) ?? []).length, 1);
  assert.match(startupSource, /const sessionCwd = assertReaderExecutionCwd\(sessionManager\.getCwd\(\)\)/);
  assert.match(startupSource, /projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /cwd: sessionCwd/);
  for (const route of [routeSource, eventRouteSource, autoNameRouteSource]) {
    assert.doesNotMatch(route, /SessionManager\.open\(/);
  }
});

test("RPC wrapper avoids per-chunk idle and running-state maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const notifySource = source.slice(
    source.indexOf("export function notifyRunningChange"),
    source.indexOf("export async function startRpcSession"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.match(startSource, /RUNNING_STATE_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
  assert.match(notifySource, /if \(listeners\.size === 0\)/);
  assert.match(notifySource, /lastRunningSnapshot = ""/);
});

test("message persistence invalidates activity snapshots after the SDK append", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  assert.match(
    startSource,
    /event\.type === "message_end"[\s\S]*?queueMicrotask\(\(\) => \{[\s\S]*?invalidateSessionListCache\(\);[\s\S]*?emitActivityEvent\(\{ kind: "session", sessionId \}\)/,
  );
});

test("normal session teardown paths use graceful extension shutdown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deleteRouteSource = await readFile(new URL("../app/api/sessions/[id]/route.ts", import.meta.url), "utf8");
  const trustRouteSource = await readFile(new URL("../app/api/project-trust/route.ts", import.meta.url), "utf8");
  const idleSource = source.slice(
    source.indexOf("  private resetIdleTimer"),
    source.indexOf("  private persistBashOnlySession"),
  );
  const forkSource = source.slice(
    source.indexOf('case "fork"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(idleSource, /this\.shutdown\(\)/);
  assert.match(forkSource, /if \(!this\.isRunning\(\)\) await this\.shutdown\(\)/);
  assert.match(deleteRouteSource, /await getRpcSession\(id\)\?\.shutdown\(\)/);
  assert.match(trustRouteSource, /await destroyRpcSessionsForCwd\(result\.cwd\)/);
});

test("archive shutdown closes RPC write admission before teardown", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("  async shutdown(): Promise<void>"));

  assert.match(source, /assertSessionWriteAllowed/);
  assert.match(source, /if \(this\.shuttingDown && type !== "get_state"\)/);
  assert.match(source, /if \(!\["get_state", "abort", "abort_bash", "abort_compaction", "stop_all"\]\.includes\(type\)\) this\.assertWriteOpen\(\)/);
  assert.match(shutdown, /this\.shuttingDown = true;[\s\S]*this\.clearScheduler\("manual"\)/);
});

test("session shutdown preserves configured unattended preference", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const shutdown = source.slice(source.indexOf("  async shutdown(): Promise<void>"));

  // Idle teardown disposes the in-memory wrapper; it must not turn a still
  // enabled session preference into a durable explicit-off state.
  assert.doesNotMatch(shutdown, /this\.unattendedEnabled = false;/);
  assert.match(shutdown, /this\.clearScheduler\("manual"\);/);
});

test("new sessions stay transient until a durable lifecycle event", async () => {


  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const persistStart = source.indexOf("  persistSessionFileNow(");
  const persistEnd = source.indexOf("\n  onEvent(", persistStart);
  const persistSource = source.slice(persistStart, persistEnd);
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
const nameSource = source.slice(source.indexOf('case "set_session_name"'), source.indexOf('case "get_session_stats"'));
  const toolsSource = source.slice(source.indexOf('case "set_tools"'), source.indexOf('case "reload"'));

  assert.match(startupSource, /registerRpcSession\(wrapper\);/);
  assert.doesNotMatch(startupSource, /wrapper\.persistSessionFileNow\(\);/);
  assert.match(source, /event\.type === "message_end"[\s\S]*?queueMicrotask\(\(\) => \{[\s\S]*?this\.persistSessionFileNow\(\);/);
  assert.match(source, /if \(!sessionFile \|\| existsSync\(sessionFile\)\) return false;/);
  assert.match(nameSource, /this\.persistSessionFileNow\(true\);/);
  assert.doesNotMatch(toolsSource, /persistSessionFileNow/);

const bashSource = source.slice(source.indexOf('case "bash"'), source.indexOf('case "abort_bash"'));

  // Creating an ensure_session runtime must not create a durable empty JSONL.
  assert.match(persistSource, /allowEmpty = false/);
  assert.match(persistSource, /const entries = manager\.getEntries\(\);[\s\S]*const hasMessage = entries\.some/);
  assert.match(persistSource, /if \(!allowEmpty && !hasMessage\) return;/);
  // Existing files and message-backed sessions still use the same idempotent path.
  assert.match(persistSource, /if \(!sessionFile \|\| existsSync\(sessionFile\)\) return;/);
  assert.doesNotMatch(startupSource, /wrapper\.persistSessionFileNow\(\);/);
  // Bash-only sessions remain durable because bash is an actual user action.
  assert.match(bashSource, /this\.persistSessionFileNow\(true\);/);
});

test("new-session route applies model scope during construction instead of follow-up commands", async () => {
  const source = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  assert.match(source, /initialModel: \{ provider, modelId \}/);
  assert.match(source, /thinkingLevel: explicitThinkingLevel/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_model"/);
  assert.doesNotMatch(source, /session\.send\(\{ type: "set_thinking_level"/);
  assert.match(source, /model: state\.model/);
  assert.match(source, /thinkingLevel: state\.thinkingLevel/);
});

test("prompt routes mark only preflight failures as rejected", async () => {
  const existingRoute = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const newRoute = await readFile(new URL("../app/api/agent/new/route.ts", import.meta.url), "utf8");

  for (const source of [existingRoute, newRoute]) {
    assert.match(source, /let promptAccepted = false/);
    assert.match(source, /await .*\.send\(/);
    assert.match(source, /promptAccepted = .*\.type === "prompt"/);
    assert.match(source, /commandType === "prompt" && !promptAccepted/);
  }
});

test("RPC session startup persists only explicit model defaults", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.match(startupSource, /modelDefaultChanged\) invalidateModelsCache\(\)/);
  const persistenceBlock = startupSource.slice(
    startupSource.indexOf("const persistedPreferences"),
    startupSource.indexOf("// If specific tool names", startupSource.indexOf("const persistedPreferences")),
  );
  assert.match(persistenceBlock, /\{ model: initialModel \}/);
  assert.doesNotMatch(persistenceBlock, /thinkingLevel/);
});

test("custom extension UI receives the fixed headless terminal facade", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const customUiSource = source.slice(
    source.indexOf("private requestExtensionCustomUi"),
    source.indexOf("private requestExtensionUi"),
  );

  assert.match(customUiSource, /createHeadlessCustomUiTui\(/);
  assert.match(customUiSource, /width,/);
});

test("pending custom extension UI counts as waiting for user", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const interactionSource = source.slice(
    source.indexOf("hasPendingUserInteraction(): boolean"),
    source.indexOf("  start(): void"),
  );

  assert.match(interactionSource, /\["select", "confirm", "input", "editor", "custom"\]/);
});

test("waiting-for-user subscription broadcasts pending request ids", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const machinery = source.slice(source.indexOf("getWaitingListeners"), source.indexOf("export async function startRpcSession"));

  assert.match(machinery, /subscribeWaitingUserRequests/);
  assert.match(machinery, /notifyWaitingUserChange/);
  assert.match(machinery, /getWaitingForUserRequests/);
  assert.match(machinery, /pendingUserRequestIds\(\)/);
  assert.match(machinery, /globalThis\.__piWaitingListeners/);
  // 请求出现与消失（settle/close/destroy）都必须通知订阅者。
  assert.match(source, /notifyWaitingUserChange\(\);/g);
  assert.ok((source.match(/notifyWaitingUserChange\(\);/g) ?? []).length >= 5);
});

test("steer and follow_up route through prompt() so input hooks (image compression) run", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const combined = source.slice(source.indexOf('case "steer"'), source.indexOf('case "get_tools"'));
  assert.match(combined, /case "steer":\s+case "follow_up":/);
  // Both commands share one input-hook path, preserving image transformations.
  assert.match(combined, /this\.promptWithDisplayTracking\(command\.message/);
  assert.match(combined, /streamingBehavior: type === "steer" \? "steer" : "followUp"/);
  assert.doesNotMatch(combined, /this\.inner\.(steer|followUp)\(/);
  assert.match(combined, /\.\.\.\(images\?\.length \? \{ images \} : \{\}\)/);

});

test("queues streaming prompts and image attachments submitted during compaction", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "set_unattended"'),
  );
  const queueSource = source.slice(
    source.indexOf("private queuedMessages"),
    source.indexOf("private enqueuePromptDisplayInput"),
  );
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "set_model"'),
  );
  const clearSource = source.slice(
    source.indexOf('case "clear_queue"'),
    source.indexOf('case "steer"'),
  );
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );

  assert.match(promptSource, /streamingBehavior && this\.inner\.isCompacting/);
  assert.match(promptSource, /this\.deferPromptDuringCompaction\(/);
  assert.match(promptSource, /promptImages/);
  assert.match(queueSource, /deferredCompactionPrompts/);
  assert.match(queueSource, /prompt\.images/);
  assert.match(queueSource, /await this\.send\(/);
  assert.match(queueSource, /scheduleDeferredCompactionPromptFlush/);
  assert.match(source, /private scheduleDeferredCompactionPromptFlush\(delayMs = 0\)/);
  assert.match(startSource, /event\.type === "compaction_end"\) this\.scheduleDeferredCompactionPromptFlush\(\)/);
  assert.match(stateSource, /pendingMessageCount: queueIdentity\.counts\.total/);
  assert.match(stateSource, /queuedMessages: this\.queuedMessages\(\)/);
  assert.match(clearSource, /const deferred = this\.deferredCompactionPrompts\.splice\(0\)/);
});

test("deferred compaction prompts terminate after non-compaction rejection", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const flushSource = source.slice(
    source.indexOf("  private async flushDeferredCompactionPrompts"),
    source.indexOf("  private enqueuePromptDisplayInput"),
  );
  const catchStart = flushSource.indexOf("      } catch (error) {");
  assert.ok(catchStart >= 0, "deferred prompt catch path is present");
  const catchSource = flushSource.slice(catchStart);
  const retryGuard = catchSource.indexOf("if (this.inner.isCompacting)");
  assert.ok(retryGuard >= 0, "a compaction race is still distinguished from a terminal rejection");
  // The item stays queued while admission is awaited, so a compaction race
  // only has to release the claim; a terminal rejection removes it for good.
  const retryBody = catchSource.slice(retryGuard, catchSource.indexOf("removeTaken()", retryGuard));
  assert.match(retryBody, /admittingDeferredPrompts\.delete\(prompt\)/);
  assert.doesNotMatch(retryBody, /unshift/);
  assert.match(catchSource, /this\.emit\(\s*\{\s*type: "prompt_error"/);
});

test("a deferred item is only removed after it was actually admitted", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const flushSource = source.slice(
    source.indexOf("  private async flushDeferredCompactionPrompts"),
    source.indexOf("  private enqueuePromptDisplayInput"),
  );
  // Taking the head must not splice it: the awaited admission below is exactly
  // the window in which a Recall can arrive.
  assert.match(flushSource, /const prompt = this\.deferredCompactionPrompts\[0\]/);
  assert.doesNotMatch(flushSource, /deferredCompactionPrompts\.shift\(\)/);
  assert.match(flushSource, /deferredCompactionPrompts\.indexOf\(prompt\)/);
  assert.match(flushSource, /if \(!this\.deferredCompactionPrompts\.includes\(prompt\)\) \{ removeTaken\(\); continue; \}/);
});

test("extension-command reload reapplies the runtime auto-compaction override", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadStart = source.indexOf("private async reloadResources(): Promise<void>");
  const reloadEnd = source.indexOf("private createExtensionCommandContextActions", reloadStart);
  assert.ok(reloadStart >= 0 && reloadEnd > reloadStart, "shared reload helper is present");
  const reloadSource = source.slice(reloadStart, reloadEnd);
  assert.match(reloadSource, /await this\.inner\.reload\(/);
  assert.match(reloadSource, /this\.applyForcedEmptySystemPrompt\(\);[\s\S]*?this\.applyRuntimeAutoCompactionOverride\(\);/);
  assert.match(source.slice(reloadEnd), /reload: async \(\) => \{\s*await this\.reloadResources\(\);/);
});

test("reloading a session invalidates the models cache", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const reloadSource = source.slice(
    source.indexOf('case "reload"'),
    source.indexOf('case "abort_compaction"'),
  );

  assert.match(reloadSource, /await this\.reloadResources\(\)/);
  const helperStart = source.indexOf("private async reloadResources(): Promise<void>");
  const helperEnd = source.indexOf("private createExtensionCommandContextActions", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "shared reload helper is present");
  const helperSource = source.slice(helperStart, helperEnd);
  assert.match(helperSource, /this\.applyForcedEmptySystemPrompt\(\);[\s\S]*?this\.applyRuntimeAutoCompactionOverride\(\);[\s\S]*?invalidateModelsCache\(\);/);
});

test("retries remove a failed assistant before each repeated Agent.continue", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const retrySource = source.slice(
    source.indexOf("private async retryLastFailedTurn"),
    source.indexOf("  async send(", source.indexOf("private async retryLastFailedTurn")),
  );
  const loopSource = retrySource.slice(retrySource.indexOf("while (await"));

  assert.match(retrySource, /continueRetryIndex\(/);
  assert.match(retrySource, /continueRetryMode\(/);
  assert.match(retrySource, /const prepareRetry = \(required: boolean\): boolean/);
  assert.match(retrySource, /currentRetryIndex/);
  assert.match(loopSource, /if \(!prepareRetry\(false\)\) break;/);
  assert.match(retrySource, /await session\.agent\.continue\(\)/);
});

test("unattended retry stays visible as running and exposes the unattended flag", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // Agent.continue() does not increment pendingPromptCount, so the scheduler's
  // retry window must count promptRunning or the activity panel reports a fake
  // "failed" state (and plays the error sound) while the retry is in flight.
  const runningSource = source.slice(
    source.indexOf("isRunning(): boolean"),
    source.indexOf("setUnattendedEnabled("),
  );
  assert.match(runningSource, /pendingPromptCount > 0 \|\| this\.questionAnalysisJobs\.size > 0 \|\| this\.promptRunning/);
  const schedulerSource = source.slice(
    source.indexOf("getSchedulerState(): SchedulerState | null"),
    source.indexOf("private clearScheduler("),
  );
  assert.match(schedulerSource, /getUnattendedEnabled\(\): boolean[\s\S]*?return this\.unattendedEnabled/);
  assert.match(source, /recordSessionRunError\(this\.inner\.sessionId, errorMessage, this\.unattendedEnabled, this\.currentRunId\)/);
  assert.match(source, /private emit\(event: AgentEvent\)[\s\S]*?unattended: this\.unattendedEnabled/);
});

test("activity status distinguishes normal prompts from retry execution", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const activitySource = source.slice(
    source.indexOf("isRetryInFlight(): boolean"),
    source.indexOf("setUnattendedEnabled("),
  );
  assert.match(activitySource, /isRetryInFlight\(\): boolean[\s\S]*?return this\._alive && this\.promptRunning/);
  assert.match(activitySource, /isUserPromptActive\(\): boolean[\s\S]*?pendingPromptCount > 0[\s\S]*?this\.inner\.isStreaming && !this\.promptRunning/);
});

test("fireScheduler re-arms the next backoff on busy instead of clearing (pi retry storm)", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const fireSource = source.slice(
    source.indexOf("private fireScheduler(): void"),
    source.indexOf("private scheduleNextBackoff("),
  );
  // Unattended switched off still stops the scheduler immediately...
  assert.match(fireSource, /if \(this\.shuttingDown \|\| !this\.unattendedEnabled\) \{\s*this\.clearScheduler\(\);/);
  // ...but a busy session (pi's built-in transient retry in flight) must
  // re-arm the next backoff instead of dying, so the scheduler takes over
  // once the storm subsides.
  assert.match(
    fireSource,
    /if \(this\.pendingPromptCount > 0\) \{[\s\S]*?this\.clearScheduler\("manual"\);[\s\S]*?return;/,
  );
  assert.match(
    fireSource,
    /if \(this\.promptRunning \|\| this\.inner\.isStreaming \|\| this\.inner\.isCompacting \|\| this\.inner\.isBashRunning\) \{[\s\S]*?this\.scheduleNextBackoff\(/,
  );
  assert.doesNotMatch(fireSource, /if \(!this\.unattendedEnabled \|\| this\.promptRunning/);
});

test("new prompt clears stale unattended scheduler before admission", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "set_unattended"'),
  );
  const prepareSource = source.slice(source.indexOf("private async prepareInputRuntime"), source.indexOf("private assertInputPreparationActive"));
  assert.match(prepareSource, /if \(this\.schedulerState\) this\.clearScheduler\("manual"\);/);
  assert.match(promptSource, /await this\.prepareInputRuntime\(inputGeneration\);[\s\S]*?this\.pendingPromptCount \+= 1/);
});

test("completed assistant turns defer automatic compaction with a runtime override", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const deferSource = source.slice(
    source.indexOf("private deferPostRunCompaction"),
    source.indexOf("  start(): void"),
  );
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  setForceEmptySystemPrompt"),
  );
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "set_unattended"'),
  );
  const retrySource = source.slice(
    source.indexOf('case "retry_continue"'),
    source.indexOf('case "abort"'),
  );
  const stateSource = source.slice(
    source.indexOf('case "get_state"'),
    source.indexOf('case "set_model"'),
  );
  const compactSource = source.slice(
    source.indexOf('case "compact"'),
    source.indexOf('case "set_session_name"'),
  );
  const autoCompactionSource = source.slice(
    source.indexOf('case "set_auto_compaction"'),
    source.indexOf('case "clear_queue"'),
  );
  const steerSource = source.slice(
    source.indexOf('case "steer"'),
    source.indexOf('case "get_tools"'),
  );
  const destroySource = source.slice(
    source.indexOf("  private disposeNow(): void"),
    source.indexOf("  private async runShutdown(): Promise<void>"),
  );

  assert.match(deferSource, /assistant\.role !== "assistant" \|\| assistant\.stopReason !== "stop"/);
  assert.match(deferSource, /pendingQueueCount\(\) > 0/);
  assert.match(deferSource, /settings\.enabled/);
  assert.match(deferSource, /applyOverrides\(\{ compaction: \{ enabled: false \} \}\)/);
  assert.doesNotMatch(deferSource, /isContextOverflow/);
  assert.match(startSource, /event\.type === "message_end"[\s\S]*?deferPostRunCompaction\(event\.message\)/);
  assert.match(startSource, /event\.type === "agent_end"[\s\S]*?pendingQueueCount\(\) > 0[\s\S]*?restoreDeferredCompaction\(\)/);
  assert.match(startSource, /event\.type === "agent_settled"[\s\S]*?restoreDeferredCompaction\(\)/);
  assert.match(promptSource, /await this\.prepareInputRuntime\(inputGeneration\)/);
  const prepareSource = source.slice(source.indexOf("private async prepareInputRuntime"), source.indexOf("private assertInputPreparationActive"));
  assert.match(prepareSource, /!this\.inner\.isCompacting\) this\.restoreDeferredCompaction\(\)/);
  assert.match(retrySource, /clearScheduler\("manual"\);[\s\S]*?restoreDeferredCompaction\(\)/);
  assert.match(stateSource, /autoCompactionEnabled: this\.reportedAutoCompactionEnabled\(\)/);
  assert.match(compactSource, /withFinalRunningNotification[\s\S]*?restoreDeferredCompaction\(\)/);
  assert.match(autoCompactionSource, /restoreDeferredCompaction\(\);[\s\S]*?setAutoCompactionEnabledRuntimeOnly/);
  assert.match(source, /applyRuntimeCompactionOverride\(this\.inner\.settingsManager, enabled\)/);
  assert.match(stateSource, /reportedAutoCompactionEnabled\(\)/);
  assert.match(steerSource, /case "steer":\s+case "follow_up":[\s\S]*?prepareInputRuntime\(inputGeneration\)/);
  assert.match(prepareSource, /clearScheduler\("manual"\)/);
  assert.match(destroySource, /this\.restoreDeferredCompaction\(\)/);
});

test("chat-only transient recreation carries context lineage and Fast mode", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const toolsSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export async function setRpcSessionTools")),
  );

  assert.match(toolsSource, /buildTransientSessionRecreationOptions\(existing\.inner\.sessionManager/);
  assert.match(toolsSource, /const recreationOptions/);
  assert.match(toolsSource, /startRpcSession\([\s\S]*?recreationOptions/);
});

test("serializes concurrent tool-policy recreation per logical session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const toolsSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export async function setRpcSessionTools")),
  );
  assert.match(source, /var __piToolMutationLocks/);
  assert.match(source, /async function withToolMutationLock/);
  assert.match(toolsSource, /return withToolMutationLock\(sessionId, async \(\) =>/);
  assert.match(toolsSource, /await existing\.shutdown\(\)/);
});

test("agent_end failure re-arms the unattended scheduler even after it was cleared", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const endSource = source.slice(
    source.indexOf('} else if (event.type === "agent_end") {'),
    source.indexOf('} else if (event.type === "agent_settled") {'),
  );
  assert.match(
    endSource,
    /this\.unattendedEnabled &&[\s\S]*?!this\.schedulerState\?\.active[\s\S]*?this\.scheduleNextBackoff\(errorMessage\)/,
  );
  assert.doesNotMatch(endSource, /isTransientErrorMessage/);
});

test("retry lifecycle re-arms the unattended scheduler after prompt_error", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const retrySource = source.slice(
    source.indexOf("private async retryWithLifecycle(): Promise<void>"),
    source.indexOf("private evaluateUnattended(): void"),
  );
  assert.match(
    retrySource,
    /this\.emit\(\{\s*type: "prompt_error"[\s\S]*?this\.scheduleNextBackoff\(error instanceof Error \? error\.message : String\(error\)\)/,
  );
});

test("a pending unattended retry after process restart waits for manual confirmation", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /private unattendedResumeRequired = false/);
  assert.match(source, /reason: "restart"/);
  assert.match(source, /private preserveSchedulerForRestart\(\)/);
  assert.match(source, /destroyForProcessExit\(\)/);
  assert.match(source, /destroy\(\): void/);
  assert.match(source, /globalThis\.\__piSessions\?\.forEach\(\(s\) => s\.destroyForProcessExit\(\)\)/);
  assert.doesNotMatch(source, /export function restorePersistedUnattendedSessions/);
  assert.doesNotMatch(source, /sessionFileRecentlyChanged/);
});

test("maximum unattended attempts stay terminal across server reevaluation", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /if \(attempt >= MAX_AUTO_ATTEMPTS\) \{[\s\S]*?reason: "limit"[\s\S]*?this\.persistUnattendedState\(\)/);
  assert.match(source, /next\?\.reason !== "limit" && !this\.schedulerState\?\.active/);
  assert.match(source, /savedSchedulerState\.active \|\| savedSchedulerState\.reason === "limit"/);
});

test("evaluateUnattended falls back to the persisted file tail when the live tail is stripped", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const evalSource = source.slice(
    source.indexOf("private evaluateUnattended(): void"),
    source.indexOf("private armSchedulerTimer("),
  );
  // Live transcript loses the failed chain after pi's built-in retry
  // exhausts; the scheduler must re-arm from the session file instead.
  assert.match(evalSource, /fileTailSchedulerState\(\)/);
  // Custom metadata (for example vision-proxy-config) may be appended after
  // the failed assistant message; the fallback must scan backward for the
  // last actual message instead of requiring the physical last JSONL line.
  assert.match(evalSource, /for \(let index = lines\.length - 1; index >= 0(?: && [^;]+)?; index -= 1\)/);
  assert.match(evalSource, /entry\?\.type !== "message" \|\| !entry\.message/);
  assert.match(evalSource, /lastMessage\.role !== "assistant" \|\| lastMessage\.stopReason !== "error"/);
  assert.doesNotMatch(evalSource, /isTransientErrorMessage/);
  assert.match(evalSource, /nextSchedulerState\(messages, null\)/);
  // A completed live tail must not trigger the file fallback read.
  assert.match(evalSource, /hasRealOutput\(liveLast\.msg/);
});

test("stripped-chain retry records the run as failed so it does not settle completed", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  // A continue() that does not throw can still be a failed unattended retry:
  // pi's prepareRetry strips the failed assistant chain from the live
  // transcript, so without this the run would settle as "completed" and the
  // client would play the completion sound for a failure.
  assert.match(source, /private retryRunFailure\(\): string \| null/);
  assert.match(source, /lastAssistantClassification\(/);
  assert.match(source, /liveLast\.kind === "transient" \|\| liveLast\.kind === "fatal"/);
  assert.match(source, /entry\.message\.role === "assistant"/);
  assert.match(source, /entry\.message\.stopReason === "error" \|\| err/);
  // The owned run must keep its failure when agent_settled arrives, so a
  // failed retry produces an error notification instead of a completion sound.
  const finallySource = source.slice(
    source.indexOf("private async retryLastFailedTurn"),
    source.indexOf("  async send(", source.indexOf("private async retryLastFailedTurn")),
  );
  assert.match(finallySource, /const retryError = this\.retryRunFailure\(\);/);
  assert.match(finallySource, /if \(retryError !== null\) \{\s*recordSessionRunError\(this\.inner\.sessionId, retryError, this\.unattendedEnabled, this\.currentRunId\);/);
  assert.match(finallySource, /recordSessionRunError[\s\S]*?await session\._emitAgentSettled\(\)/);
});

test("RPC session startup restores a recorded thinking level for every reopened session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  assert.match(startupSource, /const persistedThinkingLevel = readSessionThinkingLevel\(sessionManager\)/);
  assert.match(startupSource, /if \(thinkingLevel === undefined && persistedThinkingLevel !== undefined\)/);
  assert.match(source, /function readSessionThinkingLevel\(sessionManager: SessionManager\)/);
  assert.match(source, /entry\.type === "thinking_level_change"/);
  assert.match(source, /level = entry\.thinkingLevel/);
  assert.match(
    startupSource,
    /const initial = hasExistingMessages[\s\S]*?\.\.\.\(thinkingLevel !== undefined \? \{ thinkingLevel \} : \{\}\)/,
  );
});

test("explicit thinking selections record a session marker when none exists", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const start = source.indexOf('case "set_thinking_level"');
  const end = source.indexOf('case "compact"', start);
  const setThinkingSource = source.slice(start, end);

  assert.match(setThinkingSource, /hadSessionThinkingLevel/);
  assert.match(setThinkingSource, /readSessionThinkingLevel\(sessionManager\)/);
  assert.match(setThinkingSource, /sessionManager\.appendThinkingLevelChange\(effectiveLevel\)/);
});

test("evaluateUnattended does not treat previous turn assistant output as current turn success", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const evalSource = source.slice(
    source.indexOf("private evaluateUnattended(): void"),
    source.indexOf("private armSchedulerTimer("),
  );
  assert.match(evalSource, /liveTailIsAssistant = lastLiveMessage\?\.role === "assistant"/);
  assert.match(evalSource, /liveTailIsAssistant[\s\S]*?lastAssistantClassification/);
});

test("evaluateUnattended immediately clears scheduler when the turn completed with real output", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const evalSource = source.slice(
    source.indexOf("private evaluateUnattended(): void"),
    source.indexOf("private armSchedulerTimer("),
  );
  assert.match(evalSource, /if \(turnCompletedWithRealOutput\) \{\s*if \(this\.schedulerState \|\| this\.schedulerTimer\) \{\s*this\.clearScheduler\("idle"\);/);
  assert.match(evalSource, /if \(next\.reason === "manual" && this\.schedulerState\?\.active && next\.key === this\.schedulerState\.key\) \{\s*return;\s*\}/);
});

test("terminology jobs persist outside chat context and complete through direct completion", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const taskSource = source.slice(
    source.indexOf("private async completeQuestionTask"),
    source.indexOf("  private enqueuePromptDisplayInput", source.indexOf("private async completeQuestionTask")),
  );
  const analysisSource = source.slice(
    source.indexOf("private async completeQuestionAnalysis"),
    source.indexOf("private async completeQuestionRewrite", source.indexOf("private async completeQuestionAnalysis")),
  );
  const jobSource = source.slice(
    source.indexOf("private async startQuestionAnalysisJob"),
    source.indexOf("  async send(", source.indexOf("private async startQuestionAnalysisJob")),
  );
  const commandSource = source.slice(source.indexOf('case "analyze_question"'), source.indexOf('case "prompt"'));

  assert.match(taskSource, /completeSimple\(/);
  assert.match(taskSource, /response\.usage/);
  assert.match(taskSource, /priceQuestionAnalysis\(/);
  assert.match(taskSource, /pricing: priced\.pricing/);
  assert.doesNotMatch(taskSource, /this\.inner\.prompt\(/);
  assert.match(analysisSource, /QUESTION_ANALYSIS_SYSTEM_PROMPT/);
  assert.match(analysisSource, /buildQuestionAnalysisPrompt\(job\.question, job\.priorContext/);
  assert.match(jobSource, /pendingQuestionAnalysisData/);
  assert.match(jobSource, /appendQuestionAnalysisEntry/);
  assert.match(jobSource, /scheduleQuestionAnalysisJob/);
  assert.match(commandSource, /contextMode/);
  assert.match(commandSource, /entryId/);
  assert.match(commandSource, /return this\.startQuestionAnalysisJob\(/);
});

test("draft question analysis uses the same direct completion without a saved entry", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const draftSource = source.slice(
    source.indexOf("private async completeQuestionDraft"),
    source.indexOf("private async completeQuestionRewrite", source.indexOf("private async completeQuestionDraft")),
  );
  const commandSource = source.slice(source.indexOf('case "analyze_question_draft"'), source.indexOf('case "rewrite_question"'));

  assert.match(draftSource, /normalizeQuestion\(question\)/);
  assert.match(draftSource, /QUESTION_ANALYSIS_SYSTEM_PROMPT/);
  assert.match(draftSource, /buildQuestionAnalysisContext\(this\.inner\.sessionManager\.getBranch\(\)/);
  assert.match(draftSource, /buildQuestionAnalysisPrompt\(normalizedQuestion, contextInfo\.text/);
  assert.match(draftSource, /context: \{\s*mode,/);
  assert.match(draftSource, /this\.completeQuestionTask\(/);
  assert.match(commandSource, /typeof command\.question === "string"/);
  assert.match(commandSource, /command\.contextMode === "context"/);
  assert.match(commandSource, /return this\.completeQuestionDraft\(/);
});

test("question rewrite command uses bounded direct completion with extracted terms", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const rewriteSource = source.slice(
    source.indexOf("private async completeQuestionRewrite"),
    source.indexOf("  private appendQuestionAnalysisEntry", source.indexOf("private async completeQuestionRewrite")),
  );
  const commandSource = source.slice(source.indexOf('case "rewrite_question"'), source.indexOf('case "prompt"'));

  assert.match(rewriteSource, /QUESTION_REWRITE_TERMS_MAX_CHARS/);
  assert.match(rewriteSource, /QUESTION_REWRITE_SYSTEM_PROMPT/);
  assert.match(rewriteSource, /buildQuestionRewritePrompt\(normalizedQuestion, normalizedTerms\)/);
  assert.match(rewriteSource, /QUESTION_REWRITE_MAX_TOKENS/);
  assert.match(commandSource, /typeof command\.question === "string"/);
  assert.match(commandSource, /typeof command\.terms === "string"/);
  assert.match(commandSource, /return this\.completeQuestionRewrite\(/);
});

test("STE100 rewrite command uses bounded direct completion", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const rewriteSource = source.slice(
    source.indexOf("private async completeSte100Rewrite"),
    source.indexOf("  private queuedMessages", source.indexOf("private async completeSte100Rewrite")),
  );
  const commandSource = source.slice(source.indexOf('case "rewrite_ste100"'), source.indexOf('case "prompt"'));

  assert.match(rewriteSource, /STE100_REWRITE_SYSTEM_PROMPT/);
  assert.match(rewriteSource, /buildSte100RewritePrompt\(normalizedText\)/);
  assert.match(rewriteSource, /STE100_REWRITE_MAX_TOKENS/);
  assert.match(commandSource, /typeof command\.question === "string"/);
  assert.match(commandSource, /return this\.completeSte100Rewrite\(/);
});

test("background terminology work keeps RPC session alive until result persistence", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningLine = source.slice(source.indexOf("isRunning(): boolean"), source.indexOf("  setUnattendedEnabled", source.indexOf("isRunning(): boolean")));
  assert.match(runningLine, /questionAnalysisJobs\.size > 0/);
  assert.match(source, /acquireQuestionAnalysisJobLock/);
  assert.match(source, /restoreQuestionAnalysisJobs\(jobs/);
});

test("manually aborted session clears unattended scheduler and never auto-retries", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");

  // Abort command clears scheduler and sets abortRequested flag
  const abortCase = source.slice(
    source.indexOf('case "abort":'),
    source.indexOf('case "get_state":', source.indexOf('case "abort":')),
  );
  assert.match(abortCase, /this\.abortRequested = true/);
  assert.match(abortCase, /this\.clearScheduler\("manual"\)/);

  // evaluateUnattended checks if the live assistant was aborted and clears scheduler
  const evalSource = source.slice(
    source.indexOf("private evaluateUnattended(): void"),
    source.indexOf("private armSchedulerTimer("),
  );
  assert.match(evalSource, /liveAssistant\?\.msg\.stopReason === "aborted"/);
  assert.match(evalSource, /this\.clearScheduler\("manual"\)/);

  // fireScheduler clears scheduler if last message was aborted
  const fireSource = source.slice(
    source.indexOf("private fireScheduler(): void"),
    source.indexOf("private scheduleNextBackoff("),
  );
  assert.match(fireSource, /last\.msg\.stopReason === "aborted"/);
  assert.match(fireSource, /this\.clearScheduler\(last\.msg\.stopReason === "aborted" \? "manual" : "idle"\)/);

  // scheduleNextBackoff does not retry when aborted
  const backoffSource = source.slice(
    source.indexOf("private scheduleNextBackoff("),
    source.indexOf("hasPendingUserInteraction(): boolean", source.indexOf("private scheduleNextBackoff(")),
  );
  assert.match(backoffSource, /!this\.unattendedEnabled \|\| this\.abortRequested/);
  assert.match(backoffSource, /liveLast\?\.msg\.stopReason === "aborted"/);

  // retryRunFailure ignores aborted assistant
  const failureSource = source.slice(
    source.indexOf("private retryRunFailure(): string | null"),
    source.indexOf("private armSchedulerTimer("),
  );
  assert.match(failureSource, /if \(this\.abortRequested\) return null;/);
  assert.match(failureSource, /if \(liveLast\?\.msg\.stopReason === "aborted"\) return null;/);
  assert.match(failureSource, /if \(entry\.message\.stopReason === "aborted"\) return null;/);
});

test("set_model clears session caches and emits session activity event", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const setModelSource = source.slice(
    source.indexOf('case "set_model":'),
    source.indexOf('case "fork":'),
  );
  assert.match(setModelSource, /invalidateSessionReadCache\(this\.sessionFile\)/);
  assert.match(setModelSource, /clearSessionCaches\(this\.sessionId\)/);
  assert.match(setModelSource, /getModelThinkingDefaults\(readModelsConfig\(\)\)/);
  assert.match(setModelSource, /resolveDefaultThinkingLevel\(/);
  assert.match(setModelSource, /thinkingLevel: this\.inner\.agent\?\.state\?\.thinkingLevel/);
  assert.match(setModelSource, /emitActivityEvent\(\{ kind: "session", sessionId: this\.sessionId \}\)/);
});


test("persists original prompt-template input as display-only metadata", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  assert.match(source, /promptTemplateInvocation\(text, this\.inner\.promptTemplates\)/);
  assert.match(source, /flushPendingPromptDisplayInputForMessage\(\)/);
  assert.match(
    source,
    /appendCustomEntry\(SESSION_DISPLAY_INPUT_CUSTOM_TYPE, \{[\s\S]*?targetEntryId: targetEntry\.id,[\s\S]*?input: pending\.input/,
  );
  assert.match(source, /this\.discardPendingPromptDisplayInput\(pending\)/);
});


test("RPC serializes branch navigation and rejects writes against a stale runtime leaf", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const send = source.slice(source.indexOf("  async send(command:"), source.indexOf("  private async sendCommand", source.indexOf("  async send(command:")));
  const dispatch = source.slice(source.indexOf("  private async sendCommand"), source.indexOf('      case "analyze_question"'));

  assert.match(send, /treeNavigationPending \|\| this\.isRunning\(\)/);
  assert.match(send, /finally \{\s*this\.treeNavigationPending = false;\s*\}/);
  assert.match(send, /if \(this\.treeNavigationPending && !String\(command\.type\)\.startsWith\("get_"\) && command\.type !== "abort"\)/);
  assert.match(dispatch, /Object\.hasOwn\(command, "expectedLeafId"\) && !matchesExpectedLeaf\(this\.inner\.sessionManager, command\.expectedLeafId\)/);
  assert.match(dispatch, /throw new Error\(BRANCH_POSITION_CHANGED\)/);
});

test("retry preserves native system loadouts through repeated failed turns", async (t) => {
  const { inner, wrapper } = unattendedFixture(t);
  const user = { role: "user", content: "resume the original task", timestamp: 1 };
  const system = { role: "system", content: "", sections: { policy: "keep the task scope" }, toolsAdded: [{ name: "read" }], timestamp: 2 };
  const error = { role: "assistant", content: [], stopReason: "error", errorMessage: "HTTP 503", timestamp: 3 };
  const nextSystem = { ...system, sections: { policy: "updated scope" }, timestamp: 4 };
  inner.agent.state.messages = [user, system, error];
  let attempts = 0;
  inner.agent.continue = async () => {
    attempts++;
    assert.deepEqual(inner.agent.state.messages, attempts === 1 ? [user, system] : [user, system, nextSystem]);
    if (attempts === 1) inner.agent.state.messages.push(nextSystem, error);
  };
  inner._handlePostAgentRun = async () => attempts === 1;
  inner._flushPendingBashMessages = () => {};
  inner._emitAgentSettled = async () => {};
  wrapper.retryRunFailure = () => null;
  await wrapper.retryLastFailedTurn();
  assert.equal(attempts, 2);
  assert.deepEqual(inner.agent.state.messages, [user, system, nextSystem]);
});

test("retry-only RPC returns a typed missing-anchor rejection without creating a prompt", async (t) => {
  const made = makeToolFixture();
  t.after(() => made.wrapper.destroy());
  made.inner.agent.state.messages = [];
  made.inner.agent.continue = async () => { throw new Error("must not continue without an anchor"); };

  await assert.rejects(
    () => made.wrapper.send({ type: "retry_continue_only" }),
    (error) => error?.code === "retry_unavailable" && /No continue turn/.test(error.message),
  );
  assert.deepEqual(made.inner.agent.state.messages, []);
  assert.deepEqual(made.state.appended, []);
});

test("guarded manual retry can recover a definitive no-anchor rejection without replaying a changed run", async (t) => {
  const activity = await jiti.import("./session-activity.ts");
  const { inner, wrapper } = unattendedFixture(t);
  const run = activity.recordSessionRunStart(inner.sessionId, process.cwd());
  activity.recordSessionRunError(inner.sessionId, "HTTP 503", false, run.runId);
  inner.prompt = async (_message, options) => {
    options?.preflightResult?.("started");
    activity.recordSessionRunStart(inner.sessionId, process.cwd());
  };
  const events = [];
  const done = new Promise(resolve => wrapper.onEvent(event => {
    events.push(event);
    if (event.type === "prompt_done") resolve();
  }));
  await wrapper.send({ type: "retry_continue", expectedRunId: run.runId });
  await done;
  assert.deepEqual(events.filter(event => event.type === "prompt_error"), []);
  assert.equal(events.filter(event => event.type === "prompt_done").length, 1);
  await assert.rejects(
    wrapper.send({ type: "retry_continue", expectedRunId: run.runId }),
    error => error.code === "retry_target_changed",
  );
});

test("batch retry checks the latest run and does not replay a stale accepted request", async (t) => {
  const activity = await jiti.import("./session-activity.ts");
  for (const status of ["unknown", "failed"]) {
    const { inner, wrapper } = unattendedFixture(t);
    const run = activity.recordSessionRunStart(inner.sessionId, process.cwd());
    if (status === "unknown") activity.recordSessionRunUnknown(inner.sessionId, run.runId);
    else activity.recordSessionRunError(inner.sessionId, "HTTP 503", false, run.runId);
    inner.agent.state.messages = [{ role: "user", content: "task" }];
    let retried = 0;
    wrapper.retryLastFailedTurn = async () => {
      retried++;
      activity.recordSessionRunStart(inner.sessionId, process.cwd());
    };
    await wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId });
    assert.equal(retried, 1, status);
    await assert.rejects(
      wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId }),
      error => error.code === "retry_target_changed",
    );
    assert.equal(retried, 1, "a stale retry cannot start another run");
  }
});

test("batch retry refuses terminal, active, missing and malformed run targets", async (t) => {
  const activity = await jiti.import("./session-activity.ts");
  for (const status of ["running", "completed", "aborted", "missing", "malformed"]) {
    const { inner, wrapper, saved } = unattendedFixture(t);
    const run = activity.recordSessionRunStart(inner.sessionId, process.cwd());
    if (status === "completed") activity.recordSessionRunSettled(inner.sessionId, run.runId);
    if (status === "aborted") activity.recordSessionRunAbort(inner.sessionId, false, run.runId);
    inner.agent.state.messages = [{ role: "user", content: "task" }];
    let retried = 0;
    wrapper.retryLastFailedTurn = async () => { retried++; };
    await assert.rejects(wrapper.send({ type: "retry_continue_only", expectedRunId: status === "malformed" ? null : status === "missing" ? "not-the-run" : run.runId }),
      error => error.code === "retry_target_changed");
    assert.equal(retried, 0, status);
    assert.equal(saved(), null, "a rejection cannot change unattended preferences");
  }
});

test("batch retry refuses live background work, queues and pending user interaction", async (t) => {
  const activity = await jiti.import("./session-activity.ts");
  for (const busy of ["parent", "retry", "background", "queue", "question"]) {
    const { inner, wrapper } = unattendedFixture(t);
    const run = activity.recordSessionRunStart(inner.sessionId, process.cwd());
    activity.recordSessionRunUnknown(inner.sessionId, run.runId);
    inner.agent.state.messages = [{ role: "user", content: "task" }];
    wrapper.getExecutionState = () => ({ active: ["parent", "retry", "background"].includes(busy), queuedCount: busy === "queue" ? 1 : 0 });
    wrapper.hasPendingUserInteraction = () => busy === "question";
    let retried = 0;
    wrapper.retryLastFailedTurn = async () => { retried++; };
    await assert.rejects(wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId }),
      error => error.code === "runtime_busy");
    assert.equal(retried, 0, busy);
  }
});

test("batch retry waits for extension startup and rechecks state and Stop after the wait", async (t) => {
  const activity = await jiti.import("./session-activity.ts");
  for (const change of ["completed", "stopped"]) {
    const { inner, wrapper } = unattendedFixture(t);
    const run = activity.recordSessionRunStart(inner.sessionId, process.cwd());
    activity.recordSessionRunUnknown(inner.sessionId, run.runId);
    inner.agent.state.messages = [{ role: "user", content: "task" }];
    let release;
    const gate = new Promise(resolve => { release = resolve; });
    wrapper.waitForExtensionsBound = () => gate;
    let retried = 0;
    wrapper.retryLastFailedTurn = async () => { retried++; };
    const pending = wrapper.send({ type: "retry_continue_only", expectedRunId: run.runId });
    assert.equal(retried, 0, "retry cannot run before extensions are ready");
    if (change === "completed") activity.recordSessionRunSettled(inner.sessionId, run.runId);
    else wrapper.inputStopGeneration++;
    release();
    await assert.rejects(pending, change === "completed" ? error => error.code === "retry_target_changed" : /stopped/i);
    assert.equal(retried, 0, change);
  }
});

test("RPC root navigation and get_state expose the confirmed null cursor", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const navigation = source.slice(source.indexOf('      case "navigate_tree"'), source.indexOf('      case "set_fast_mode"'));
  const state = source.slice(source.indexOf('      case "get_state"'), source.indexOf('      case "set_model"'));

  assert.match(navigation, /command\.targetId === null[\s\S]*?manager\.resetLeaf\(\)[\s\S]*?return \{ cancelled: false, leafId: null/);
  assert.match(state, /branchPosition: \{[\s\S]*?typeof this\.inner\.sessionManager\.getLeafId === "function"/);
});


test("user fork navigation keeps the clicked message's actual parent, including consecutive users", async (t) => {
  const made = makeToolFixture();
  t.after(() => made.wrapper.destroy());
  const manager = SessionManager.inMemory(process.cwd());
  const first = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const second = manager.appendMessage({ role: "user", content: "second", timestamp: 2 });
  const third = manager.appendMessage({ role: "user", content: "third", timestamp: 3 });
  const agent = {
    isStreaming: false, isCompacting: false, sessionManager: manager,
    _extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    _refreshFinalizedContext() {}, _restoreToolsFromTranscript() {}, _resolveIdleWaitIfIdle() {},
  };
  made.inner.sessionManager = manager;
  made.inner.navigateTree = (id, options) => AgentSession.prototype.navigateTree.call(agent, id, options);

  for (const from of [third, first]) {
    manager.branch(from);
    const result = await made.wrapper.send({ type: "navigate_tree", targetId: third, before: true });
    assert.equal(result.cancelled, false);
    assert.equal(result.expectedLeafId, second);
    assert.equal(result.leafId, second);
    assert.equal(manager.getLeafId(), second);
    assert.deepEqual(manager.buildSessionContext().messages.map(message => message.content), ["first", "second"]);
  }
});

test("before-message navigation rejects non-user targets without moving the session", async (t) => {
  const made = makeToolFixture();
  t.after(() => made.wrapper.destroy());
  const manager = SessionManager.inMemory(process.cwd());
  const user = manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const assistant = manager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  made.inner.sessionManager = manager;
  await assert.rejects(made.wrapper.send({ type: "navigate_tree", targetId: assistant, before: true }), /user message/i);
  assert.equal(manager.getLeafId(), assistant);
  assert.notEqual(user, assistant);
});

test("assistant navigation acknowledges metadata appended after the requested message", async (t) => {
  const made = makeToolFixture();
  t.after(() => made.wrapper.destroy());
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendMessage({ role: "user", content: "first", timestamp: 1 });
  const assistant = manager.appendMessage({ role: "assistant", content: [], api: "test", provider: "test", model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: 2 });
  const later = manager.appendMessage({ role: "user", content: "later", timestamp: 3 });
  const agent = {
    isStreaming: false, isCompacting: false, sessionManager: manager,
    _extensionRunner: { hasHandlers: () => false, emit: async () => {} },
    _refreshFinalizedContext() {}, _restoreToolsFromTranscript() {}, _resolveIdleWaitIfIdle() {},
  };
  made.inner.sessionManager = manager;
  made.inner.navigateTree = async (id, options) => {
    const result = await AgentSession.prototype.navigateTree.call(agent, id, options);
    manager.appendCustomEntry("test-metadata", {});
    return result;
  };
  manager.branch(later);

  const result = await made.wrapper.send({ type: "navigate_tree", targetId: assistant });
  assert.equal(result.expectedLeafId, assistant);
  assert.equal(result.metadataLeaf, true);
  assert.equal(result.leafId, manager.getLeafId());
  assert.notEqual(result.leafId, assistant);
  assert.equal(manager.getEntry(result.leafId).type, "custom");
});

test("explicit custom UI close settles only the active custom request", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const closeCaseStart = source.indexOf('case "extension_ui_close"');
  const closeCaseEnd = source.indexOf('case "extension_ui_input"', closeCaseStart);
  const closeCase = source.slice(closeCaseStart, closeCaseEnd);
  const closeMethod = source.slice(
    source.indexOf("private closeCustomUi"),
    source.indexOf("private handleExtensionUiInput"),
  );

  assert.notEqual(closeCaseStart, -1);
  assert.notEqual(closeCaseEnd, -1);
  assert.match(closeCase, /typeof command\.id === "string"/);
  assert.match(closeCase, /this\.closeCustomUi\(command\.id, undefined\)/);
  assert.doesNotMatch(closeCase, /handleExtensionUiInput/);
  assert.match(closeMethod, /this\.activeCustomUis\.get\(id\)/);
  assert.match(closeMethod, /custom\.component\.dispose\?\.\(\)/);
  assert.match(closeMethod, /closed: true/);
  assert.match(closeMethod, /custom\.resolve\(value\)/);
});

test("resolver keeps runtime-active visible tools, drops hidden or withdrawn tools, and respects empty chat-only", () => {
  const { inner } = makeToolFixture({
    active: ["read", "runtime", "modelOnly", "hidden"],
  });

  assert.deepEqual(
    resolveActiveToolNames(inner, READ_ONLY, inner.getActiveToolNames()),
    ["read", "grep", "find", "ls", "runtime", "modelOnly"],
  );
  const runtimeOnly = resolveActiveToolNames(inner, READ_ONLY, ["read", "runtime", "missing"]);
  assert.deepEqual(runtimeOnly, ["read", "grep", "find", "ls", "runtime"]);
  assert.ok(!runtimeOnly.includes("inactive"));
  assert.deepEqual(resolveActiveToolNames(inner, [], inner.getActiveToolNames()), []);
  assert.ok(!resolveActiveToolNames(inner, READ_ONLY, ["read", "powershell"]).includes("powershell"));
});

test("set_tools and get_tools use production resolver and never expose hidden declarations", async (t) => {
  const made = makeToolFixture({ active: ["read", "runtime", "hidden"] });
  t.after(() => made.wrapper.destroy());

  await made.wrapper.send({ type: "set_tools", toolNames: READ_ONLY });
  assert.deepEqual(made.state.activations.at(-1), ["read", "grep", "find", "ls", "runtime"]);
  assert.deepEqual(made.state.appended.at(-1), [TOOL_SELECTION_TYPE, { version: 1, tools: READ_ONLY }]);

  const tools = await made.wrapper.send({ type: "get_tools" });
  assert.ok(tools.some((tool) => tool.name === "runtime"));
  assert.ok(!tools.some((tool) => tool.name === "hidden"));
});

test("reload keeps new runtime activation and drops extension withdrawals in both reload paths", async (t) => {
  const made = makeToolFixture({
    active: ["read", "runtime"],
    afterReload: ["read", "runtime", "modelOnly"],
  });
  t.after(() => made.wrapper.destroy());

  await made.wrapper.send({ type: "reload" });
  assert.deepEqual(made.state.activations.at(-1), ["read", "runtime", "modelOnly"]);

  made.state.afterReload = ["read", "runtime"];
  await made.wrapper.createExtensionCommandContextActions().reload();
  assert.deepEqual(made.state.activations.at(-1), ["read", "runtime"]);
});

test("branch and root navigation reapply the pin, preserve Reader controls, and keep target extensions only", async (t) => {
  const made = makeToolFixture({
    active: ["read", "runtime", "Agent"],
    entries: [selectionEntry(["read", "bash"])],
    afterNavigate: ["read", "bash", "runtime", "modelOnly"],
    afterRoot: ["read", "write", "runtime"],
  });
  t.after(() => made.wrapper.destroy());

  const branch = await made.wrapper.send({ type: "navigate_tree", targetId: "older" });
  assert.deepEqual(branch, { cancelled: false, leafId: "leaf", editorText: "restored draft" });
  assert.deepEqual(made.state.activations.at(-1), ["read", "bash", "runtime", "modelOnly", "Agent"]);

  made.state.afterNavigate = ["read", "bash", "runtime"];
  await made.wrapper.createExtensionCommandContextActions().navigateTree("newer", { summarize: true });
  assert.deepEqual(made.state.lastNavigateOptions, { summarize: true });
  assert.deepEqual(made.state.activations.at(-1), ["read", "bash", "runtime", "Agent"]);

  await made.wrapper.send({ type: "navigate_tree", targetId: null });
  assert.deepEqual(made.state.activations.at(-1), ["read", "bash", "runtime", "Agent"]);
});

test("startup and recreation apply one resolver to SDK initial activity", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const toolsSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export async function setRpcSessionTools")),
  );

  assert.match(startupSource, /const initialToolNames = inner\.getActiveToolNames\(\);/);
  assert.match(startupSource, /resolveActiveToolNames\(\s*inner,\s*effectiveToolNames \?\? initialToolNames,\s*strictToolAllowlistEnabled \? \[\] : initialToolNames/);
  assert.match(toolsSource, /startRpcSession\(sessionId, persistedFile/);
  assert.match(toolsSource, /startRpcSession\(\s*`__recreate__/);
});

// Regression cases introduced by upstream v0.10.0, retained with Reader cases.

import { mkdir, mkdtemp, readdir, rm, rmdir, unlink } from "node:fs/promises";

import { tmpdir } from "node:os";

import { join } from "node:path";

import { AgentSession, SessionManager } from "@earendil-works/pi-coding-agent";


test("get_tools projects the SDK tool definition and active state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const getToolsSource = source.slice(
    source.indexOf('case "get_tools"'),
    source.indexOf('case "get_commands"'),
  );

  assert.match(getToolsSource, /\.getAllTools\(\)/);
  assert.match(getToolsSource, /name: t\.name/);
  assert.match(getToolsSource, /description: t\.description/);
  assert.match(getToolsSource, /active: active\.has\(t\.name\)/);
});


test("only normal sessions load the codemode, tool-search, and mcp built-ins", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(
    startupSource,
    /const builtins = subagentResources \|\| chatOnly \|\| strictToolAllowlistEnabled\s*\? undefined\s*: await createPiWebBuiltinExtensions\(\{ agentDir \}\);/,
  );
  // Spread only into the normal-session factories, after the chat-only and subagent branches.
  assert.equal(startupSource.match(/\.\.\.\(builtins\?\.extensions \?\? \[\]\)/g)?.length, 1);
  assert.ok(
    startupSource.indexOf("...(builtins?.extensions") > startupSource.indexOf("CHAT_ONLY_RESOURCE_LOADER_OPTIONS, extensionFactories"),
  );
  // The Read-only policy for MCP tools rides along with the MCP extension.
  assert.match(startupSource, /\.\.\.\(builtins\?\.extensions \?\? \[\]\),\s*createReadOnlyMcpPolicyExtension\(\),/);
  // The wrapper connects the host's servers before a prompt starts a run.
  assert.match(
    startupSource,
    /\.\.\.\(\(builtinResources\?\.mcpHost \?\? builtins\?\.mcpHost\) \? \{ mcpHost: builtinResources\?\.mcpHost \?\? builtins\?\.mcpHost \} : \{\}\),/,
  );
});


test("built-in subagents persist their selected resource policy", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const subagentPolicySource = await readFile(new URL("./subagents.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(subagentSource, /SessionManager\.create\(parent\.cwd, undefined, \{ parentSession: parent\.sessionFile \}\)/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_META_TYPE/);
  assert.match(subagentSource, /appendCustomEntry\(SUBAGENT_RESULT_TYPE/);
  assert.match(subagentSource, /dependencies\.registerSession\(inner, \{/);
  assert.match(subagentSource, /skillRuntimeContext: childSkillRuntimeContext/);
  assert.match(subagentSource, /createSubagentSkillRuntimeContext\(/);
  assert.match(subagentSource, /filterRuntimeSkills\(projected\.skills as RuntimeSkillLike\[\], childSkillRuntimeContext\)/);
  assert.match(
    subagentSource,
    /subagentExtensionLoaderOptions\(\{ \.\.\.profile, mcp: mcpEnabled, codemode: codemodeEnabled \}\)/,
  );
  assert.match(subagentSource, /createSubagentSkillsBinding\(\{[\s\S]*?loadSkills: profile\.loadSkills,[\s\S]*?skills: selectedSkillNames,/);
  assert.match(
    subagentSource,
    /\.filter\(\(tool\) => !SUBAGENT_CONTROL_TOOL_NAMES\.includes\(tool as typeof SUBAGENT_CONTROL_TOOL_NAMES\[number\]\)\)/,
  );
  assert.match(
    subagentSource,
    /const effectiveProfileTools = parentRemoteHost[\s\S]*?profile\.tools\.filter\(\(tool\) => parentRemoteHost\.policy\.orchestration\.childTools\.includes\(tool\)\)[\s\S]*?: profile\.tools;/,
  );
  assert.match(subagentSource, /withSubagentExtensionTools\(effectiveProfileTools, extensionToolNames\)/);
  assert.match(subagentSource, /resourceSnapshot:/);
  assert.match(startupSource, /readValidSubagentResources\(startupEntries\)/);
  assert.match(
    source,
    /function readValidSubagentResources\([\s\S]*?if \(hasSubagentResourceSnapshot\(entries\) && !resources\) \{[\s\S]*?Invalid subagent resource snapshot/,
  );
  assert.match(startupSource, /resourceLoaderOptions: subagentResources\s*\?/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  assert.match(startupSource, /subagentExtensionLoaderOptions\(subagentResources\)/);
  assert.match(startupSource, /createSubagentSkillRuntimeContext\(/);
  assert.match(startupSource, /filterRuntimeSkills\(projected\.skills as RuntimeSkillLike\[\], skillRuntimeContext\)/);
  assert.match(startupSource, /createSubagentSkillsBinding\(\{[\s\S]*?loadSkills: subagentResources\.loadSkills,[\s\S]*?skills: subagentSkillNames,/);
  assert.match(startupSource, /subagentToolOptions\(subagentResources\)/);
  assert.match(
    subagentPolicySource,
    /export function subagentToolOptions\([\s\S]*?const excludeTools: string\[\] = \[\.\.\.SUBAGENT_CONTROL_TOOL_NAMES\];[\s\S]*?tools: \[\.\.\.resources\.tools\][\s\S]*?excludeTools/,
  );
  assert.match(source, /createSubagentController\(/);
  assert.match(source, /suppressCompletionNotifications: true/);
  assert.match(source, /suppressCompletionNotifications: Boolean\(subagentResources\)/);
  assert.match(startupSource, /createSubagentExtension\([\s\S]*?SUBAGENT_CONTROLLER\.extensionRuntime,[\s\S]*?\(\) => listSubagentProfiles\(sessionCwd\),[\s\S]*?isBuiltInSubagentsEnabled/);
  assert.match(startupSource, /preferPiWebSubagentExtension\(base\)/);
});


test("running snapshots expose sessions with suppressed completion notifications", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const runningRouteSource = await readFile(new URL("../app/api/agent/running/route.ts", import.meta.url), "utf8");
  const sessionsRouteSource = await readFile(new URL("../app/api/sessions/route.ts", import.meta.url), "utf8");
  const snapshotSource = source.slice(
    source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export function getCompletionNotificationSuppressedRpcSessionIds")),
  );

  assert.match(snapshotSource, /session\.isRunning\(\) && session\.hasSuppressedCompletionNotifications\(\)/);
  assert.match(runningRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
  assert.match(sessionsRouteSource, /completionNotificationSuppressedSessionIds: getCompletionNotificationSuppressedRpcSessionIds\(\)/);
});


test("RPC wrapper avoids per-chunk idle maintenance", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startSource = source.slice(
    source.indexOf("  start(): void"),
    source.indexOf("  beginExtensionBinding"),
  );

  assert.match(startSource, /IDLE_RESET_EVENT_TYPES\.has\(event\.type\)/);
  assert.doesNotMatch(startSource, /subscribe\(\(event: AgentEvent\) => \{\s*this\.resetIdleTimer\(\)/);
});


test("clone copies the requested leaf into a child session", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const cloneSource = source.slice(
    source.indexOf('case "clone"'),
    source.indexOf('case "navigate_tree"'),
  );

  assert.match(cloneSource, /typeof command\.leafId === "string"/);
  assert.match(cloneSource, /branchHasAssistant/);
  assert.match(cloneSource, /createBranchedSession\(leafId\)/);
  assert.match(cloneSource, /cacheSessionPath\(newSessionId, clonedPath\)/);
  assert.match(cloneSource, /invalidateSessionListCache\(\)/);
  assert.match(cloneSource, /return \{ cancelled: false, newSessionId,/);
});


test("cold persisted fork copies a branch without creating an Agent runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-cold-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  try {
    const manager = SessionManager.create(root, sessionDir);
    manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
    const assistantEntryId = manager.appendMessage(assistantFixture("source response"));
    const sourceFile = manager.getSessionFile();
    const result = await forkPersistedSessionFromFile(manager.getSessionId(), sourceFile, assistantEntryId);

    assert.equal(result.cancelled, false);
    assert.ok(result.newSessionId);
    assert.ok(result.newSessionPath);
    assert.notEqual(result.newSessionPath, sourceFile);
    const forked = SessionManager.open(result.newSessionPath, sessionDir);
    assert.equal(forked.getLeafId(), assistantEntryId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("cold agent Fork routes directly to persisted session handling", async () => {
  const route = await readFile(new URL("../app/api/agent/[id]/route.ts", import.meta.url), "utf8");
  const coldForkSource = route.slice(
    route.indexOf("// Forking a cold session"),
    route.indexOf("if (existing?.isAlive())"),
  );

  assert.match(coldForkSource, /forkPersistedSessionFromFile\(/);
  assert.doesNotMatch(coldForkSource, /startRpcSession\(/);
  assert.match(route, /!existing\?\.isAlive\(\) && !existing\?\.isShuttingDown\(\)/);
});

test("fork copies the selected assistant entry without replacing the source session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-quoted-branch-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "source prompt", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "selected response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const selectedEntryId = manager.getLeafId();
  const sourceFile = manager.getSessionFile();
  let forkedFile;
  let disposed = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: {},
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: selectedEntryId });
    const sessions = await SessionManager.list(root, sessionDir);
    const forkedInfo = sessions.find((session) => session.id === result.newSessionId);
    assert.ok(forkedInfo);
    forkedFile = forkedInfo.path;
    assert.equal(SessionManager.open(forkedFile, sessionDir).getLeafId(), selectedEntryId);
    assert.equal(manager.getLeafId(), selectedEntryId);
    assert.equal(disposed, false);
  } finally {
    wrapper.destroy();
    if (forkedFile) await unlink(forkedFile);
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});


test("fork before the first message returns the native text and image payload for a fresh session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-root-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const nativeImage = { type: "image", data: "aGVsbG8=", mimeType: "image/png" };
  const firstEntryId = manager.appendMessage({ role: "user", content: [{ type: "text", text: "source prompt" }, nativeImage], timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "source response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const sourceFile = manager.getSessionFile();
  const sourceLeafId = manager.getLeafId();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const result = await wrapper.send({ type: "fork", entryId: firstEntryId });
    assert.deepEqual(result, { cancelled: false, restoreMessage: manager.getEntry(firstEntryId).message });
    const sessions = await SessionManager.list(root, sessionDir);
    assert.equal(sessions.filter((session) => session.id !== manager.getSessionId()).length, 0);
    assert.equal(manager.getLeafId(), sourceLeafId);
  } finally {
    wrapper.destroy();
    if (sourceFile) await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});


function assistantFixture(text) {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}


test("fork copies finished entries while the source keeps running", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-running-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  const firstUserId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const firstAssistantId = manager.appendMessage(assistantFixture("first response"));
  // The turn the agent is still running: its user message is already on disk.
  const runningUserId = manager.appendMessage({ role: "user", content: "running prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const sourceBefore = await readFile(sourceFile, "utf8");
  const forkedFiles = [];
  let disposed = false;
  let shutdownEvents = 0;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => { shutdownEvents += 1; } },
    agent: { state: {} },
    dispose() { disposed = true; },
  });

  try {
    const forked = await wrapper.send({ type: "fork", entryId: runningUserId });
    const branched = await wrapper.send({ type: "fork", entryId: firstAssistantId });
    const sessions = await SessionManager.list(root, sessionDir);
    for (const result of [forked, branched]) {
      const info = sessions.find((session) => session.id === result.newSessionId);
      assert.ok(info);
      forkedFiles.push(info.path);
      const child = SessionManager.open(info.path, sessionDir);
      assert.equal(child.getHeader().parentSession, sourceFile);
      assert.equal(child.getLeafId(), firstAssistantId);
      assert.deepEqual(child.getEntries().map((entry) => entry.id), [firstUserId, firstAssistantId]);
    }

    assert.equal(wrapper.isAlive(), true);
    assert.equal(disposed, false);
    assert.equal(shutdownEvents, 0);
    assert.equal(manager.getLeafId(), runningUserId);
    assert.equal(await readFile(sourceFile, "utf8"), sourceBefore);
  } finally {
    wrapper.destroy();
    for (const file of forkedFiles) await unlink(file);
    await unlink(sourceFile);
    await rmdir(sessionDir);
    await rmdir(root);
  }
});


test("fork refuses a running shell command and returns the initial user message without a child", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-unsaved-fork-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendModelChange("test", "test-model");
    // The first user message is restored into a fresh session instead of being
    // copied to a child; the source file is irrelevant on this path.
  const userId = manager.appendMessage({ role: "user", content: "first prompt", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  await unlink(sourceFile);
  const inner = {
    sessionId: manager.getSessionId(),
    sessionFile: manager.getSessionFile(),
    sessionManager: manager,
    isStreaming: true,
    isCompacting: false,
    isBashRunning: true,
    extensionRunner: {},
    agent: { state: {} },
    abortBash() {},
    dispose() {},
  };
  const wrapper = new AgentSessionWrapper(inner);

  try {
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );
    await assert.rejects(
      wrapper.send({ type: "fork", entryId: userId }),
      /Cannot fork while a shell command is running/,
    );

    inner.isBashRunning = false;
    const expected = { cancelled: false, restoreMessage: manager.getEntry(userId).message };
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: userId }), expected);
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: userId }), expected);
    assert.equal(wrapper.isAlive(), true);
    assert.deepEqual(await readdir(sessionDir), []);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});


test("clone writes one reopenable child before source shutdown completes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "clone fixture", timestamp: Date.now() });
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "fixture response" }],
    api: "test",
    provider: "test",
    model: "test",
    usage: {
      input: 1,
      output: 1,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  });
  const cloneLeafId = manager.getLeafId();
  manager.appendSessionInfo("source-only metadata");

  const sourceFile = manager.getSessionFile();
  let clonedFile;
  let releaseShutdown;
  let signalShutdown;
  const shutdownStarted = new Promise((resolve) => { signalShutdown = resolve; });
  const shutdownHeld = new Promise((resolve) => { releaseShutdown = resolve; });
  let finishPrompt;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    prompt: (_message, options) => new Promise((resolve) => {
      finishPrompt = resolve;
      options.preflightResult?.("started");
    }),
    extensionRunner: {
      emit: async () => {
        signalShutdown();
        await shutdownHeld;
        throw new Error("fixture shutdown failure");
      },
    },
    agent: { state: {} },
    dispose() {},
  });

  try {
    const prompt = wrapper.send({ type: "prompt", message: "keep this run active" });
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      wrapper.send({ type: "clone", leafId: cloneLeafId }),
      /Cannot clone while the session is running/,
    );
    assert.ok(finishPrompt);
    finishPrompt();
    await new Promise((resolve) => setImmediate(resolve));
    await prompt;

    const firstClone = wrapper.send({ type: "clone", leafId: cloneLeafId });
    await shutdownStarted;
    await assert.rejects(
      wrapper.send({ type: "clone" }),
      /Session is shutting down/,
    );
    releaseShutdown();
    await assert.rejects(firstClone, /fixture shutdown failure/);

    const sessions = await SessionManager.list(root, sessionDir);
    const clonedInfo = sessions.find((session) => session.path !== sourceFile);
    assert.ok(clonedInfo);
    clonedFile = clonedInfo.path;

    const cloned = SessionManager.open(clonedFile, sessionDir);
    assert.equal(cloned.getHeader().parentSession, sourceFile);
    assert.equal(cloned.getLeafId(), cloneLeafId);
    assert.deepEqual(cloned.buildSessionContext().messages, manager.buildSessionContext().messages);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});


test("cancelled session replacement releases its lock", async () => {
  const manager = SessionManager.inMemory(tmpdir());
  let autoRetryEnabled = false;
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    setAutoRetryEnabled: (enabled) => { autoRetryEnabled = enabled; },
    extensionRunner: {},
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "fork", entryId: "missing" }), { cancelled: true });
    await wrapper.send({ type: "set_auto_retry", enabled: true });
    assert.equal(autoRetryEnabled, true);
  } finally {
    wrapper.destroy();
  }
});


test("clone cancels an assistant-free branch without creating a file", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-web-clone-empty-"));
  const sessionDir = join(root, "sessions");
  await mkdir(sessionDir);
  const manager = SessionManager.create(root, sessionDir);
  manager.appendMessage({ role: "user", content: "no assistant yet", timestamp: Date.now() });
  const sourceFile = manager.getSessionFile();
  const wrapper = new AgentSessionWrapper({
    sessionId: manager.getSessionId(),
    sessionFile: sourceFile,
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    isBashRunning: false,
    extensionRunner: { emit: async () => {} },
    agent: { state: {} },
    dispose() {},
  });

  try {
    assert.deepEqual(await wrapper.send({ type: "clone" }), { cancelled: true });
    // Since pi 0.99 the first user message already creates the source file.
    assert.deepEqual((await SessionManager.list(root, sessionDir)).map((session) => session.path), [sourceFile]);
  } finally {
    wrapper.destroy();
    await rm(root, { recursive: true, force: true });
  }
});


test("exact prompts are sent through before_agent_start instead of the SDK prompt state", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const subagentSource = await readFile(new URL("./subagent-runtime.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const promptSource = source.slice(
    source.indexOf('case "prompt"'),
    source.indexOf('case "abort"'),
  );

  // Pi 0.86 replays agent.state.systemPrompt from the transcript: assigning it throws,
  // and the loop's request context no longer carries a systemPrompt field.
  assert.doesNotMatch(source, /this\.inner\.agent\.state\.systemPrompt\s*=/);
  assert.doesNotMatch(source, /prepareNextTurnWithContext/);
  assert.doesNotMatch(subagentSource, /this\.inner\.agent\.state\.systemPrompt\s*=/);
  assert.match(startupSource, /subagentSkillsBinding = subagentResources[\s\S]*?createSubagentSkillsBinding\([\s\S]*?exactSystemPrompt: subagentResources\.exactSystemPrompt/);
  assert.match(startupSource, /appendSystemPrompt: subagentResources\.appendSystemPrompt/);
  const childExtensionSource = subagentSource.slice(
    subagentSource.indexOf("const subagentSkillsBinding ="),
    subagentSource.indexOf("const sessionManager =", subagentSource.indexOf("const subagentSkillsBinding =")),
  );
  assert.match(childExtensionSource, /promptPlan\.exactSystemPrompt !== undefined/);
  assert.match(childExtensionSource, /createSubagentSkillsBinding\([\s\S]*?exactSystemPrompt: promptPlan\.exactSystemPrompt/);
  assert.match(
    childExtensionSource,
    /\.\.\.\(subagentSkillsBinding\.loaderOptions\.extensionFactories \?\? \[\]\),/,
  );
  assert.match(childExtensionSource, /extensionFactories: childExtensionFactories,/);
  assert.match(promptSource, /preflightResult: \(success\) => \{[\s\S]*?acceptPreflight\(\)/);
  assert.doesNotMatch(promptSource, /requestedToolNames/);
});


test("RPC session startup persists explicit model defaults through the preference boundary", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  // Explicit startup model selection is persisted by the dedicated helper;
  // startup never reaches into the settings manager's global setters directly.
  assert.match(startupSource, /persistExplicitStartupPreferences\(/);
  assert.doesNotMatch(startupSource, /setDefaultModelAndProvider\(|setDefaultThinkingLevel\(/);
});


test("normal sessions restore persisted tool selections before loading resources", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /readSessionToolSelectionPolicy\(sessionManager\.getEntries\(\)/);
  assert.match(startupSource, /const effectiveToolNames = subagentResources\?\.tools \?\? toolNames \?\? persistedToolNames/);
  assert.ok(startupSource.indexOf("const chatOnly") < startupSource.indexOf("createAgentSessionServices("));
  assert.match(startupSource, /const chatOnly = effectiveToolNames\?\.length === 0/);
  assert.match(startupSource, /const trustReloadOptions = projectTrustReloadOptions\(sessionCwd, agentDir\)/);
  assert.match(startupSource, /wrapper\.beginExtensionBinding\(\{ forceEmptySystemPrompt: effectiveToolNames\?\.length === 0 \}\)/);
});

test("strict per-session tool selections disable extension and remote-host loading", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));

  assert.match(startupSource, /const strictToolAllowlistEnabled = !subagentResources/);
  assert.match(startupSource, /if \(!subagentResources && strictToolAllowlist === true\) \{[\s\S]*?strictToolAllowlist requires an explicit toolNames allow-list/);
  assert.match(startupSource, /validateSessionToolSelection\(toolNames\)/);
  assert.match(startupSource, /appendSessionToolSelection\(sessionManager, effectiveToolNames, \{\s*strict: strictToolAllowlist === true,?\s*\}\)/);
  assert.match(startupSource, /toolsOption = effectiveToolNames\.length === 0 \|\| strictToolAllowlistEnabled/);
  assert.match(startupSource, /strictToolAllowlistEnabled\s*\?\s*\{/);
  assert.match(startupSource, /noExtensions: true/);
  assert.match(startupSource, /extensionFactories: \[createCompactionModelExtension\(settingsManager\)\]/);
  assert.match(startupSource, /if \(!strictToolAllowlistEnabled \|\| options\.parentRemoteHost\) \{\s*remoteClaudeHost =/);
  assert.match(startupSource, /strictToolAllowlist !== undefined/);
  assert.match(startupSource, /explicitStrictPolicyNeedsPersist/);
});

test("explicit strict=false overrides a persisted strict policy before reopen", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const startupSource = source.slice(source.indexOf("export async function startRpcSession"));
  const toolsSource = source.slice(
    source.indexOf("export async function setRpcSessionTools"),
    source.indexOf("// ----------------------------------------------------------------------------", source.indexOf("export async function setRpcSessionTools")),
  );
  assert.match(startupSource, /persistedToolPolicy\.strict !== \(strictToolAllowlist === true\)/);
  assert.match(startupSource, /strict: strictToolAllowlist === true/);
  assert.match(toolsSource, /const entries = manager\.getEntries\(\)/);
  assert.match(toolsSource, /const persistedToolPolicy = readSessionToolSelectionPolicy\(entries\)/);
  assert.match(toolsSource, /const effectiveStrictToolAllowlist = strictToolAllowlist \?\? persistedToolPolicy\?\.strict \?\? false/);
});


test("crossing the Chat-only boundary persists and rebuilds the wrapper", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const switchStart = source.indexOf("export async function setRpcSessionTools");
  const switchSource = source.slice(
    switchStart,
    source.indexOf("// ----------------------------------------------------------------------------", switchStart),
  );

  assert.match(switchSource, /!hasCurrentResourcePolicy\s*\|\| existing\.isChatOnly\(\) !== \(toolNames\.length === 0\)/);
  assert.match(switchSource, /appendSessionToolSelection\(existing\.inner\.sessionManager, toolNames, \{\s*strict: nextStrictToolAllowlist/);
  assert.match(switchSource, /await existing\.shutdown\(\)/);
  assert.match(switchSource, /__recreate__\$\{randomUUID\(\)\}/);
  assert.match(switchSource, /sessionId: started\.realSessionId/);
});


test("file-tail retry consumes model-routing backoff before arming the scheduler", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const fallback = source.slice(
    source.indexOf("const fileNext = this.fileTailSchedulerState()"),
    source.indexOf("if (next === null)", source.indexOf("const fileNext = this.fileTailSchedulerState()")),
  );
  assert.match(fallback, /this\.consumeModelRoutingRetryDelay\(\s*nextBackoffDelayMs/);
});

test("model-routing backoff preserves a provider Retry-After lower bound", async () => {
  const source = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
  const methodStart = source.indexOf("private consumeModelRoutingRetryDelay");
  const method = source.slice(methodStart, source.indexOf("private async tryModelRoutingSwitch", methodStart));
  assert.match(method, /Math\.max\(getModelRoutingRetryDelayMs\(failedAttempt\), defaultDelay\)/);
});


test("live automatic-compaction choices persist per session and survive reopening without global writes", async (t) => {
  const { SessionManager } = await jiti.import("@earendil-works/pi-coding-agent");
  const root = await mkdtemp(join(tmpdir(), "pi-web-compaction-choice-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: "synthetic compaction preference", timestamp: 1 });
  const fixture = makeToolFixture();
  fixture.inner.sessionManager = manager;
  fixture.inner.sessionFile = manager.getSessionFile();
  fixture.inner.settingsManager.applyOverrides = () => {};
  t.after(() => fixture.wrapper.destroy());
  for (const enabled of [false, true, false]) {
    await fixture.wrapper.send({ type: "set_auto_compaction", enabled });
    const opened = SessionManager.open(manager.getSessionFile());
    const entries = opened.getEntries().filter(entry => entry.type === "custom" && entry.customType === "pi-web:auto-compaction");
    assert.ok(entries.length > 0, "live choice must leave a per-session durable fact");
    assert.deepEqual(entries.at(-1).data, { version: 1, autoCompactionEnabled: enabled });
    assert.equal(opened.buildSessionContext().messages.some(message => JSON.stringify(message).includes("pi-web:auto-compaction")), false);
    const resumed = makeToolFixture({ entries: opened.getEntries() });
    resumed.inner.settingsManager.applyOverrides ??= () => {};
    try { assert.equal((await resumed.wrapper.send({ type: "get_state" })).autoCompactionEnabled, enabled); }
    finally { resumed.wrapper.destroy(); }
    assert.deepEqual(fixture.inner.settingsManager.getGlobalSettings(), {});
    assert.deepEqual(fixture.inner.settingsManager.getProjectSettings(), {});
  }
});
