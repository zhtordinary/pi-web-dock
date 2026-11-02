import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); const core = require("../../../bin/session-wait-core.cjs");

test("peer route rejects a bare environment public key without a persistent pair", async (t) => {
  const root=mkdtempSync(join(tmpdir(),"bare-peer-reject-")); t.after(()=>rmSync(root,{recursive:true,force:true})); const old={root:process.env.PI_WEB_SESSION_WAIT_STATE_ROOT,device:process.env.PI_WEB_DEVICE_ID,config:process.env.PI_WEB_SESSION_ACTIVITY_CONFIG,keys:process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS}; process.env.PI_WEB_SESSION_WAIT_STATE_ROOT=root; process.env.PI_WEB_DEVICE_ID="local"; process.env.PI_WEB_SESSION_ACTIVITY_CONFIG=JSON.stringify({device:{id:"local",name:"Local"},peers:[{id:"remote",name:"Remote",url:"http://remote.test"}]}); const keys=core.generatePeerKeyPair(); process.env.PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS=JSON.stringify({remote:keys.publicKey}); t.after(()=>{for(const [k,v] of Object.entries({PI_WEB_SESSION_WAIT_STATE_ROOT:old.root,PI_WEB_DEVICE_ID:old.device,PI_WEB_SESSION_ACTIVITY_CONFIG:old.config,PI_WEB_SESSION_CONTROL_PEER_PUBLIC_KEYS:old.keys})){if(v===undefined)delete process.env[k];else process.env[k]=v;}});
  const env=core.createSignedEnvelope({channel:"reader",sender:{deviceId:"remote",sessionId:"remote-session"},recipient:"local",operation:"pull_messages",scope:["pull_messages"],body:{request:"pull"}},keys.privateKey); const jiti=createJiti(import.meta.url,{alias:{"@":process.cwd()},interopDefault:true,moduleCache:false}); const route=await jiti.import("./peer/route.ts"); const response=await route.POST(new Request("http://127.0.0.1/api/session-control/peer",{method:"POST",headers:{"content-type":"application/json",host:"127.0.0.1"},body:JSON.stringify(env)})); assert.equal(response.status,403); assert.equal(core.readState(root,"reader").inbox[env.messageId],undefined);
});
