import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { createReaderEventsClient } from "./reader-events-client.mjs";

function fixture() {
  const sources = [], channels = new Set(), storage = new Map();
  class EventSource {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSED = 2;
    constructor(url) { this.url = url; this.closed = false; this.readyState = EventSource.CONNECTING; sources.push(this); }
    close() { this.closed = true; this.readyState = EventSource.CLOSED; }
    open() { this.readyState = EventSource.OPEN; this.onopen?.(); }
    fail(readyState = EventSource.CLOSED) { this.readyState = readyState; this.onerror?.(); }
    addEventListener(type, fn) { (this.named ??= new Map()).set(type, fn); }
    ping() { this.named?.get("ping")?.({data:"{}"}); }
    emit(event) { this.onmessage?.({ data: JSON.stringify(event) }); }
  }
  class BroadcastChannel {
    constructor() { channels.add(this); }
    postMessage(data) { for (const c of channels) if (c !== this) queueMicrotask(() => c.onmessage?.({ data })); }
    close() { channels.delete(this); }
  }
  let next = 0;
  const env = () => ({ EventSource, BroadcastChannel, localStorage: { getItem:k=>storage.get(k)??null, setItem:(k,v)=>storage.set(k,v), removeItem:k=>storage.delete(k) }, crypto:{randomUUID:()=>`tab-${++next}`}, Date, setTimeout, clearTimeout, setInterval, clearInterval, queueMicrotask });
  return { env, EventSource, sources, storage, channels };
}
async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) { assert.ok(Date.now() < end, "condition timed out"); await new Promise(r=>setTimeout(r,10)); }
}

test("four HTTP-origin tabs share one fallback SSE and receive all notification types", async () => {
  const f = fixture(), clients = Array.from({length:4},()=>createReaderEventsClient(f.env())), received = clients.map(()=>[]);
  const unsub = clients.map((c,i)=>c.subscribe(p=>received[i].push(p)));
  try {
    await until(()=>f.sources.length === 1);
    f.sources[0].onopen();
    let seq = 0;
    for (const type of ["running","waiting_user","activity","waits_changed","peer_state"]) f.sources[0].emit({type,device:"mini",bootId:"boot",seq:++seq,requestIds:["r1"]});
    await new Promise(r=>setTimeout(r,0));
    for (const packets of received) assert.deepEqual(packets.filter(p=>p.kind==="event").map(p=>p.data.type),["running","waiting_user","activity","waits_changed","peer_state"]);
    assert.equal(f.sources.filter(s=>!s.closed).length,1);
    unsub[0]();
    await until(()=>f.sources.length===2);
    assert.equal(f.sources.filter(s=>!s.closed).length,1);
    assert.equal(f.sources[0].closed,true);
    assert.match(f.sources[1].url, /cursors=/);
  } finally { unsub.forEach(stop=>stop()); clients.forEach(c=>c.dispose()); }
  assert.equal(f.sources.filter(s=>!s.closed).length,0);
  assert.equal(f.channels.size,0);
});

test("same-document consumers reuse transport, receive snapshots, and isolate failures", async () => {
  const f=fixture(), c=createReaderEventsClient(f.env()), seen=[];
  const a=c.subscribe(()=>{throw new Error("consumer failure")});
  const b=c.subscribe(p=>seen.push(p));
  try {
    await until(()=>f.sources.length===1);
    f.sources[0].onopen();
    f.sources[0].emit({type:"running",runningSessionIds:["s1"]});
    assert.equal(seen.at(-1).data.runningSessionIds[0],"s1");
    a(); assert.equal(f.sources[0].closed,false);
    const late=[];const d=c.subscribe(p=>late.push(p));
    await new Promise(r=>setTimeout(r,0));
    assert.equal(late.find(p=>p.kind==="event").data.snapshot,true);d();
  } finally { a();b();c.dispose(); }
});

