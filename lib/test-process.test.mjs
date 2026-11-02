import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { runProcess, waitForWorkerIdle } from "../test-support/test-process.mjs";

test("process result includes drained stdout and stderr and exact exit status", async () => {
  const result = await runProcess(process.execPath, ["-e",
    'process.stdout.write("x".repeat(2 ** 20)); process.stderr.write("diagnostic"); process.exitCode = 7;']);
  assert.equal(result.code, 7);
  assert.equal(result.stdout, "x".repeat(2 ** 20));
  assert.equal(result.stderr, "diagnostic");
});

test("process launch error rejects without claiming successful completion", async () => {
  await assert.rejects(runProcess("/nonexistent/fixture-command", []), { code: "ENOENT" });
});

test("readiness deadline fails explicitly and exited workers are not ready", async () => {
  await assert.rejects(waitForWorkerIdle({exitCode:null, signalCode:null, pid:1}, "/nonexistent/fixture-health", { timeoutMs: 20 }), /deadline/);
  await assert.rejects(waitForWorkerIdle({exitCode:1, signalCode:null, pid:1}, "/nonexistent/fixture-health"), /exited/);
});

test("idle readiness can require completion of the worker lock release", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "reader-ready-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const health = join(root, "health.json"), lock = join(root, "worker.lock");
  writeFileSync(health, JSON.stringify({pid:1, status:"idle"}));
  mkdirSync(lock);
  const timer = setTimeout(() => rmSync(lock, { recursive: true }), 30);
  t.after(() => clearTimeout(timer));
  await waitForWorkerIdle({pid:1, exitCode:null, signalCode:null}, health, {releasedLock:lock});
  assert.equal(existsSync(lock), false);
});
