import assert from "node:assert/strict";
import test from "node:test";
import { AgentSession } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { AgentSessionWrapper } = await jiti.import("./rpc-manager.ts");
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function setup(t, handler = async () => {}) {
  let ui;
  const errors = [];
  const inner = {
    sessionId: "extension-ui-test",
    isStreaming: false, isCompacting: false, isBashRunning: false, isIdle: true,
    sessionManager: { getCwd: () => "/tmp" },
    agent: { state: {}, abort() {} },
    abortRetry() {}, abortCompaction() {}, abortBranchSummary() {}, dispose() {},
    // Use the SDK's actual command dispatch and idle-agent abort paths.
    prompt: AgentSession.prototype.prompt,
    _tryExecuteExtensionCommand: AgentSession.prototype._tryExecuteExtensionCommand,
    abort: AgentSession.prototype.abort,
    waitForIdle: AgentSession.prototype.waitForIdle,
    _extensionRunner: {
      getCommand: () => ({ handler: () => handler(ui) }),
      createCommandContext: () => ({}),
      emitError: (error) => errors.push(error),
    },
    extensionRunner: {},
  };
  const wrapper = new AgentSessionWrapper(inner);
  t.after(() => wrapper.destroy());
  ui = wrapper.createExtensionUiContext();
  const events = [];
  wrapper.onEvent((event) => events.push(event));
  return { wrapper, ui, events, errors };
}

for (const method of ["select", "confirm", "input", "editor", "custom"]) {
  test(`Stop unwinds a command waiting on ${method} and closes its UI`, async (t) => {
    let continued = false;
    let disposed = 0;
    const { wrapper, events, errors } = setup(t, async (ui) => {
      if (method === "custom") {
        await ui.custom(() => ({ render: () => ["Choose"], dispose: () => { disposed += 1; } }));
      } else {
        await ui[method]("Choose", method === "select" ? ["A", "B"] : "Details");
      }
      continued = true;
    });
    const sending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const request = events.find((event) => event.method === method);
    assert.ok(request);
    assert.equal(wrapper.isRunning(), true);

    await wrapper.send({ type: "abort" });
    await sending;
    await nextTurn();
    assert.equal(continued, false);
    assert.equal(wrapper.isRunning(), false);
    assert.equal(wrapper.pendingUiRequests.size, 0);
    assert.equal(wrapper.pendingUiResponses.size, 0);
    assert.equal(wrapper.activeCustomUis.size, 0);
    assert.equal(errors.length, 1);
    assert.match(errors[0].error, /cancelled by Stop/);
    assert.ok(events.some((event) => event.id === request.id && (event.type === "extension_ui_closed" || event.closed)));
    assert.ok(events.some((event) => event.type === "prompt_done"));
    assert.equal(disposed, method === "custom" ? 1 : 0);
    const replay = [];
    wrapper.onEvent((event) => replay.push(event))();
    assert.equal(replay.some((event) => event.id === request.id), false);

    // A later explicit command can ask again; answering still resumes it.
    const nextSending = wrapper.send({ type: "prompt", message: "/choose" });
    await nextTurn();
    const nextRequest = events.findLast((event) => event.method === method && !event.closed);
    assert.notEqual(nextRequest.id, request.id);
    if (method === "custom") wrapper.closeCustomUi(nextRequest.id, "A");
    else await wrapper.send({ type: "extension_ui_response", id: nextRequest.id, runtimeGeneration: nextRequest.runtimeGeneration, ...(method === "confirm" ? { confirmed: true } : { value: "A" }) });
    await nextSending;
    assert.equal(continued, true);
  });
}

test("normal cancel and caller abort keep UI defaults and notify all subscribers", async (t) => {
  const { wrapper, ui, events } = setup(t);
  const pending = ui.select("Choose", ["A"]);
  const request = events.at(-1);
  await wrapper.send({ type: "extension_ui_response", id: request.id, runtimeGeneration: request.runtimeGeneration, cancelled: true });
  assert.equal(await pending, undefined);
  assert.equal(events.at(-1).type, "extension_ui_closed");
  assert.equal(events.at(-1).id, request.id);
  assert.equal(events.at(-1).resolution, "cancelled");

  const controller = new AbortController();
  const confirm = ui.confirm("Confirm", "Continue?", { signal: controller.signal });
  controller.abort();
  assert.equal(await confirm, false);
  assert.equal(wrapper.pendingUiRequests.size, 0);
});

