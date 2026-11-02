import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { alias: { "@": process.cwd() } });
const store = await jiti.import("./reader-control-receipts.ts");
const service = await jiti.import("./session-mutation-service.ts");
const client = await jiti.import("./remote-session-mutation.ts");
const target = { id: "remote-fixture", url: "https://remote-fixture.test:30142", name: "Fixture" };
const command = (changes = {}) => ({ operationId: "original-operation", deviceId: target.id, sessionId: "deleted-session", op: "delete", force: true, ...changes });
const result = (input, status) => ({ operationId: input.operationId, deviceId: input.deviceId, sessionId: input.sessionId, status });
const available = { capability: async () => "supported", discovery: async () => ({ operations: [] }), acknowledge: async () => true, openBridge: async () => { throw Error("bridge unavailable"); } };
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "reader-recovery-"));
  const old = { root: process.env.PI_WEB_CONTROL_RECEIPT_ROOT, config: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG };
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT = root;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: target.id }, peers: [] });
  t.after(() => {
    for (const [key, value] of [["PI_WEB_CONTROL_RECEIPT_ROOT", old.root], ["PI_WEB_SESSION_ACTIVITY_CONFIG", old.config]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });
  return root;
}
function legacy(root, input = command()) {
  const now = new Date().toISOString();
  const receipt = { schemaVersion: 1, receiptId: "legacy-receipt", deviceId: input.deviceId, sessionId: input.sessionId,
    operation: "session_mutation", idempotencyKey: input.operationId, requestFingerprint: store.controlRequestFingerprint(input),
    cwd: "session-mutation", outcome: "completed", createdAt: now, acceptedAt: now, updatedAt: now };
  const key = [receipt.deviceId, receipt.sessionId, receipt.operation, receipt.idempotencyKey].join("\0");
  const raw = JSON.stringify({ schemaVersion: 1, receipts: { [key]: receipt } });
  writeFileSync(join(root, "receipts.json"), raw);
  return { raw, receipt };
}
function child(root, body) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", `import { createJiti } from "jiti";
    import fs from "node:fs"; import { syncBuiltinESMExports } from "node:module"; import { DatabaseSync } from "node:sqlite";
    const jiti = createJiti(${JSON.stringify(import.meta.url)});
    ${body}`], { cwd: process.cwd(), env: { PATH: process.env.PATH, HOME: root,
      PI_WEB_CONTROL_RECEIPT_ROOT: root, PI_WEB_SESSION_ACTIVITY_CONFIG: process.env.PI_WEB_SESSION_ACTIVITY_CONFIG }, encoding: "utf8", timeout: 30000 });
}
const servicePath = JSON.stringify(new URL("./session-mutation-service.ts", import.meta.url).pathname);

test("preadmission loss survives reload and explicit continuation executes only the saved original ID and parameters", async (t) => {
  fixture(t);
  const values = new Map(), calls = [];
  const storage = { getItem: key => values.get(key), setItem: (key, value) => values.set(key, value) };
  const original = command({ op: "rename", name: "Original name", force: true });
  let effects = 0;
  const lost = client.createRemoteSessionMutationClient({ ...available, storage, uuid: () => original.operationId,
    proxy: async (mode, input) => { calls.push({ mode, input }); throw Error("POST never reached admission"); } });
  assert.equal((await lost(target, original.op, original.sessionId, original.name, original.force)).status, "unknown");
  const resumed = client.createRemoteSessionMutationClient({ ...available, storage,
    uuid: () => { throw Error("Recovery must not allocate a new ID"); },
    discovery: () => service.listSessionMutations(), acknowledge: () => Promise.resolve(false),
    proxy: async (mode, input) => { calls.push({ mode, input }); return mode === "query" ? service.querySessionMutation(input)
      : service.executeSessionMutation(input, async () => { effects++; return new Response(); }); } });
  await resumed.recover([target]);
  assert.equal(resumed.snapshot()[0].receipt.status, "not_found", "absence is observable without executing");
  const changedIntent = await resumed(target, "delete", original.sessionId, undefined, false);
  assert.equal(changedIntent.previousOperation, true);
  assert.equal(changedIntent.status, "not_found");
  assert.equal(effects, 0);
  assert.equal(calls.filter(call => call.mode === "execute").length, 1, "reload and new intent are query-only");
  const before = calls.length;
  const completed = await Promise.all([resumed.continueOriginal(original.operationId, target.id), resumed.continueOriginal(original.operationId, target.id)]);
  assert.deepEqual(completed.map(receipt => receipt.status), ["completed", "completed"]);
  assert.deepEqual(calls.slice(before).map(call => call.mode), ["query", "execute"]);
  assert.deepEqual(calls.at(-1).input, original);
  assert.equal(effects, 1);
  assert.equal((await resumed.continueOriginal(original.operationId, target.id)).status, "completed");
  assert.equal(effects, 1);
});

test("late original admission racing explicit continuation still has one business effect", async (t) => {
  fixture(t);
  const original = command();
  const data = JSON.stringify([{ target, command: original, receipt: result(original, "not_found") }]);
  let effects = 0, posts = 0;
  const perform = client.createRemoteSessionMutationClient({ ...available,
    storage: { getItem: key => key.endsWith(".v2") ? data : null, setItem() {} },
    proxy: async (mode, input) => {
      if (mode === "query") return service.querySessionMutation(input);
      posts++;
      // The timed-out original arrives after the continuation's absence read.
      await service.executeSessionMutation(original, async () => { effects++; return new Response(); });
      return service.executeSessionMutation(input, async () => { effects++; return new Response(); });
    } });
  assert.equal((await perform.continueOriginal(original.operationId, target.id)).status, "completed");
  assert.equal(posts, 1);
  assert.equal(effects, 1);
});

test("explicit continuation of an admitted unknown never executes it again", async (t) => {
  fixture(t);
  const original = command();
  let effects = 0, posts = 0;
  await service.executeSessionMutation(original, async () => { effects++; throw Error("effect response lost"); });
  const perform = client.createRemoteSessionMutationClient({ ...available,
    discovery: () => service.listSessionMutations(),
    proxy: async (mode, input) => { if (mode === "execute") posts++; return service.querySessionMutation(input); } });
  await perform.recover([target]);
  assert.equal((await perform.continueOriginal(original.operationId, target.id)).status, "unknown");
  assert.equal(posts, 0);
  assert.equal(effects, 1);
});

test("continuation capability failures retain the original ID without making a mutation request", async () => {
  for (const supported of ["upgrade_required", "unavailable"]) {
    const original = command(), calls = [];
    const saved = JSON.stringify([{ target, command: original, receipt: result(original, "not_found") }]);
    const perform = client.createRemoteSessionMutationClient({ ...available, capability: async () => supported,
      storage: { getItem: key => key.endsWith(".v2") ? saved : null, setItem() {} },
      proxy: async (mode, input) => { calls.push(mode); return result(input, "completed"); } });
    const receipt = await perform.continueOriginal(original.operationId, target.id);
    assert.equal(receipt.notSent, true); assert.equal(receipt.operationId, original.operationId);
    assert.deepEqual(calls, []);
    assert.deepEqual(perform.snapshot()[0].command, original);
    assert.equal(perform.snapshot()[0].busy, false);
    assert.equal(perform.snapshot()[0].confirmed, false);
  }
});

test("historical recovery without original parameters cannot be continued or guessed", async () => {
  const original = command(), calls = [];
  const perform = client.createRemoteSessionMutationClient({ ...available,
    discovery: async () => ({ operations: [{ receipt: result(original, "not_found"), updatedAt: "now" }] }),
    proxy: async (mode, input) => { calls.push(mode); return result(input, "not_found"); } });
  await perform.recover([target]);
  await assert.rejects(perform.continueOriginal(original.operationId, target.id), /original command is unavailable/);
  assert.deepEqual(calls, ["query"]);
  assert.equal(await perform.review(original.operationId, target.id), false);
  assert.equal(perform.snapshot().length, 1);
});

test("a lost continuation response is resolved after reload by querying the same ID without another POST", async (t) => {
  fixture(t);
  const original = command(), data = new Map([["pi-web.pending-session-mutations.v2", JSON.stringify([{ target, command: original, receipt: result(original, "not_found") }])]]);
  let effects = 0, posts = 0;
  const options = { ...available, storage: { getItem: key => data.get(key), setItem: (key, value) => data.set(key, value) },
    discovery: () => service.listSessionMutations(),
    proxy: async (mode, input) => {
      if (mode === "query") return service.querySessionMutation(input);
      posts++;
      await service.executeSessionMutation(input, async () => { effects++; return new Response(); });
      throw Error("completed response lost");
    } };
  const first = client.createRemoteSessionMutationClient(options);
  assert.equal((await first.continueOriginal(original.operationId, target.id)).status, "unknown");
  const reloaded = client.createRemoteSessionMutationClient(options);
  await reloaded.recover([target]);
  assert.equal(reloaded.snapshot()[0].receipt.status, "completed");
  assert.equal((await reloaded.continueOriginal(original.operationId, target.id)).status, "completed");
  assert.equal(posts, 1); assert.equal(effects, 1);
});

test("continuation with unavailable durable browser storage still queries but cannot leave another untracked POST", async () => {
  const original = command(), calls = [];
  const perform = client.createRemoteSessionMutationClient({ ...available,
    legacyStorage: { getItem: () => JSON.stringify([["old-key", { command: original, targetOrigin: target.url }]]), setItem() {} },
    proxy: async (mode, input) => { calls.push(mode); return result(input, "not_found"); } });
  const receipt = await perform.continueOriginal(original.operationId, target.id);
  assert.equal(receipt.notSent, true); assert.equal(receipt.notSentReason, "storageUnavailable");
  assert.deepEqual(calls, ["query"]);
  assert.equal(perform.snapshot()[0].command.operationId, original.operationId);
});

test("capability and recovery GETs are read-only, including legacy storage", async (t) => {
  const root = fixture(t);
  const route = await jiti.import("../app/api/session-mutations/route.ts");
  const get = query => route.GET(new Request(`http://localhost/api/session-mutations?${query}`, { headers: { host: "localhost" } }));
  assert.deepEqual(await (await get("capabilities=1")).json(), { protocol: 2, deviceId: target.id, recovery: true });
  assert.deepEqual(await (await get("recovery=1")).json(), { operations: [] });
  assert.deepEqual(readdirSync(root), [], "queries cannot create locks, databases or markers");
  const old = legacy(root);
  assert.equal((await (await get("recovery=1")).json()).operations[0].receipt.operationId, command().operationId);
  assert.deepEqual(readdirSync(root), ["receipts.json"]);
  assert.equal(readFileSync(join(root, "receipts.json"), "utf8"), old.raw);
});

