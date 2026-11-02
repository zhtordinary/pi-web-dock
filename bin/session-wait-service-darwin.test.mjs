import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
const entry = new URL("./session-wait-service.cjs", import.meta.url).pathname;
test("Darwin service apply writes the user LaunchAgent with complete escaped argv and numeric UID manager plan", () => {
  const root=mkdtempSync(join(tmpdir(),"darwin-service-path-")); try { const home=join(root,"home"); const result=spawnSync(process.execPath,[entry,"--apply","--platform=darwin","--state-root",join(root,"state"),"--mode","pull","--peer-url","http://peer.test/a?x=1&y=2","--pull-peer-id","peer","--reader-url","http://reader.test","--private-key-file",join(root,"key.pem"),"--sender-file",join(root,"session file"),"--sender-device-id","local","--sender-session-id","worker"],{encoding:"utf8",env:{...process.env,HOME:home}}); assert.equal(result.status,0,result.stderr); const payload=JSON.parse(result.stdout); const expected=join(home,"Library","LaunchAgents",payload.template.file); assert.equal(payload.written,expected); const plist=readFileSync(expected,"utf8"); assert.match(plist,/--mode<\/string><string>pull/); assert.match(plist,/--pull-peer-id/); assert.match(plist,/--reader-url/); assert.match(plist,/--private-key-file/); assert.match(plist,/&amp;/); assert.doesNotMatch(plist,/gui\/\$UID/); assert.match(JSON.stringify(payload.managerPlan),new RegExp(String(process.getuid?.() ?? process.env.UID))); } finally { rmSync(root,{recursive:true,force:true}); }
});
