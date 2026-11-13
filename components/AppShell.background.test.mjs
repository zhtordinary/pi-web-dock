import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
const source = await readFile(new URL("./AppShell.tsx", import.meta.url), "utf8");
const file = ts.createSourceFile("AppShell.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function callback(name, scope) {
  function find(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) return node.initializer;
    return ts.forEachChild(node, find);
  }
  const node = find(file);
  assert.ok(node, name);
  const code = ts.transpileModule(`(${node.getText(file)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return new Function("scope", `with(scope) { return ${code}; }`)(scope);
}
function harness() {
  const claims = new Set(), sounds = [], notifications = [], refreshed = [];
  const scope = {
    useCallback: fn => fn,
    setRefreshKey: () => refreshed.push("list"), setExplorerRefreshKey: () => refreshed.push("files"),
    setRemoteSession: update => { scope.remote = update(scope.remote); },
    remote: { device: { id: "other-peer" }, sessionInfo: { id: "session-1" }, sessionRunning: true },
    refreshTopBarSessionMetadata: () => refreshed.push("metadata"),
    isSubagentSession: session => session?.relation?.kind === "subagent",
    statusSoundRequestId: (id, kind, run) => run ? `status:${kind}:${id}:${run}` : "",
    claimSoundRequest: async key => { if (claims.has(key)) return false; claims.add(key); return true; },
    tryPlaySoundRequest: (key, play, eligible) => {
      if (!eligible() || claims.has(key)) return;
      claims.add(key); play();
    },
    canPlaySound: () => true,
    playDoneSound: () => sounds.push("done"), playErrorSound: () => sounds.push("error"),
    shouldShowBrowserNotification: () => true,
    sessionCompletionTag: ({ deviceId, sessionId, runId }) => deviceId && sessionId && runId
      ? `pi-session-complete:${deviceId}:${sessionId}:${runId}` : undefined,
    deliverSessionNotification: notification => notifications.push(notification),
    translate: key => key,
  };
  return { scope, claims, sounds, notifications, refreshed, complete: callback("handleSessionRunComplete", scope) };
}
function item(status = "completed", overrides = {}) {
  return { device: { id: "remote-peer", name: "remote" }, session: { id: "session-1", name: "Actual completed session" },
    latestRun: { runId: "run-1", status }, ...overrides };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test("background completion uses actual peer/session/run and shares the foreground sound claim", async () => {
  const h = harness();
  h.claims.add("status:done:session-1:run-1"); // Foreground prompt_done already played.
  h.complete(item()); h.complete(item()); await flush();
  assert.deepEqual(h.sounds, []);
  assert.equal(h.notifications.length, 1);
  assert.equal(h.notifications[0].targetSession.id, "session-1");
  assert.equal(h.notifications[0].targetDevice.id, "remote-peer");
  assert.equal(h.notifications[0].title, "Actual completed session");
  assert.equal(h.notifications[0].tag, "pi-session-complete:remote-peer:session-1:run-1");
  assert.deepEqual(h.notifications[0].identity, { deviceId: "remote-peer", sessionId: "session-1", runId: "run-1" });
  assert.equal(h.scope.remote.sessionRunning, true, "completion on another peer cannot clear this slot");
  assert.ok(h.refreshed.includes("list"));
  assert.ok(h.refreshed.includes("files"));
  h.scope.remote.device.id = "remote-peer";
  h.complete(item("completed", { latestRun: { status: "completed", runId: "run-2" } })); await flush();
  assert.equal(h.scope.remote.sessionRunning, false);
  assert.deepEqual(h.sounds, ["done"]);
  assert.equal(h.notifications.length, 2, "a later run has a separate claim");
});

test("subagent and unattended failure remain silent; ordinary errors do not send success notifications", async () => {
  const h = harness();
  h.complete(item("completed", { session: { id: "child", relation: { kind: "subagent" } } }));
  h.complete(item("failed", { unattended: true })); await flush();
  assert.deepEqual(h.sounds, []);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.claims.size, 0);
  h.complete(item("failed")); await flush();
  assert.deepEqual(h.sounds, ["error"]);
  assert.deepEqual(h.notifications, []);
});

test("foreground end retains refresh only, leaving completion notifications to the registry", () => {
  const h = harness();
  callback("handleAgentEnd", h.scope)();
  assert.deepEqual(h.refreshed, ["list", "files", "metadata"]);
  assert.deepEqual(h.notifications, []);
  assert.equal(h.claims.size, 0);
});

test("notification URL and click preserve remote ownership instead of opening a local ID collision", () => {
  const notifications = [], local = [], remote = [];
  const scope = {
    useCallback: fn => fn, localDeviceId: "local", URLSearchParams,
    window: { Notification: {}, focus: () => {} }, Notification: { permission: "granted" },
    showBrowserNotification: options => notifications.push(options),
    handleSelectSession: session => local.push(session), openRemoteSession: (...args) => remote.push(args),
  };
  const deliver = callback("deliverSessionNotification", scope);
  const completed = item();
  deliver({ targetSession: completed.session, targetDevice: completed.device, title: "done", body: "done" });
  assert.equal(new URL(notifications[0].sessionUrl, "http://reader").searchParams.get("device"), "remote-peer");
  notifications[0].onClick();
  assert.equal(remote[0][0].id, "remote-peer");
  assert.equal(remote[0][1], "session-1");
  assert.deepEqual(local, []);
  deliver({ targetSession: completed.session, targetDevice: { id: "local" }, title: "done", body: "done" });
  notifications[1].onClick();
  assert.equal(local[0].id, "session-1");
  assert.equal(new URL(notifications[1].sessionUrl, "http://reader").searchParams.has("device"), false);
});


test("late foreground end/error callbacks cannot clear a same-ID session on another peer", () => {
  const h = harness();
  const end = callback("handleAgentEnd", h.scope);
  const error = callback("handleRemoteAgentError", h.scope);
  end("session-1", "remote-peer");
  error("session-1", "remote-peer");
  assert.equal(h.scope.remote.sessionRunning, true);
  end("session-1", "other-peer");
  assert.equal(h.scope.remote.sessionRunning, false);
});
