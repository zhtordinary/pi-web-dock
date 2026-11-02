import { isSessionMutationReceipt, unknownSessionMutation, type SessionMutationCommand, type SessionMutationReceipt } from "./session-mutation-command";

import { SESSION_MUTATION_PROTOCOL, type SessionMutationIdentity, type SessionMutationRecoveryPage } from "./session-mutation-recovery";

export type SessionMutationChannel = {
  request(mode: "query" | "execute", command: SessionMutationCommand): Promise<SessionMutationReceipt>;
  protocol?: number;
  recovery?(after?: string): Promise<SessionMutationRecoveryPage>;
  acknowledge?(identity: SessionMutationIdentity, reviewedUnknown: boolean): Promise<boolean>;
  close(): void;
};

export function isSessionMutationBridgeAuthenticationRequired(error: unknown): boolean {
  return (error as { code?: string } | null)?.code === "AUTH_REQUIRED";
}

/** This frame is a transport only; no Reader workspace URL/state is touched. */
export function openSessionMutationBridge(deviceId: string, targetOrigin: string, options: {
  window?: Window; document?: Document; readyTimeoutMs?: number; requestTimeoutMs?: number;
} = {}): Promise<SessionMutationChannel> {
  const host = options.window ?? window;
  const doc = options.document ?? document;
  return new Promise((resolve, reject) => {
    const channel = host.crypto.randomUUID();
    const frame = doc.createElement("iframe");
    frame.hidden = true;
    frame.setAttribute("aria-hidden", "true");
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin");
    frame.referrerPolicy = "no-referrer";
    const url = new URL("/api/session-mutations/bridge", targetOrigin);
    url.searchParams.set("parentOrigin", host.location.origin);
    url.searchParams.set("channel", channel);
    frame.src = url.href;
    let ready = false;
    let closed = false;
    const pending = new Map<string, { finish: (value: unknown) => void; timer: ReturnType<typeof setTimeout> }>();
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(readyTimer);
      host.removeEventListener("message", onMessage);
      for (const entry of pending.values()) { clearTimeout(entry.timer); entry.finish(null); }
      pending.clear();
      frame.remove();
    };
    const call = (mode: string, values: Record<string, unknown>): Promise<unknown> => new Promise((finish) => {
      if (!ready || closed || !frame.contentWindow) { finish(null); return; }
      const requestId = host.crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); finish(null); }, options.requestTimeoutMs ?? 12_000);
      pending.set(requestId, { finish, timer });
      frame.contentWindow.postMessage({ type: "session-mutation-command", channel, requestId, mode, ...values }, targetOrigin);
    });
    const request: SessionMutationChannel["request"] = async (mode, command) => {
      const result = await call(mode, { command });
      return isSessionMutationReceipt(result, command) ? result : unknownSessionMutation(command);
    };
    const onMessage = (event: MessageEvent) => {
      if (closed || event.source !== frame.contentWindow || event.origin !== targetOrigin || event.data?.channel !== channel) return;
      if (event.data.type === "session-mutation-auth-required" && !ready) {
        close(); reject(Object.assign(new Error("Open the target Reader directly to authenticate and inspect the original operation"), { code: "AUTH_REQUIRED" })); return;
      }
      if (event.data.type === "session-mutation-ready" && !ready) {
        if (event.data.deviceId !== deviceId) { close(); reject(new Error("Bridge target device mismatch")); return; }
        if (event.data.protocol !== SESSION_MUTATION_PROTOCOL) {
          close(); reject(Object.assign(new Error("Target Reader requires an upgrade"), { code: "UPGRADE_REQUIRED" })); return;
        }
        ready = true;
        clearTimeout(readyTimer);
        resolve({ request, close, protocol: SESSION_MUTATION_PROTOCOL,
          recovery: async (after = "") => {
            const result = await call("recovery", { after }) as SessionMutationRecoveryPage | null;
            if (!result || !Array.isArray(result.operations)) throw new Error("Recovery list unavailable");
            return result;
          },
          acknowledge: async (identity, reviewedUnknown) => {
            const result = await call("acknowledge", { command: { ...identity, reviewedUnknown } }) as { acknowledged?: boolean } | null;
            return result?.acknowledged === true;
          },
        });
        return;
      }
      if (event.data.type !== "session-mutation-result" || typeof event.data.requestId !== "string") return;
      const entry = pending.get(event.data.requestId);
      if (!entry) return;
      pending.delete(event.data.requestId);
      clearTimeout(entry.timer);
      entry.finish(event.data.result);
    };
    const readyTimer = setTimeout(() => { close(); reject(new Error("Bridge readiness was not confirmed")); }, options.readyTimeoutMs ?? 10_000);
    host.addEventListener("message", onMessage);
    frame.onload = () => frame.contentWindow?.postMessage({ type: "session-mutation-hello", channel }, targetOrigin);
    doc.body.appendChild(frame);
  });
}
