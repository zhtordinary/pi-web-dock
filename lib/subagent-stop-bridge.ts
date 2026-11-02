import { randomUUID } from "node:crypto";
import type { ExtensionAPI, InlineExtension } from "@earendil-works/pi-coding-agent";

/** Session-local adapter to pi-subagents' public control protocol; never prompts a model. */
export function createSubagentStopBridge() {
  let events: ExtensionAPI["events"] | undefined;
  const pending = new Set<(error: Error) => void>();
  const dispose = () => {
    events = undefined;
    for (const reject of [...pending]) reject(new Error("Background control runtime closed"));
  };
  const extension: InlineExtension = {
    name: "pi-web-subagent-stop", hidden: true,
    factory(pi) {
      events = pi.events;
      pi.on("session_shutdown", dispose);
    },
  };
  const stop = (runId: string): Promise<void> => new Promise((resolve, reject) => {
    if (!events) { reject(new Error("Background control runtime unavailable")); return; }
    const requestId = randomUUID();
    let unsubscribe = () => {};
    const finish = (error?: Error) => {
      clearTimeout(timer);
      unsubscribe();
      pending.delete(cancel);
      if (error) reject(error); else resolve();
    };
    const cancel = (error: Error) => finish(error);
    const timer = setTimeout(() => finish(new Error("Background stop acknowledgement unavailable; inspect the run before retrying")), 5_000);
    pending.add(cancel);
    unsubscribe = events.on(`subagents:rpc:v1:reply:${requestId}`, (value) => {
      const reply = value as { version?: number; requestId?: string; success?: boolean; error?: { message?: string } };
      if (reply?.version !== 1 || reply.requestId !== requestId) return;
      finish(reply.success === true ? undefined : new Error(reply.error?.message ?? "Background stop rejected"));
    });
    try { events.emit("subagents:rpc:v1:request", { version: 1, requestId, method: "stop", params: { id: runId } }); }
    catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
  return { extension, stop, dispose };
}
