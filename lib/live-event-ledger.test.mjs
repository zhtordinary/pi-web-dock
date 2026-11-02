import assert from "node:assert/strict";
import fs, { appendFileSync, existsSync, mkdirSync, renameSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { spawn } from "node:child_process";

const ledger = await createJiti(import.meta.url).import("./live-event-ledger.ts");
function fixture(t) {
  const previous = process.env.PI_WEB_LIVE_EVENT_STATE_ROOT;
  const root = mkdtempSync(join(tmpdir(), "reader-live-ledger-"));
  process.env.PI_WEB_LIVE_EVENT_STATE_ROOT = root;
  t.after(() => {
    if (previous === undefined) delete process.env.PI_WEB_LIVE_EVENT_STATE_ROOT;
    else process.env.PI_WEB_LIVE_EVENT_STATE_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const input = (cursor, bootId = "boot-a") => ({ sessionId: "isolated", deviceId: "test-device", bootId, cursor,
    event: { type: "agent_start", text: `event-${cursor}` } });
  return { root, input, path: ledger.liveEventLedgerPath("isolated", "test-device"),
    read: () => ledger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }) };
}

test("a fresh process cannot infer complete prefix coverage from the first readable cursor", (t) => {
  const f = fixture(t);
  assert.equal(ledger.appendDurableLiveEvent(f.input(2)).persisted, true);
  const result = f.read();
  assert.equal(result.writeFailureObserved, false);
  assert.equal(result.records[0].cursor, 2);
  assert.equal(result.coverageComplete, false);
  assert.equal(ledger.readDurableLiveEventRecords("isolated", { deviceId: "test-device", cursor: 1 }).coverageComplete, true,
    "coverage only describes the explicitly requested retained range");
});

test("ledger direct writer rejects a physical legacy lock through a root alias", (t) => {
  const f = fixture(t);
  const alias = join(tmpdir(), `reader-live-ledger-alias-${process.pid}-${Date.now()}`);
  symlinkSync(f.root, alias);
  t.after(() => rmSync(alias, { force: true }));
  const physicalLock = `${f.path}.lock`;
  mkdirSync(physicalLock);
  process.env.PI_WEB_LIVE_EVENT_STATE_ROOT = alias;

  const result = ledger.appendDurableLiveEvent(f.input(1));
  assert.equal(result.persisted, false);
  assert.equal(existsSync(f.path), false, "legacy lock rejection must not create ledger bytes");
});

test("actual stopped projection binds the current Reader process and preserves the historical runtime as metadata", async (t) => {
  const f = fixture(t); const previous = process.env.PI_WEB_SESSION_ACTIVITY_CONFIG;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device: { id: "test-device", name: "fixture" }, peers: [] });
  t.after(() => { if (previous === undefined) delete process.env.PI_WEB_SESSION_ACTIVITY_CONFIG; else process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = previous; });
  assert.equal(ledger.appendDurableLiveEvent(f.input(1, "old-process:runtime")).persisted, true);
  const { readStoppedSessionLiveEvents } = await createJiti(import.meta.url).import("./rpc-manager.ts");
  const snapshot = readStoppedSessionLiveEvents("isolated", { cursor: 0, limit: 100, maxBytes: 131072 });
  assert.equal(snapshot.events.length, 1);
  assert.equal(snapshot.bootId, snapshot.readerBootId);
  assert.notEqual(snapshot.bootId, "old-process:runtime");
  assert.equal(snapshot.bootScope, "reader-process");
  assert.equal(snapshot.replayedRuntimeBootId, "old-process:runtime");
});

test("bounded durable ledger replays across boots with monotonic cursors and explicit retention", (t) => {
  const f = fixture(t);
  for (let cursor = 1; cursor <= 520; cursor += 1) {
    assert.equal(ledger.appendDurableLiveEvent(f.input(cursor, cursor > 510 ? "boot-b" : "boot-a")).persisted, true);
  }
  const result = f.read();
  assert.equal(result.durableAvailable, true);
  assert.equal(result.latestBootId, "boot-b");
  assert.equal(result.records.length, 512);
  assert.equal(result.records[0].cursor, 9);
  assert.equal(result.records.at(-1).cursor, 520);
  assert.equal(ledger.appendDurableLiveEvent(f.input(520)).cursor, 521, "stale worker allocates from the locked durable tail");
});

