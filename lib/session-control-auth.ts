import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const core = require("../bin/session-wait-core.cjs") as typeof import("../bin/session-wait-core.cjs");

export type PeerScope = "resume_prior_work" | "report_result" | "observe_wait" | "pull_messages";
export const SESSION_CONTROL_SCOPE: PeerScope = "resume_prior_work";

export function generateSessionControlKeyPair() {
  return core.generatePeerKeyPair() as { publicKey: string; privateKey: string };
}
export function createSessionControlEnvelope(input: Record<string, unknown>, privateKey: string) {
  return core.createSignedEnvelope(input, privateKey);
}
export function verifySessionControlEnvelope(envelope: unknown, publicKey: string, options: Record<string, unknown> = {}) {
  return core.verifySignedEnvelope(envelope, publicKey, options);
}
export function configuredSessionControlPublicKeys(): Record<string, unknown> {
  return core.loadPublicKeyPins(process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS) as Record<string, unknown>;
}
export function acceptSessionControlEnvelope(root: string, channel: string, envelope: Record<string, unknown>, options: Record<string, unknown> = {}) {
  return core.acceptPeerEnvelope(root, channel, envelope, options);
}
