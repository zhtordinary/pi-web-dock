import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const rpcManager = await readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8");
const sessionActivity = await readFile(new URL("./session-activity.ts", import.meta.url), "utf8");
const rpcRegression = await readFile(new URL("./rpc-manager.test.mjs", import.meta.url), "utf8");
const runtimeRegression = await readFile(new URL("./rpc-runtime-ownership.test.mjs", import.meta.url), "utf8");

test("combined RPC startup owns admission through registration and preserves native MCP wiring", () => {
  const startup = rpcManager.slice(rpcManager.indexOf("export async function startRpcSession"));
  const startingBody = startup.slice(0, startup.indexOf("    let sessionManager"));
  assert.match(startingBody, /const inflight = locks\.get\(sessionId\);/);
  assert.match(startingBody, /const starting = Promise\.resolve\(\)\.then\(async \(\) =>/);
  assert.match(startingBody, /const existing = registry\.get\(sessionId\);[\s\S]*?await existing\.shutdown\(\);/);
  assert.ok(startup.indexOf("const starting = Promise.resolve().then(async () =>") < startup.indexOf("SessionManager.open("));
  assert.ok(startup.indexOf("SessionManager.open(") < startup.indexOf("registerRpcSession(wrapper)"));
  assert.match(startup, /const builtins = subagentResources \|\| chatOnly[\s\S]*?createPiWebBuiltinExtensions/);
  assert.match(startup, /new AgentSessionWrapper\(inner, projectSkillRuntime, fastModeState, \{[\s\S]*?builtins\?\.mcpHost/);
  assert.match(startup, /registerRpcSession\(wrapper\);/);
  assert.match(startup, /if \(locks\.get\(sessionId\) === starting\) locks\.delete\(sessionId\);/);
});

test("combined wrapper keeps registry ownership and native MCP disposal ordering", () => {
  assert.match(rpcManager, /function registerRpcSession\(wrapper: AgentSessionWrapper\)/);
  assert.match(rpcManager, /if \(existing\?\.isAlive\(\) && existing !== wrapper\)/);
  assert.match(rpcManager, /if \(registry\.get\(wrapper\.sessionId\) !== wrapper\) return;/);
  assert.match(
    rpcManager,
    /constructor\(public readonly inner: AgentSessionLike,[\s\S]*?mcpOptions: \{\s*mcpHost\?: Pick<McpHost, "prepareForPrompt" \| "dispose">;\s*remoteClaudeHost\?: RemoteClaudeHostBinding;\s*(?:strictToolAllowlist\?: boolean;\s*)?(?:skillRuntimeContext\?: RuntimeSkillPolicyContext;\s*)?(?:stopBackgroundRun\?: \(runId: string\) => Promise<void>;\s*)?(?:runtimeOwnership\?: SessionRuntimeOwnership;\s*)?\} = \{\}\)/,
  );
  const disposeNow = rpcManager.slice(
    rpcManager.indexOf("  private disposeNow(): void"),
    rpcManager.indexOf("  private async runShutdown(): Promise<void>"),
  );
  const runShutdown = rpcManager.slice(
    rpcManager.indexOf("  private async runShutdown(): Promise<void>"),
    rpcManager.indexOf("  destroy(): void"),
  );
  const destroy = rpcManager.slice(
    rpcManager.indexOf("  destroy(): void"),
    rpcManager.indexOf("  async shutdown(): Promise<void>"),
  );
  const shutdown = rpcManager.slice(rpcManager.indexOf("  async shutdown(): Promise<void>"));
  assert.match(disposeNow, /this\.inner\.dispose\(\)/);
  assert.match(runShutdown, /this\.disposeMcpHost\(\);[\s\S]*?session_shutdown/);
  assert.match(runShutdown, /this\.disposeNow\(\);/);
  assert.match(destroy, /this\.runShutdown\(\)\.catch/);
  assert.match(shutdown, /this\.runShutdown\(\)/);
});

test("combined run callbacks carry currentRunId and cannot erase another runtime", () => {
  const lifecycle = rpcManager.slice(rpcManager.indexOf("  start(): void"), rpcManager.indexOf("  setForceEmptySystemPrompt"));
  assert.match(lifecycle, /recordSessionRunStart\(this\.inner\.sessionId, this\.cwd\)\.runId/);
  assert.match(lifecycle, /recordSessionRunError\(this\.inner\.sessionId, errorMessage, this\.unattendedEnabled, this\.currentRunId\)/);
  assert.match(lifecycle, /touchSessionRun\(this\.inner\.sessionId, this\.currentRunId\)/);
  assert.match(lifecycle, /recordSessionRunSettled\(this\.inner\.sessionId, this\.currentRunId\)/);
  assert.match(rpcManager, /recordSessionRunAbort\(this\.sessionId, this\.unattendedEnabled, this\.currentRunId\)/);
  assert.match(rpcManager, /recordSessionRunUnknown\(this\.sessionId, this\.currentRunId\)/);
  assert.match(rpcManager, /const withRunId = this\.currentRunId[\s\S]*?runId: this\.currentRunId/);
});

test("combined activity ledger matches both session and run and preserves terminal states", () => {
  assert.match(sessionActivity, /expectedRunId\?: string \| null/);
  assert.match(sessionActivity, /record\.runId === runId && record\.sessionId === sessionId/);
  assert.match(sessionActivity, /record\.status !== "running" && record\.status !== "unknown"/);
  assert.match(sessionActivity, /if \(state\.activeBySession\.get\(sessionId\) === record\.runId\) state\.activeBySession\.delete\(sessionId\);/);
  assert.match(sessionActivity, /record\.status === status/);
});

test("combined regression files cover admission, replacement, late settlement, and MCP callbacks", () => {
  assert.match(rpcRegression, /registerRpcSession/);
  assert.match(rpcRegression, /currentRunId/);
  assert.match(runtimeRegression, /concurrent opens share one runtime/);
  assert.match(runtimeRegression, /replacement waits for extension shutdown/);
  assert.match(runtimeRegression, /late SDK settlement cannot finish/);
});
