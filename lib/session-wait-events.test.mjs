import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp,mkdir,writeFile,rename,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createJiti } from "jiti";
const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { subscribeSessionWaitChanges } = await jiti.import("./session-wait-events.ts");
const { subscribeActivityEvents } = await jiti.import("./activity-events.ts");

test("shared file observer sees external atomic state writes and late-created roots",async()=>{
 const dir=await mkdtemp(join(tmpdir(),"reader-wait-events-")),root=join(dir,"state");let changes=0;
 const stop=subscribeActivityEvents(e=>{if(e.kind==="wait")changes++});
 const subscribers=Array.from({length:4},()=>subscribeSessionWaitChanges(root,"test"));
 try{
  const map=globalThis[Symbol.for("pi-web.session-wait-watchers")];assert.equal(map.get(`${root}:test`).refs,4);
  await mkdir(root);await new Promise(r=>setTimeout(r,30));const before=changes;
  await writeFile(join(root,"test.json.tmp"),"{}");await rename(join(root,"test.json.tmp"),join(root,"test.json"));
  const end=Date.now()+2000;while(changes===before){assert.ok(Date.now()<end);await new Promise(r=>setTimeout(r,10))}
  assert.equal(map.get(`${root}:test`).refs,4);
 }finally{subscribers.forEach(s=>s());stop();await rm(dir,{recursive:true,force:true})}
 assert.equal(globalThis[Symbol.for("pi-web.session-wait-watchers")].has(`${root}:test`),false);
});