test("missing, failed and internally discontinuous ledgers never claim complete coverage", (t) => {
  const f = fixture(t);
  assert.equal(f.read().durableAvailable, false);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, true);
  assert.equal(ledger.appendDurableLiveEvent(f.input(3)).persisted, true);
  const gap = f.read(); assert.equal(gap.coverageComplete, false);
  assert.deepEqual(gap.gap, { afterCursor: 1, recoverFromCursor: 2 });
  const before = readFileSync(f.path);
  // A valid JSON record can still exceed the per-event contract.
  writeFileSync(f.path, JSON.stringify({ schemaVersion: 1, ...f.input(4), recordedAt: new Date().toISOString(),
    event: { type: "agent_start", text: "x".repeat(2 * 1024 * 1024) } }) + "\n");
  assert.equal(f.read().durableAvailable, false);
  assert.equal(ledger.appendDurableLiveEvent(f.input(5)).persisted, false);
  writeFileSync(f.path, before);
  assert.equal(f.read().writeFailureObserved, true, "repairing bytes cannot erase this process's observed write failure");
  assert.equal(f.read().coverageComplete, false);
});

test("independent worker processes allocate unique cursors while holding the same ledger lock", async (t) => {
  const f = fixture(t);
  for (let cursor = 1; cursor <= 630; cursor++) assert.equal(ledger.appendDurableLiveEvent(f.input(cursor)).persisted, true);
  const script = `import { createJiti } from "jiti";
    const ledger = await createJiti(${JSON.stringify(import.meta.url)}).import(${JSON.stringify(new URL("./live-event-ledger.ts", import.meta.url).pathname)});
    for (let i = 0; i < 10; i++) {
      let result;
      for (let attempt = 0; attempt < 200; attempt++) {
        result = ledger.appendDurableLiveEvent({ sessionId: "isolated", deviceId: "test-device", bootId: "worker-" + process.pid,
          cursor: 1, event: { type: "agent_start", worker: process.pid, index: i } });
        if (result.persisted) break;
        await new Promise(r => setTimeout(r, 5));
      }
      if (!result?.persisted) throw new Error("worker did not acquire the bounded writer lock");
    }`;
  await Promise.all(Array.from({ length: 3 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { cwd: process.cwd(),
      env: { PATH: process.env.PATH, HOME: f.root, PI_WEB_LIVE_EVENT_STATE_ROOT: f.root }, stdio: ["ignore", "ignore", "pipe"] });
    let diagnostic = ""; child.stderr.on("data", chunk => { diagnostic = (diagnostic + chunk).slice(-1000); });
    child.on("error", reject); child.on("exit", code => code === 0 ? resolve() : reject(new Error(diagnostic)));
  })));
  const result = f.read();
  assert.equal(result.durableAvailable, true);
  assert.equal(result.records.length, 512);
  assert.deepEqual(result.records.map(r => r.cursor), Array.from({ length: 512 }, (_, index) => index + 149));
  assert.equal(new Set(result.records.filter(r => r.event.worker).map(r => r.event.worker)).size, 3);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).cursor, 661, "parent reloads allocation metadata after other processes compact");
});

test("corrupt, torn, wrong-device and duplicate cursors are incomplete and never rewritten", (t) => {
  const f = fixture(t);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, true);
  const valid = readFileSync(f.path, "utf8");
  for (const invalid of [valid + "broken\n", valid.slice(0, -1), valid + valid,
    valid.replace('"test-device"', '"other-device"')]) {
    writeFileSync(f.path, invalid);
    assert.equal(f.read().durableAvailable, false);
    assert.deepEqual(f.read().records, []);
    assert.equal(ledger.appendDurableLiveEvent(f.input(2)).persisted, false);
    assert.equal(readFileSync(f.path, "utf8"), invalid);
  }
});

