import assert from "node:assert/strict";
import test from "node:test";
import { createReaderEventStream } from "./reader-event-stream.ts";

const frame=bytes=>JSON.parse(new TextDecoder().decode(bytes).slice(6).trim());
test("subscriptions precede all authoritative snapshots and live events remain immediate",async()=>{
 const controller=new AbortController();let live,stopped=0;
 const stream=createReaderEventStream(new Request("http://localhost/api/reader/events",{signal:controller.signal}),{
  subscribe(emit,register){live=emit;register(()=>stopped++);},
  snapshot(){assert.equal(typeof live,"function");return [{type:"running",runningSessionIds:["s"]},{type:"waiting_user",sessions:[{sessionId:"s",requestIds:["q"]}]},{type:"waits_changed"}]}
 });
 const reader=stream.getReader();
 for(const type of ["running","waiting_user","waits_changed"])assert.equal(frame((await reader.read()).value).type,type);
 live({type:"activity",device:"peer",seq:1,runId:"run",status:"completed"});
 assert.equal(frame((await reader.read()).value).runId,"run");
 controller.abort();assert.equal(stopped,1);assert.equal((await reader.read()).done,true);
});
test("consumer cancellation and partial startup failure release every registered resource",async()=>{
 let released=0;
 const stream=createReaderEventStream(new Request("http://localhost"),{subscribe(_emit,register){register(()=>released++)},snapshot:()=>[]});
 await stream.cancel();assert.equal(released,1);
 const broken=createReaderEventStream(new Request("http://localhost"),{subscribe(_emit,register){register(()=>released++);throw new Error("offline source")},snapshot:()=>[]});
 const reader=broken.getReader();assert.equal(frame((await reader.read()).value).type,"transport_error");assert.equal((await reader.read()).done,true);assert.equal(released,2);
});
test("already aborted requests never subscribe",async()=>{
 const c=new AbortController();c.abort();let n=0;
 const stream=createReaderEventStream(new Request("http://localhost",{signal:c.signal}),{subscribe(){n++},snapshot:()=>[]});
 assert.equal((await stream.getReader().read()).done,true);assert.equal(n,0);
});

test("notification streams participate in the existing graceful-shutdown registry",async()=>{
 let stopped=0;
 const stream=createReaderEventStream(new Request("http://localhost"),{subscribe(_emit,register){register(()=>stopped++)},snapshot:()=>[]});
 const registry=globalThis[Symbol.for("pi-web.agentEventStreamClosers")];assert.equal(registry.size,1);
 const reader=stream.getReader();const pending=reader.read();for(const close of [...registry])close("error");
 await assert.rejects(pending,/shutting down/);assert.equal(registry.size,0);assert.equal(stopped,1);
});
