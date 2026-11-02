import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// Shared storage models same-origin documents. Web Locks serializes claim
// read/check/write; tests below also exercise the unsupported fallback.
const store = new Map();
globalThis.window = {
  localStorage: {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => { store.set(key, value); },
  },
};
globalThis.localStorage = globalThis.window.localStorage;

const lockTails = new Map();
const locks = {
  request: async (name, callback) => {
    const previous = lockTails.get(name) ?? Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    lockTails.set(name, current);
    await previous;
    try {
      return await callback({ name });
    } finally {
      release();
      if (lockTails.get(name) === current) lockTails.delete(name);
    }
  },
};
Object.defineProperty(globalThis.navigator, "locks", { value: locks, configurable: true });

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
function renderAudio(useAudio) {
  let api;
  function Probe() {
    api = useAudio();
    return React.createElement("div");
  }
  renderToStaticMarkup(React.createElement(Probe));
  return api;
}

const audio = await import("./useAudio.ts");
const { shouldDeferSoundUntilUnlock, claimSoundRequest, statusSoundRequestId, tryPlaySoundRequest, waitSoundRequestId } = audio;
const freshAudio = () => import(`./useAudio.ts?fresh-${Date.now()}-${Math.random()}`);

test("does not defer a stale wait sound until keyboard unlock", () => {
  assert.equal(shouldDeferSoundUntilUnlock("wait", "suspended"), false);
  assert.equal(shouldDeferSoundUntilUnlock("done", "suspended"), true);
  assert.equal(shouldDeferSoundUntilUnlock("wait", "running"), false);
});

test("first occurrence claims and persists one intent", async () => {
  store.clear();
  const fresh = await freshAudio();
  const key = waitSoundRequestId("req-1111");
  assert.equal(await fresh.claimSoundRequest(key), true);
  assert.deepEqual(Object.keys(JSON.parse(store.get("pi-sound-claims") ?? "{}")), [key]);
});

test("replay of the same intent stays silent", async () => {
  store.clear();
  const fresh = await freshAudio();
  const key = waitSoundRequestId("req-2222");
  assert.equal(await fresh.claimSoundRequest(key), true);
  assert.equal(await fresh.claimSoundRequest(key), false);
  assert.equal(await fresh.claimSoundRequest(key), false);
});

test("a fresh document keeps the claim silent via shared storage", async () => {
  store.clear();
  const first = await freshAudio();
  const second = await freshAudio();
  const key = waitSoundRequestId("req-3333");
  assert.equal(await first.claimSoundRequest(key), true);
  assert.equal(await second.claimSoundRequest(key), false);
  assert.equal(await second.claimSoundRequest(waitSoundRequestId("req-4444")), true);
});

test("corrupt claim storage degrades to in-memory dedup", async () => {
  store.set("pi-sound-claims", "{not-json");
  const fresh = await freshAudio();
  const key = waitSoundRequestId("req-5555");
  assert.equal(await fresh.claimSoundRequest(key), true);
  assert.equal(await fresh.claimSoundRequest(key), false);
});

test("claim is consumed before playback to prevent cross-document duplicate", async () => {
  store.clear();
  const fresh = await freshAudio();
  let starts = 0;
  assert.equal(fresh.tryPlaySoundRequest(waitSoundRequestId("req-failed"), async () => {
    starts += 1;
    return false;
  }), true);
  await tick();
  await tick();
  assert.equal(starts, 1);
  assert.equal(fresh.tryPlaySoundRequest(waitSoundRequestId("req-failed"), async () => {
    starts += 1;
    return true;
  }), false);
});

test("Web Locks serialize two document claims for one intent", async () => {
  store.clear();
  const first = await freshAudio();
  const second = await freshAudio();
  const key = waitSoundRequestId("req-race");
  const results = await Promise.all([first.claimSoundRequest(key), second.claimSoundRequest(key)]);
  assert.deepEqual(results.sort(), [false, true]);
});

test("two documents start at most one playback for one intent", async () => {
  store.clear();
  const first = await freshAudio();
  const second = await freshAudio();
  let starts = 0;
  const key = waitSoundRequestId("req-play-race");
  assert.equal(first.tryPlaySoundRequest(key, async () => { starts += 1; return true; }), true);
  assert.equal(second.tryPlaySoundRequest(key, async () => { starts += 1; return true; }), true);
  await tick();
  await tick();
  await tick();
  assert.equal(starts, 1);
});