test("oversized and symlink ledgers fail closed without following or replacing the target", (t) => {
  const f = fixture(t);
  writeFileSync(f.path, "x".repeat(3 * 1024 * 1024));
  assert.equal(f.read().durableAvailable, false);
  rmSync(f.path);
  const target = join(f.root, "preserved"); writeFileSync(target, "preserved");
  symlinkSync(target, f.path);
  assert.equal(f.read().durableAvailable, false);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, false);
  assert.equal(readFileSync(target, "utf8"), "preserved");
});

test("a ledger changed after this process's append is validated again before the next cursor", (t) => {
  const f = fixture(t);
  const line = (cursor) => JSON.stringify({ schemaVersion: 1, ...f.input(cursor), recordedAt: new Date().toISOString() }) + "\n";
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).cursor, 1);
  appendFileSync(f.path, line(40));
  assert.equal(ledger.appendDurableLiveEvent(f.input(2)).cursor, 41, "another writer's append moves the tail");
  const compacted = join(f.root, "compacted");
  writeFileSync(compacted, line(60) + line(61));
  renameSync(compacted, f.path);
  assert.equal(ledger.appendDurableLiveEvent(f.input(3)).cursor, 62, "another writer's compaction replaces the file");
  assert.deepEqual(f.read().records.map((record) => record.cursor), [60, 61, 62]);
  rmSync(f.path);
  const target = join(f.root, "preserved"); writeFileSync(target, "preserved");
  symlinkSync(target, f.path);
  assert.equal(ledger.appendDurableLiveEvent(f.input(4)).persisted, false);
  assert.equal(readFileSync(target, "utf8"), "preserved");
});

test("compaction rewrites once per slack window and keeps the retained replay window", (t) => {
  const f = fixture(t);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, true);
  const original = statSync(f.path).ino;
  for (let cursor = 2; cursor <= 640; cursor += 1) {
    assert.equal(ledger.appendDurableLiveEvent(f.input(cursor)).persisted, true);
  }
  assert.equal(statSync(f.path).ino, original, "appends within the slack never rewrite the file");
  const before = f.read();
  assert.equal(before.records.length, 512);
  assert.equal(before.records[0].cursor, 129);
  assert.equal(ledger.appendDurableLiveEvent(f.input(641)).cursor, 641);
  assert.notEqual(statSync(f.path).ino, original, "crossing the slack compacts");
  assert.equal(readFileSync(f.path, "utf8").trimEnd().split("\n").length, 512);
  const after = f.read();
  assert.equal(after.records[0].cursor, 130);
  assert.equal(after.records.at(-1).cursor, 641);
  assert.equal(ledger.appendDurableLiveEvent(f.input(641)).cursor, 642, "the compacted tail keeps allocating");
});

test("byte-bound ledgers stay within the read bound shared with earlier Readers", (t) => {
  const f = fixture(t);
  const large = (cursor) => ({ ...f.input(cursor), event: { type: "tool_execution_update", text: "x".repeat(30 * 1024) } });
  for (let cursor = 1; cursor <= 120; cursor += 1) {
    assert.equal(ledger.appendDurableLiveEvent(large(cursor)).persisted, true);
    assert.ok(statSync(f.path).size <= ledger.LIVE_EVENT_LEDGER_MAX_BYTES + 128 * 1024);
  }
  const result = f.read();
  assert.equal(result.durableAvailable, true);
  assert.equal(result.records.at(-1).cursor, 120);
  const retainedBytes = result.records.length * Buffer.byteLength(JSON.stringify({ schemaVersion: 1, ...large(120),
    recordedAt: new Date().toISOString() }) + "\n");
  assert.ok(retainedBytes <= ledger.LIVE_EVENT_LEDGER_MAX_BYTES);
});