for (const phase of ["before-import-commit", "after-import-commit", "before-pointer-rename", "after-pointer-rename"]) {
  test(`legacy migration survives SIGKILL ${phase} without replay or losing the old receipt`, async (t) => {
    const root = fixture(t), old = legacy(root);
    const kill = `fs.writeFileSync(${JSON.stringify(join(root, "crash-phase"))}, ${JSON.stringify(phase)}); process.kill(process.pid, "SIGKILL");`;
    const hook = phase.includes("commit") ? `const original = DatabaseSync.prototype.exec;
      DatabaseSync.prototype.exec = function(sql) { if (sql === "COMMIT") {
        ${phase === "after-import-commit" ? "original.call(this, sql);" : ""} ${kill}
      } return original.call(this, sql); };` : `const original = fs.renameSync;
      fs.renameSync = function(from, to) { if (to === ${JSON.stringify(join(root, "receipts.json"))}) {
        ${phase === "after-pointer-rename" ? "original(from, to);" : ""} ${kill}
      } return original(from, to); };`;
    const killed = child(root, `${hook}
      syncBuiltinESMExports();
      const service = await jiti.import(${servicePath});
      await service.executeSessionMutation(${JSON.stringify(command({ operationId: "new-operation-after-upgrade" }))}, async () => { fs.appendFileSync(${JSON.stringify(join(root, "effects"))}, "effect"); return new Response(); });`);
    assert.equal(killed.signal, "SIGKILL", killed.stderr);
    assert.equal(readFileSync(join(root, "crash-phase"), "utf8"), phase);
    let effects = 0;
    assert.equal((await service.executeSessionMutation(command(), async () => { effects++; return new Response(); })).status, "completed");
    assert.equal((await service.executeSessionMutation(command({ operationId: "new-operation-after-upgrade" }), async () => { effects++; return new Response(); })).status, "completed");
    assert.equal(effects, 1);
    assert.equal(readFileSync(join(root, "receipts.legacy.json"), "utf8"), old.raw);
    assert.equal(JSON.parse(readFileSync(join(root, "receipts.json"), "utf8")).schemaVersion, 2);
    assert.equal((await service.listSessionMutations()).operations.length, 2);
    const restarted = child(root, `const service = await jiti.import(${servicePath});
      const result = await service.executeSessionMutation(${JSON.stringify(command())}, async () => { throw Error("duplicate effect"); });
      process.stdout.write(JSON.stringify(result));`);
    assert.equal(restarted.status, 0, restarted.stderr);
    assert.equal(JSON.parse(restarted.stdout).status, "completed");
  });
}

