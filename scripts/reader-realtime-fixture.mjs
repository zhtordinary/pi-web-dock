// Synthetic HTTP/1.1 fixture: no Reader runtime, providers, credentials or reserved ports.
import http from "node:http";
import { readFile } from "node:fs/promises";
const clients=new Set();let opened=0,seq=0;
const files=new Map([["/reader-events-worker.js",new URL("../public/reader-events-worker.js",import.meta.url)],["/reader-events-client.mjs",new URL("../public/reader-events-client.mjs",import.meta.url)]]);
const frame=(r,data)=>r.write(`data: ${JSON.stringify(data)}\n\n`);
const event=type=>({type,device:"fixture",bootId:"fixture-boot",seq:++seq,runningSessionIds:["synthetic"],sessions:[{sessionId:"synthetic",requestIds:[`q-${seq}`]}],runId:`r-${seq}`,sessionId:"synthetic",status:"completed",online:true});
const snapshots=new Map(["running","waiting_user","waits_changed"].map(type=>[type,event(type)]));
const recent=[];
const server=http.createServer(async(req,res)=>{
 const url=new URL(req.url,"http://localhost");res.setHeader("Cache-Control","no-store");
 if(url.pathname==="/api/reader/events"){
  res.writeHead(200,{"Content-Type":"text/event-stream","Connection":"keep-alive"});clients.add(res);opened++;
  for(const data of snapshots.values())frame(res,{...data,snapshot:true});
  for(const data of recent)frame(res,{...data,replay:true});
  const id=setInterval(()=>res.write(":\n\n"),1000);req.on("close",()=>{clearInterval(id);clients.delete(res)});return;
 }
 res.setHeader("Content-Type","application/json");
 if(url.pathname==="/stats"){res.end(JSON.stringify({active:clients.size,opened,seq}));return}
 if(url.pathname==="/emit"){
  const type=url.searchParams.get("type");if(!["running","waiting_user","waits_changed","activity","peer_state"].includes(type)){res.writeHead(400);res.end("{}");return}
  const data=event(type);
  if(type==="activity"){recent.push(data);if(recent.length>200)recent.shift()}else snapshots.set(type,data);
  for(const r of clients)frame(r,data);res.end(JSON.stringify(data));return;
 }
 if(url.pathname==="/drop"){for(const r of [...clients])r.end();res.end("{}");return}
 if(url.pathname==="/read"){res.end(JSON.stringify({ok:true}));return}
 if(files.has(url.pathname)){res.setHeader("Content-Type","text/javascript");res.end(await readFile(files.get(url.pathname)));return}
 if(url.pathname!=="/"){res.writeHead(404);res.end("{}");return}
 res.setHeader("Content-Type","text/html");res.end(`<!doctype html><title>Reader realtime fixture</title><p id="state">Connecting</p><script type="module">
 import {createReaderEventsClient} from "/reader-events-client.mjs";
 const fallback=new URLSearchParams(location.search).has("fallback");
 const env=new Proxy(window,{get(t,k){if(k==="SharedWorker"&&fallback)return undefined;const v=Reflect.get(t,k,t);return ["addEventListener","removeEventListener","setTimeout","clearTimeout","setInterval","clearInterval","queueMicrotask"].includes(k)?v.bind(t):v}});
 window.probe={events:[],opens:0,errors:0,sharing:null};const client=createReaderEventsClient(env);
 window.stop=client.subscribe(p=>{if(p.kind==="event"){probe.events.push(p.data);probe.events=probe.events.slice(-200)}else if(p.kind==="open"){probe.opens++;probe.sharing=p.sharing??"broadcast";document.querySelector("#state").textContent="Connected"}else if(p.kind==="error")probe.errors++});
 window.read=async()=>{const t=performance.now(),c=new AbortController(),id=setTimeout(()=>c.abort(),3000);try{const r=await fetch("/read",{signal:c.signal});await r.json();return {status:r.status,ms:Math.round(performance.now()-t)}}finally{clearTimeout(id)}};
 </script>`);
});
server.listen(0,"127.0.0.1",()=>console.log(JSON.stringify({port:server.address().port,pid:process.pid})));
const close=()=>{for(const r of clients)r.end();server.close(()=>process.exit(0));setTimeout(()=>process.exit(1),2000).unref()};process.on("SIGTERM",close);process.on("SIGINT",close);