test("steady-state append avoids full ledger reads and compacts in batches", async (t) => {
  const f = fixture(t);
  let reads = 0;
  let compactions = 0;
  const originalRead = fs.readSync;
  const originalRename = fs.renameSync;
  t.mock.method(fs, "readSync", (...args) => { reads++; return originalRead(...args); });
  t.mock.method(fs, "renameSync", (...args) => {
    if (args[1] === f.path) compactions++;
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const isolatedLedger = await createJiti(import.meta.url, { moduleCache: false }).import("./live-event-ledger.ts");
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  for (let cursor = 1; cursor <= 1000; cursor++) {
    assert.equal(isolatedLedger.appendDurableLiveEvent(f.input(cursor)).persisted, true);
  }
  assert.ok(compactions >= 1 && compactions <= 4, `expected batched compaction, got ${compactions}`);
  assert.ok(reads >= compactions && reads <= 12, `hot path reread the full ledger ${reads} times`);
  t.diagnostic(`1000 appends: ${reads} full-read syscalls, ${compactions} atomic compactions`);
  const raw = readFileSync(f.path, "utf8").trim().split("\n");
  assert.ok(raw.length <= ledger.LIVE_EVENT_LEDGER_COMPACT_EVENTS);
  const result = f.read();
  assert.equal(result.records.length, 512);
  assert.equal(result.lastPersistedCursor, 1000);
  assert.equal(result.records[0].cursor, 489);
});

test("byte threshold retains a bounded newest window while leaving compaction headroom", (t) => {
  const f = fixture(t);
  for (let cursor = 1; cursor <= 180; cursor++) {
    const input = f.input(cursor);
    input.event.text = "x".repeat(30 * 1024);
    assert.equal(ledger.appendDurableLiveEvent(input).persisted, true);
    assert.ok(statSync(f.path).size <= ledger.LIVE_EVENT_LEDGER_COMPACT_BYTES);
  }
  const raw = readFileSync(f.path, "utf8").trim().split("\n").map(JSON.parse);
  const result = f.read();
  assert.equal(result.lastPersistedCursor, 180);
  assert.ok(result.records.length < 100);
  assert.equal(result.records.at(-1).cursor, 180);
  const retained = raw.slice(-result.records.length);
  const bytes = retained.reduce((sum, record) => sum + Buffer.byteLength(JSON.stringify(record)) + 1, 0);
  assert.ok(bytes <= ledger.LIVE_EVENT_LEDGER_MAX_BYTES);
  assert.ok(bytes + Buffer.byteLength(JSON.stringify(raw[0])) + 1 > ledger.LIVE_EVENT_LEDGER_MAX_BYTES);
});

test("maintenance failure preserves acknowledged append and retries compaction before growing", async (t) => {
  const f = fixture(t);
  for (let cursor = 1; cursor <= ledger.LIVE_EVENT_LEDGER_COMPACT_EVENTS; cursor++) {
    assert.equal(ledger.appendDurableLiveEvent(f.input(cursor)).persisted, true);
  }
  const originalRename = fs.renameSync;
  let failCompaction = true;
  t.mock.method(fs, "renameSync", (...args) => {
    if (failCompaction && args[1] === f.path) throw new Error("injected compaction failure");
    return originalRename(...args);
  });
  syncBuiltinESMExports();
  const isolatedLedger = await createJiti(import.meta.url, { moduleCache: false }).import("./live-event-ledger.ts");
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const committed = isolatedLedger.appendDurableLiveEvent(f.input(641));
  assert.equal(committed.persisted, true);
  assert.equal(committed.cursor, 641);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).lastPersistedCursor, 641);
  const before = readFileSync(f.path, "utf8");
  assert.equal(isolatedLedger.appendDurableLiveEvent(f.input(642)).persisted, false);
  assert.equal(readFileSync(f.path, "utf8"), before);
  failCompaction = false;
  assert.equal(isolatedLedger.appendDurableLiveEvent(f.input(642)).cursor, 642);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).records.at(-1).cursor, 642);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).lastPersistedCursor, 642);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).writeFailureObserved, false);
});

test("cached allocation fails closed after complete-line truncation or removal", (t) => {
  const f = fixture(t);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, true);
  const first = readFileSync(f.path, "utf8");
  assert.equal(ledger.appendDurableLiveEvent(f.input(2)).persisted, true);
  const complete = readFileSync(f.path, "utf8");
  writeFileSync(f.path, first);
  assert.equal(f.read().durableAvailable, false);
  assert.equal(f.read().lastPersistedCursor, null);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, false);
  assert.equal(readFileSync(f.path, "utf8"), first);
  rmSync(f.path);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, false);
  writeFileSync(f.path, complete);
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).cursor, 3);
});

