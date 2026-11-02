import { randomUUID } from "node:crypto";
import { localDeviceId, readActivityConfig } from "@/lib/activity-peers";
import { isSessionMutationBridgeRequestAllowed } from "@/lib/session-mutation-bridge-security";

export const dynamic = "force-dynamic";

/** Dedicated, runtime-free transport page. Never renders the Reader workspace. */
export async function GET(request: Request) {
  const config = readActivityConfig();
  if (!isSessionMutationBridgeRequestAllowed(request, config)) return new Response("Untrusted bridge parent", { status: 403 });
  const url = new URL(request.url);
  const parentOrigin = url.searchParams.get("parentOrigin")!;
  const channel = url.searchParams.get("channel")!;
  const nonce = randomUUID();
  const settings = JSON.stringify({ parentOrigin, channel, deviceId: localDeviceId(config) }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Session operation transport</title><script nonce="${nonce}">
"use strict";
const settings = ${settings};
const send = value => window.parent.postMessage({ ...value, channel: settings.channel }, settings.parentOrigin);
const ready = () => send({ type: "session-mutation-ready", deviceId: settings.deviceId, protocol: 2 });
window.addEventListener("message", async event => {
  if (event.source !== window.parent || event.origin !== settings.parentOrigin || event.data?.channel !== settings.channel) return;
  const data = event.data;
  if (data.type === "session-mutation-hello") { ready(); return; }
  if (data.type !== "session-mutation-command" || !["query", "execute", "recovery", "acknowledge"].includes(data.mode) || typeof data.requestId !== "string") return;
  let result = null;
  try {
    const query = data.mode === "query" || data.mode === "recovery";
    const parameters = data.mode === "recovery" ? { recovery: "1", after: data.after || "" }
      : { operationId: data.command?.operationId, deviceId: data.command?.deviceId, sessionId: data.command?.sessionId };
    const body = data.mode === "acknowledge" ? { ...data.command, action: "acknowledge" } : data.command;
    const response = await fetch("/api/session-mutations" + (query ? "?" + new URLSearchParams(parameters) : ""), {
      method: query ? "GET" : "POST", headers: { "content-type": "application/json" },
      ...(query ? {} : { body: JSON.stringify(body) }), cache: "no-store"
    });
    if (response.ok) result = await response.json();
  } catch {}
  send({ type: "session-mutation-result", requestId: data.requestId, result });
});
ready();
</script>`, { headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; frame-ancestors ${parentOrigin}; base-uri 'none'; form-action 'none'`,
  } });
}
