import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {createJiti} from "jiti";

test("unified endpoint delivers local snapshots and live activity without starting agents",async()=>{
 const home=await mkdtemp(join(tmpdir(),"reader-unified-route-"));
 const keys=["PI_CODING_AGENT_DIR","PI_WEB_SESSION_WAIT_STATE_ROOT","PI_WEB_SESSION_ACTIVITY_CONFIG","PI_WEB_BOUND_PORT"];
 const before=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.PI_CODING_AGENT_DIR=home;process.env.PI_WEB_SESSION_WAIT_STATE_ROOT=join(home,"waits");process.env.PI_WEB_SESSION_ACTIVITY_CONFIG=JSON.stringify({device:{id:"fixture",name:"Fixture"},peers:[]});process.env.PI_WEB_BOUND_PORT="30141";
 const controller=new AbortController();
 try{
  const jiti=createJiti(import.meta.url,{tsconfigPaths:true});const {GET}=await jiti.import("./route.ts");const {emitActivityEvent}=await jiti.import("../../../../lib/activity-events.ts");
  const response=await GET(new Request("http://localhost/api/reader/events",{signal:controller.signal}));assert.equal(response.status,200);assert.match(response.headers.get("content-type"),/event-stream/);
  const reader=response.body.getReader();const frame=bytes=>JSON.parse(new TextDecoder().decode(bytes).slice(6).trim());
  for(const type of ["activity_meta","runtime_identity","running","waiting_user","waits_changed"]){const e=frame((await reader.read()).value);assert.equal(e.type,type);assert.equal(e.device,"fixture");if(type==="runtime_identity")assert.equal(e.channel,"production")}
  emitActivityEvent({kind:"run",sessionId:"synthetic",runId:"r",status:"completed"});const e=frame((await reader.read()).value);assert.equal(e.type,"activity");assert.equal(e.runId,"r");assert.equal(e.status,"completed");controller.abort();
 }finally{controller.abort();for(const k of keys){if(before[k]===undefined)delete process.env[k];else process.env[k]=before[k]}await rm(home,{recursive:true,force:true})}
});
