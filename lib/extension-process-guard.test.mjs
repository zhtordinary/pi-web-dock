import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url);
const { installExtensionProcessGuard } = await jiti.import("./extension-process-guard.ts");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function guardedEmitter() {
  const emitter = new EventEmitter();
  const logged = [];
  assert.equal(installExtensionProcessGuard(emitter, (message) => logged.push(message)), true);
  return { emitter, logged };
}

// 2026-10-17 22:54: a Honcho initialization rejected after its session was replaced, Next.js logged it,
// and pi-lens's crash guard (rethrow from both handlers) ended the whole server with exit code 7.
const incident = (guarded) => `
const { createJiti } = await import("jiti");
${guarded ? `const { installExtensionProcessGuard } = await createJiti(process.cwd() + "/").import("./lib/extension-process-guard.ts");` : ""}
process.on("unhandledRejection", (error) => console.error("⨯ unhandledRejection:", error.message)); // as Next.js does
process.on("uncaughtException", (error) => console.error("⨯ uncaughtException:", error.message));
${guarded ? "installExtensionProcessGuard();" : ""}
process.on("uncaughtException", (error) => { throw error; }); // pi-lens installCrashGuard()
process.on("unhandledRejection", (reason) => { throw reason instanceof Error ? reason : new Error(String(reason)); });
(async () => { await null; throw new Error("extension ctx is stale"); })();
setTimeout(() => { console.log("still serving"); process.exit(0); }, 300);
`;
const runIncident = (guarded) =>
  spawnSync(process.execPath, ["--input-type=module", "-e", incident(guarded)], { cwd: root, encoding: "utf8" });

test("without the guard a rethrowing crash handler ends the whole process", () => {
  const result = runIncident(false);
  assert.equal(result.status, 7, result.stderr);
  assert.doesNotMatch(result.stdout, /still serving/);
  assert.match(result.stderr, /⨯ unhandledRejection: extension ctx is stale/);
});

test("with the guard the same handlers are contained and the process keeps serving", () => {
  const result = runIncident(true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /still serving/);
  assert.match(result.stderr, /⨯ unhandledRejection: extension ctx is stale/, "Next.js's own handler still logs the error");
  assert.match(result.stderr, /contained an error thrown by a unhandledRejection handler: Error: extension ctx is stale/);
});

test("handlers registered before the guard are untouched and later ones keep their identity", () => {
  const emitter = new EventEmitter();
  const earlier = () => {};
  emitter.on("unhandledRejection", earlier);
  const logged = [];
  installExtensionProcessGuard(emitter, (message) => logged.push(message));
  assert.equal(emitter.rawListeners("unhandledRejection")[0], earlier);

  const later = () => {};
  const onceLater = () => {};
  const prependedLater = () => {};
  emitter.on("unhandledRejection", later);
  emitter.once("unhandledRejection", onceLater);
  emitter.prependListener("unhandledRejection", prependedLater);
  assert.deepEqual(emitter.listeners("unhandledRejection"), [prependedLater, earlier, later, onceLater]);
  emitter.off("unhandledRejection", later);
  emitter.off("unhandledRejection", onceLater);
  emitter.removeListener("unhandledRejection", prependedLater);
  assert.deepEqual(emitter.listeners("unhandledRejection"), [earlier]);
  assert.deepEqual(logged, []);
});

test("arguments, this and once semantics are preserved", () => {
  const { emitter } = guardedEmitter();
  const calls = [];
  emitter.once("uncaughtException", function (error, origin) {
    calls.push(["once", error.message, origin, this === emitter]);
  });
  emitter.prependOnceListener("uncaughtException", () => calls.push(["prepended once"]));
  emitter.on("uncaughtException", () => calls.push(["on"]));
  emitter.emit("uncaughtException", new Error("a"), "uncaughtException");
  emitter.emit("uncaughtException", new Error("b"), "uncaughtException");
  assert.deepEqual(calls, [["prepended once"], ["once", "a", "uncaughtException", true], ["on"], ["on"]]);
  assert.equal(emitter.listenerCount("uncaughtException"), 1);
});

test("errors thrown by synchronous and asynchronous handlers are logged, not raised", async () => {
  const { emitter, logged } = guardedEmitter();
  emitter.on("uncaughtException", () => { throw new Error("sync boom"); });
  emitter.on("unhandledRejection", async () => { throw new Error("async boom"); });
  emitter.once("unhandledRejection", () => { throw "plain string"; });
  assert.doesNotThrow(() => emitter.emit("uncaughtException", new Error("x"), "uncaughtException"));
  assert.doesNotThrow(() => emitter.emit("unhandledRejection", new Error("y"), Promise.resolve()));
  await new Promise((resolve) => setImmediate(resolve));
  // Synchronous throws are reported during emit, the asynchronous rejection on a later tick.
  assert.equal(logged.length, 3);
  assert.match(logged[0], /uncaughtException handler: Error: sync boom/);
  assert.match(logged[1], /unhandledRejection handler: plain string/);
  assert.match(logged[2], /unhandledRejection handler: Error: async boom/);
});

test("other events and invalid listeners behave as before", () => {
  const { emitter } = guardedEmitter();
  const listener = () => { throw new Error("not guarded"); };
  emitter.on("custom", listener);
  assert.equal(emitter.rawListeners("custom")[0], listener);
  assert.throws(() => emitter.emit("custom"), /not guarded/);
  assert.throws(() => emitter.on("unhandledRejection", "not a function"), { code: "ERR_INVALID_ARG_TYPE" });
});

test("installing twice does not wrap twice, and a failing logger never escapes", () => {
  const emitter = new EventEmitter();
  const logged = [];
  assert.equal(installExtensionProcessGuard(emitter, (message) => logged.push(message)), true);
  assert.equal(installExtensionProcessGuard(emitter, () => { throw new Error("second logger"); }), false);
  emitter.on("uncaughtException", () => { throw new Error("boom"); });
  emitter.emit("uncaughtException", new Error("x"), "uncaughtException");
  assert.equal(logged.length, 1);

  const silent = new EventEmitter();
  installExtensionProcessGuard(silent, () => { throw new Error("log failed"); });
  silent.on("unhandledRejection", () => { throw new Error("boom"); });
  assert.doesNotThrow(() => silent.emit("unhandledRejection", new Error("x"), Promise.resolve()));
});

test("instrumentation installs the guard before anything else can load an extension", async () => {
  const source = await readFile(join(root, "instrumentation-node.ts"), "utf8");
  const body = source.slice(source.indexOf("export function registerNodeInstrumentation"));
  const installAt = body.indexOf("installExtensionProcessGuard()");
  assert.ok(installAt > 0, "registerNodeInstrumentation installs the guard");
  assert.ok(installAt < body.indexOf("configureHttpDispatcher()"));
  assert.ok(installAt < body.indexOf("initializeSessionWaitRuntime()"));
});
