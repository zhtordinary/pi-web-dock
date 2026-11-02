import { randomUUID } from "node:crypto";
import { readActivityConfig, type ActivityConfig } from "./activity-peers";
import { isApiRequestHostAllowed } from "./request-security";

export const SESSION_MUTATION_BRIDGE_PATH = "/api/session-mutations/bridge";

/** A transport document, not a cross-site API exception. CSP and the script's
 * source/origin/channel checks bind its capability to the configured parent. */
export function isSessionMutationBridgeRequestAllowed(request: Request, config?: ActivityConfig): boolean {
  if (request.method !== "GET" || !isApiRequestHostAllowed(request)) return false;
  const url = new URL(request.url);
  if (url.pathname !== SESSION_MUTATION_BRIDGE_PATH) return false;
  const parentOrigin = url.searchParams.get("parentOrigin") ?? "";
  const channel = url.searchParams.get("channel") ?? "";
  if (!/^[A-Za-z0-9-]{8,100}$/.test(channel)) return false;
  const mode = request.headers.get("sec-fetch-mode");
  const destination = request.headers.get("sec-fetch-dest");
  if ((mode && mode !== "navigate") || (destination && destination !== "iframe")) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== parentOrigin) return false;
  const allowed = new Set([url.origin]);
  for (const peer of (config ?? readActivityConfig()).peers ?? []) {
    try {
      const peerUrl = new URL(peer.url);
      if (["http:", "https:"].includes(peerUrl.protocol)) allowed.add(peerUrl.origin);
    } catch { /* Invalid configuration grants no capability. */ }
  }
  return allowed.has(parentOrigin);
}

/** No transport authority is granted by this diagnostic document. Keep the 401,
 * but let an allowed parent distinguish missing browser credentials from a hang. */
export function sessionMutationBridgeAuthenticationRequired(request: Request): Response {
  if (!isSessionMutationBridgeRequestAllowed(request)) return new Response("Untrusted bridge parent", { status: 403 });
  const url = new URL(request.url);
  const parentOrigin = url.searchParams.get("parentOrigin")!;
  const channel = url.searchParams.get("channel")!;
  const nonce = randomUUID();
  const settings = JSON.stringify({ parentOrigin, channel }).replace(/</g, "\\u003c");
  return new Response(`<!doctype html><meta charset="utf-8"><title>Authentication required</title><script nonce="${nonce}">
"use strict";
const settings = ${settings};
window.parent.postMessage({ type: "session-mutation-auth-required", channel: settings.channel }, settings.parentOrigin);
</script>`, { status: 401, headers: {
    "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy": `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors ${parentOrigin}; base-uri 'none'; form-action 'none'`,
  } });
}