test("a changed legacy store after committed import fails closed rather than merging divergent histories", async (t) => {
  const root = fixture(t); legacy(root);
  const killed = child(root, `const original=DatabaseSync.prototype.exec; DatabaseSync.prototype.exec=function(sql) {
    const result=original.call(this,sql); if(sql==="COMMIT") process.kill(process.pid,"SIGKILL"); return result; };
    const service=await jiti.import(${servicePath}); await service.executeSessionMutation(${JSON.stringify(command())}, async()=>new Response());`);
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  legacy(root, command({ operationId: "external-legacy-write" }));
  let effects = 0;
  await assert.rejects(service.executeSessionMutation(command(), async () => { effects++; return new Response(); }), /Legacy receipts changed/);
  assert.equal(effects, 0);
});

test("committed reservation with a lost COMMIT response remains replay-safe", async (t) => {
  const root = fixture(t);
  await store.reserveControlReceipt({ deviceId: target.id, sessionId: "seed", operation: "prompt", idempotencyKey: "seed-operation", requestFingerprint: "f", cwd: "fixture" });
  const failed = child(root, `const original=DatabaseSync.prototype.exec; let injected=false;
    DatabaseSync.prototype.exec=function(sql) { const result=original.call(this,sql); if(sql==="COMMIT"&&!injected) { injected=true; throw Object.assign(Error("lost commit response"), {code:"EIO"}); } return result; };
    const service=await jiti.import(${servicePath});
    try { await service.executeSessionMutation(${JSON.stringify(command())}, async()=>{ fs.writeFileSync(${JSON.stringify(join(root,"effect"))},"effect"); return new Response(); }); }
    catch(error) { process.stdout.write(error.message); }`);
  assert.equal(failed.status, 0, failed.stderr); assert.match(failed.stdout, /lost commit response/);
  let effects = 0;
  assert.equal((await service.executeSessionMutation(command(), async () => { effects++; return new Response(); })).status, "unknown");
  assert.equal(effects, 0);
  assert.equal((await service.listSessionMutations()).operations[0].receipt.status, "unknown");
});