test("iframe claim accepts only the registered parent origin and source", async () => {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const listeners = [];
  const messages = [];
  const parent = {
    postMessage: (data, targetOrigin) => messages.push({ data, targetOrigin }),
  };
  const child = {
    localStorage: oldWindow.localStorage,
    parent,
    addEventListener: (type, listener) => { if (type === "message") listeners.push(listener); },
  };
  globalThis.window = child;
  globalThis.document = { referrer: "https://shell.example/monitor" };
  try {
    const fresh = await freshAudio();
    const pending = fresh.claimSoundRequest(waitSoundRequestId("req-iframe"));
    await tick();
    assert.equal(messages.length, 1);
    assert.equal(messages[0].targetOrigin, "https://shell.example");
    const request = messages[0].data;
    for (const event of [
      { data: { type: fresh.SOUND_CLAIM_RESPONSE_EVENT, nonce: request.nonce, claimed: true }, source: {}, origin: "https://shell.example" },
      { data: { type: fresh.SOUND_CLAIM_RESPONSE_EVENT, nonce: request.nonce, claimed: true }, source: parent, origin: "https://other.example" },
    ]) listeners.forEach((listener) => listener(event));
    listeners.forEach((listener) => listener({
      data: { type: fresh.SOUND_CLAIM_RESPONSE_EVENT, nonce: request.nonce, claimed: true },
      source: parent,
      origin: "https://shell.example",
    }));
    assert.equal(await pending, true);
  } finally {
    globalThis.window = oldWindow;
    if (oldDocument === undefined) delete globalThis.document;
    else globalThis.document = oldDocument;
  }
});

test("terminal keys require server run identity", () => {
  assert.equal(statusSoundRequestId("session-1", "done"), "");
  assert.equal(statusSoundRequestId("session-1", "done", "run-1"), "status:done:session-1:run-1");
});

test("claim store retains 501 intents without the old 500-entry eviction", async () => {
  store.clear();
  const fresh = await freshAudio();
  for (let index = 0; index <= 500; index += 1) {
    assert.equal(await fresh.claimSoundRequest(waitSoundRequestId(`req-${index}`)), true);
  }
  const replay = await freshAudio();
  assert.equal(await replay.claimSoundRequest(waitSoundRequestId("req-0")), false);
});

