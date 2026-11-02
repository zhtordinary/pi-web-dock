import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url); const core = require("./session-wait-core.cjs");
import { runProcess as run } from "../test-support/test-process.mjs";

test("worker verifies a queued direct push with a signed receipt query", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "worker-receipt-query-")); t.after(() => rmSync(root, { recursive: true, force: true })); const key = core.generatePeerKeyPair(); const keyFile = join(root, "key.pem"); writeFileSync(keyFile, key.privateKey, { mode: 0o600 });
  const seen=[]; const server = createServer((req, res) => { let body=""; req.on("data", x => body += x); req.on("end", () => { const envelope=JSON.parse(body); seen.push(envelope.operation); const payload = envelope.operation === "receipt_query" ? { accepted:true, status:"processed" } : { accepted:true, status:"queued" }; res.writeHead(200, {"content-type":"application/json"}); res.end(JSON.stringify(payload)); }); }); await new Promise(resolve => server.listen(0, "127.0.0.1", resolve)); t.after(() => server.close()); const port=server.address().port; const peerUrl=`http://127.0.0.1:${port}`;
  process.env.PI_WEB_SESSION_ACTIVITY_CONFIG = JSON.stringify({ device:{id:"device-a"}, peers:[{id:"device-b",name:"B",url:peerUrl}] }); core.pairPeer(root, "reader", { deviceId:"device-b", peerUrl, publicKey:key.publicKey, sessions:["session-b"], scopes:["resume_prior_work","pull_messages"] });
  const plan=core.createPlan(root,"reader",{id:"receipt-plan",owner:{deviceId:"device-a",sessionId:"owner"},nodes:[{id:"B",session:{deviceId:"device-b",sessionId:"session-b"},condition:"task_completed",continuation:{target:{deviceId:"device-b",sessionId:"session-b"},authorizedScope:["resume_prior_work"],message:"B"}}]});
  const args=["bin/session-wait-worker.cjs","--state-root",root,"--channel","reader","--once","--peer-url",peerUrl,"--allowed-peer-url",peerUrl,"--private-key-file",keyFile,"--sender-device-id","device-a","--sender-session-id","owner"]; const first=await run(process.execPath,args,{env:{...process.env},stdio:["ignore","pipe","pipe"]}); assert.equal(first.code,0,first.stderr); const worker=await run(process.execPath,args,{env:{...process.env},stdio:["ignore","pipe","pipe"]}); assert.equal(worker.code,0,worker.stderr); const item=Object.values(core.readState(root,"reader").outbox).find(x=>x.planId===plan.plan.id); assert.equal(item.status,"processed");
});