test("process death after deletion effect leaves independently discoverable unknown and a permanent anti-replay ID", async (t) => {
  const root = fixture(t);
  const killed = child(root, `const service=await jiti.import(${servicePath});
    await service.executeSessionMutation(${JSON.stringify(command())}, async()=>{
      fs.appendFileSync(${JSON.stringify(join(root,"effects"))},"deleted\\n"); process.kill(process.pid,"SIGKILL"); return new Response(); });`);
  assert.equal(killed.signal, "SIGKILL", killed.stderr);
  assert.equal(readFileSync(join(root,"effects"),"utf8"),"deleted\n");
  const page = await service.listSessionMutations();
  assert.equal(page.operations[0].receipt.status,"unknown");
  assert.deepEqual(page.operations[0].command,command());
  let effects = 0;
  assert.equal((await service.executeSessionMutation(command(),async()=>{effects++;return new Response();})).status,"unknown");
  assert.equal(effects,0);
  assert.equal(await service.acknowledgeSessionMutation(command(),false),false);
  assert.equal(await service.acknowledgeSessionMutation(command(),true),true);
  assert.equal((await service.listSessionMutations()).operations.length,0,"manual review only removes reminder");
  assert.equal((await service.querySessionMutation(command())).status,"unknown");
  assert.equal((await service.executeSessionMutation(command(),async()=>{effects++;return new Response();})).status,"unknown");
  assert.equal(effects,0);
});

test("corrupt indexed storage fails before business effects and queries never report absence", async (t) => {
  fixture(t); await service.executeSessionMutation(command(),async()=>new Response());
  writeFileSync(store.controlReceiptDatabasePath(),"corrupt database");
  await assert.rejects(service.querySessionMutation(command()));
  let effects=0;
  await assert.rejects(service.executeSessionMutation(command({operationId:"another-operation"}),async()=>{effects++;return new Response();}));
  assert.equal(effects,0);
});