test("does not cache a failed decode and retries playback", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  let fetchCount = 0;
  let decodeCount = 0;
  let starts = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  class FakeAudioContext {
    state = "running";
    destination = {};
    decodeAudioData() {
      decodeCount += 1;
      return decodeCount === 1 ? Promise.reject(new Error("synthetic decode failure")) : Promise.resolve({});
    }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  try {
    const fresh = await import(`./useAudio.ts?decode-retry-${Date.now()}-${Math.random()}`);
    const api = renderAudio(fresh.useAudio);
    assert.equal(await api.playDoneSound(), true);
    assert.equal(fetchCount, 2);
    assert.equal(starts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("keeps completion sound pending after resume rejection until unlock succeeds", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  let fetchCount = 0;
  let resumeCalls = 0;
  let starts = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  class FakeAudioContext {
    static latest;
    state = "suspended";
    destination = {};
    constructor() { FakeAudioContext.latest = this; }
    resume() {
      resumeCalls += 1;
      if (resumeCalls === 1) return Promise.reject(new Error("synthetic autoplay rejection"));
      this.state = "running";
      return Promise.resolve();
    }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  try {
    const fresh = await import(`./useAudio.ts?unlock-retry-${Date.now()}-${Math.random()}`);
    const api = renderAudio(fresh.useAudio);
    const pending = api.playDoneSound();
    await tick();
    assert.equal(resumeCalls, 1);
    assert.equal(starts, 0);
    api.unlockAudio();
    assert.equal(await pending, true);
    assert.equal(FakeAudioContext.latest.state, "running");
    assert.equal(resumeCalls, 2);
    assert.equal(fetchCount, 1);
    assert.equal(starts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("audio hook instances play after persisted sound preference is enabled", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  let starts = 0;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  class FakeAudioContext {
    state = "running";
    destination = {};
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  store.set("pi-sound-enabled", "false");
  try {
    const fresh = await import(`./useAudio.ts?toggle-sync-${Date.now()}-${Math.random()}`);
    const first = renderAudio(fresh.useAudio);
    const second = renderAudio(fresh.useAudio);
    first.onSoundToggle();
    assert.equal(await second.playWaitSound(), true);
    assert.equal(starts, 1);
  } finally {
    store.clear();
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("does not merge separate suspended intents beyond the sound dedup window", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  const oldNow = Date.now;
  let now = 10_000;
  let resumeCalls = 0;
  let starts = 0;
  Date.now = () => now;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  class FakeAudioContext {
    state = "suspended";
    destination = {};
    resume() {
      resumeCalls += 1;
      if (resumeCalls === 1) return Promise.reject(new Error("synthetic autoplay rejection"));
      this.state = "running";
      return Promise.resolve();
    }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  store.clear();
  try {
    const fresh = await import(`./useAudio.ts?suspended-window-${Date.now()}-${Math.random()}`);
    const api = renderAudio(fresh.useAudio);
    const first = api.playDoneSound();
    await tick();
    now += 3_000;
    const second = api.playDoneSound();
    assert.notStrictEqual(first, second);
    api.unlockAudio();
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(starts, 2);
  } finally {
    Date.now = oldNow;
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("sound settings allow toggling individual status sounds", async () => {
  const store = new Map();
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  let starts = 0;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  class FakeAudioContext {
    state = "running";
    destination = {};
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  const oldWindow = globalThis.window;
  globalThis.window = {
    localStorage: {
      getItem(k) { return store.get(k) ?? null; },
      setItem(k, v) { store.set(k, String(v)); },
      removeItem(k) { store.delete(k); },
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
  };

  try {
    const fresh = await import(`./useAudio.ts?status-settings-${Date.now()}-${Math.random()}`);
    const api = renderAudio(fresh.useAudio);

    // Initial state: all enabled
    assert.equal(api.soundSettings.enabled, true);
    assert.equal(api.soundSettings.done, true);
    assert.equal(api.soundSettings.error, true);
    assert.equal(api.soundSettings.wait, true);

    // Disable done sound specifically
    api.updateSoundSettings({ done: false });
    assert.equal(fresh.readSoundSettings().done, false);
    assert.equal(await api.playDoneSound(), false);
    assert.equal(starts, 0);

    // Error and wait sounds still play
    assert.equal(await api.playErrorSound(), true);
    assert.equal(starts, 1);
    assert.equal(await api.playWaitSound(), true);
    assert.equal(starts, 2);

    // Preview sound plays even when done is disabled
    assert.equal(await api.playPreviewSound("done"), true);
    assert.equal(starts, 3);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
    if (oldWindow === undefined) delete globalThis.window;
    else globalThis.window = oldWindow;
  }
});


test("interrupted AudioContext resumes on unlock and flushes pending completion", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  let fetchCount = 0;
  let resumeCalls = 0;
  let starts = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) };
  };
  class FakeAudioContext {
    static latest;
    state = "interrupted";
    destination = {};
    constructor() { FakeAudioContext.latest = this; }
    resume() {
      resumeCalls += 1;
      if (resumeCalls === 1) return Promise.reject(new Error("synthetic interruption rejection"));
      this.state = "running";
      return Promise.resolve();
    }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start() { starts += 1; } };
    }
    createGain() {
      return { connect() {}, gain: { value: 0 } };
    }
  }
  globalThis.AudioContext = FakeAudioContext;
  try {
    const fresh = await import(`./useAudio.ts?interrupted-${Date.now()}-${Math.random()}`);
    assert.equal(fresh.shouldDeferSoundUntilUnlock("done", "interrupted"), true);
    assert.equal(fresh.shouldDeferSoundUntilUnlock("wait", "interrupted"), false);
    const api = renderAudio(fresh.useAudio);
    const pending = api.playDoneSound();
    await tick();
    assert.equal(resumeCalls, 1);
    assert.equal(starts, 0);
    api.unlockAudio();
    assert.equal(await pending, true);
    assert.equal(fetchCount, 1);
    assert.equal(starts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("claim eligibility rejects an audio-ineligible document before persistent claim", async () => {
  store.clear();
  const fresh = await freshAudio();
  let starts = 0;
  const key = waitSoundRequestId("req-ineligible");
  assert.equal(fresh.tryPlaySoundRequest(key, async () => { starts += 1; return true; }, () => false), false);
  await tick();
  assert.equal(starts, 0);
  assert.equal(await fresh.claimSoundRequest(key), true);
});

test("automatic sound eligibility follows running context and per-kind settings", async () => {
  const oldAudioContext = globalThis.AudioContext;
  class FakeAudioContext {
    state = "suspended";
    destination = {};
    resume() { this.state = "running"; return Promise.resolve(); }
  }
  globalThis.AudioContext = FakeAudioContext;
  store.clear();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    assert.equal(api.canPlaySound("done"), false);
    api.unlockAudio();
    await tick();
    assert.equal(api.canPlaySound("done"), true);
    api.updateSoundSettings({ done: false });
    assert.equal(api.canPlaySound("done"), false);
    assert.equal(api.canPlaySound("error"), true);
    api.updateSoundSettings({ enabled: false, done: true });
    assert.equal(api.canPlaySound("error"), false);
    api.updateSoundSettings({ enabled: true });
    assert.equal(api.canPlaySound("done"), true);
  } finally {
    store.clear();
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

test("fetch, body, and decode loads time out and late results cannot poison a retry", async () => {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  const oldSetTimeout = globalThis.setTimeout;
  const oldClearTimeout = globalThis.clearTimeout;
  const timers = [];
  const fetchResolvers = [];
  const bodyResolvers = [];
  const decodeResolvers = [];
  let stage = "fetch";
  let fetchCount = 0;
  let starts = 0;
  globalThis.setTimeout = (fn, ms, ...args) => {
    if (ms === 5_000) {
      const handle = { cancelled: false, fn: () => fn(...args) };
      timers.push(handle);
      return handle;
    }
    return oldSetTimeout(fn, ms, ...args);
  };
  globalThis.clearTimeout = (handle) => {
    if (handle && typeof handle === "object" && "cancelled" in handle) {
      handle.cancelled = true;
      return;
    }
    return oldClearTimeout(handle);
  };
  globalThis.fetch = () => {
    fetchCount += 1;
    if (stage === "fetch") return new Promise((resolve) => fetchResolvers.push(resolve));
    if (stage === "body") return Promise.resolve({ ok: true, arrayBuffer: () => new Promise((resolve) => bodyResolvers.push(resolve)) });
    return Promise.resolve({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  };
  class FakeAudioContext {
    state = "running";
    destination = {};
    decodeAudioData() {
      if (stage === "decode") return new Promise((resolve) => decodeResolvers.push(resolve));
      return Promise.resolve({});
    }
    createBufferSource() { return { connect() {}, start() { starts += 1; } }; }
    createGain() { return { connect() {}, gain: { value: 0 } }; }
  }
  globalThis.AudioContext = FakeAudioContext;
  const fire = async () => {
    const handle = timers.find((candidate) => !candidate.cancelled);
    assert.ok(handle, "expected an active audio load deadline");
    handle.cancelled = true;
    handle.fn();
    await tick();
  };
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);

    const fetchFirst = api.playPreviewSound("done");
    await tick();
    await fire();
    await tick();
    const fetchShared = api.playPreviewSound("done");
    await tick();
    assert.equal(fetchCount, 2);
    fetchResolvers[0]?.({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
    await tick();
    assert.equal(fetchCount, 2);
    await fire();
    await fire();
    assert.equal(await fetchFirst, false);
    assert.equal(await fetchShared, false);

    stage = "body";
    const bodyPlay = api.playPreviewSound("error");
    await tick();
    await fire();
    await fire();
    assert.equal(await bodyPlay, false);
    bodyResolvers.forEach((resolve) => resolve(new ArrayBuffer(8)));
    await tick();
    assert.equal(starts, 0);

    stage = "decode";
    const decodePlay = api.playPreviewSound("wait");
    await tick();
    await tick();
    await tick();
    assert.equal(decodeResolvers.length, 1);
    await fire();
    await tick();
    assert.equal(decodeResolvers.length, 2);
    await fire();
    assert.equal(await decodePlay, false);
    decodeResolvers.forEach((resolve) => resolve({}));
    await tick();

    stage = "success";
    const retry = api.playPreviewSound("wait");
    assert.equal(await retry, true);
    assert.equal(starts, 1);
  } finally {
    globalThis.fetch = oldFetch;
    globalThis.setTimeout = oldSetTimeout;
    globalThis.clearTimeout = oldClearTimeout;
    if (oldAudioContext === undefined) delete globalThis.AudioContext;
    else globalThis.AudioContext = oldAudioContext;
  }
});

// ---------------------------------------------------------------------------
// AudioContext lifecycle: the browser may take the context back at any time
// (device unplugged, system sleep, interruption). Status sounds must come back
// without a page reload.
// ---------------------------------------------------------------------------
function installLifecycleFakes() {
  const oldFetch = globalThis.fetch;
  const oldAudioContext = globalThis.AudioContext;
  const oldNow = Date.now;
  const instances = [];
  const policy = {
    resume(ctx) { ctx.setState("running"); return Promise.resolve(); },
    clock() { return performance.now() / 1000; },
  };
  class FakeAudioContext {
    state = "suspended";
    destination = {};
    closed = false;
    resumeCalls = 0;
    starts = 0;
    listeners = new Map();
    constructor() { instances.push(this); }
    get currentTime() { return policy.clock(this); }
    addEventListener(type, listener) {
      const registered = this.listeners.get(type) ?? [];
      registered.push(listener);
      this.listeners.set(type, registered);
    }
    fire(type) { for (const listener of this.listeners.get(type) ?? []) listener({ type }); }
    setState(state) { this.state = state; this.fire("statechange"); }
    resume() { this.resumeCalls += 1; return policy.resume(this); }
    close() { this.closed = true; this.setState("closed"); return Promise.resolve(); }
    decodeAudioData() { return Promise.resolve({}); }
    createBufferSource() {
      return { connect() {}, start: () => { this.starts += 1; } };
    }
    createGain() { return { connect() {}, gain: { value: 0 } }; }
  }
  globalThis.AudioContext = FakeAudioContext;
  globalThis.fetch = async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) });
  store.clear();
  return {
    instances,
    policy,
    setNow(value) { Date.now = () => value; },
    restore() {
      Date.now = oldNow;
      globalThis.fetch = oldFetch;
      if (oldAudioContext === undefined) delete globalThis.AudioContext;
      else globalThis.AudioContext = oldAudioContext;
      store.clear();
    },
  };
}

// A document that records the listeners the module installs, so a test can
// deliver gestures / visibility changes the way a browser would.
function installRecordingDocument({ parent, referrer = "", visibilityState = "visible" } = {}) {
  const oldWindow = globalThis.window;
  const oldDocument = globalThis.document;
  const windowListeners = [];
  const documentListeners = [];
  const doc = {
    referrer,
    visibilityState,
    addEventListener: (type, listener) => documentListeners.push({ type, listener }),
  };
  globalThis.window = {
    localStorage: oldWindow.localStorage,
    ...(parent ? { parent } : {}),
    addEventListener: (type, listener, options) => windowListeners.push({ type, listener, options }),
  };
  globalThis.document = doc;
  return {
    doc,
    windowListeners,
    fireWindow(type) { for (const entry of windowListeners) if (entry.type === type) entry.listener({ type }); },
    fireDocument(type) { for (const entry of documentListeners) if (entry.type === type) entry.listener({ type }); },
    restore() {
      globalThis.window = oldWindow;
      if (oldDocument === undefined) delete globalThis.document;
      else globalThis.document = oldDocument;
    },
  };
}

test("a context the browser suspended is taken back without any gesture", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    const ctx = fakes.instances[0];
    assert.equal(ctx.state, "running");
    assert.equal(api.canPlaySound("done"), true);
    // e.g. the output device disappeared while nobody was touching the page
    ctx.setState("suspended");
    await tick();
    assert.equal(ctx.resumeCalls, 2, "statechange resumed the context itself");
    assert.equal(ctx.state, "running");
    assert.equal(api.canPlaySound("done"), true);
    assert.equal(fakes.instances.length, 1, "a recoverable context is never replaced");
  } finally {
    fakes.restore();
  }
});

test("a wedged context is replaced inside a gesture and queued sounds follow it", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    const wedged = fakes.instances[0];
    const resumeDefault = fakes.policy.resume;
    // interrupted for good: every resume() is refused (InvalidStateError in browsers)
    fakes.policy.resume = (ctx) => (ctx === wedged ? Promise.reject(new Error("InvalidStateError")) : resumeDefault(ctx));
    wedged.setState("interrupted");
    assert.equal(api.canPlaySound("done"), false);
    const queued = api.playDoneSound();
    await tick();
    assert.equal(fakes.instances.length, 1, "no gesture, no replacement");
    assert.equal(wedged.starts, 0);

    api.unlockAudio(); // the user is back
    assert.equal(await queued, true, "the queued completion sound plays on the new context");
    assert.equal(fakes.instances.length, 2);
    const fresh2 = fakes.instances[1];
    assert.equal(wedged.closed, true);
    assert.equal(fresh2.state, "running");
    assert.equal(fresh2.starts, 1);
    assert.equal(wedged.starts, 0);
    assert.equal(api.canPlaySound("done"), true);
  } finally {
    fakes.restore();
  }
});

test("replacing the context is rate limited when the environment keeps refusing", async () => {
  const fakes = installLifecycleFakes();
  try {
    fakes.setNow(1_000_000);
    fakes.policy.resume = () => Promise.reject(new Error("InvalidStateError"));
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    assert.equal(fakes.instances.length, 2, "first refusal swaps once");
    api.unlockAudio();
    await tick();
    api.unlockAudio();
    await tick();
    assert.equal(fakes.instances.length, 2, "repeated refusals inside the cooldown do not thrash");
    fakes.setNow(1_011_000);
    api.unlockAudio();
    await tick();
    assert.equal(fakes.instances.length, 3, "after the cooldown a new attempt is allowed");
  } finally {
    fakes.restore();
  }
});

test("a context that reports running while its clock is frozen is replaced at the next gesture", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    const dead = fakes.instances[0];
    assert.equal(dead.state, "running");
    fakes.policy.clock = (ctx) => (ctx === dead ? 0 : performance.now() / 1000);
    api.unlockAudio();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fakes.instances.length, 2, "frozen clock means dead output");
    assert.equal(dead.closed, true);
    assert.equal(fakes.instances[1].state, "running");
  } finally {
    fakes.restore();
  }
});

test("a healthy running context is probed once, not on every keystroke", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    api.unlockAudio();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fakes.instances.length, 1, "advancing clock keeps the context");
    // Inside the probe interval a further gesture must not even look at the clock.
    let clockReads = 0;
    fakes.policy.clock = () => { clockReads += 1; return performance.now() / 1000; };
    for (let index = 0; index < 5; index += 1) api.unlockAudio();
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(clockReads, 0);
    assert.equal(fakes.instances.length, 1);
  } finally {
    fakes.restore();
  }
});

test("an audio device error swaps the context without waiting for a gesture", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    const first = fakes.instances[0];
    first.fire("error");
    await tick();
    assert.equal(fakes.instances.length, 2);
    assert.equal(first.closed, true);
    assert.equal(fakes.instances[1].state, "running");
    assert.equal(api.canPlaySound("done"), true);
  } finally {
    fakes.restore();
  }
});

test("a context the browser closed is recreated", async () => {
  const fakes = installLifecycleFakes();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    fakes.instances[0].setState("closed");
    await tick();
    assert.equal(fakes.instances.length, 2);
    assert.equal(fakes.instances[1].state, "running");
    assert.equal(api.canPlaySound("done"), true);
  } finally {
    fakes.restore();
  }
});

test("the page coming back (visible / focus / pageshow) resumes a suspended context", async () => {
  const fakes = installLifecycleFakes();
  const page = installRecordingDocument({ visibilityState: "visible" });
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    api.unlockAudio();
    await tick();
    const ctx = fakes.instances[0];
    assert.equal(ctx.resumeCalls, 1);
    // Lost the statechange entirely (e.g. the tab was frozen): only presence signals remain.
    ctx.state = "suspended";
    page.doc.visibilityState = "hidden";
    page.fireDocument("visibilitychange");
    await tick();
    assert.equal(ctx.resumeCalls, 1, "a hidden page does not try");
    page.doc.visibilityState = "visible";
    page.fireDocument("visibilitychange");
    await tick();
    assert.equal(ctx.resumeCalls, 2);
    assert.equal(ctx.state, "running");
    ctx.state = "interrupted";
    fakes.setNow(Date.now() + 5_000);
    page.fireWindow("focus");
    await tick();
    assert.equal(ctx.resumeCalls, 3, "interrupted contexts are retried on focus too");
    ctx.state = "suspended";
    fakes.setNow(Date.now() + 5_000);
    page.fireWindow("pageshow");
    await tick();
    assert.equal(ctx.resumeCalls, 4);
  } finally {
    page.restore();
    fakes.restore();
  }
});

test("gesture listeners are module level, capturing, and cover the iOS unlock events", async () => {
  const fakes = installLifecycleFakes();
  const page = installRecordingDocument();
  try {
    await freshAudio();
    const gestureTypes = new Set(page.windowListeners.filter((entry) => entry.options?.capture === true).map((entry) => entry.type));
    for (const type of ["pointerdown", "mousedown", "touchstart", "touchend", "keydown", "click"]) {
      assert.ok(gestureTypes.has(type), `${type} unlocks audio in the capture phase`);
    }
    // A gesture alone creates and unlocks the shared context; no component has to be mounted.
    page.fireWindow("keydown");
    await tick();
    assert.equal(fakes.instances.length, 1);
    assert.equal(fakes.instances[0].state, "running");
  } finally {
    page.restore();
    fakes.restore();
  }
});

test("gestures inside an embedded Reader are forwarded to the shell at most once a second", async () => {
  const fakes = installLifecycleFakes();
  const posted = [];
  const parent = { postMessage: (data, targetOrigin) => posted.push({ data, targetOrigin }) };
  const page = installRecordingDocument({ parent, referrer: "https://shell.example/monitor" });
  try {
    fakes.setNow(5_000_000);
    const fresh = await freshAudio();
    page.fireWindow("keydown");
    page.fireWindow("click");
    await tick();
    assert.equal(posted.length, 1, "burst of gestures is throttled");
    assert.deepEqual(posted[0].data, { type: fresh.SOUND_UNLOCK_EVENT });
    assert.equal(posted[0].targetOrigin, "https://shell.example");
    fakes.setNow(5_001_500);
    page.fireWindow("pointerdown");
    await tick();
    assert.equal(posted.length, 2);
  } finally {
    page.restore();
    fakes.restore();
  }
});

test("a top-level document unlocks itself and never posts unlock messages", async () => {
  const fakes = installLifecycleFakes();
  const page = installRecordingDocument({ referrer: "https://shell.example/" });
  const posted = [];
  globalThis.window.parent = globalThis.window; // a top-level window is its own parent
  globalThis.window.postMessage = (...args) => posted.push(args);
  try {
    await freshAudio();
    page.fireWindow("keydown");
    await tick();
    assert.equal(fakes.instances.length, 1, "the gesture unlocked this document's own context");
    assert.deepEqual(posted, []);
  } finally {
    page.restore();
    fakes.restore();
  }
});

test("every dropped status sound leaves its reason in the diagnostics log", async () => {
  const fakes = installLifecycleFakes();
  const page = installRecordingDocument();
  try {
    const fresh = await freshAudio();
    const api = renderAudio(fresh.useAudio);
    assert.equal(api.canPlaySound("done"), false);
    api.unlockAudio();
    await tick();
    assert.equal(api.canPlaySound("done"), true);
    const ctx = fakes.instances[0];
    ctx.state = "interrupted";
    assert.equal(api.canPlaySound("error"), false);
    // writeSoundSettings does not unlock; updateSoundSettings is a gesture entry and would resume the context.
    fresh.writeSoundSettings({ ...fresh.readSoundSettings(), wait: false });
    assert.equal(api.canPlaySound("wait"), false);
    const { state, log } = fresh.getAudioDiagnostics();
    assert.equal(state, "interrupted");
    const reasons = log.filter((entry) => entry.event === "dropped").map((entry) => entry.detail);
    assert.deepEqual(reasons, ["done:no-context", "error:interrupted", "wait:key-off"]);
    assert.ok(log.some((entry) => entry.event === "created"));
    assert.equal(globalThis.window.__piAudio, fresh.getAudioDiagnostics, "console entry point");
    assert.ok(log.length <= 64);
  } finally {
    page.restore();
    fakes.restore();
  }
});
