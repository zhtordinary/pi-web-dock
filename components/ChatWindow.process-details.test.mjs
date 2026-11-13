import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { stripTypeScriptTypes } from "node:module";
import ts from "typescript";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createJiti } from "jiti";
import { splitProcessRenderSegments } from "../lib/process-render-segments.ts";

const source = await readFile(new URL("./ChatWindow.tsx", import.meta.url), "utf8");
const segmentSource = await readFile(new URL("../lib/process-render-segments.ts", import.meta.url), "utf8");
const groupSource = await readFile(new URL("./ProcessDetailsGroup.tsx", import.meta.url), "utf8");
const jiti = createJiti(import.meta.url, { jsx: { runtime: "automatic" }, tsconfigPaths: true });
const { ProcessDetailsGroup } = await jiti.import("./ProcessDetailsGroup.tsx");

test("keeps the persisted tail time during pre-snapshot waits and gives live output the timestamp", () => {
  assert.match(
    source,
    /if \(showTimestamp && isStreaming && hasStreamingContent\)/,
  );
  assert.match(
    source,
    /const split = splitFinalAssistantBlocks\(message\)[\s\S]*<MessageView[\s\S]*isStreaming[\s\S]*showTimestamp=\{true\}/,
  );
});

test("resets process details when the turn gains or loses its final answer", () => {
  // useState only reads defaultExpanded on mount; keying each split group on
  // answer availability makes an answered turn start collapsed even if it first
  // rendered unanswered.
  assert.match(
    source,
    /key=\{`process-group-\$\{finalAnswerMessage \? "answered" : "unanswered"\}/,
  );
});

test("a historical window end is not the live process tail", () => {
  const expression = source.match(/const isCurrentTail = ([^;]+);/)?.[1];
  assert.ok(expression);
  const evaluate = new Function('atLiveTail', 'endIdx', 'messages', 'userIdx', 'lastAnchorIdx', `return (${expression});`);
  assert.equal(evaluate(false, 3, Array(3), 0, 0), false,
    'an older bounded window must retain historical process rendering even when its local group ends last');
  assert.equal(evaluate(true, 3, Array(3), 0, 0), true);
  assert.equal(evaluate(true, 2, Array(3), 0, 0), false);
});

test("opening a process entry expands only its own segment within the turn", () => {
  const expression = source.match(/const opened = ([^;]+);/)?.[1];
  assert.ok(expression);
  const opened = new Function("openedProcessEntryId", "entryIds", "segment", "groupStartIdx", "endIdx", `return (${expression});`);
  const ids = ["q", "e1", "e2", "control", "e4", "e5", "answer"];
  const first = { items: [{ index: 1 }, { index: 2 }] };
  const second = { items: [{ index: 4 }, { index: 5 }] };
  assert.equal(opened("e1", ids, first, 0, ids.length), true);
  assert.equal(opened("e1", ids, second, 0, ids.length), false);
  assert.equal(opened("e4", ids, second, 0, ids.length), true);
  assert.equal(opened("e4", ids, first, 0, ids.length), false);
});

test("keeps session-control cards outside collapsed process details", () => {
  assert.match(source, /splitProcessRenderSegments/);
  assert.match(segmentSource, /SESSION_CONTROL_INITIAL_MESSAGE_CUSTOM_TYPE/);
  assert.match(segmentSource, /(?:export )?function isSessionControlDisplayMessage/);
  assert.match(segmentSource, /function splitProcessRenderSegments/);
  assert.match(segmentSource, /segments\.push\(\{ kind: "session-control", index: item\.index \}\)/);
  assert.match(source, /segment\.kind === "session-control"[\s\S]*keyPrefix: "session-control"/);
  assert.match(source, /messageCount=\{segment\.items\.length\}/);
  assert.doesNotMatch(source, /processSummaries|renderProcessSummary/);
});

test("agent-only sessions anchor their leading control card so the result remains visible", () => {
  assert.match(source, /const hasAnchor = isResponseTurnAnchor\(msg\)[\s\S]*transcript\.firstUserEntryId === null[\s\S]*isSessionControlDisplayMessage\(msg\)/);
  assert.match(source, /if \(isResponseTurnAnchor\(messages\[i\]\)[\s\S]*transcript\.firstUserEntryId === null[\s\S]*isSessionControlDisplayMessage\(messages\[i\]\)/);
});

test("uses ephemeral partial results while preserving the final transcript result", () => {
  assert.match(source, /const map = new Map<string, ToolResultMessage>\(activeToolResults\);[\s\S]*?for \(const msg of messages\)[\s\S]*?map\.set/);
  assert.match(source, /\[activeToolResults, messages\]/);
  assert.match(source, /<MessageView[\s\S]*message=\{searchableMessage\}[\s\S]*toolResults=\{toolResults\}/);
});

test("splits interleaved process messages around a session-control card", () => {
  const firstProcess = { role: "assistant", content: [{ type: "text", text: "process A" }] };
  const sessionControl = {
    role: "custom",
    customType: "pi-web:session-peer",
    content: "collaboration",
    display: true,
    details: { source: "session-control", messageId: "peer-1" },
  };
  const secondProcess = { role: "assistant", content: [{ type: "text", text: "process B" }] };
  const finalProcess = { role: "assistant", content: [{ type: "text", text: "final" }] };
  const segments = splitProcessRenderSegments([firstProcess, sessionControl, secondProcess, finalProcess], [0, 1, 2], 3, finalProcess);

  assert.deepEqual(segments, [
    { kind: "details", items: [{ kind: "message", index: 0 }] },
    { kind: "session-control", index: 1 },
    { kind: "details", items: [{ kind: "message", index: 2 }, { kind: "final", index: 3, message: finalProcess }] },
  ]);
});

test("row metadata keeps empty process bodies and trailing tools in an unanswered turn", async () => {
  const {isTranscriptPlaceholder}=await jiti.import('../lib/transcript-store.ts');
  const {getDisplayableAssistantBlocks,getAssistantErrorMessage}=await jiti.import('../lib/message-display.ts');
  const helper=source.slice(source.indexOf('function hasDisplayableProcessMessage('),source.indexOf('const QUOTE_BLOCK_TAGS'));
  const displayable=new Function('isTranscriptPlaceholder','getDisplayableAssistantBlocks',stripTypeScriptTypes(helper)+'; return hasDisplayableProcessMessage;')(isTranscriptPlaceholder,getDisplayableAssistantBlocks);
  const start=source.indexOf('const processIndices: number[] = []');
  const end=Math.min(...['const finalAssistant =','const processSegments ='].map(marker=>source.indexOf(marker,start)).filter(index=>index>start));
  const select=new Function('messages','entryIds','transcript','userIdx','finalAssistantIdx','endIdx','hasDisplayableProcessMessage','getAssistantErrorMessage',stripTypeScriptTypes(source.slice(start,end))+'; return visibleProcessIndices;');
  const rows=[{role:'user',content:'q'},{role:'assistant',content:[]},{role:'assistant',content:[{type:'toolCall',id:'call',name:'read',arguments:{}}]},{role:'toolResult',content:[]}];
  const ids=['q','empty','call','result'];
  const transcript={items:new Map(ids.slice(1).map(id=>[id,{process:true}]))};
  for(const messages of [rows.map((row,index)=>index?{...row,__readerPlaceholder:true}:row),rows]) {
    const indices=select(messages,ids,transcript,0,2,4,displayable,getAssistantErrorMessage);
    assert.deepEqual(indices,[1,3]);
    const segments=splitProcessRenderSegments(messages,indices,2,messages[2]);
    assert.deepEqual(segments[0].items.map(item=>item.index),[1,2,3]);
    assert.equal(segments[0].items.length,3);
  }
});

const processLabels = {
  "chat.processDetails": "Process details", "chat.messages": "messages",
  "chat.toolCalls": "tool calls", "chat.loadingProcessContent": "Loading process content…",
  "chat.retryProcessContent": "Retry process content", "chat.failedToReadProcess": "Process read failed",
};
const processT = (key) => processLabels[key] ?? key;

function readProcessHarness() {
  const tree = ts.createSourceFile("ChatWindow.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(tree) === "readHistoryProcess") return node.initializer;
    return ts.forEachChild(node, find);
  }
  const callback = find(tree);
  assert.ok(callback);
  const h = { reads: {}, scope: { sessionId: "s" }, error: null, operation: async () => undefined };
  const bindings = {
    reader: { getState: () => ({ requestedScope: h.scope, error: h.error }), expandProcess: (range) => h.operation(range) },
    setOpenedProcessEntryId: (id) => { h.opened = id; },
    setProcessReadStates: (update) => { h.reads = update(h.reads); },
    t: processT,
  };
  h.read = new Function(...Object.keys(bindings), `return (${stripTypeScriptTypes(callback.getText(tree))});`)(...Object.values(bindings));
  return h;
}
const processRange = { firstEntryId: "e1", lastEntryId: "e57" };

test("one group loading status covers 56 placeholders without hiding an already loaded memory card", () => {
  const html = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    initiallyExpanded: true, loading: true, messageCount: 57, toolCallCount: 16, t: processT,
  }, [React.createElement("span", { key: "memory" }, "Loaded memory context"),
    ...Array.from({ length: 56 }, (_, i) => React.createElement("div", { key: i, "data-entry-id": `e${i}`, "aria-hidden": "true" }))]));
  assert.equal((html.match(/role="status"/g) ?? []).length, 1);
  assert.equal((html.match(/Loading process content/g) ?? []).length, 1);
  assert.match(html, /Process details · 57 messages · 16 tool calls/);
  assert.match(html, /Loaded memory context/);
  const start = source.indexOf("if (isTranscriptPlaceholder(msg))");
  assert.ok(start >= 0);
  const row = source.slice(start, source.indexOf("\n", start));
  assert.match(row, /data-chat-message-row="true"/);
  assert.match(row, /data-entry-id=\{entryIds\[idx\]\}/);
  assert.doesNotMatch(row, /loadingProcessContent|role="status"/);
});

test("a running process group stays open while its history body is still loading", () => {
  const live = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    active: true, initiallyExpanded: false, loading: true, messageCount: 29, toolCallCount: 15, t: processT,
  }, "Already loaded process"));
  assert.match(live, /aria-expanded="true"/);
  assert.match(live, /Already loaded process/);
  assert.match(live, /Loading process content/);
  const settled = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, {
    active: false, initiallyExpanded: false, messageCount: 29, toolCallCount: 15, t: processT,
  }, "Already loaded process"));
  assert.match(settled, /aria-expanded="false"/);
  assert.doesNotMatch(settled, /Already loaded process/);
});

test("live process loading does not leave a completed turn manually opened", async () => {
  const h = readProcessHarness();
  await h.read(processRange, false);
  assert.equal(h.opened, undefined);
  assert.deepEqual(h.reads.e1, { loading: false, error: null });
  await h.read(processRange);
  assert.equal(h.opened, "e1");
});

test("live groups request missing content once and leave a failed read for explicit retry", () => {
  const tree = ts.createSourceFile("ProcessDetailsGroup.tsx", groupSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let effect;
  function visit(node) {
    if (ts.isCallExpression(node) && node.expression.getText(tree) === "useEffect") effect = node;
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(effect, "live history must be read after render, not only on a manual click");
  const body = stripTypeScriptTypes(effect.arguments[0].getText(tree));
  let reads = 0;
  const run = (active, loading, loadError) => new Function("active", "loading", "loadError", "onExpand", `return (${body})();`)(active, loading, loadError, () => { reads++; });
  run(false, false, null);
  run(true, true, null);
  run(true, false, "Network offline");
  assert.equal(reads, 0);
  run(true, false, null);
  assert.equal(reads, 1);
  assert.match(source, /active=\{isLiveTail\}/);
  assert.match(source, /readHistoryProcess\(processRange, !isLiveTail\)/);
});

test("a failed process group renders an actionable error rather than another loading status", () => {
  const props = {
    initiallyExpanded: true, loadError: "Network offline", messageCount: 57, toolCallCount: 16,
    t: processT, onExpand() {},
  };
  const html = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, props, "Already loaded process content"));
  const loading = renderToStaticMarkup(React.createElement(ProcessDetailsGroup, { ...props, loading: true }));
  assert.match(html, /role="alert"/);
  assert.match(html, /Network offline/);
  assert.match(html, /Retry process content/);
  assert.match(html, /Already loaded process content/);
  assert.match(loading, /role="status"/);
  assert.doesNotMatch(html, /role="status"/);
  assert.doesNotMatch(loading, /Network offline/);
  assert.match(groupSource, /onClick=\{onExpand\}/);
});

test("process loading remains visible until its complete asynchronous read settles", async () => {
  const h = readProcessHarness();
  let finish;
  h.operation = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.read(processRange);
  assert.deepEqual(h.reads.e1, { loading: true, error: null });
  assert.equal(h.opened, "e1");
  finish();
  await pending;
  assert.deepEqual(h.reads.e1, { loading: false, error: null });
});

test("failed process reads expose the reader error and a successful retry clears it", async () => {
  const h = readProcessHarness();
  h.error = { message: "Network offline", retryable: true };
  h.operation = async () => null;
  await h.read(processRange);
  assert.deepEqual(h.reads.e1, { loading: false, error: "Network offline" });
  h.error = null;
  h.operation = async () => undefined;
  await h.read(processRange);
  assert.deepEqual(h.reads.e1, { loading: false, error: null });
});

test("unexpected process read rejections become retryable group errors", async () => {
  const h = readProcessHarness();
  h.operation = async () => { throw new Error("Unexpected read failure"); };
  await assert.doesNotReject(h.read(processRange));
  assert.deepEqual(h.reads.e1, { loading: false, error: "Unexpected read failure" });
});

test("a late process failure cannot repopulate state after a session or branch switch", async () => {
  const h = readProcessHarness();
  let finish;
  h.operation = () => new Promise((resolve) => { finish = resolve; });
  const pending = h.read(processRange);
  assert.deepEqual(h.reads.e1, { loading: true, error: null });
  h.scope = { sessionId: "other" };
  h.reads = {};
  h.error = { message: "Late failure" };
  finish(null);
  await pending;
  assert.deepEqual(h.reads, {});
});

test("renders process groups collapsed with their counts and hidden children", () => {
  const labels = {
    "chat.processDetails": "Process details",
    "chat.messages": "messages",
    "chat.toolCall": "tool call",
    "chat.expandProcess": "Expand process",
    "chat.collapseProcess": "Collapse process",
  };
  const html = renderToStaticMarkup(React.createElement(
    ProcessDetailsGroup,
    { messageCount: 2, toolCallCount: 1, t: (key) => labels[key] ?? key },
    React.createElement("span", { "data-process-child": "true" }, "process child"),
  ));

  assert.match(html, /aria-expanded="false"/);
  assert.match(html, /Process details · 2 messages · 1 tool call/);
  assert.doesNotMatch(html, /data-process-child/);
  assert.doesNotMatch(html, /process child/);
});