test("indexed read and replay use indexed equality lookups rather than decoding unrelated malformed history", async (t) => {
  fixture(t); await service.executeSessionMutation(command(),async()=>new Response());
  const other=await store.reserveControlReceipt({deviceId:target.id,sessionId:"other",operation:"prompt",idempotencyKey:"unrelated-bad-entry",requestFingerprint:"f",cwd:"fixture"});
  const db=new DatabaseSync(store.controlReceiptDatabasePath());
  db.prepare("UPDATE receipts SET json='invalid' WHERE receipt_id=?").run(other.receipt.receiptId); db.close();
  assert.equal((await service.querySessionMutation(command())).status,"completed");
  assert.equal((await service.executeSessionMutation(command(),async()=>{throw Error("replay");})).status,"completed");
  await assert.rejects(store.readControlReceipt({deviceId:target.id,sessionId:"other",receiptId:other.receipt.receiptId}));
});

for (const oldStatus of [404,405,200,503]) {
  test(`old peer capability HTTP ${oldStatus} requires upgrade before any POST or pending lock`, async (t) => {
    const prior=globalThis.fetch, calls=[];
    globalThis.fetch=async (url,init)=>{calls.push({url,init});return new Response(JSON.stringify(oldStatus===503?{error:"Mutation receipt unavailable"}:{old:true}),{status:oldStatus});};
    t.after(()=>{globalThis.fetch=prior;});
    const perform=client.createRemoteSessionMutationClient({openBridge:async()=>{throw Error("should not need bridge");}});
    const actual=await perform(target,"delete","session",undefined,true);
    assert.equal(actual.notSent,true); assert.equal(actual.upgradeRequired,true); assert.equal(actual.status,"failed");
    assert.equal(perform.snapshot().length,0); assert.equal(calls.length,1); assert.equal(calls[0].init.method,"GET");
    assert.match(calls[0].url,/capabilities=1/);
  });
}

test("readiness/capability unavailable never admits an effect or creates a permanent unknown", async (t) => {
  const old=globalThis.fetch; globalThis.fetch=async()=>{throw Error("offline");};t.after(()=>{globalThis.fetch=old;});
  const calls=[];
  const perform=client.createRemoteSessionMutationClient({proxy:async()=>{calls.push("POST");throw Error("unexpected");},openBridge:async()=>{calls.push("ready");throw Error("no ready");}});
  const actual=await perform(target,"delete","session");
  assert.equal(actual.notSent,true); assert.equal(perform.snapshot().length,0); assert.deepEqual(calls,["ready"]);
});

test("reload without browser storage discovers vanished session operations and only queries their original IDs", async () => {
  const input=command(), calls=[]; let outcome="unknown";
  const perform=client.createRemoteSessionMutationClient({...available,discovery:async()=>({operations:[{command:input,receipt:result(input,outcome),updatedAt:"now"}]}),
    proxy:async(mode,value)=>{calls.push({mode,value});return result(value,outcome);}});
  await perform.recover([target]);
  assert.equal(perform.snapshot().length,1); assert.equal(perform.snapshot()[0].command.force,true);
  assert.deepEqual(calls.map(c=>c.mode),["query"]);
  outcome="completed";await perform.recover([target]);
  assert.equal(perform.snapshot()[0].receipt.status,"completed","late result stays visible until reviewed");
  assert.equal(perform.snapshot()[0].confirmed,true);
  assert.equal(await perform.review(input.operationId,input.deviceId),true);
  assert.equal(perform.snapshot().length,0);
  assert.equal(calls.some(c=>c.mode==="execute"),false);
});

test("a new rename/archive intent queries the old operation and requires a separate click after resolution", async () => {
  const calls=[], data=new Map();let status="unknown",seq=0;
  const perform=client.createRemoteSessionMutationClient({...available,storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)},uuid:()=>`operation-${++seq}`,
    proxy:async(mode,input)=>{calls.push({mode,input});return result(input,status);}});
  await perform(target,"rename","session","B",true);
  status="completed";
  const second=await perform(target,"rename","session","C",false);
  assert.equal(second.previousOperation,true);assert.equal(second.status,"completed");
  assert.deepEqual(calls.map(c=>[c.mode,c.input.name,c.input.force]),[["execute","B",true],["query","B",true]]);
  await perform(target,"archive","session",undefined,false);
  assert.equal(calls.at(-1).mode,"execute");assert.equal(calls.at(-1).input.op,"archive");assert.equal(seq,2);
});

