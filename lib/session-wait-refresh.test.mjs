import assert from "node:assert/strict";
import test from "node:test";
import { createWaitStatusRefresher } from "./session-wait-client.ts";

test("in-flight wait invalidations coalesce and serialized reads keep progress visible",async()=>{
 const reads=[],applied=[];const r=createWaitStatusRefresher(()=>new Promise(resolve=>reads.push(resolve)),v=>applied.push(v),e=>{throw e});
 const first=r.refresh();r.refresh();r.refresh();assert.equal(reads.length,1);
 reads.shift()("stale");await Promise.resolve();assert.deepEqual(applied,["stale"]);assert.equal(reads.length,1);
 reads.shift()("current");await first;assert.deepEqual(applied,["stale","current"]);r.dispose();
});
test("switching peer or unmount cancels writes from an obsolete refresh",async()=>{
 let resolve,signal;const applied=[];const r=createWaitStatusRefresher(s=>{signal=s;return new Promise(done=>resolve=done)},v=>applied.push(v),()=>{});
 const pending=r.refresh();r.dispose();assert.equal(signal.aborted,true);resolve("old peer");await pending;assert.deepEqual(applied,[]);
});

test("continuous changes do not keep a control refresh promise busy forever",async()=>{
 const reads=[],applied=[];const r=createWaitStatusRefresher(()=>new Promise(resolve=>reads.push(resolve)),v=>applied.push(v),()=>{});
 const first=r.refresh();r.refresh();reads.shift()(1);await Promise.resolve();
 r.refresh();reads.shift()(2);await first;assert.deepEqual(applied,[1,2]);r.dispose();
});

test("ongoing invalidations do not hide a status-read failure",async()=>{
 const reads=[],errors=[];const r=createWaitStatusRefresher(()=>new Promise((_resolve,reject)=>reads.push(reject)),()=>{},e=>errors.push(e.message));
 const first=r.refresh();r.refresh();reads.shift()(new Error("offline"));await Promise.resolve();assert.deepEqual(errors,["offline"]);
 reads.shift()(new Error("still offline"));await first;assert.deepEqual(errors,["offline","still offline"]);r.dispose();
});
