import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { interopDefault: true });
const { acquireSessionRuntimeOwnership } = await jiti.import("./session-runtime-ownership.ts");
const modulePath = new URL("./session-runtime-ownership.ts", import.meta.url).pathname;
const jitiPath = import.meta.resolve("jiti");
function contender(file) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from ${JSON.stringify(jitiPath)};
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const { acquireSessionRuntimeOwnership } = await jiti.import(${JSON.stringify(modulePath)});
    process.on('message', message => {
      if (message === 'acquire') {
        try { globalThis.lease = acquireSessionRuntimeOwnership(${JSON.stringify(file)}); process.send({ acquired: true }); }
        catch (error) { process.send({ acquired: false, code: error.code, owner: error.owner }); }
      }
      if (message === 'release') { globalThis.lease?.release(); process.send({ released: true }); }
    });
    process.send({ ready: true });
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  let stderr = ""; child.stderr.on("data", chunk => { stderr += chunk; });
  child.diagnostics = () => stderr;
  return child;
}
async function message(child, command) {
  const response = once(child, "message"); child.send(command); return (await response)[0];
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "reader-runtime-owner-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, file: join(root, "session.jsonl") };
}
async function processFixture(t, file) {
  const child = contender(file);
  t.after(async () => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGKILL"); await exited; });
  assert.deepEqual((await once(child, "message"))[0], { ready: true }, child.diagnostics()); return child;
}
test("two processes racing for one transcript have exactly one owner, including an unpersisted draft", { timeout: 15000 }, async t => {
  const { file } = await fixture(t);
  const a = await processFixture(t, file), b = await processFixture(t, file);
  const results = await Promise.all([message(a, "acquire"), message(b, "acquire")]);
  assert.equal(results.filter(r => r.acquired).length, 1);
  const winner = results[0].acquired ? a : b, loser = winner === a ? b : a;
  const conflict = results.find(r => !r.acquired); assert.equal(conflict.code, "session_runtime_owned");
  // The lock can win before its diagnostic record is published; never guess a port.
  if (conflict.owner) { assert.equal(conflict.owner.pid, winner.pid); assert.equal(conflict.owner.entry, "reader"); assert.equal(conflict.owner.port, undefined); }
  assert.equal((await message(loser, "acquire")).owner.pid, winner.pid);
  await message(winner, "release"); assert.equal((await message(loser, "acquire")).acquired, true); await message(loser, "release");
});
test("a paused live owner is never reclaimed; SIGKILL releases the kernel lock without a TTL", { timeout: 15000 }, async t => {
  const { file } = await fixture(t); const a = await processFixture(t, file);
  assert.equal((await message(a, "acquire")).acquired, true); a.kill("SIGSTOP");
  assert.throws(() => acquireSessionRuntimeOwnership(file), { code: "session_runtime_owned" });
  const exit = once(a, "exit"); a.kill("SIGKILL"); await exit;
  const recovered = acquireSessionRuntimeOwnership(file); recovered.release(); recovered.release();
  const next = acquireSessionRuntimeOwnership(file); next.release();
});
test("physical aliases contend and release does not delete the shared lock inode", async t => {
  const { root, file } = await fixture(t); await writeFile(file, "fixture\n");
  const alias = join(root, "alias.jsonl"); await symlink(file, alias);
  const owner = acquireSessionRuntimeOwnership(file);
  try { assert.throws(() => acquireSessionRuntimeOwnership(alias), { code: "session_runtime_owned" }); }
  finally { owner.release(); }
  const next = acquireSessionRuntimeOwnership(alias); next.release();
});
test("failed owner-record publication releases admission for a subsequent valid create", async t => {
  const { file } = await fixture(t);
  await mkdir(`${file}.runtime-owner.json`);
  assert.throws(() => acquireSessionRuntimeOwnership(file));
  await rm(`${file}.runtime-owner.json`, { recursive: true });
  const owner = acquireSessionRuntimeOwnership(file); owner.release();
});
