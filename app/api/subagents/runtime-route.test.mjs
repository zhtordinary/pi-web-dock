import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";
import { createJiti } from "jiti";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
const testAgentDir = await mkdtemp(join(tmpdir(), "pi-web-subagent-runtime-test-"));
process.env.PI_CODING_AGENT_DIR = testAgentDir;

after(async () => {
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  await rm(testAgentDir, { recursive: true, force: true });
});

const jiti = createJiti(import.meta.url, {
  alias: { "@": process.cwd() },
  interopDefault: true,
  moduleCache: false,
});
const { GET, POST } = await jiti.import("./[id]/route.ts");
const remoteHost = await jiti.import("../../../lib/remote-claude-host.ts");

const id = "subagent-route-test";
const context = { params: Promise.resolve({ id }) };

function request(body) {
  return new Request(`http://localhost/api/subagents/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function remotePackageForAgentDir(agentDir) {
  const candidates = [
    join(agentDir ?? "", "packages", "pi-remote-claude"),
    join(process.env.HOME ?? "", ".pi", "agent", "packages", "pi-remote-claude"),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, "lib", "host-contract.mjs")));
}

async function installRemoteRouteFixture(t) {
  const packageRoot = remotePackageForAgentDir(originalAgentDir);
  if (!packageRoot) {
    t.skip("pi-remote-claude host contract is not installed in this offline test root");
    return null;
  }
  const { mkdir, symlink } = await import("node:fs/promises");
  await mkdir(join(testAgentDir, "packages"), { recursive: true });
  const packageLink = join(testAgentDir, "packages", "pi-remote-claude");
  if (!existsSync(packageLink)) await symlink(packageRoot, packageLink, "dir");

  const previousRegistry = globalThis.__piSessions;
  const previousRuns = globalThis.__piSubagentRuns;
  const parentId = "remote-parent-route-test";
  const childId = "remote-child-route-test";
  const parentCwd = testAgentDir;
  const childCwd = testAgentDir;
  const makeManager = (sessionId, cwd) => ({
    getSessionId: () => sessionId,
    getCwd: () => cwd,
    getEntries: () => [],
  });
  const model = { provider: "claude-remote", id: "remote-model" };
  const modelRuntime = { getModels: () => [model] };
  const parentManager = makeManager(parentId, parentCwd);
  const childManager = makeManager(childId, childCwd);
  const steered = [];
  let aborts = 0;
  const parentInner = {
    sessionId: parentId,
    sessionManager: parentManager,
    model,
  };
  const childInner = {
    sessionId: childId,
    sessionManager: childManager,
    model,
    steer: async (message) => { steered.push(message); },
    abort: async () => { aborts += 1; },
  };
  const parent = {
    inner: parentInner,
    isAlive: () => true,
    isRunning: () => false,
    sessionFile: `/tmp/${parentId}.jsonl`,
  };
  const child = {
    inner: childInner,
    isAlive: () => true,
    isRunning: () => true,
    sessionFile: `/tmp/${childId}.jsonl`,
  };
  const run = {
    sessionId: childId,
    sessionPath: child.sessionFile,
    parentSessionId: parentId,
    parentToolCallId: "route-test-call",
    profile: "Explore",
    description: "Inspect",
    task: "Inspect",
    runInBackground: true,
    status: "running",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  globalThis.__piSessions = new Map([[parentId, parent], [childId, child]]);
  globalThis.__piSubagentRuns = new Map([[childId, { run }]]);
  const parentBinding = await remoteHost.installRemoteClaudeHost({
    hostIdentity: parentInner,
    sessionManager: parentManager,
    sessionId: parentId,
    cwd: parentCwd,
    agentDir: testAgentDir,
    activeTools: ["read", "Agent", "get_subagent_result", "steer_subagent"],
    modelRuntime,
    builtInEnabled: true,
    allowCancellation: true,
  });
  assert.ok(parentBinding);
  const childBinding = await remoteHost.installRemoteClaudeHost({
    hostIdentity: childInner,
    sessionManager: childManager,
    sessionId: childId,
    cwd: childCwd,
    agentDir: testAgentDir,
    activeTools: ["read"],
    modelRuntime,
    builtInEnabled: true,
    allowCancellation: true,
    parent: parentBinding,
  });
  assert.ok(childBinding);
  t.after(() => {
    remoteHost.revokeRemoteClaudeHost(childBinding);
    remoteHost.revokeRemoteClaudeHost(parentBinding);
    globalThis.__piSessions = previousRegistry;
    globalThis.__piSubagentRuns = previousRuns;
  });
  return { parentId, childId, run, steered, get aborts() { return aborts; } };
}

function installRunningSubagent(t) {
  const previousRegistry = globalThis.__piSessions;
  const previousRuns = globalThis.__piSubagentRuns;
  let running = true;
  const steered = [];
  let aborts = 0;
  const entries = [{
    type: "custom",
    customType: "pi-web:subagent",
    id: "meta",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    data: {
      version: 1,
      parentSessionId: "parent",
      parentSessionPath: "/tmp/parent.jsonl",
      parentToolCallId: "tool-call",
      profile: "Explore",
      description: "Inspect",
      task: "Inspect files",
      runInBackground: true,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
  }];
  globalThis.__piSubagentRuns = new Map();
  globalThis.__piSessions = new Map([[id, {
    isAlive: () => true,
    isRunning: () => running,
    sessionFile: `/tmp/${id}.jsonl`,
    inner: {
      sessionManager: { getEntries: () => entries },
      steer: async (message) => { steered.push(message); },
      abort: async () => { aborts += 1; },
    },
  }]]);
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    globalThis.__piSubagentRuns = previousRuns;
  });
  return {
    steered,
    get aborts() { return aborts; },
    stop() { running = false; },
  };
}

test("subagent route reads live state and accepts steer and abort actions", async (t) => {
  const state = installRunningSubagent(t);

  const getResponse = await GET(new Request(`http://localhost/api/subagents/${id}`), context);
  const getBody = await getResponse.json();
  assert.equal(getResponse.status, 200);
  assert.equal(getBody.run.status, "running");
  assert.equal(getBody.run.profile, "Explore");

  const steerResponse = await POST(request({ action: "steer", message: "  focus on tests  " }), context);
  assert.equal(steerResponse.status, 200);
  assert.deepEqual(state.steered, ["focus on tests"]);

  const abortResponse = await POST(request({ action: "abort" }), context);
  assert.equal(abortResponse.status, 200);
  assert.equal(state.aborts, 1);
});