test("reload queries an absent original receipt without resubmitting even when the old POST may arrive late", async () => {
  const input=command(), calls=[];
  const saved=JSON.stringify([{target,command:input,receipt:result(input,"unknown")}]);
  const perform=client.createRemoteSessionMutationClient({...available,storage:{getItem:key=>key.endsWith("v2")?saved:null,setItem(){}},
    proxy:async(mode,value)=>{calls.push(mode);return result(value,"not_found");}});
  await perform.recover();
  assert.deepEqual(calls,["query"]);assert.equal(perform.snapshot()[0].receipt.status,"not_found");
});

test("server-backed recovery blocks a new intent even when browser storage is corrupt or full", async () => {
  const input=command(),calls=[];
  const perform=client.createRemoteSessionMutationClient({...available,storage:{getItem:()=>"corrupt",setItem(){throw Error("quota");}},
    discovery:async()=>({operations:[{command:input,receipt:result(input,"unknown"),updatedAt:"now"}]}),
    proxy:async(mode,value)=>{calls.push({mode,value});return result(value,"unknown");}});
  const actual=await perform(target,"rename",input.sessionId,"New name",false);
  assert.equal(actual.previousOperation,true);assert.equal(actual.operationId,input.operationId);
  assert.deepEqual(calls.map(c=>c.mode),["query"]);assert.deepEqual(calls[0].value,input);
});

test("failed recovery discovery blocks new effects without locking out later recovery", async () => {
  const calls=[];let offline=true;
  const perform=client.createRemoteSessionMutationClient({...available,storage:{getItem:()=>null,setItem(){}},uuid:()=>"recovered-operation",discovery:async()=>{if(offline)throw Error("unavailable");return{operations:[]};},
    proxy:async(mode,input)=>{calls.push(mode);return result(input,"completed");}});
  assert.equal((await perform(target,"delete","session")).notSent,true);assert.equal(perform.snapshot().length,0);assert.deepEqual(calls,[]);
  offline=false;assert.equal((await perform(target,"delete","session")).status,"completed");assert.deepEqual(calls,["execute"]);
});


test("unavailable browser storage refuses a fresh POST before creating an invisible in-flight intent", async () => {
  for (const storage of [undefined, { getItem: () => null, setItem() { throw Error("quota"); } }]) {
    const calls = [];
    const perform = client.createRemoteSessionMutationClient({ ...available, storage, uuid: () => "unsaved-operation",
      proxy: async (mode, input) => { calls.push(mode); return result(input, "unknown"); } });
    const value = await perform(target, "delete", "session");
    assert.equal(value.notSent, true); assert.equal(perform.snapshot().length, 0); assert.deepEqual(calls, []);
  }
});


test("marker rename followed by repeated directory fsync EIO keeps admission blocked until recovery sync succeeds", async (t) => {
  const root = fixture(t); legacy(root);
  const input = command({ operationId: "post-migration-new-operation" });
  const fault = child(root, `let markerRenamed=false, attempts=0; const rename=fs.renameSync, sync=fs.fsyncSync;
    fs.renameSync=function(from,to){const value=rename(from,to);if(to===${JSON.stringify(join(root,"receipts.json"))})markerRenamed=true;return value;};
    fs.fsyncSync=function(fd){if(markerRenamed&&fs.fstatSync(fd).isDirectory()){attempts++;throw Object.assign(Error("directory EIO"),{code:"EIO"});}return sync(fd);};
    syncBuiltinESMExports(); const service=await jiti.import(${servicePath});const outcomes=[];
    for(let i=0;i<2;i++){try{await service.executeSessionMutation(${JSON.stringify(input)},async()=>{fs.appendFileSync(${JSON.stringify(join(root,"effects"))},"duplicate");return new Response();});outcomes.push("executed");}catch(error){outcomes.push(error.code);}}
    process.stdout.write(JSON.stringify({attempts,outcomes}));`);
  assert.equal(fault.status,0,fault.stderr);
  assert.deepEqual(JSON.parse(fault.stdout),{attempts:2,outcomes:["EIO","EIO"]});
  assert.equal(readdirSync(root).includes("effects"),false);
  let effects=0;assert.equal((await service.executeSessionMutation(input,async()=>{effects++;return new Response();})).status,"completed");
  assert.equal(effects,1);assert.equal((await service.querySessionMutation(command())).status,"completed");
});


