import assert from "node:assert/strict";
import test from "node:test";

// 共享 SSE 推动器测试：fetch 打桩为"可编程 SSE 流"。核心保证：
// 1) 多订阅者共享一条连接；2) 事件推送分发给所有订阅者；
// 3) 单个退订后连接存活，最后退订即断开；4) 断线按退避重连且携带
// lastSeq 游标续传（?since=）。重连退避 5s，相关用例需等待。

const { subscribePeerActivity } = await import("./peer-activity-poller.ts");

const sseBlock = (payload) => `data: ${JSON.stringify(payload)}\n\n`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 可编程 fetch：暴露流控制器，支持计数/收集 URL/失败注入。 */
function makeHarness() {
  const state = { count: 0, urls: [], controllers: [], failNext: 0 };
  const fakeFetch = async (url) => {
    state.count += 1;
    state.urls.push(url);
    if (state.failNext > 0) {
      state.failNext -= 1;
      throw new Error("ECONNREFUSED");
    }
    let controller;
    const stream = new ReadableStream({ start(c) { controller = c; } });
    state.controllers.push(controller);
    return { ok: true, status: 200, body: stream };
  };
  return { state, fakeFetch };
}

test("multiple subscribers share one SSE connection and both receive pushed events", async () => {
  const h = makeHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = h.fakeFetch;
  try {
    const receivedA = [];
    const receivedB = [];
    const subA = subscribePeerActivity({ id: "peer-x", url: "http://10.0.0.1:30141" }, (event) => receivedA.push(event));
    const subB = subscribePeerActivity({ id: "peer-x", url: "http://10.0.0.1:30141/" }, (event) => receivedB.push(event));
    await sleep(50);

    assert.equal(h.state.count, 1, "second subscriber must not open its own SSE connection");

    h.state.controllers[0].enqueue(new TextEncoder().encode(
      sseBlock({ seq: 1, at: 1, kind: "run", runId: "r1", status: "started" }) +
      sseBlock({ seq: 2, at: 2, kind: "run", runId: "r1", status: "completed" }),
    ));
    await sleep(30);

    assert.equal(receivedA.length, 2, "subscriber A receives pushed events");
    assert.equal(receivedB.length, 2, "subscriber B receives pushed events");
    assert.equal(receivedA[1].status, "completed");

    subA.unsubscribe();
    subB.unsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("connection survives one unsubscribe and stops after the last one", async () => {
  const h = makeHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = h.fakeFetch;
  try {
    const received = [];
    const subA = subscribePeerActivity({ id: "peer-y", url: "http://10.0.0.2:30141" }, (event) => received.push(event));
    const subB = subscribePeerActivity({ id: "peer-y", url: "http://10.0.0.2:30141" }, (event) => received.push(event));
    await sleep(50);
    const controller = h.state.controllers[0];
    assert.ok(controller, "poller should have an open stream");

    subA.unsubscribe();
    controller.enqueue(new TextEncoder().encode(sseBlock({ seq: 3, at: 3, kind: "run", runId: "r2", status: "started" })));
    await sleep(30);
    assert.ok(received.length >= 1, "live subscriber still receives after sibling unsubscribes");

    subB.unsubscribe();
    await sleep(50);
    const frozen = received.length;
    controller.enqueue(new TextEncoder().encode(sseBlock({ seq: 4, at: 4, kind: "run", runId: "r3", status: "started" })));
    await sleep(50);
    assert.equal(received.length, frozen, "no delivery after last subscriber leaves");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("reconnect after disconnect carries lastSeq for catch-up (?since=)", async () => {
  const h = makeHarness();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = h.fakeFetch;
  try {
    const received = [];
    const subA = subscribePeerActivity({ id: "peer-z", url: "http://10.0.0.3:30141" }, (event) => received.push(event));
    await sleep(50);

    h.state.controllers[0].enqueue(new TextEncoder().encode(sseBlock({ seq: 5, at: 5, kind: "run", runId: "big", status: "started" })));
    await sleep(30);
    assert.equal(received.length, 1, "initial event received (seq advanced to 5)");

    // 对端断开（关闭流）→ read 收尾 → runLoop 退避重连。
    h.state.controllers[0].close();
    await sleep(6_000); // 5s 退避 + jitter

    assert.ok(h.state.count >= 2, "poller reconnects after disconnect");
    assert.equal(h.state.urls[0].includes("since=0"), true, "initial connection uses since=0");
    assert.equal(h.state.urls[h.state.urls.length - 1].includes("since=5"), true, "reconnect carries lastSeq for catch-up");

    subA.unsubscribe();
  } finally {
    globalThis.fetch = originalFetch;
  }
});
