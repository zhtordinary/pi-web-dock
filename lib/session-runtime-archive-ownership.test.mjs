import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { interopDefault: true });
const { acquireSessionRuntimeOwnership } = await jiti.import("./session-runtime-ownership.ts");
const { acquireStateWriteLock } = await import("../bin/state-write-lock.cjs");
const modulePath = new URL("./session-runtime-ownership.ts", import.meta.url).pathname;
const jitiPath = import.meta.resolve("jiti");
async function worker(t, file) {
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import { createJiti } from ${JSON.stringify(jitiPath)};
    const { acquireSessionRuntimeOwnership } = await createJiti(import.meta.url).import(${JSON.stringify(modulePath)});
    let owner;
    process.on('message', action => {
      try { if(action==='acquire') owner=acquireSessionRuntimeOwnership(${JSON.stringify(file)}); else owner?.release(); process.send({ok:true}); }
      catch(error) {process.send({ok:false,code:error.code});}
    }); process.send({ready:true});
  `], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  t.after(async () => { if(child.exitCode===null && child.signalCode===null) {const end=once(child,"exit"); child.kill("SIGKILL"); await end;} });
  assert.deepEqual((await once(child,"message"))[0], {ready:true});
  return child;
}
async function command(child, action) { const reply=once(child,"message"); child.send(action); return (await reply)[0]; }
test("two Reader processes share one crash-released owner and archive uses the same mutex", {timeout:15000}, async t => {
  const root=await mkdtemp(join(tmpdir(),"reader-owner-proof-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,"session.jsonl"), child=await worker(t,file);
  assert.equal((await command(child,"acquire")).ok,true);
  assert.throws(()=>acquireSessionRuntimeOwnership(file),{code:"session_runtime_owned"});
  assert.throws(()=>acquireStateWriteLock(file),{code:"ELOCKED"});
  child.kill("SIGSTOP"); assert.throws(()=>acquireSessionRuntimeOwnership(file),{code:"session_runtime_owned"});
  const end=once(child,"exit"); child.kill("SIGKILL"); await end;
  const archive=acquireStateWriteLock(file);
  assert.throws(()=>acquireSessionRuntimeOwnership(file),{code:"session_runtime_owned"}); archive();
  const next=acquireSessionRuntimeOwnership(file); next.release(); next.release();
});
test("physical aliases cannot acquire independent ownership", async t => {
  const root=await mkdtemp(join(tmpdir(),"reader-owner-alias-")); t.after(()=>rm(root,{recursive:true,force:true}));
  const file=join(root,"session.jsonl"), alias=join(root,"alias.jsonl"); await writeFile(file,"fixture\n"); await symlink(file,alias);
  const owner=acquireSessionRuntimeOwnership(file);
  try {assert.throws(()=>acquireSessionRuntimeOwnership(alias),{code:"session_runtime_owned"});} finally {owner.release();}
  const next=acquireSessionRuntimeOwnership(alias); next.release();
});
