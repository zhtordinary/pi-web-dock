import assert from "node:assert/strict";
import test from "node:test";
import { canCancel, canPause, canResume, evidenceSourceKey, waitReadiness, waitStatusKey, workerHealth, waitConditionKey, waitActionKey } from "./session-wait-ui.ts";

test("wait UI projection exposes real controls, device identity and worker health", () => {
  assert.equal(canPause("waiting"), true); assert.equal(canPause("completed"), false); assert.equal(canResume("blocked"), true); assert.equal(canCancel("cancelled"), false);
  assert.equal(waitStatusKey("retrying"), "sessionWait.status.retrying");
  assert.equal(waitConditionKey("turn_settled"), "sessionWait.condition.turn_settled");
  assert.equal(waitActionKey("wait_for_result"), "sessionWait.action.wait_for_result");
  assert.equal(waitActionKey(), "sessionWait.next.none");
  assert.equal(waitActionKey("none"), "sessionWait.next.none");
  assert.deepEqual(workerHealth({ status: "idle" }), { status: "healthy" });
  assert.equal(workerHealth({ status: "blocked", reason: "offline" }).status, "blocked");
  assert.equal(workerHealth(null).status, "unknown");
});

test("readiness distinguishes Reader lifecycle from worker and unknown outcomes", () => {
  const wait = { status: "waiting", target: { deviceId: "local" } }; const facts = { localDeviceId: "local", workerHealthy: false };
  assert.equal(waitReadiness(wait, facts).status, "ready");
  assert.equal(waitReadiness(wait, facts).driver, "reader");
  assert.equal(waitReadiness({ ...wait, condition: "ui_request", target: { deviceId: "remote" } }, facts).driver, "reader");
  assert.equal(waitReadiness(wait, { ...facts, externalTask: true }).status, "pending");
  assert.equal(waitReadiness({ ...wait, target: { deviceId: "remote" } }, { ...facts, peerReason: "peer_not_paired" }).status, "blocked");
  assert.equal(waitReadiness(wait, { ...facts, unknownDelivery: true }).nextAction, "inspect_recipient_receipt");
  assert.equal(waitReadiness({ ...wait, status: "cancelled" }, facts).status, "inactive");
  assert.equal(evidenceSourceKey({}), "sessionWait.evidence.unspecified");
});