test("Stop cancels a custom UI factory that has not mounted yet", async (t) => {
  const { wrapper, ui, events } = setup(t);
  let finishFactory;
  let disposed = false;
  const pending = ui.custom(() => new Promise((resolve) => { finishFactory = resolve; }));
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await nextTurn();
  await wrapper.send({ type: "abort" });
  await rejected;
  finishFactory({ render: () => ["Late panel"], dispose: () => { disposed = true; } });
  await nextTurn();
  assert.equal(disposed, true);
  assert.equal(events.some((event) => event.method === "custom"), false);
  assert.equal(wrapper.activeCustomUis.size, 0);
  await assert.rejects(ui.select("Reopen after Stop", ["A"]), { name: "AbortError" });
});

test("Stop before custom UI initialization does not invoke the factory", async (t) => {
  const { wrapper, ui } = setup(t);
  let invoked = false;
  const pending = ui.custom(() => { invoked = true; return { render: () => [] }; });
  const rejected = assert.rejects(pending, { name: "AbortError" });
  await wrapper.send({ type: "abort" });
  await rejected;
  assert.equal(invoked, false);
});

test("authoritative UI snapshots and exact responses preserve manual-input flow", async t => {
  const {wrapper, ui} = setup(t);
  const snapshots = [];
  const unsubscribe = wrapper.subscribeUiRequests(snapshot => snapshots.push(snapshot));
  t.after(unsubscribe);
  const selected = ui.select("Review", ["Allow one reviewer", "Type a reply"]);
  let snapshot = wrapper.getPendingUiRequestsSnapshot();
  const request = snapshot.requests[0];
  assert.equal(request.responseSchema.allowFreeText, false);
  assert.equal(snapshots.at(-1).requests[0].id, request.id);
  const answer = { type: "extension_ui_response", id: request.id, runtimeGeneration: snapshot.runtimeGeneration, value: "Type a reply" };
  await assert.rejects(wrapper.send({...answer, value: "arbitrary"}), {code:"ui_response_invalid"});
  await assert.rejects(wrapper.send({...answer, confirmed:true}), {code:"ui_response_invalid"});
  await assert.rejects(wrapper.send({...answer, runtimeGeneration:"old"}), {code:"ui_generation_mismatch"});
  assert.equal((await wrapper.send(answer)).status, "accepted");
  assert.equal(await selected, "Type a reply");
  assert.equal((await wrapper.send(answer)).status, "replayed");
  await assert.rejects(wrapper.send({...answer,value:"Allow one reviewer"}), {code:"ui_request_conflict"});
  assert.equal(wrapper.getPendingUiRequestsSnapshot().requests.length,0);
  const typed = ui.input("Your reply");
  snapshot = wrapper.getPendingUiRequestsSnapshot();
  assert.equal(snapshot.requests[0].responseSchema.allowFreeText,true);
  await wrapper.send({type:"extension_ui_response",id:snapshot.requests[0].id,runtimeGeneration:snapshot.runtimeGeneration,value:"Use the existing reviewer; do not start another"});
  assert.equal(await typed,"Use the existing reviewer; do not start another");
});

test("expired and unknown UI IDs never succeed; snapshots are detached", async t => {
  const {wrapper,ui} = setup(t);
  const pending = ui.confirm("Expire","Details",{timeout:5});
  const snapshot = wrapper.getPendingUiRequestsSnapshot();
  const id = snapshot.requests[0].id;
  snapshot.requests[0].title="mutated";
  assert.equal(wrapper.getPendingUiRequestsSnapshot().requests[0].title,"Expire");
  await pending;
  await assert.rejects(wrapper.send({type:"extension_ui_response",id,runtimeGeneration:snapshot.runtimeGeneration,confirmed:true}),{code:"ui_request_expired"});
  await assert.rejects(wrapper.send({type:"extension_ui_response",id:"missing",runtimeGeneration:snapshot.runtimeGeneration,confirmed:true}),{code:"ui_request_unknown"});
});

test("event observers cannot rewrite the authoritative option set", async t => {
 const {wrapper,ui}=setup(t);
 const unsubscribe=wrapper.onEvent(event=>{if(event.method==='select')event.options.push('injected')});t.after(unsubscribe);
 const pending=ui.select('Exact options',['Only']);
 const snapshot=wrapper.getPendingUiRequestsSnapshot();const request=snapshot.requests[0];
 assert.deepEqual(request.options,['Only']);
 const replay=wrapper.onEvent(event=>{if(event.method==='select')event.options.push('replay-injected')});replay();
 assert.deepEqual(wrapper.getPendingUiRequestsSnapshot().requests[0].options,['Only']);
 await assert.rejects(wrapper.send({type:'extension_ui_response',id:request.id,runtimeGeneration:snapshot.runtimeGeneration,value:'injected'}),{code:'ui_response_invalid'});
 await wrapper.send({type:'extension_ui_response',id:request.id,runtimeGeneration:snapshot.runtimeGeneration,cancelled:true});await pending;
});
