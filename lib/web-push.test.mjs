import assert from "node:assert/strict";
import test from "node:test";

async function loadSubject() {
  const { createJiti } = await import("jiti");
  return createJiti(import.meta.url).import("./web-push.ts");
}

const { createWebPushNotifier, localeText } = await loadSubject();

function makeEnvironment({
  initialState = null,
  sessionNames = new Map([["session-1", "My session"]]),
  errorFor = () => null,
} = {}) {
  let state = initialState;
  let saved = null;
  const sent = [];

  const env = {
    send: async (subscription, payload, vapidKeys) => {
      sent.push({ subscription, payload, vapidKeys });
      const error = errorFor(subscription);
      if (error) throw error;
    },
    loadState: () => state,
    saveState: (s) => { saved = s; },
    generateVapidKeys: () => ({ publicKey: "pub-key", privateKey: "priv-key" }),
    listSessionNames: async () => sessionNames,
  };

  return {
    notifier: createWebPushNotifier(env),
    sent,
    getSaved: () => saved,
  };
}

const SUB_EN = {
  endpoint: "https://push.example.com/en",
  keys: { p256dh: "p256dh-en", auth: "auth-en" },
  locale: "en",
};
const SUB_ZH = {
  endpoint: "https://push.example.com/zh",
  keys: { p256dh: "p256dh-zh", auth: "auth-zh" },
  locale: "zh-CN",
};

test("generates and persists VAPID keys when no state exists", () => {
  const { notifier, getSaved } = makeEnvironment();

  assert.equal(notifier.getVapidPublicKey(), "pub-key");
  assert.deepEqual(getSaved(), {
    vapidKeys: { publicKey: "pub-key", privateKey: "priv-key" },
    subscriptions: [],
  });
});

test("reuses persisted VAPID keys", () => {
  const { notifier } = makeEnvironment({
    initialState: {
      vapidKeys: { publicKey: "persisted-pub", privateKey: "persisted-priv" },
      subscriptions: [],
    },
  });

  assert.equal(notifier.getVapidPublicKey(), "persisted-pub");
});

test("addSubscription upserts by endpoint and persists", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);
  notifier.addSubscription({ ...SUB_EN, locale: "zh-CN" });

  const saved = getSaved();
  assert.equal(saved.subscriptions.length, 2);
  const updated = saved.subscriptions.find((s) => s.endpoint === SUB_EN.endpoint);
  assert.equal(updated.locale, "zh-CN");
});

test("addSubscription persists even after getVapidPublicKey already saved", () => {
  const { notifier, getSaved } = makeEnvironment();

  notifier.getVapidPublicKey(); // first save
  notifier.addSubscription(SUB_EN);

  assert.equal(getSaved().subscriptions.length, 1);
});

test("notifySessionComplete sends localized payloads with a reliable completion identity", async () => {
  const { notifier, sent } = makeEnvironment();
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1", { deviceId: "device-1", runId: "run-1" });

  assert.equal(sent.length, 2);
  const en = sent.find((s) => s.subscription.endpoint === SUB_EN.endpoint);
  const zh = sent.find((s) => s.subscription.endpoint === SUB_ZH.endpoint);
  assert.deepEqual(JSON.parse(en.payload), {
    title: "My session",
    body: "Task finished.",
    url: "/?session=session-1&device=device-1",
    tag: "pi-session-complete:device-1:session-1:run-1",
    deviceId: "device-1",
    sessionId: "session-1",
    runId: "run-1",
  });
  assert.deepEqual(JSON.parse(zh.payload), {
    title: "My session",
    body: "任务已完成。",
    url: "/?session=session-1&device=device-1",
    tag: "pi-session-complete:device-1:session-1:run-1",
    deviceId: "device-1",
    sessionId: "session-1",
    runId: "run-1",
  });
});

test("notifySessionComplete leaves incomplete identity untagged", async () => {
  const { notifier, sent } = makeEnvironment({ sessionNames: new Map() });
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("unknown-session");

  assert.deepEqual(JSON.parse(sent[0].payload), {
    title: "任务完成",
    body: "任务已完成。",
    url: "/?session=unknown-session",
  });
});

test("notifySessionComplete prunes subscriptions dropped by the push service", async () => {
  const { notifier, sent, getSaved } = makeEnvironment({
    errorFor: (subscription) => subscription.endpoint === SUB_ZH.endpoint ? { statusCode: 410 } : null,
  });
  notifier.addSubscription(SUB_EN);
  notifier.addSubscription(SUB_ZH);

  await notifier.notifySessionComplete("session-1");

  assert.equal(sent.length, 2);
  const saved = getSaved();
  assert.deepEqual(saved.subscriptions.map((s) => s.endpoint), [SUB_EN.endpoint]);
});

test("localeText falls back to English for unknown locales", () => {
  assert.equal(localeText("zh-CN", "taskFinished"), "任务已完成。");
  assert.equal(localeText("ja", "taskFinished"), "Task finished.");
  assert.equal(localeText("en", "sessionComplete"), "Session complete");
});

test("push requests immediate delivery with a long TTL", async () => {
  const { PUSH_OPTIONS } = await loadSubject();

  // iOS may defer non-high-urgency pushes to an arbitrary later window.
  assert.equal(PUSH_OPTIONS.urgency, "high");
  assert.equal(PUSH_OPTIONS.TTL, 2419200);
});

test("vapidSubject defaults to a valid https URL, not mailto:localhost", async () => {
  const { vapidSubject } = await loadSubject();
  const subject = vapidSubject();
  assert.doesNotMatch(subject, /@localhost$/);
  assert.ok(subject.startsWith("https://") || subject.startsWith("mailto:"), subject);
});


test("removeSubscription deletes one endpoint and persists only when present", () => {
  const { notifier, getSaved } = makeEnvironment({ initialState: { vapidKeys: { publicKey: "pub", privateKey: "priv" }, subscriptions: [SUB_EN, SUB_ZH] } });
  assert.equal(notifier.removeSubscription(SUB_ZH.endpoint), true);
  assert.deepEqual(getSaved().subscriptions.map((item) => item.endpoint), [SUB_EN.endpoint]);
  assert.equal(notifier.removeSubscription("https://push.example.com/missing"), false);
});