test("SharedWorker carries four ports on one SSE, replays silently, recovers CLOSED, and releases last subscriber", async () => {
  const f=fixture(), self={}, reconnects=[];
  const context=vm.createContext({self,EventSource:f.EventSource,Map,Date,JSON,
    setTimeout:(fn,ms)=>{reconnects.push({fn,ms});return reconnects.length},
    clearTimeout:()=>{}});
  vm.runInContext(await readFile(new URL("./reader-events-worker.js",import.meta.url),"utf8"),context);
  const port=()=>({messages:[],postMessage(p){this.messages.push(p)},start(){},close(){this.closed=true}});
  const ports=Array.from({length:4},port);
  for(const p of ports){self.onconnect({ports:[p]});p.onmessage({data:{kind:"subscribe"}})}
  assert.equal(f.sources.length,1); f.sources[0].open();
  f.sources[0].fail(f.EventSource.CONNECTING); assert.equal(f.sources.length,1);
  let seq = 0;
  for(const type of ["running","waiting_user","waits_changed","activity"]) f.sources[0].emit({type,device:"air",seq:++seq,bootId:"boot"});
  for(const p of ports)assert.equal(p.messages.filter(x=>x.kind==="event").length,4);
  const late=port();self.onconnect({ports:[late]});late.onmessage({data:{kind:"subscribe"}});
  assert.equal(late.messages.find(x=>x.data?.type==="waiting_user").data.snapshot,true);
  assert.equal(late.messages.find(x=>x.data?.type==="activity").data.replay,true);
  const old=f.sources[0]; old.fail(f.EventSource.CLOSED);
  assert.equal(old.closed,true); assert.equal(reconnects.filter(timer=>timer.ms===1000).length,1);
  reconnects.find(timer=>timer.ms===1000).fn(); assert.equal(f.sources.length,2); assert.equal(f.sources[1].closed,false);
  old.fail(f.EventSource.CLOSED); assert.equal(f.sources[1].closed,false);
  for(const p of ports)p.onmessage({data:{kind:"unsubscribe"}});
  assert.equal(f.sources[1].closed,false);
  late.onmessage({data:{kind:"unsubscribe"}});assert.equal(f.sources[1].closed,true);
});

test("fallback reconnects CLOSED sources for broadcast, page, and storage-error branches", async () => {
  const branches = [
    ["broadcast", f => f.env()],
    ["page", f => { const env=f.env(); env.BroadcastChannel=undefined; return env; }],
    ["storage-error", f => { const env=f.env(); env.localStorage.setItem=()=>{throw new Error("storage unavailable")}; return env; }],
  ];
  for (const [name, envFor] of branches) {
    const f=fixture(), env=envFor(f), reconnects=[];
    const realSetTimeout=env.setTimeout, realClearTimeout=env.clearTimeout;
    env.setTimeout=(fn,ms)=>ms===1000 ? (reconnects.push({fn,ms}), reconnects.length) : realSetTimeout(fn,ms);
    env.clearTimeout=id=>{ if (typeof id === "number" && id <= reconnects.length) return; realClearTimeout(id); };
    const c=createReaderEventsClient(env), stop=c.subscribe(()=>{});
    try {
      await until(()=>f.sources.length===1);
      const old=f.sources[0]; old.fail(f.EventSource.CONNECTING); assert.equal(f.sources.length,1,name);
      old.fail(f.EventSource.CLOSED);
      assert.equal(old.closed,true,name); assert.equal(reconnects.length,1,name); assert.equal(reconnects[0].ms,1000,name);
      reconnects[0].fn(); await until(()=>f.sources.length===2);
      const current=f.sources[1]; assert.equal(current.closed,false,name);
      old.fail(f.EventSource.CLOSED); assert.equal(current.closed,false,name);
    } finally { stop(); c.dispose(); }
  }
});

test("invalid ownership records do not strand notifications", async () => {
  const f=fixture();f.storage.set("pi-reader-owner:/api/reader/events",JSON.stringify({id:"dead"}));
  const c=createReaderEventsClient(f.env());const stop=c.subscribe(()=>{});
  try { await until(()=>f.sources.length===1); } finally {stop();c.dispose()}
});

