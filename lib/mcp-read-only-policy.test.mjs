import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { createSubagentMcpPolicyExtension, isMcpTool, isReadOnlySelection } = await jiti.import("./mcp-read-only-policy.ts");

test("a pinned selection is read-only when it names tools and none can write or run commands", () => {
  assert.equal(isReadOnlySelection(["read", "grep", "find", "ls"]), true);
  assert.equal(isReadOnlySelection(["read"]), true);
  // No pin follows pi's configured tools, and an empty pin is Chat only, which loads no MCP.
  assert.equal(isReadOnlySelection(undefined), false);
  assert.equal(isReadOnlySelection([]), false);
  for (const writer of ["bash", "powershell", "edit", "write"]) {
    assert.equal(isReadOnlySelection(["read", writer]), false, writer);
  }
});

test("MCP tools are the MCP extension's and any named mcp__", () => {
  const source = (path) => ({ path, source: "builtin", scope: "user", origin: "top-level" });
  assert.equal(isMcpTool({ name: "read_mcp_resource", sourceInfo: source("builtin:mcp") }), true);
  assert.equal(isMcpTool({ name: "mcp__docs__search", sourceInfo: source("/ext/other-mcp.ts") }), true);
  assert.equal(isMcpTool({ name: "web_search", sourceInfo: source("/ext/search.ts") }), false);
  assert.equal(isMcpTool({ name: "codemode", sourceInfo: source("builtin:codemode") }), false);
});

test("child MCP policy checks owner before hint and applies equally to nested calls", () => {
  let onToolCall;
  const unselected = {
    name: "mcp__other__write",
    sourceInfo: { path: "/extensions/other-mcp.ts" },
    annotations: { readOnlyHint: true },
  };
  const selectedReadOnly = {
    name: "mcp__selected__search",
    sourceInfo: { path: "/extensions/selected-mcp.ts" },
    annotations: { readOnlyHint: true },
  };
  const selectedWrite = {
    name: "mcp__selected__write",
    sourceInfo: { path: "/extensions/selected-mcp.ts" },
    annotations: { readOnlyHint: false },
  };
  const extension = createSubagentMcpPolicyExtension(() => ({
    tools: ["read", selectedReadOnly.name, selectedWrite.name],
  }));
  extension.factory({
    on: (eventName, handler) => { if (eventName === "tool_call") onToolCall = handler; },
    getAllTools: () => [unselected, selectedReadOnly, selectedWrite],
  });

  assert.deepEqual(onToolCall({ toolName: unselected.name }), {
    block: true,
    reason: `"${unselected.name}" comes from an extension this subagent's profile did not select, so the call was blocked.`,
  });
  assert.equal(onToolCall({ toolName: unselected.name, parentToolCallId: "codemode/1" }).block, true);
  assert.equal(onToolCall({ toolName: selectedReadOnly.name }), undefined);

  const readOnlyDenied = onToolCall({ toolName: selectedWrite.name });
  assert.equal(readOnlyDenied.block, true);
  assert.match(readOnlyDenied.reason, /readOnlyHint/);
});
