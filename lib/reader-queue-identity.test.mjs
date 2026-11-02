import assert from "node:assert/strict";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true, moduleCache: false });
const { ReaderQueueIdentity } = await jiti.import("./reader-queue-identity.ts");

const message = (text, data) => ({ role: "user", timestamp: 1, content: [{ type: "text", text }, ...(data ? [{ type: "image", data, mimeType: "image/png" }] : [])] });
function fixture(mode = "one-at-a-time") {
  const agent = new Agent({ steeringMode: mode, followUpMode: mode, streamFn: () => { throw new Error("No model calls in queue tests"); } });
  const events = []; let id = 0; let tracker;
  tracker = new ReaderQueueIdentity(agent, "boot", () => events.push(tracker.snapshot()), () => `item-${++id}`);
  return { agent, tracker, events };
}

test("pinned SDK FIFO consumption retains the second same-text image identity", () => {
  const { agent, tracker, events } = fixture();
  const first = message("same", "AAAA"), second = message("same", "BBBB");
  agent.steer(first); agent.steer(second);
  const queued = tracker.snapshot();
  assert.equal(queued.steering.length, 2);
  assert.notEqual(queued.steering[0].itemId, queued.steering[1].itemId);
  assert.equal("images" in queued.steering[0], false, "SSE summaries must not retransmit image bytes");
  assert.deepEqual(agent.steeringQueue.drain(), [first]);
  const recalled = tracker.snapshot([], true);
  assert.equal(recalled.steering[0].itemId, queued.steering[1].itemId);
  assert.equal(recalled.steering[0].images[0].data, "BBBB");
  assert.ok(recalled.queueRevision > queued.queueRevision);
  assert.equal(events.at(-1).steering.length, 1);
  tracker.dispose();
});

test("reused message objects still have per-enqueue occurrence identities", () => {
  const { agent, tracker } = fixture(); const same = message("same", "AAAA");
  agent.followUp(same); agent.followUp(same);
  const before = tracker.snapshot(); agent.followUpQueue.drain();
  assert.notEqual(before.followUp[0].itemId, before.followUp[1].itemId);
  assert.equal(tracker.snapshot().followUp[0].itemId, before.followUp[1].itemId);
  agent.followUp(same);
  assert.notEqual(tracker.snapshot().followUp[1].itemId, before.followUp[0].itemId);
  tracker.dispose();
});

test("all-mode drain, image-only queues, empty polling and clear preserve SDK semantics", () => {
  const { agent, tracker, events } = fixture("all");
  agent.steer(message("", "AAAA")); agent.steer(message("", "BBBB"));
  const count = events.length; const revision = tracker.snapshot().queueRevision;
  assert.equal(agent.followUpQueue.drain().length, 0);
  assert.equal(events.length, count);
  assert.equal(tracker.snapshot().queueRevision, revision);
  assert.equal(agent.steeringQueue.drain().length, 2);
  assert.deepEqual(tracker.snapshot().steering, []);
  agent.steer(message("a")); agent.followUp(message("b")); agent.clearAllQueues();
  assert.deepEqual(tracker.snapshot().steering, []); assert.deepEqual(tracker.snapshot().followUp, []);
  tracker.dispose();
});

test("deferred compaction prompts retain identity, order and authoritative images", () => {
  const { agent, tracker } = fixture(); agent.steer(message("sdk", "AAAA"));
  const deferred = [{ message: "same", images: [{ data: "BBBB", mimeType: "image/png" }], streamingBehavior: "steer" }, { message: "", images: [{ data: "CCCC", mimeType: "image/png" }], streamingBehavior: "followUp" }];
  const first = tracker.snapshot(deferred); const next = tracker.snapshot(deferred, true);
  assert.equal(first.queueRevision, next.queueRevision);
  assert.equal(first.steering[1].itemId, next.steering[1].itemId);
  assert.deepEqual(next.steering.map(item => item.text), ["sdk", "same"]);
  assert.equal(next.followUp[0].images[0].data, "CCCC"); tracker.dispose();
});

test("unsupported or externally mutated SDK queues fail instead of guessing by text", () => {
  assert.throws(() => new ReaderQueueIdentity({}, "boot", () => {}), /pinned SDK/);
  const { agent, tracker } = fixture(); agent.steeringQueue.messages.push(message("outside"));
  assert.throws(() => tracker.snapshot(), /pinned SDK/); tracker.dispose();
});

test("disposal restores SDK methods without changing queued messages", () => {
  const agent = new Agent({ streamFn: () => { throw new Error("No model calls in queue tests"); } }); const enqueue = agent.steeringQueue.enqueue; const drain = agent.steeringQueue.drain;
  const tracker = new ReaderQueueIdentity(agent, "boot", () => {}); const item = message("queued"); agent.steer(item); tracker.dispose();
  assert.equal(agent.steeringQueue.enqueue, enqueue); assert.equal(agent.steeringQueue.drain, drain);
  assert.deepEqual(agent.steeringQueue.drain(), [item]);
});

test("exact native peer retraction preserves the remaining queue identities", () => {
 const {agent,tracker}=fixture(); const peer={role:'custom',customType:'pi-web:session-peer',content:'work',details:{messageId:'peer'}};
 agent.followUp(peer);agent.followUp(peer);const before=tracker.snapshot();
 assert.equal(tracker.removeExact('followUp',peer),true);
 const after=tracker.snapshot();assert.equal(after.followUp.length,1);assert.equal(after.followUp[0].itemId,before.followUp[1].itemId);
 assert.ok(after.queueRevision>before.queueRevision);assert.equal(after.followUp[0].role,'custom');
 assert.deepEqual(agent.followUpQueue.drain(),[peer]);assert.equal(tracker.snapshot().followUp.length,0);tracker.dispose();
});

test("deferred native peer messages retain custom identity and cannot become recalled user drafts", async () => {
 const {tracker}=fixture();const {assertUserQueueRecall}=await jiti.import('./queued-draft.ts');
 const peer={kind:'peer',delivery:'steer',message:{customType:'pi-web:session-peer',content:'work',display:true,details:{messageId:'peer'}}};
 const first=tracker.snapshot([peer]);const again=tracker.snapshot([peer]);
 assert.equal(first.steering[0].role,'custom');assert.equal(first.steering[0].customType,'pi-web:session-peer');assert.equal(first.steering[0].text,'work');
 assert.equal(first.steering[0].itemId,again.steering[0].itemId);assert.throws(()=>assertUserQueueRecall(first));tracker.dispose();
});
