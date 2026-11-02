import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const [ledger, receipts, live, rpc] = await Promise.all([
  readFile(new URL("./live-event-ledger.ts", import.meta.url), "utf8"),
  readFile(new URL("./reader-control-receipts.ts", import.meta.url), "utf8"),
  readFile(new URL("./live-agent-events.ts", import.meta.url), "utf8"),
  readFile(new URL("./rpc-manager.ts", import.meta.url), "utf8"),
]);

test("live events have a bounded durable ledger with explicit replay inputs", () => {
  assert.match(ledger, /LIVE_EVENT_LEDGER_MAX_EVENTS/);
  assert.match(ledger, /LIVE_EVENT_LEDGER_MAX_BYTES/);
  assert.match(ledger, /retainLedgerRecords/);
  assert.match(ledger, /appendDurableLiveEvent/);
  assert.match(ledger, /readDurableLiveEventRecords/);
  assert.match(ledger, /durableAvailable: false/);
  assert.match(ledger, /bootId/);
  assert.match(ledger, /cursor/);
  assert.match(ledger, /compact/);
  assert.match(live, /LIVE_EVENT_BUFFER_SIZE/);
});

test("control receipts are durable, locked, fingerprinted, and lifecycle-aware", () => {
  assert.match(receipts, /withStateFileTransaction/);
  assert.match(receipts, /writePrivateFileAtomicSync/);
  assert.match(receipts, /controlRequestFingerprint/);
  assert.match(receipts, /reserveControlReceipt/);
  assert.match(receipts, /idempotency_conflict/);
  assert.match(receipts, /prior_attempt_unknown/);
  for (const outcome of ["accepted", "running", "completed", "failed", "aborted", "unknown"]) {
    assert.match(receipts, new RegExp(`"${outcome}"`));
  }
  const readBlock = receipts.slice(receipts.indexOf("export async function readControlReceipt"));
  assert.doesNotMatch(readBlock, /withStore\(/);
});

test("control receipts cannot inherit a completed run or omit command inputs", () => {
  assert.match(rpc, /operation === "steer" \|\| operation === "abort"/);
  assert.match(rpc, /clearRunIdAfterEmit = true/);
  assert.match(rpc, /if \(clearRunIdAfterEmit\) this\.currentRunId = null/);
});
