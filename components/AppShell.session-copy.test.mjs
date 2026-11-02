import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const topBarStart = source.indexOf("const sessionTopBar");
const topBarEnd = source.indexOf("const chatWindowContent", topBarStart);
const topBar = source.slice(topBarStart, topBarEnd);
const copyHandlerStart = source.indexOf("const handleCopySessionField = useCallback");
const copyHandlerEnd = source.indexOf("const syncCollapsedProvidersToIframe", copyHandlerStart);
const copyHandler = source.slice(copyHandlerStart, copyHandlerEnd);

test("session top bar copies the reusable source-session identity block", () => {
  assert.ok(topBarStart >= 0, "session top bar missing");
  assert.ok(topBarEnd > topBarStart, "session top bar boundary missing");
  assert.match(source, /buildTalkMapSourceInfo\(\{/);
  assert.match(source, /sourcePath: topBarSession\.path/);
  assert.match(source, /sourceProject: topBarProjectPath \?\? ""/);
  assert.match(source, /handleCopySessionField\("sourceInfo", topBarSessionInfoText\)/);
  assert.match(topBar, /topBarSessionId && topBarSession\?\.path/);
  assert.match(topBar, /handleTopBarCopySessionInfo/);
  assert.match(topBar, /session\.copySourceInfo/);
  assert.match(topBar, /<Copy size=\{13\}/);
  assert.match(topBar, /<Check size=\{13\}/);
});

function buildInlineCopyHandler(copy) {
  const match = source.match(/onClick=\{(\(\) => void handleCopySessionField\(field, value\)\.catch\(\(\) => \{\}\))\}/);
  assert.ok(match, "inline session-field copy handler missing");
  return Function("handleCopySessionField", "field", "value", `return ${match[1]};`)(copy, "cost", "$1.23");
}

test("inline session-field copy consumes synchronous and asynchronous rejections", async () => {
  const unhandled = [];
  const calls = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const syncHandler = buildInlineCopyHandler((field, value) => {
      calls.push(["sync", field, value]);
      return Promise.reject(new Error("sync clipboard failure"));
    });
    const asyncHandler = buildInlineCopyHandler((field, value) => {
      calls.push(["async", field, value]);
      return new Promise((_, reject) => setImmediate(() => reject(new Error("async clipboard failure"))));
    });
    assert.equal(syncHandler(), undefined);
    assert.equal(asyncHandler(), undefined);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
  assert.deepEqual(calls, [
    ["sync", "cost", "$1.23"],
    ["async", "cost", "$1.23"],
  ]);
  assert.deepEqual(unhandled, []);
});

test("only full session-info copies get one trailing newline", () => {
  assert.ok(copyHandlerStart >= 0, "session copy handler missing");
  assert.ok(copyHandlerEnd > copyHandlerStart, "session copy handler boundary missing");
  assert.match(source, /handleCopySessionField\("sourceInfo", sourceInfo\)/);
  assert.ok(copyHandler.includes('const clipboardValue = field === "sourceInfo" ? `${value.replace(/\\n*$/, "")}\\n` : value;'));
  assert.match(copyHandler, /copyText\(clipboardValue\)/);
  assert.match(copyHandler, /return copyText\(clipboardValue\)\.then/);
});