test("invalid allocation and fsync failures never return successful append receipts", async (t) => {
  const f = fixture(t);
  for (const cursor of [0, -1, NaN, Number.MAX_SAFE_INTEGER + 1]) {
    assert.equal(ledger.appendDurableLiveEvent(f.input(cursor)).persisted, false);
  }
  assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted, true);
  let failSync = true;
  const originalSync = fs.fsyncSync;
  t.mock.method(fs, "fsyncSync", (...args) => {
    if (failSync) throw new Error("injected fsync failure");
    return originalSync(...args);
  });
  syncBuiltinESMExports();
  const isolatedLedger = await createJiti(import.meta.url, { moduleCache: false }).import("./live-event-ledger.ts");
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const result = isolatedLedger.appendDurableLiveEvent(f.input(2));
  assert.equal(result.persisted, false);
  assert.equal(result.cursor, undefined);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).lastPersistedCursor, 1,
    "readable new bytes do not advance the previously confirmed durable prefix");
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).coverageComplete, false);
  assert.equal(isolatedLedger.readDurableLiveEventRecords("isolated", { deviceId: "test-device" }).writeFailureObserved, true);
  failSync = false;
  assert.equal(isolatedLedger.appendDurableLiveEvent(f.input(2)).cursor, 3, "uncertain prior bytes are not allocated twice");
  const recovered=isolatedLedger.readDurableLiveEventRecords("isolated", {deviceId:"test-device"});
  assert.equal(recovered.lastPersistedCursor,3);assert.equal(recovered.writeFailureObserved,false);assert.equal(recovered.coverageComplete,true);
});


test("a recovered lock conflict restores watermark without hiding the missing event cursor",async t=>{
 const f=fixture(t);assert.equal(ledger.appendDurableLiveEvent(f.input(1)).persisted,true);
 const {acquireStateWriteLock}=await import('../bin/state-write-lock.cjs');const release=acquireStateWriteLock(f.path);
 try {assert.equal(ledger.appendDurableLiveEvent(f.input(2)).persisted,false);}finally{release();}
 assert.equal(f.read().lastPersistedCursor,1);
 assert.equal(ledger.appendDurableLiveEvent(f.input(3)).persisted,true);
 const recovered=f.read();assert.equal(recovered.lastPersistedCursor,3);assert.equal(recovered.writeFailureObserved,false);
 assert.equal(recovered.coverageComplete,false);assert.deepEqual(recovered.gap,{afterCursor:1,recoverFromCursor:2});
});

test('first-file directory sync failure must recover before any append is acknowledged',async t=>{
 const f=fixture(t);const originalSync=fs.fsyncSync;let fail=true,calls=0;
 t.mock.method(fs,'fsyncSync',fd=>{if(fs.fstatSync(fd).isDirectory()){calls++;if(fail)throw Object.assign(new Error('directory EIO'),{code:'EIO'});}return originalSync(fd)});
 syncBuiltinESMExports();t.after(()=>{t.mock.restoreAll();syncBuiltinESMExports()});
 const isolated=await createJiti(import.meta.url,{moduleCache:false}).import('./live-event-ledger.ts');
 assert.equal(isolated.appendDurableLiveEvent(f.input(1)).persisted,false);
 assert.equal(isolated.appendDurableLiveEvent(f.input(2)).persisted,false);assert.equal(calls,2);
 assert.equal(isolated.readDurableLiveEventRecords('isolated',{deviceId:'test-device'}).lastPersistedCursor,0);
 fail=false;assert.equal(isolated.appendDurableLiveEvent(f.input(3)).persisted,true);assert.equal(calls,3);
 const recovered=isolated.readDurableLiveEventRecords('isolated',{deviceId:'test-device'});
 assert.equal(recovered.lastPersistedCursor,3);assert.equal(recovered.writeFailureObserved,false);
});
