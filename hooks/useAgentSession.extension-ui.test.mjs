import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";
import vm from "node:vm";
import * as queue from "../lib/extension-ui-queue.ts";
import { isBlockingExtensionUiRequest } from "../lib/browser-notifications.ts";
import { getToolNamesForPreset } from "../lib/tool-presets.ts";

const source = await readFile(new URL("./useAgentSession.ts", import.meta.url), "utf8");
const chatWindow = await readFile(new URL("../components/ChatWindow.tsx", import.meta.url), "utf8");
function section(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing production section: ${start}`);
  return source.slice(from, to);
}
const callbacks = [
  section("  const respondToExtensionUi = useCallback", "  const addNotice = useCallback"),
  section("  const handleExtensionUiRequest = useCallback", "  const settleUiStage = useCallback"),
  section("  const handleAgentEvent = useCallback", "  handleAgentEventRef.current = handleAgentEvent"),
  section("  const handleToolPresetChange = useCallback", "  const scrollUserMsgToTop = useCallback"),
].join("\n");
const projection = section("  const extensionDialog = extensionDialogs[0]", "  return {");
const plain = (value) => structuredClone(value);
const ids = (values) => Array.from(values, (value) => value.id);
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ toolsResult = {} } = {}) {
  const state = { dialogs: [], custom: [], commands: [], effects: [], errors: [], attention: [], presets: [], preferences: [], notices: [] };
  let command = async (sid, input) => input.type === "set_tools" ? toolsResult : {};
  const noop = () => {};
  const ctx = {
    ...queue, isBlockingExtensionUiRequest, getToolNamesForPreset,
    useCallback: (callback) => callback, opts: {}, console: { error: (...args) => state.errors.push(args) },
    sessionIdRef: { current: "s" }, sessionPropIdRef: { current: "s" }, sessionHookMountedRef: { current: true }, remotePeerRef: { current: null },
    ensuringNewSessionRef: { current: null }, sessionToolsPinnedRef: { current: false },
    stateRunRevisionRef: { current: 0 }, currentAgentRunIdRef: { current: "previous-run" }, rpcPromptPendingRef: { current: false },
    activeToolIdsRef: { current: new Set() }, toolEventRevisionRef: { current: 0 }, setActiveToolResults: noop, setAgentPhase: noop,
    pendingSessionLoadRef: { current: null },
    setExtensionDialogs(update) {
      state.dialogs = typeof update === "function" ? update(state.dialogs) : update;
      state.effects.push(["dialogs", ids(state.dialogs)]);
    },
    setExtensionCustomUis(update) {
      state.custom = typeof update === "function" ? update(state.custom) : update;
      state.effects.push(["custom", ids(state.custom)]);
    },
    onAttentionNeeded: (request) => state.attention.push(request.id),
    markSessionDialogInteracted: (sid) => state.effects.push(["interacted", sid]),
    sendAgentCommandR: async (sid, input) => {
      state.commands.push([sid, plain(input)]);
      return command(sid, input);
    },
    loadAgentState: async () => ({}), restoreLoadedRunState: noop,
    closeEvents: () => state.effects.push(["close"]),
    maintainEventsConnected: (sid) => state.effects.push(["maintain", sid]),
    cancelEventStreamGrace: () => state.effects.push(["cancel-grace"]),
    reader: { recordUnseenEntry() {}, reconcileTail: async () => state.effects.push(["reconcile"]) },
    setPreferredToolPreset: (preset) => state.preferences.push(preset), setToolPresetState: (preset) => state.presets.push(preset), clearSlashCommands: noop,
    setExtensionStatuses: noop, setExtensionUsages: noop, setExtensionWidgets: noop, setEditorSuggestion: noop, setSystemPrompt: noop,
    loadTools: async () => {}, syncLiveModel: noop,
    addNotice: (notice) => state.notices.push(plain(notice)), t: (key) => key, appendMessage: noop, apiPath: noop, invalidateSessionDetailsForSession: noop,
    loadSession: noop, confirmPromptDelivery: noop, notifyPromptStage: noop, onAgentError: noop, refreshSessionCost: noop,
    scrollToBottom: noop, settleUiStage: noop, syncQueuedDrafts: noop, syncQueuedDraftResponse: noop, updateMessages: noop, dispatch: noop,
  };
  vm.runInNewContext(stripTypeScriptTypes(`${callbacks}\nObject.assign(globalThis, {
    request: handleExtensionUiRequest, event: handleAgentEvent, respond: respondToExtensionUi,
    close: closeExtensionCustomUi, input: sendExtensionCustomInput, tools: handleToolPresetChange,
  });`), ctx);
  return { state, ctx, request: ctx.request, event: ctx.event, respond: ctx.respond, close: ctx.close, input: ctx.input, tools: ctx.tools,
    setCommand: (next) => { command = next; },
    view() {
      const values = { extensionDialogs: state.dialogs, extensionCustomUis: state.custom };
      vm.runInNewContext(`${projection}\nglobalThis.view = { extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount };`, values);
      return values.view;
    },
  };
}
function seed(h) {
  h.request({ method: "confirm", id: "dialog-a", title: "First", runtimeGeneration: "generation-a" });
  h.request({ method: "editor", id: "dialog-b", title: "Second" });
  h.request({ method: "custom", id: "panel-a", lines: ["First"] });
  h.request({ method: "custom", id: "panel-b", lines: ["Second"] });
}

test("all blocking dialog methods queue by request id and expose the FIFO head/count independently of panels", () => {
  const h = fixture();
  for (const method of ["select", "confirm", "input", "editor"]) h.request({ method, id: method, title: method });
  const first = h.state.dialogs[0];
  h.request({ method: "select", id: "select", title: "replayed" });
  h.request({ method: "custom", id: "panel-a", lines: ["one"] });
  h.request({ method: "custom", id: "panel-b", lines: ["two"] });
  assert.deepEqual(ids(h.state.dialogs), ["select", "confirm", "input", "editor"]);
  assert.ok(h.state.dialogs[0] === first, "dialog replay cannot replace or reorder the waiting request");
  const view = h.view();
  assert.equal(view.extensionDialog.id, "select");
  assert.equal(view.waitingExtensionDialogCount, 3);
  assert.equal(view.extensionCustomUi.id, "panel-a");
  assert.equal(view.waitingExtensionCustomUiCount, 1);
});

test("the hook exports queue heads/counts and Reader binds each request-scoped panel", () => {
  const returned = source.slice(source.indexOf("  const extensionDialog = extensionDialogs[0]"));
  assert.match(returned, /extensionDialog, waitingExtensionDialogCount, extensionCustomUi, waitingExtensionCustomUiCount, extensionStatuses, extensionUsages, extensionWidgets, editorSuggestion, respondToExtensionUi, sendExtensionCustomInput, closeExtensionCustomUi,/);
  const dialog = chatWindow.slice(chatWindow.indexOf("        <ExtensionDialog"), chatWindow.indexOf("      {extensionCustomUi &&"));
  assert.match(dialog, /key=\{extensionDialog\.id\}/);
  assert.match(dialog, /request=\{extensionDialog\}/);
  assert.match(dialog, /waitingCount=\{waitingExtensionDialogCount\}/);
  assert.match(dialog, /onRespond=\{respondToExtensionUi\}/);
  const custom = chatWindow.slice(chatWindow.indexOf("        <ExtensionCustomPanel"), chatWindow.indexOf("      {sessionSearchOpen"));
  assert.match(custom, /key=\{extensionCustomUi\.id\}/);
  assert.match(custom, /request=\{extensionCustomUi\}/);
  assert.match(custom, /waitingCount=\{waitingExtensionCustomUiCount\}/);
});

test("extension usage updates invalidate the active session cost", () => {
  const h = fixture();
  h.ctx.invalidateSessionDetailsForSession = (id) => h.state.effects.push(["cost-invalidated", id]);
  h.request({ method: "setExtensionUsage", usageKey: "fixture", usage: { label: "fixture" } });
  assert.deepEqual(h.state.effects, [["cost-invalidated", "s"]]);
  h.ctx.sessionIdRef.current = null;
  h.request({ method: "setExtensionUsage", usageKey: "fixture" });
  assert.equal(h.state.effects.length, 1);
});

test("custom rerenders replace only their own slot and custom close removes only its matching request", () => {
  const h = fixture(); seed(h);
  h.request({ method: "custom", id: "panel-a", lines: ["updated"] });
  assert.deepEqual(ids(h.state.custom), ["panel-a", "panel-b"]);
  assert.deepEqual(plain(h.state.custom[0].lines), ["updated"]);
  const attentionCount = h.state.attention.length;
  h.request({ method: "custom", id: "panel-a", closed: true });
  h.request({ method: "custom", id: "unknown", closed: true });
  assert.equal(h.state.attention.length, attentionCount, "close does not request user attention");
  assert.deepEqual(ids(h.state.custom), ["panel-b"]);
  assert.deepEqual(ids(h.state.dialogs), ["dialog-a", "dialog-b"]);
});

test("dialog response carries request generation and removes only the acknowledged request", async () => {
  const h = fixture(); seed(h);
  const gate = deferred(); h.setCommand(() => gate.promise);
  const response = h.respond(h.state.dialogs[0], { confirmed: true });
  assert.deepEqual(h.state.commands, [["s", { type: "extension_ui_response", id: "dialog-a", runtimeGeneration: "generation-a", confirmed: true }]]);
  assert.deepEqual(ids(h.state.dialogs), ["dialog-a", "dialog-b"], "awaiting server acknowledgement keeps the dialog visible");
  gate.resolve(); await response;
  assert.deepEqual(ids(h.state.dialogs), ["dialog-b"]);
  assert.deepEqual(ids(h.state.custom), ["panel-a", "panel-b"]);
  assert.equal(h.view().waitingExtensionDialogCount, 0);
  h.setCommand(async () => { throw new Error("offline"); });
  await h.respond(h.state.dialogs[0], { cancelled: true });
  assert.deepEqual(ids(h.state.dialogs), ["dialog-b"], "failed responses must remain recoverable");
  assert.equal(h.state.errors.length, 1);
});

test("custom panel close and input remain request scoped and wait for server closure", async () => {
  const h = fixture(); seed(h);
  await h.close(h.state.custom[0]);
  await h.input(h.state.custom[1], "key input");
  assert.deepEqual(h.state.commands, [
    ["s", { type: "extension_ui_close", id: "panel-a" }],
    ["s", { type: "extension_ui_input", id: "panel-b", data: "key input" }],
  ]);
  assert.deepEqual(ids(h.state.custom), ["panel-a", "panel-b"]);
  h.request({ method: "custom", id: "panel-a", closed: true });
  h.event({ type: "extension_ui_closed", id: "dialog-b" });
  assert.deepEqual(ids(h.state.dialogs), ["dialog-a"]);
  assert.deepEqual(ids(h.state.custom), ["panel-b"]);
  h.ctx.sessionIdRef.current = null;
  await h.close(h.state.custom[0]);
  await h.respond(h.state.dialogs[0], { cancelled: true });
  assert.equal(h.state.commands.length, 2, "no detached-session command is issued");
  const customPanel = chatWindow.slice(chatWindow.indexOf("        <ExtensionCustomPanel"), chatWindow.indexOf("        <ExtensionCustomPanel") + 700);
  assert.match(customPanel, /onClose=\{closeExtensionCustomUi\}/);
  assert.match(customPanel, /onInput=\{sendExtensionCustomInput\}/);
});

test("reconnect drops stale requests in both queues and replay neither duplicates nor reorders the survivors", () => {
  const h = fixture(); seed(h);
  h.event({ type: "connected", pendingExtensionUiIds: ["dialog-b", "panel-b", "dialog-c", "panel-c"] });
  assert.deepEqual(ids(h.state.dialogs), ["dialog-b"]);
  assert.deepEqual(ids(h.state.custom), ["panel-b"]);
  h.event({ type: "extension_ui_request", method: "editor", id: "dialog-b", replay: true });
  h.event({ type: "extension_ui_request", method: "confirm", id: "dialog-c", replay: true });
  h.event({ type: "extension_ui_request", method: "custom", id: "panel-b", replay: true, lines: ["replay render"] });
  h.event({ type: "extension_ui_request", method: "custom", id: "panel-c", replay: true });
  assert.deepEqual(ids(h.state.dialogs), ["dialog-b", "dialog-c"]);
  assert.deepEqual(ids(h.state.custom), ["panel-b", "panel-c"]);
  assert.deepEqual(plain(h.state.custom[0].lines), ["replay render"]);
  h.event({ type: "connected" });
  assert.deepEqual(ids(h.state.dialogs), ["dialog-b", "dialog-c"], "an absent snapshot is not an empty snapshot");
  h.event({ type: "connected", pendingExtensionUiIds: [] });
  assert.equal(h.view().extensionDialog, null);
  assert.equal(h.view().extensionCustomUi, null);
  assert.equal(h.view().waitingExtensionDialogCount, 0);
  assert.equal(h.view().waitingExtensionCustomUiCount, 0);
});

for (const toolsResult of [{ recreated: true }, { sessionId: "replacement" }]) {
  test(`tool wrapper replacement clears both UI queues even when old close events cannot arrive: ${JSON.stringify(toolsResult)}`, async () => {
    const h = fixture({ toolsResult }); seed(h); h.state.effects = [];
    await h.tools("none");
    assert.deepEqual(ids(h.state.dialogs), []);
    assert.deepEqual(ids(h.state.custom), []);
    const expectedId = toolsResult.sessionId ?? "s";
    assert.equal(h.ctx.sessionIdRef.current, expectedId);
    assert.deepEqual(h.state.commands, [["s", { type: "set_tools", toolNames: [] }], [expectedId, { type: "get_state" }]]);
    assert.deepEqual(h.state.effects.slice(0, 4), [["cancel-grace"], ["close"], ["dialogs", []], ["custom", []]]);
    if (toolsResult.recreated) assert.deepEqual(h.state.effects[4], ["maintain", "s"]);
    else assert.equal(h.state.effects.filter(([effect]) => effect === "maintain").length, 0, "replacement-session selection owns its new stream");
  });
}

test("tool changes preserving the same wrapper retain its waiting UI and configured mode retracts the tool pin", async () => {
  const h = fixture(); seed(h); h.state.effects = [];
  h.ctx.sessionToolsPinnedRef.current = true;
  await h.tools("configured");
  assert.deepEqual(h.state.commands[0], ["s", { type: "set_tools" }]);
  assert.equal(h.ctx.sessionToolsPinnedRef.current, false);
  assert.deepEqual(h.state.preferences, ["configured"]);
  assert.deepEqual(h.state.presets, ["configured"]);
  assert.deepEqual(ids(h.state.dialogs), ["dialog-a", "dialog-b"]);
  assert.deepEqual(ids(h.state.custom), ["panel-a", "panel-b"]);
  assert.deepEqual(h.state.effects, []);
});

test("rejected tool changes do not claim success or store a preference", async () => {
  const h = fixture();
  h.ctx.sessionToolsPinnedRef.current = true;
  h.setCommand(async () => { throw new Error("profile cannot change tools"); });
  await h.tools("configured");
  assert.equal(h.ctx.sessionToolsPinnedRef.current, true);
  assert.deepEqual(h.state.preferences, []);
  assert.deepEqual(h.state.presets, []);
  assert.deepEqual(h.state.notices, [{ type: "error", message: "chat.toolPresetUnconfirmed" }]);
});

test("a late tool response cannot change the next session or its preference", async () => {
  const h = fixture();
  const waiting = deferred();
  h.setCommand(async () => waiting.promise);
  const change = h.tools("configured");
  h.ctx.sessionIdRef.current = "next";
  waiting.resolve({});
  await change;
  assert.deepEqual(h.state.preferences, []);
  assert.deepEqual(h.state.presets, []);
});
