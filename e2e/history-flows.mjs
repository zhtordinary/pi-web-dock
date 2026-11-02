// Own-cloud browser fixture: rendered Reader + real bounded history HTTP APIs.
// Only runtime SSE is simulated; all generation commands are rejected.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { mkdirSync, mkdtempSync, writeFileSync, createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
const root=dirname(dirname(fileURLToPath(import.meta.url)));
const artifacts=process.env.HISTORY_QA_ARTIFACTS || mkdtempSync(join(tmpdir(),'reader-history-browser-'));
mkdirSync(artifacts,{recursive:true});
const home=mkdtempSync(join(tmpdir(),'reader-history-home-')),agent=join(home,'agent'),project=join(home,'project'),sessions=join(agent,'sessions','fixture');
for(const path of [agent,project,sessions])mkdirSync(path,{recursive:true});
const id='qa-history',timestamp='2026-10-19T06:00:00.000Z';
const entries=Array.from({length:64},(_,i)=>({type:'message',id:`e${i}`,parentId:i?`e${i-1}`:null,timestamp,message:{role:'user',content:[{type:'text',text:`QA row ${String(i).padStart(2,'0')} ${i>=60?'bounded preview '+('padding '.repeat(1600))+` needle-${i}`:'saved history'} `}],timestamp:Date.parse(timestamp)}}));
writeFileSync(join(sessions,`${timestamp.replaceAll(':','-')}_${id}.jsonl`),[{type:'session',version:3,id,timestamp,cwd:project},...entries].map(JSON.stringify).join('\n')+'\n');
const imageData='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jfV8AAAAASUVORK5CYII=';
const extraSessions = {
 'qa-other': [{type:'message',id:'other-0',parentId:null,timestamp,message:{role:'user',content:'QA OTHER SESSION',timestamp:Date.parse(timestamp)}}],
 'qa-edit': [
  {type:'message',id:'edit-0',parentId:null,timestamp,message:{role:'user',content:'QA EDIT SESSION',timestamp:Date.parse(timestamp)}},
  {type:'message',id:'edit-1',parentId:'edit-0',timestamp,message:{role:'assistant',content:[{type:'text',text:'Fixture answer'}],provider:'fixture',model:'fixture',api:'openai-responses',stopReason:'stop',usage:{input:0,output:0,cacheRead:0,cacheWrite:0,totalTokens:0,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}},timestamp:Date.parse(timestamp)}},
  {type:'message',id:'edit-2',parentId:'edit-1',timestamp,message:{role:'user',content:[{type:'text',text:'Expanded hidden template '+ 'expanded '.repeat(8000)},{type:'image',data:imageData,mimeType:'image/png'}],timestamp:Date.parse(timestamp)}},
  {type:'custom',id:'edit-display',parentId:'edit-2',timestamp,customType:'pi-web:display-input',data:{targetEntryId:'edit-2',input:' /template **original** '+ 'argument '.repeat(6000)+'\n '}},
 ],
};
for(const [sessionId,records] of Object.entries(extraSessions)) writeFileSync(join(sessions,`${timestamp.replaceAll(':','-')}_${sessionId}.jsonl`),[{type:'session',version:3,id:sessionId,timestamp,cwd:project},...records].map(JSON.stringify).join('\n')+'\n');
const probe=createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const base=`http://127.0.0.1:${port}`, log=createWriteStream(join(artifacts,'server.log'));
const env={...process.env,HOME:home,PI_CODING_AGENT_DIR:agent,PI_WEB_PASSWORD:'',NEXT_TELEMETRY_DISABLED:'1',PI_WEB_SESSION_ACTIVITY_CONFIG:JSON.stringify({device:{id:'qa-cloud',name:'Isolated cloud QA'},peers:[]})};
delete env.XDG_CONFIG_HOME;delete env.XDG_STATE_HOME;
const child=spawn(process.execPath,[join(root,'node_modules/next/dist/bin/next'),'start','-H','127.0.0.1','-p',String(port)],{cwd:root,env,stdio:['ignore','pipe','pipe']});child.stdout.pipe(log);child.stderr.pipe(log);
const evidence={scope:'Rendered AppShell/ChatWindow, real isolated history APIs; simulated runtime replay, no model',historyRequests:[],blockedRuntimeCommands:0,forwardedRuntimeCommands:0,replayedRows:0};
const clients=new Set();let proxy;
const save=()=>writeFileSync(join(artifacts,'evidence.json'),JSON.stringify(evidence,null,2));
try{
 const deadline=Date.now()+60000;while(!(await fetch(`${base}/api/sessions`).catch(()=>null))?.ok){if(Date.now()>deadline)throw Error('startup timeout');await delay(100);}
 proxy=createServer(async(req,res)=>{try{
  const url=new URL(req.url,base);const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=Buffer.concat(chunks);
  if(url.pathname==='/__qa/replay'){
   for(const client of clients)for(const entry of entries)client.write(`data: ${JSON.stringify({type:'message_end',message:entry.message,entryId:entry.id})}\n\n`);
   evidence.replayedRows+=entries.length;save();res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({subscribers:clients.size,replayed:entries.length}));return;
  }
  if(/^\/api\/agent\/qa-[^/]+\/events$/.test(url.pathname)){res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache'});res.write(`data: ${JSON.stringify({type:'connected',sessionId:url.pathname.split('/')[3],isStreaming:false,pendingExtensionUiIds:[]})}\n\n`);clients.add(res);res.on('close',()=>clients.delete(res));return;}
  if(/^\/api\/sessions\/qa-[^/]+\/state$/.test(url.pathname)){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({running:false,state:null}));return;}
  if(url.pathname.startsWith('/api/agent/')&&req.method==='POST'){evidence.blockedRuntimeCommands++;save();res.writeHead(403,{'content-type':'application/json'});res.end(JSON.stringify({error:'Runtime commands forbidden in history browser fixture'}));return;}
  if(url.pathname.includes('/history')){evidence.historyRequests.push(url.pathname+url.search);save();}
  const upstream=await fetch(url,{method:req.method,headers:{...req.headers,host:url.host},...(body.length?{body}:{}),redirect:'manual'});
  res.writeHead(upstream.status,Object.fromEntries([...upstream.headers].filter(([key])=>!['content-length','content-encoding','transfer-encoding'].includes(key))));
  if(upstream.body){const stream=Readable.fromWeb(upstream.body);stream.on('error',()=>res.destroy());res.on('close',()=>stream.destroy());stream.pipe(res);}else res.end();
 }catch(error){res.destroy();writeFileSync(join(artifacts,'error.txt'),String(error));}});
 proxy.listen(Number(process.env.HISTORY_QA_PORT||31590),'127.0.0.1');await once(proxy,'listening');
 const url=`http://127.0.0.1:${proxy.address().port}/?session=${id}`;writeFileSync(join(artifacts,'fixture.json'),JSON.stringify({url,home,artifacts},null,2));save();console.log(`QA_READY ${url}`);
 await new Promise(resolve=>{process.once('SIGINT',resolve);process.once('SIGTERM',resolve);});
}finally{
 for(const client of clients)client.end();proxy?.closeAllConnections();proxy?.close();
 const exited=once(child,'exit');child.kill('SIGTERM');const timer=setTimeout(()=>child.kill('SIGKILL'),5000);await exited;clearTimeout(timer);log.end();save();
}
