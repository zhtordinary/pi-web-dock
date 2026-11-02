import { existsSync, readFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], ...options });
    const stdout = [], stderr = [];
    child.stdout?.on("data", (chunk) => stdout.push(chunk));
    child.stderr?.on("data", (chunk) => stderr.push(chunk));
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      child, code, signal,
      stdout: Buffer.concat(stdout).toString(),
      stderr: Buffer.concat(stderr).toString(),
    }));
  });
}

export async function waitForWorkerIdle(child, healthFile, { timeoutMs = 10000, releasedLock } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error("worker exited before idle");
    try {
      const health = JSON.parse(readFileSync(healthFile, "utf8"));
      if (health.pid === child.pid && health.status === "idle" && (!releasedLock || !existsSync(releasedLock))) return health;
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error;
    }
    await delay(10);
  }
  throw new Error("worker did not become idle before the fixture deadline");
}