test("insecure HTTP crypto and worker startup failure preserve shared fallback delivery",async()=>{
 const f=fixture(),env=f.env();let closed=false,unsubscribed=false;
 env.SharedWorker=class{constructor(){this.port={start(){},postMessage(p){if(p.kind==="unsubscribe")unsubscribed=true},close(){closed=true}}}};
 const timeout=env.setTimeout;env.setTimeout=(fn,ms)=>timeout(fn,ms===3000?0:ms);
 env.crypto={getRandomValues:bytes=>bytes.fill(17)};
 const c=createReaderEventsClient(env),packets=[];const stop=c.subscribe(p=>packets.push(p));
 try{await until(()=>f.sources.length===1);assert.equal(closed,true);assert.equal(unsubscribed,true);f.sources[0].onopen();f.sources[0].emit({type:"waiting_user",sessions:[{requestIds:["q"]}]});assert.equal(packets.at(-1).data.type,"waiting_user")}finally{stop();c.dispose()}
});

test("visible ping resets silence watchdog and a silent open stream reconnects with its cursor", () => {
 const f=fixture(),env=f.env(),timers=new Map();let id=0;
 env.BroadcastChannel=undefined;env.setTimeout=(fn,ms)=>{timers.set(++id,{fn,ms});return id};env.clearTimeout=id=>timers.delete(id);
 const client=createReaderEventsClient(env),stop=client.subscribe(()=>{});
 try {
  const source=f.sources[0];source.open();source.emit({type:"activity",device:"d",bootId:"b",seq:7});
  const before=[...timers.keys()].find(id=>timers.get(id).ms===75000);source.ping();
  assert.equal(timers.has(before),false);
  [...timers.values()].find(t=>t.ms===75000).fn();assert.equal(source.closed,true);
  [...timers.values()].find(t=>t.ms===1000).fn();assert.equal(f.sources.length,2);
  assert.match(decodeURIComponent(f.sources[1].url),/"seq":7/);
 }finally{stop()}
});

test("fallback late subscriber retains the fresh build identity across a same-boot reset",async()=>{
 const f=fixture(),c=createReaderEventsClient(f.env()),stop=c.subscribe(()=>{});
 try {
  await until(()=>f.sources.length===1);f.sources[0].open();
  f.sources[0].emit({type:"running",device:"d",runningSessionIds:["old"]});
  f.sources[0].emit({type:"runtime_identity",device:"d",bootId:"new",buildId:"new-build"});
  f.sources[0].emit({type:"activity_meta",device:"d",bootId:"new",seq:0,reset:true});
  const packets=[],late=c.subscribe(p=>packets.push(p));await new Promise(r=>setTimeout(r,0));
  assert.equal(packets.find(p=>p.data?.type==="runtime_identity").data.buildId,"new-build");
  assert.equal(packets.some(p=>p.data?.type==="running"),false);late();
 } finally {stop();c.dispose();}
});

test("worker late subscriber retains current build identity and discards a previous boot identity",async()=>{
 const f=fixture(),self={};const context=vm.createContext({self,EventSource:f.EventSource,Map,Date,JSON,setTimeout:()=>1,clearTimeout:()=>{}});
 vm.runInContext(await readFile(new URL("./reader-events-worker.js",import.meta.url),"utf8"),context);
 const port=()=>({messages:[],postMessage(p){this.messages.push(p)},start(){},close(){}});
 const first=port();self.onconnect({ports:[first]});first.onmessage({data:{kind:"subscribe"}});f.sources[0].open();
 f.sources[0].emit({type:"runtime_identity",device:"d",bootId:"old",buildId:"old-build"});
 f.sources[0].emit({type:"activity_meta",device:"d",bootId:"new",seq:0,reset:true});
 const midway=port();self.onconnect({ports:[midway]});midway.onmessage({data:{kind:"subscribe"}});
 assert.equal(midway.messages.some(p=>p.data?.type==="runtime_identity"),false);
 f.sources[0].emit({type:"runtime_identity",device:"d",bootId:"new",buildId:"new-build"});
 f.sources[0].emit({type:"activity_meta",device:"d",bootId:"new",seq:0,reset:true});
 const late=port();self.onconnect({ports:[late]});late.onmessage({data:{kind:"subscribe"}});
 assert.equal(late.messages.find(p=>p.data?.type==="runtime_identity").data.buildId,"new-build");
 for(const p of [first,midway,late])p.onmessage({data:{kind:"unsubscribe"}});
});
