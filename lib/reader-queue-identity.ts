import { randomUUID } from "node:crypto";
import type { QueuedDraftMessage, QueuedDraftState } from "./queued-draft";

type QueueKind = "steering" | "followUp";
type CoreQueue = {
  messages: unknown[];
  enqueue(message: unknown): unknown;
  drain(): unknown[];
  clear(): unknown;
};
type QueueEntry = { itemId: string; message: unknown };
export type DeferredQueueInput = {
  kind?: "prompt";
  message: string;
  images?: Array<{ data: string; mimeType: string }>;
  streamingBehavior: "steer" | "followUp";
} | { kind: "peer"; message: {customType: string; content: string; display: boolean; details: unknown}; delivery?: "steer" | "follow_up"; };

function contractError(): Error {
  return Object.assign(new Error("Reader queue identity requires the pinned SDK core enqueue/drain/clear contract"), { code: "queue_identity_unavailable" });
}

function queueItem(entry: QueueEntry, includeImages: boolean): QueuedDraftMessage {
  const message = entry.message as { role?: unknown; customType?: unknown; content?: unknown; message?: unknown; images?: unknown } | null;
  const role = typeof message?.role === "string" ? message.role : typeof message?.message === "string" ? "user" : "unknown";
  const customType = typeof message?.customType === "string" ? message.customType : undefined;
  const content = message?.content ?? message?.message;
  const blocks = Array.isArray(content) ? content : [];
  const text = typeof content === "string" ? content : blocks
    .filter(block => block && block.type === "text" && typeof block.text === "string")
    .map(block => block.text).join("\n");
  const rawImages = Array.isArray(message?.images) ? message.images : blocks.filter(block => block?.type === "image");
  const images = rawImages.filter(image => image && typeof image.data === "string" && typeof image.mimeType === "string")
    .map(image => ({ data: image.data as string, mimeType: image.mimeType as string }));
  return { itemId: entry.itemId, role, ...(customType !== undefined ? { customType } : {}), text, hasImages: images.length > 0, imageCount: images.length, ...(includeImages && images.length ? { images } : {}) };
}

/**
 * Adapter for the pinned pi-agent-core PendingMessageQueue contract.
 * Each enqueue gets its own occurrence ID, even if the same object is enqueued
 * twice. drain returns/removes a FIFO prefix (one or all); clear removes all.
 * Neither AgentSession's pre-enqueue text event nor its text mirror is truth.
 */
export class ReaderQueueIdentity {
  private entries: Record<QueueKind, QueueEntry[]> = { steering: [], followUp: [] };
  private queues: Record<QueueKind, CoreQueue>;
  private restores: Array<() => void> = [];
  private deferredIds = new WeakMap<object, string>();
  private previousIdentity = "";
  private revision = 0;
  private failed = false;

  constructor(agent: unknown, private bootId: string, private onMutation: () => void, private newId: () => string = randomUUID) {
    const source = agent as { steeringQueue?: CoreQueue; followUpQueue?: CoreQueue } | null;
    this.queues = { steering: source?.steeringQueue as CoreQueue, followUp: source?.followUpQueue as CoreQueue };
    try {
      for (const kind of ["steering", "followUp"] as const) {
        const queue = this.queues[kind];
        if (!queue || !Array.isArray(queue.messages)
          || typeof queue.enqueue !== "function" || typeof queue.drain !== "function" || typeof queue.clear !== "function") throw contractError();
        this.entries[kind] = queue.messages.map(message => ({ itemId: this.newId(), message }));
        for (const method of ["enqueue", "drain", "clear"] as const) {
          const original = queue[method];
          const descriptor = Object.getOwnPropertyDescriptor(queue, method);
          const wrapped = (...args: unknown[]) => {
            this.assertMatches(kind);
            const before = this.entries[kind];
            const result = Reflect.apply(original, queue, args);
            if (method === "enqueue") this.entries[kind] = [...before, { itemId: this.newId(), message: args[0] }];
            else if (method === "clear") this.entries[kind] = [];
            else {
              if (!Array.isArray(result) || result.length > before.length
                || result.some((message, index) => message !== before[index].message)) this.fail();
              this.entries[kind] = before.slice(result.length);
            }
            this.assertMatches(kind);
            // Notify only real mutations. SDK empty polls must not churn revisions.
            if (method === "enqueue" || this.entries[kind].length !== before.length) this.onMutation();
            return result;
          };
          Object.defineProperty(queue, method, { value: wrapped, configurable: true, writable: true });
          this.restores.push(() => {
            if (queue[method] !== wrapped) return;
            if (descriptor) Object.defineProperty(queue, method, descriptor);
            else Reflect.deleteProperty(queue, method);
          });
        }
      }
    } catch (error) {
      this.dispose();
      throw error;
    }
  }

  private fail(): never {
    this.failed = true;
    throw contractError();
  }

  private assertMatches(kind: QueueKind): void {
    const messages = this.queues[kind].messages;
    if (this.failed || !Array.isArray(messages) || messages.length !== this.entries[kind].length
      || messages.some((message, index) => message !== this.entries[kind][index].message)) this.fail();
  }

  removeExact(kind: QueueKind, message: unknown): boolean {
    this.assertMatches(kind);
    const index = this.entries[kind].findIndex(entry => entry.message === message);
    if (index < 0) return false;
    this.queues[kind].messages.splice(index, 1);
    this.entries[kind].splice(index, 1);
    this.assertMatches(kind);
    this.onMutation();
    return true;
  }

  snapshot(deferred: readonly DeferredQueueInput[] = [], includeImages = false): QueuedDraftState {
    this.assertMatches("steering");
    this.assertMatches("followUp");
    const entries = { steering: [...this.entries.steering], followUp: [...this.entries.followUp] };
    for (const prompt of deferred) {
      let itemId = this.deferredIds.get(prompt);
      if (!itemId) { itemId = this.newId(); this.deferredIds.set(prompt, itemId); }
      const steering = prompt.kind === "peer" ? prompt.delivery === "steer" : prompt.streamingBehavior === "steer";
      entries[steering ? "steering" : "followUp"].push({ itemId, message: prompt.kind === "peer" ? { ...prompt.message, role: "custom" } : prompt });
    }
    const identity = JSON.stringify([entries.steering.map(item => item.itemId), entries.followUp.map(item => item.itemId)]);
    if (identity !== this.previousIdentity) { this.previousIdentity = identity; this.revision += 1; }
    return {
      bootId: this.bootId,
      queueRevision: this.revision,
      steering: entries.steering.map(entry => queueItem(entry, includeImages)),
      followUp: entries.followUp.map(entry => queueItem(entry, includeImages)),
    };
  }

  dispose(): void {
    for (const restore of this.restores.splice(0).reverse()) restore();
  }
}