test("failed discovery stays explicitly incomplete rather than being presented as a verified empty list", async () => {
  const perform=client.createRemoteSessionMutationClient({...available,discovery:async()=>{throw Error("offline");}});
  const recovery=await perform.recover([target]);
  assert.deepEqual(recovery.unavailableTargets,[target]);assert.deepEqual(perform.snapshot(),[]);
});


test("managed receipt symlinks share one indexed authority and migration backup", async (t) => {
  const root=fixture(t), old=legacy(root), alias=join(root,"alias");mkdirSync(alias);
  symlinkSync(join(root,"receipts.json"),join(alias,"receipts.json"));
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT=alias;
  let effects=0;
  assert.equal((await service.executeSessionMutation(command(),async()=>{effects++;return new Response();})).status,"completed");
  const input=command({operationId:"symlink-new-operation"});
  assert.equal((await service.executeSessionMutation(input,async()=>{effects++;return new Response();})).status,"completed");
  assert.equal(store.controlReceiptDatabasePath(),join(realpathSync(root),"receipts.sqlite"));
  assert.equal(existsSync(join(alias,"receipts.sqlite")),false);
  assert.equal(readFileSync(join(root,"receipts.legacy.json"),"utf8"),old.raw);
  process.env.PI_WEB_CONTROL_RECEIPT_ROOT=root;
  assert.equal((await service.executeSessionMutation(input,async()=>{effects++;return new Response();})).status,"completed");
  assert.equal(effects,1);
});

for (const terminal of ["completed", "failed", "conflict"]) {
  test(`${terminal} receipt survives offline discovery, query and browser reload without another POST`, async () => {
    const input=command(), original={...result(input,terminal),httpStatus:terminal==="completed"?200:409}, calls=[], data=new Map();
    let offline=false;
    const settings={...available,storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)},
      discovery:async()=>{if(offline)throw Error("offline");return{operations:[{command:input,receipt:original,updatedAt:"now"}]};},
      proxy:async(mode,value)=>{calls.push({mode,value});if(offline)throw Error("offline");return original;}};
    const perform=client.createRemoteSessionMutationClient(settings);
    await perform.recover([target]);
    assert.deepEqual(perform.snapshot()[0].receipt,original);
    offline=true;
    const refresh=await perform.recover([target]);
    assert.deepEqual(refresh.unavailableTargets,[target],"current discovery remains incomplete");
    assert.deepEqual(perform.snapshot()[0].receipt,original);
    assert.equal(perform.snapshot()[0].confirmed,true);
    const queried=await perform.query(input.operationId,input.deviceId);
    assert.equal(queried.status,terminal);assert.equal(queried.refreshUnavailable,true);
    const reloaded=client.createRemoteSessionMutationClient(settings);
    await reloaded.recover([target]);
    assert.deepEqual(reloaded.snapshot()[0].receipt,original);
    assert.equal(reloaded.snapshot()[0].confirmed,true);
    assert.ok(calls.every(call=>call.mode==="query"));
  });
}

test("stale discovery and an absent query cannot replace a completed fact or hide unavailable observation", async () => {
  const input=command(), original={...result(input,"completed"),httpStatus:200}, data=new Map(), calls=[];
  let stale=false;
  const perform=client.createRemoteSessionMutationClient({...available,storage:{getItem:key=>data.get(key)??null,setItem:(key,value)=>data.set(key,value)},
    discovery:async()=>({operations:[{command:input,receipt:stale?result(input,"unknown"):original,updatedAt:"now"}]}),
    proxy:async(mode,value)=>{calls.push(mode);return stale?result(value,"not_found"):original;}});
  await perform.recover([target]);stale=true;
  const observed=await perform.recover([target]);
  assert.deepEqual(perform.snapshot()[0].receipt,original);
  assert.equal(perform.snapshot()[0].confirmed,true);
  assert.deepEqual(observed.unavailableTargets,[target]);
  assert.deepEqual(calls,["query","query"]);
});