test("subagent route forwards the trusted parent session to remote child operations", async (t) => {
  const state = await installRemoteRouteFixture(t);
  if (!state) return;
  const remoteContext = { params: Promise.resolve({ id: state.childId }) };

  let response = await GET(
    new Request(`http://localhost/api/subagents/${state.childId}?parentSessionId=${encodeURIComponent(state.parentId)}`),
    remoteContext,
  );
  assert.equal(response.status, 200);
  assert.equal((await response.json()).run.parentSessionId, state.parentId);

  response = await POST(new Request(`http://localhost/api/subagents/${state.childId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "steer", message: "  focus on tests  ", parentSessionId: state.parentId }),
  }), remoteContext);
  assert.equal(response.status, 200);
  assert.deepEqual(state.steered, ["focus on tests"]);

  response = await POST(new Request(`http://localhost/api/subagents/${state.childId}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "abort", parentSessionId: state.parentId }),
  }), remoteContext);
  assert.equal(response.status, 200);
  assert.equal(state.aborts, 1);

  response = await GET(
    new Request(`http://localhost/api/subagents/${state.childId}?parentSessionId=wrong-parent`),
    remoteContext,
  );
  assert.equal(response.status, 500);
  assert.match((await response.json()).error, /parent-not-owner/);
});

test("subagent route rejects malformed parent selectors before reaching RPC", async (t) => {
  installRunningSubagent(t);
  let response = await GET(
    new Request(`http://localhost/api/subagents/${id}?parentSessionId=`),
    context,
  );
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /non-empty string/);

  response = await POST(request({ action: "abort", parentSessionId: null }), context);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /non-empty string/);
});

test("subagent route validates actions and rejects commands after completion", async (t) => {
  const state = installRunningSubagent(t);

  let response = await POST(request({ action: "steer", message: "  " }), context);
  assert.equal(response.status, 400);
  response = await POST(request({ action: "unknown" }), context);
  assert.equal(response.status, 400);

  state.stop();
  response = await POST(request({ action: "abort" }), context);
  assert.equal(response.status, 409);
  assert.match((await response.json()).error, /not running/);
});

test("subagent GET returns 404 for an unknown session", async (t) => {
  const previousRegistry = globalThis.__piSessions;
  const previousRuns = globalThis.__piSubagentRuns;
  globalThis.__piSessions = new Map();
  globalThis.__piSubagentRuns = new Map();
  t.after(() => {
    globalThis.__piSessions = previousRegistry;
    globalThis.__piSubagentRuns = previousRuns;
  });

  const missingId = `missing-subagent-${Date.now()}`;
  const response = await GET(
    new Request(`http://localhost/api/subagents/${missingId}`),
    { params: Promise.resolve({ id: missingId }) },
  );
  assert.equal(response.status, 404);
});
