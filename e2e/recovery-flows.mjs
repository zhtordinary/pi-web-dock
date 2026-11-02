// Full rendered Reader app, isolated files and real queue-recovery API.
// Run after npm run build: node e2e/recovery-flows.mjs; Ctrl+C stops both servers.
// RECOVERY_QA_ARTIFACTS optionally selects the local evidence directory.
// Agent queue execution and remote peer transport are deterministic fixtures;
// Browser interactions use the supported cloud UI tool. This fixture never sends
// generation or remote peer traffic; only the loopback proxy is exposed.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { Readable } from 'node:stream';
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createJiti } from 'jiti';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts=process.env.RECOVERY_QA_ARTIFACTS || mkdtempSync(join(tmpdir(),'reader-recovery-browser-artifacts-'));
mkdirSync(artifacts,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'reader-recovery-browser-home-'));
const agentDir=join(home,'agent'),project=join(home,'fixture-project'),sessions=join(agentDir,'sessions','fixture');
for(const dir of [agentDir,project,sessions])mkdirSync(dir,{recursive:true});
Object.assign(process.env,{HOME:home,PI_CODING_AGENT_DIR:agentDir,PI_WEB_QUEUE_RECALL_ROOT:join(home,'queue-recalls')});
const jiti=createJiti(import.meta.url,{interopDefault:true,tsconfigPaths:true});
const store=await jiti.import('../lib/queue-recall-store.ts');
const timestamp='2026-10-17T19:00:00.000Z';
for(const id of ['qa-normal','qa-large','qa-prepared','qa-ack-loss']){
 writeFileSync(join(sessions,`2026-10-17T19-00-00-000Z_${id}.jsonl`),[
  {type:'session',version:3,id,timestamp,cwd:project},
  {type:'message',id:'user',parentId:null,timestamp,message:{role:'user',content:[{type:'text',text:`Isolated recovery QA: ${id}`}]}},
  {type:'message',id:'answer',parentId:'user',timestamp,message:{role:'assistant',content:[{type:'text',text:'Offline fixture. No model is called.'}],stopReason:'stop',provider:'fixture',model:'fixture'}},
 ].map(JSON.stringify).join('\n')+'\n');
}
const smallImage=Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7','base64');
const largeImage=Buffer.alloc(6*1024*1024);smallImage.copy(largeImage);
function queue(id,text,data=smallImage.toString('base64')){return {bootId:'qa-boot',queueRevision:1,steering:[{itemId:`item-${id}`,role:'user',text,hasImages:true,imageCount:1,images:[{data,mimeType:'image/gif'}]}],followUp:[]};}
const normal=queue('normal','normal queued text');
const empty={bootId:'qa-boot',queueRevision:2,steering:[],followUp:[]};
function seed(id,op,captured,status='committed'){
 const expected={bootId:captured.bootId,queueRevision:captured.queueRevision};
 store.prepareQueueRecall(id,op,expected,captured);
 if(status==='committed')store.commitQueueRecall(id,op,expected,{clearedQueue:captured,queueSnapshot:empty,steering:[],followUp:[]});
}
seed('qa-large','large-operation',queue('large','large queued text',largeImage.toString('base64')));
seed('qa-prepared','prepared-operation',queue('prepared','prepared <script>must remain text</script>'),'prepared');
seed('qa-ack-loss','ack-loss-operation',queue('ack','ack queued text'));
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
const base=`http://127.0.0.1:${port}`;
const log=createWriteStream(join(artifacts,'server.log'));
const server=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:root,env:{...process.env,NEXT_TELEMETRY_DISABLED:'1',PI_WEB_PASSWORD:'',PI_WEB_SESSION_ACTIVITY_CONFIG:JSON.stringify({device:{id:'qa-local',name:'QA local'},peers:[]})},stdio:['ignore','pipe','pipe']});
server.stdout.pipe(log);server.stderr.pipe(log);
let proxyServer;
const serverOnly=true;
const evidence={scope:'Full rendered AppShell + ChatInput + QueueRecoveryPanel, real isolated queue-recovery server API; agent execution and remote peer transport mocked',artifacts,home,generationCommands:0,clearCount:0,ackCount:0,lostAckResponses:0,remoteCalls:[]};
try{
 const deadline=Date.now()+60000;
 while(true){const r=await fetch(`${base}/api/sessions`).catch(()=>null);if(r?.ok)break;assert.ok(Date.now()<deadline,'isolated server did not become ready');await delay(200);}
 let context;
 if(serverOnly){
  context={addInitScript:async()=>{},route:async(_pattern,handler)=>{
   proxyServer=createHttpServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const raw=Buffer.concat(chunks);
    const target=base+req.url;
    const headers={...req.headers,host:new URL(base).host};if(headers.origin)headers.origin=base;
    const forward=()=>fetch(target,{method:req.method,headers,body:['GET','HEAD'].includes(req.method)?undefined:raw,redirect:'manual'});
    const route={request:()=>({url:()=>target,method:()=>req.method,postData:()=>raw.toString(),postDataJSON:()=>JSON.parse(raw.toString())}),
     fulfill:async({status=200,json,body,headers:custom={}})=>{res.writeHead(status,{...custom,...(json===undefined?{}:{'content-type':'application/json'})});res.end(json===undefined?body:JSON.stringify(json));},
     abort:async()=>res.destroy(),fetch:forward,
     continue:async()=>{const upstream=await forward();res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([key])=>!['content-encoding','content-length','transfer-encoding'].includes(key))));if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();}};
    try{await handler(route);writeFileSync(join(artifacts,'server-evidence.json'),JSON.stringify(evidence,null,2));}catch(error){res.destroy();writeFileSync(join(artifacts,'server-error.txt'),String(error));}
   });
   proxyServer.listen(Number(process.env.RECOVERY_QA_PROXY_PORT||31587),'127.0.0.1');await once(proxyServer,'listening');
  }};
 }
 await context.addInitScript(()=>localStorage.setItem('pi-locale','zh-CN'));
 let normalCleared=false,loseAck=true;
 let remoteComplete=false,remoteOffline=false;
 // Set {remotePreadmission:true} in control.json before launch for the lost-
 // before-admission case. The setup URL persists the browser's original intent,
 // while the actual isolated receipt service has no reservation for it.
 let remotePreadmission=false;
 try{remotePreadmission=JSON.parse(readFileSync(join(artifacts,'control.json'),'utf8')).remotePreadmission===true;}catch{}
 Object.assign(process.env,{PI_WEB_CONTROL_RECEIPT_ROOT:join(home,'remote-receipts'),PI_WEB_SESSION_ACTIVITY_CONFIG:JSON.stringify({device:{id:'qa-peer'},peers:[]})});
 const mutationService=await jiti.import('../lib/session-mutation-service.ts');
 const mutationStore=await jiti.import('../lib/reader-control-receipts.ts');
 const mutationCommand=await jiti.import('../lib/session-mutation-command.ts');
 const command=remotePreadmission
  ? {operationId:'remote-missed-admission',deviceId:'qa-peer',sessionId:'deleted-session',op:'rename',name:'Original recovery name',force:true}
  : {operationId:'remote-lost-delete',deviceId:'qa-peer',sessionId:'deleted-session',op:'delete',force:false};
 let seededReceipt;
 if(!remotePreadmission)seededReceipt=(await mutationStore.reserveControlReceipt({deviceId:command.deviceId,sessionId:command.sessionId,operation:'session_mutation',idempotencyKey:command.operationId,requestFingerprint:mutationStore.controlRequestFingerprint(command),cwd:'session-mutation',bootId:'paused-fixture-owner',mutationCommand:command})).receipt;
 evidence.remoteBusinessEffects=0;
 evidence.remoteCommand=command;
 const remoteCalls=[];
 await context.route('**/*',async route=>{
  const request=route.request(),url=new URL(request.url());
  if(url.origin!==base){await route.abort();return;}
  if(url.pathname==='/api/session-mutations'&&url.searchParams.has('peers'))return route.fulfill({json:{peers:[{id:'qa-peer',name:'Fixture peer',url:'http://127.0.0.1:39999'}]}});
  if(serverOnly){try{const control=JSON.parse(readFileSync(join(artifacts,'control.json'),'utf8'));remoteComplete=control.remoteComplete===true;remoteOffline=control.remoteOffline===true;}catch{}}
  if(url.pathname==='/__qa/filters') {
   return route.fulfill({headers:{'content-type':'text/html; charset=utf-8'},body:`<!doctype html><meta charset="utf-8"><title>Isolated filter protocol QA</title>
<style>body{margin:0;font:14px sans-serif}header{padding:8px}button{margin:4px}iframe{width:100%;height:650px;border:0}pre{margin:4px}</style>
<header><strong>Fixture owner + real embedded Reader</strong><button id="days">Owner days=30, delay snapshot</button><button id="flush">Send snapshot</button><button id="legacy">Legacy owner</button><pre id="state"></pre><pre id="last"></pre></header>
<iframe id="reader" src="/?session=qa-normal&piWebEmbedded=1&piWebActivitySidebar=1"></iframe>
<script>
localStorage.setItem('pi-locale','zh-CN');
let legacy=new URL(location.href).searchParams.has('legacy'),rev=10;let filters={device:'all',archiveView:'active',project:[],status:'all',sort:'recent',days:'7',group:'none'};
const frame=document.getElementById('reader'),state=document.getElementById('state'),last=document.getElementById('last');
function show(){state.textContent=JSON.stringify({rev,legacy,filters})}function send(initial=false){frame.contentWindow.postMessage({type:'pi-web:filters-changed',filters,rev,initial,...(legacy?{}:{filterProtocol:2,epoch:'qa-owner'})},location.origin)}
document.getElementById('days').onclick=()=>{filters.days='30';rev++;show()};document.getElementById('flush').onclick=()=>send();document.getElementById('legacy').onclick=()=>{legacy=true;show();send(true)};
window.addEventListener('message',e=>{if(e.source!==frame.contentWindow)return;const d=e.data;if(d.type==='pi-web:request-filters')send(true);if(d.type==='pi-web:filters-changed'){last.textContent=JSON.stringify(d);if(!legacy&&d.intent){filters={...filters,...d.intent};if(filters.device!=='all'&&filters.group==='device')filters.group='project';rev++;show();send()}}});show();
</script>`});
  }
  if(url.pathname==='/__qa/remote-preadmission'&&remotePreadmission){
   const saved=[{target:{id:command.deviceId,name:'Fixture peer',url:'http://127.0.0.1:39999'},command,receipt:{operationId:command.operationId,deviceId:command.deviceId,sessionId:command.sessionId,status:'unknown'}}];
   return route.fulfill({headers:{'content-type':'text/html; charset=utf-8'},body:`<!doctype html><title>Isolated recovery setup</title><script>localStorage.setItem('pi-web.pending-session-mutations.v2',${JSON.stringify(JSON.stringify(saved))});localStorage.setItem('pi-locale','zh-CN');location.replace('/?session=qa-normal');</script>`});
  }
  if(serverOnly && url.pathname==='/api/sessions/qa-large/queue-recovery' && url.searchParams.has('operationId')) {
   try { const control=JSON.parse(readFileSync(join(artifacts,'control.json'),'utf8')); if(control.queueReadDelayMs) await delay(Math.min(3000,control.queueReadDelayMs)); } catch {}
  }
  if(url.pathname==='/api/remote/session-mutations'){
   remoteCalls.push({method:request.method(),query:url.search,body:request.postData()}); evidence.remoteCalls=remoteCalls;
   if(remoteOffline)return route.fulfill({status:503,json:{error:'offline fixture'}});
   if(remoteComplete&&seededReceipt){await mutationStore.updateControlReceipt(seededReceipt.receiptId,{outcome:'completed',completedAt:new Date().toISOString()});seededReceipt=undefined;}
   if(url.searchParams.has('capabilities'))return route.fulfill({json:{protocol:2,deviceId:'qa-peer',recovery:true}});
   if(url.searchParams.has('recovery'))return route.fulfill({json:await mutationService.listSessionMutations(url.searchParams.get('after')??'')});
   if(request.method()==='GET')return route.fulfill({json:await mutationService.querySessionMutation({operationId:url.searchParams.get('operationId'),deviceId:url.searchParams.get('deviceId'),sessionId:url.searchParams.get('sessionId')})});
   const body=request.postDataJSON();
   if(body.action==='acknowledge')return route.fulfill({json:{acknowledged:await mutationService.acknowledgeSessionMutation(body,body.reviewedUnknown===true)}});
   const input=mutationCommand.validateSessionMutationCommand(body);
   assert.deepEqual(input,command,'Recovery must preserve the original ID, target and complete parameters');
   const effect=async()=>{evidence.remoteBusinessEffects++;return new Response();};
   let lateOriginal=false;try{lateOriginal=JSON.parse(readFileSync(join(artifacts,'control.json'),'utf8')).remoteLateOriginal===true;}catch{}
   if(lateOriginal)await mutationService.executeSessionMutation(command,effect);
   return route.fulfill({json:await mutationService.executeSessionMutation(input,effect)});
  }
  const state=url.pathname.match(/^\/api\/sessions\/(qa-[^/]+)\/state$/);
  if(state)return route.fulfill({json:{running:false,state:{isStreaming:false,queueSnapshot:state[1]==='qa-normal'&&!normalCleared?normal:empty,queuedMessages:{steering:state[1]==='qa-normal'&&!normalCleared?['normal queued text']:[],followUp:[]},branchPosition:{leafId:'answer',pending:false}}}});
  if(url.pathname.match(/^\/api\/agent\/[^/]+$/)&&request.method()==='POST'){
   const body=request.postDataJSON();const id=url.pathname.split('/').at(-1);
   if(['prompt','peer_message','steer','follow_up','retry_continue'].includes(body.type)){evidence.generationCommands++;await route.abort();throw new Error('Generation forbidden in browser QA');}
   if(body.type==='clear_queue'){
    assert.equal(id,'qa-normal');assert.equal(normalCleared,false,'normal clear must not repeat');normalCleared=true;evidence.clearCount++;
    seed(id,body.queueRecallOperationId,normal);
    return route.fulfill({json:{success:true,data:{clearedQueue:normal,queueSnapshot:empty,steering:[],followUp:[]}}});
   }
   if(body.type==='ack_queue_recall'){evidence.ackCount++;return route.continue();}
   return route.fulfill({json:{success:true,data:{isStreaming:false,queueSnapshot:empty,queuedMessages:{steering:[],followUp:[]}}}});
  }
  if(url.pathname==='/api/sessions/qa-ack-loss/queue-recovery'&&request.method()==='POST'&&loseAck){
   loseAck=false;evidence.ackCount++;await route.fetch();evidence.lostAckResponses++;await route.abort('failed');return;
  }
  return route.continue();
 });
 if(serverOnly){writeFileSync(join(artifacts,'fixture.json'),JSON.stringify({url:`http://127.0.0.1:${proxyServer.address().port}`,home,agentDir},null,2));console.log(`QA_READY http://127.0.0.1:${proxyServer.address().port}`);await new Promise(resolve=>{process.once('SIGTERM',resolve);process.once('SIGINT',resolve);});proxyServer.closeAllConnections();proxyServer.close();}
} catch(error){writeFileSync(join(artifacts,'failure.json'),JSON.stringify({...evidence,error:String(error)},null,2));throw error;}
finally{server.kill('SIGTERM');await Promise.race([once(server,'exit'),delay(5000)]);log.end();}
